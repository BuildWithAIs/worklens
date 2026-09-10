import { afterEach, describe, expect, test } from "vitest";
import {
  mkdtemp,
  readFile,
  readdir,
  writeFile,
  realpath,
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { ModelRuntime, SessionManager } from "@earendil-works/pi-coding-agent";
import { AgentService } from "../src/main/agent-service";
import { SecureCredentials, redactStrings } from "../src/main/storage";
import { resources } from "../src/main/resources";
import { externalUrl, schemas } from "../src/main/validation";
import { mockServer, fixtureModel } from "./mock-server";
import type { ChatEvent, Selection } from "../src/shared/contracts";

const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
});
async function setup() {
  const directory = await mkdtemp(join(tmpdir(), "worklens-unit-"));
  const paths = {
    runtime: join(directory, "runtime"),
    sessions: join(directory, "sessions"),
    userData: join(directory, "app"),
  };
  const server = await mockServer();
  cleanup.push(server.close);
  const runtime = await ModelRuntime.create({ modelsPath: null });
  runtime.registerProvider("worklens-test", {
    name: "本地测试",
    api: "openai-completions",
    baseUrl: server.url,
    apiKey: "test-placeholder",
    models: [fixtureModel],
  });
  await runtime.refresh({ allowNetwork: false });
  const events: ChatEvent[] = [];
  const service = new AgentService(
    runtime,
    paths,
    (event) => events.push(event),
    (value) => value,
  );
  await service.initialize();
  cleanup.push(() => service.shutdown());
  const selection: Selection = {
    provider: "worklens-test",
    model: "worklens-test",
    thinking: "off",
  };
  return { service, runtime, events, directory, paths, selection, server };
}
async function waitEnd(events: ChatEvent[], id: string) {
  await expect
    .poll(
      () =>
        events.findLast((e) => e.conversationId === id && e.type === "run_end"),
      { timeout: 25000 },
    )
    .toBeTruthy();
  return events.findLast(
    (e) => e.conversationId === id && e.type === "run_end",
  )!;
}
describe("PRD 012, 061, 062: process and credential boundaries", () => {
  test("Copilot catalog IDs stay distinct after OAuth credential redaction", async () => {
    const directory = await mkdtemp(join(tmpdir(), "worklens-copilot-ids-"));
    const store = new SecureCredentials(directory, {
      isEncryptionAvailable: () => true,
      encryptString: (value: string) => Buffer.from(value),
      decryptString: (value: Buffer) => value.toString(),
    });
    const ids = ["claude-sonnet-4.5", "gpt-5.1-codex", "gemini-3-pro-preview"];
    await store.modify("github-copilot", async () => ({
      type: "oauth",
      access: "private-access-token",
      refresh: "private-refresh-token",
      expires: 9999999999999,
      availableModelIds: ids,
    }));
    const dto = {
      models: ids.map((id) => ({ id })),
      hiddenModels: [`github-copilot/${ids[1]}`],
    };
    expect(redactStrings(dto, (text) => store.redact(text))).toEqual(dto);
    expect(
      store.redact("private-access-token private-refresh-token"),
    ).not.toMatch(/private-/);
    expect(store.redact("AWS credentials or bearer token")).toBe(
      "AWS credentials or bearer token",
    );
    expect(
      store.redact("Authorization: Bearer private-access-token"),
    ).not.toContain("private-access-token");
  });
  test("credential read-modify-write is serialized without plaintext at rest", async () => {
    const directory = await mkdtemp(join(tmpdir(), "worklens-secrets-"));
    const encryption = {
      isEncryptionAvailable: () => true,
      encryptString: (s: string) =>
        Buffer.from(Buffer.from(s).map((b) => b ^ 0x7f)),
      decryptString: (b: Buffer) =>
        Buffer.from(Buffer.from(b).map((v) => v ^ 0x7f)).toString(),
    };
    const store = new SecureCredentials(directory, encryption);
    await store.modify("p", async () => ({
      type: "api_key",
      key: "private-test-secret",
      env: { n: "0" },
    }));
    await Promise.all(
      Array.from({ length: 20 }, () =>
        store.modify("p", async (current) => ({
          ...current!,
          type: "api_key",
          env: {
            n: String(
              Number(current?.type === "api_key" ? current.env?.n : 0) + 1,
            ),
          },
        })),
      ),
    );
    expect(await store.read("p")).toMatchObject({ env: { n: "20" } });
    expect(
      await readFile(join(directory, (await readdir(directory))[0]), "utf8"),
    ).not.toContain("private-test-secret");
    expect(await store.list()).toEqual([{ providerId: "p", type: "api_key" }]);
    expect(
      store.redact("Bearer hidden-token private-test-secret"),
    ).not.toContain("private-test-secret");
    await store.delete("p");
    expect(await store.read("p")).toBeUndefined();
  });
  test("unavailable OS encryption refuses persistence", async () => {
    const directory = await mkdtemp(join(tmpdir(), "worklens-secrets-"));
    const store = new SecureCredentials(directory, {
      isEncryptionAvailable: () => false,
      encryptString: () => Buffer.alloc(0),
      decryptString: () => "",
    });
    await expect(
      store.modify("p", async () => ({ type: "api_key", key: "secret" })),
    ).rejects.toThrow("安全存储");
    expect(await readdir(directory)).toEqual([]);
  });
  test("PRD 012, 056: redaction preserves DTO structure and hides escaped secrets", async () => {
    const directory = await mkdtemp(join(tmpdir(), "worklens-redaction-"));
    const store = new SecureCredentials(directory, {
      isEncryptionAvailable: () => true,
      encryptString: (value) => Buffer.from(value),
      decryptString: (value) => value.toString(),
    });
    const secret = 'fixture-"quoted"-\\token\nnext';
    await store.modify("quoted", async () => ({
      type: "api_key",
      key: secret,
    }));
    await store.modify("numeric", async () => ({
      type: "api_key",
      key: "123456",
    }));
    await store.modify("short", async () => ({ type: "api_key", key: "a!b" }));
    const result = redactStrings(
      {
        type: "api_key",
        elapsed: 123456,
        nested: [
          null,
          true,
          {
            text: secret,
            args: JSON.stringify({ secret }),
            error: "123456 a!b",
          },
        ],
      },
      (text) => store.redact(text),
    );
    expect(result.type).toBe("api_key");
    expect(result.elapsed).toBe(123456);
    expect(result.nested).toEqual([
      null,
      true,
      {
        text: "[redacted]",
        args: '{"secret":"[redacted]"}',
        error: "[redacted] [redacted]",
      },
    ]);
  });
  test("PRD 012: a corrupt credential does not block startup or replacement", async () => {
    const directory = await mkdtemp(join(tmpdir(), "worklens-corrupt-vault-"));
    const path = join(
      directory,
      createHash("sha256").update("openai").digest("hex") + ".json",
    );
    await writeFile(path, "{broken-vault");
    const store = new SecureCredentials(directory, {
      isEncryptionAvailable: () => true,
      encryptString: (value) => Buffer.from(value),
      decryptString: (value) => value.toString(),
    });
    const runtime = await ModelRuntime.create({
      credentials: store,
      modelsPath: null,
    });
    expect(runtime.getModels().length).toBeGreaterThan(0);
    expect(await store.read("openai")).toBeUndefined();
    expect(store.diagnosticFor("openai")).toContain("原文件尚未修改");
    expect(await store.list()).toEqual([]);
    expect(await readFile(path, "utf8")).toBe("{broken-vault");
    await store.modify("openai", async () => ({
      type: "api_key",
      key: "replacement-placeholder",
    }));
    expect(await store.read("openai")).toMatchObject({
      key: "replacement-placeholder",
    });
    expect(store.diagnosticFor("openai")).toBeUndefined();
    expect(await store.list()).toEqual([
      { providerId: "openai", type: "api_key" },
    ]);
  });
  test("untrusted renderer inputs and non-web external URLs are rejected", () => {
    expect(() => schemas.open.parse({ id: "../../secret" })).toThrow();
    expect(() => schemas.send.parse({ text: " ", requestId: "x" })).toThrow();
    for (const url of [
      "file:///C:/secret",
      "javascript:alert(1)",
      "https://user:secret@example.com",
    ])
      expect(() => externalUrl(url)).toThrow();
    expect(externalUrl("https://example.com")).toBe("https://example.com/");
  });
  test("resource loader ignores local prompts and context files", async () => {
    const directory = await mkdtemp(join(tmpdir(), "worklens-resources-"));
    await writeFile(join(directory, "AGENTS.md"), "SENTINEL_UNTRUSTED");
    await writeFile(join(directory, "SYSTEM.md"), "SENTINEL_UNTRUSTED");
    await writeFile(join(directory, "APPEND_SYSTEM.md"), "SENTINEL_UNTRUSTED");
    const { resourceLoader } = await resources(directory, directory);
    expect(resourceLoader.getAgentsFiles().agentsFiles).toEqual([]);
    expect(resourceLoader.getSystemPrompt()).not.toContain(
      "SENTINEL_UNTRUSTED",
    );
    expect(resourceLoader.getAppendSystemPrompt()).toEqual([]);
    expect(resourceLoader.getSkills().skills).toEqual([]);
  });
});
describe("PRD 030-056: real Pi agent sessions and local tools", () => {
  test("two sessions stream concurrently; cancel and repeated request isolation", async () => {
    const { service, selection, events } = await setup();
    const input = {
      requestId: "first",
      text: "SLOW " + "任务甲 ".repeat(60),
      selection,
    };
    const [a, repeated] = await Promise.all([
      service.send(input),
      service.send(input),
    ]);
    expect(repeated.id).toBe(a.id);
    const b = await service.send({
      requestId: "second",
      text: "任务乙",
      selection,
    });
    await expect(
      service.send({ ...input, conversationId: a.id, requestId: "duplicate" }),
    ).rejects.toThrow("正在运行");
    await service.cancel(a.id, a.runId!);
    const [endA, endB] = await Promise.all([
      waitEnd(events, a.id),
      waitEnd(events, b.id),
    ]);
    expect(endA.view.phase).toBe("cancelled");
    expect(endB.view.phase).toBe("completed");
    expect(endB.view.messages.map((m) => m.text).join("")).not.toContain(
      "任务甲",
    );
    expect(
      (await service.open(b.id)).messages.some((m) =>
        m.text.includes("任务乙"),
      ),
    ).toBe(true);
    await service.rename(b.id, "保留乙");
    expect((await service.list()).find((c) => c.id === b.id)?.title).toBe(
      "保留乙",
    );
    await service.delete(a.id);
    expect((await service.list()).map((c) => c.id)).toContain(b.id);
  });
  test("tool write outside runtime is persisted and restored by a fresh service", async () => {
    const { service, runtime, selection, events, directory, paths } =
      await setup();
    const target = join(directory, "outside-runtime.txt");
    const conversation = await service.send({
      requestId: "write",
      text:
        "TOOL " +
        JSON.stringify({
          name: "write",
          args: { path: target, content: "真实 Pi 工具写入" },
        }),
      selection,
    });
    const end = await waitEnd(events, conversation.id);
    expect(end.view.phase, end.view.error).toBe("completed");
    expect(await readFile(target, "utf8")).toBe("真实 Pi 工具写入");
    expect(
      end.view.messages.some(
        (m) => m.toolName === "write" && m.status === "success",
      ),
    ).toBe(true);
    const managers = await SessionManager.list(paths.runtime, paths.sessions);
    const saved = SessionManager.open(
      managers[0].path,
      paths.sessions,
      paths.runtime,
    );
    expect(saved.getCwd()).toBe(paths.runtime);
    const messages = saved.buildSessionContext().messages;
    expect(messages.some((m) => m.role === "toolResult")).toBe(true);
    await service.shutdown();
    const restored = new AgentService(
      runtime,
      paths,
      () => {},
      (x) => x,
    );
    cleanup.push(() => restored.shutdown());
    await restored.initialize();
    const restoredView = await restored.open(conversation.id);
    const restoredTool = restoredView.messages.find(
      (m) => m.toolName === "write",
    );
    expect(restoredTool?.targetPath).toBe(target);
    expect(restoredTool?.startedAt).toBeTruthy();
    expect(restoredTool?.elapsed).toBeGreaterThanOrEqual(0);
    expect(restoredTool?.elapsed).toBeLessThan(30000);
    expect(
      restoredView.messages.some(
        (m) => m.toolName === "write" && m.status === "success",
      ),
    ).toBe(true);
  });
  test("platform shell really executes with shared cwd", async () => {
    const { service, selection, events, paths } = await setup();
    const shellName = process.platform === "win32" ? "powershell" : "bash";
    const conversation = await service.send({
      requestId: "shell",
      text:
        "TOOL " +
        JSON.stringify({
          name: shellName,
          args: {
            command:
              process.platform === "win32" ? "(Get-Location).Path" : "pwd",
            timeout: 10,
          },
        }),
      selection,
    });
    const end = await waitEnd(events, conversation.id);
    expect(end.view.phase, end.view.error).toBe("completed");
    const result = end.view.messages.find((m) => m.toolName === shellName);
    expect(result?.status, result?.text).toBe("success");
    expect(result).toMatchObject({
      shellCwd: paths.runtime,
      timeoutSeconds: 10,
      exitCode: 0,
    });
    expect(result?.text.toLowerCase()).toContain(
      (await realpath(paths.runtime)).toLowerCase(),
    );
    for (const [command, timeout, status, exitCode] of [
      ["exit 7", 10, "error", 7],
      [
        process.platform === "win32" ? "Start-Sleep -Seconds 5" : "sleep 5",
        0.1,
        "timeout",
        undefined,
      ],
    ] as const) {
      const next = await service.send({
        requestId: `shell-${status}`,
        selection,
        text:
          "TOOL " +
          JSON.stringify({ name: shellName, args: { command, timeout } }),
      });
      const completed = await waitEnd(events, next.id);
      const tool = completed.view.messages.find(
        (message) => message.toolName === shellName,
      );
      expect(tool?.status, tool?.text).toBe(status);
      expect(tool?.exitCode).toBe(exitCode);
    }
  });
  test("Pi read, ls, find, grep and edit tools actually operate outside runtime", async () => {
    const { service, selection, events, directory } = await setup();
    const target = join(directory, "search-fixture.txt");
    await writeFile(target, "needle in a local document");
    for (const [name, args, expected] of [
      ["ls", { path: directory }, "search-fixture.txt"],
      ["find", { path: directory, pattern: "*.txt" }, "search-fixture.txt"],
      ["grep", { path: directory, pattern: "needle" }, "needle"],
      ["read", { path: target }, "needle"],
      ["edit", { path: target, oldText: "needle", newText: "updated" }, ""],
    ] as const) {
      const view = await service.send({
        requestId: `tool-${name}`,
        text: "TOOL " + JSON.stringify({ name, args }),
        selection,
      });
      const end = await waitEnd(events, view.id);
      const tool = end.view.messages.find((m) => m.toolName === name);
      expect(tool?.status, tool?.text).toBe("success");
      expect(tool?.text).toContain(expected);
    }
    expect(await readFile(target, "utf8")).toBe("updated in a local document");
  });
  test("unrecognized JSONL does not prevent discovery of healthy sessions", async () => {
    const { service, selection, events, paths } = await setup();
    const view = await service.send({
      requestId: "healthy",
      text: "保留有效会话",
      selection,
    });
    await waitEnd(events, view.id);
    await writeFile(join(paths.sessions, "broken.jsonl"), "{broken JSON\n");
    expect((await service.list()).some((c) => c.id === view.id)).toBe(true);
    expect(
      (await service.open(view.id)).messages.some((m) =>
        m.text.includes("保留有效会话"),
      ),
    ).toBe(true);
  });
});
