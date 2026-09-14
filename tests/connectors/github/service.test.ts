import { describe, expect, it } from "vitest";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Octokit } from "octokit";
import { setup } from "./setup";
import { HEAD, OTHER_HEAD } from "./fixture";
import {
  GitHubConnections,
  normalizeSettings,
  apiAddresses,
} from "../../../src/main/connectors/github/connection";
import { operations } from "../../../src/main/connectors/github/catalog";
import { parseRequest } from "../../../src/main/connectors/github/execute";
import { GitHubHttp } from "../../../src/main/connectors/github/http";
import { diffLines } from "../../../src/main/connectors/github/reviews";
import { RequestQueue } from "../../../src/main/connectors/github/scheduler";

describe("GitHub connection", () => {
  it("requires an explicit site, derives public/enterprise endpoints and does not expose credentials", async () => {
    expect(() => normalizeSettings({ url: "" })).toThrow();
    for (const url of [
      "https://u:secret@github.example",
      "https://github.example/o/r",
      "file:///tmp/a",
      "https://github.example?token=a",
    ])
      expect(() => normalizeSettings({ url })).toThrow();
    expect(apiAddresses("https://github.com").rest).toBe(
      "https://api.github.com",
    );
    expect(apiAddresses("https://tenant.ghe.com")).toMatchObject({
      rest: "https://api.tenant.ghe.com",
      graphql: "https://api.tenant.ghe.com/graphql",
    });
    expect(apiAddresses("https://github.example")).toMatchObject({
      rest: "https://github.example/api/v3",
      graphql: "https://github.example/api/graphql",
    });
    const s = await setup();
    expect(s.connections.info()).toMatchObject({
      configured: true,
      login: "fixture-user",
      serverVersion: "3.17.0",
    });
    expect(JSON.stringify(s.connections.info())).not.toContain(s.input.token);
    expect(await readFile(join(s.root, "github.json"), "utf8")).not.toContain(
      s.input.token,
    );
    const restored = new GitHubConnections(
      join(s.root, "github.json"),
      s.crypto,
    );
    await restored.load();
    expect(restored.info().configured).toBe(true);
    await expect(
      s.connections.test({ url: "https://different.example" }),
    ).rejects.toThrow("token");
    expect(await s.connections.test({ url: s.input.url })).toContain(
      "fixture-user",
    );
    await s.connections.remove();
    expect(s.connections.info()).toEqual({ url: "", configured: false });
    expect(s.service.names()).toEqual([]);
  });
  it("disables old requests on failed save and rejects unavailable encryption", async () => {
    const s = await setup();
    const old = s.connections.snapshot();
    s.fixture.state.identityStatus = 401;
    await expect(s.connections.save(s.input)).rejects.toThrow("401");
    expect(old.signal.aborted).toBe(true);
    expect(s.service.names()).toEqual([]);
    s.fixture.state.identityStatus = 200;
    const unavailable = new GitHubConnections(
      join(s.root, "unavailable.json"),
      { ...s.crypto, isEncryptionAvailable: () => false },
    );
    await expect(unavailable.save(s.input)).rejects.toThrow("安全存储");
  });
});
describe("GitHub discovery and reads", () => {
  it("uses official REST routes and strict operation contracts", async () => {
    const endpoints = new Set<string>();
    for (const group of Object.values(new Octokit().rest))
      for (const method of Object.values(group))
        endpoints.add(
          `${method.endpoint.DEFAULTS.method} ${method.endpoint.DEFAULTS.url}`,
        );
    const unknown = Object.entries(operations)
      .filter(([, op]) => op.route && !endpoints.has(op.route))
      .map(([key, op]) => [key, op.route]);
    expect(unknown).toEqual([]);
    const s = await setup();
    const schema = await s.call({
      operation: "describe_operation",
      name: "create_issue",
    });
    expect(schema.data.schema.additionalProperties).toBe(false);
    expect(() =>
      parseRequest(
        {
          request: {
            operation: "create_issue",
            repo: "o/r",
            title: "A",
            token: "secret",
          },
        },
        true,
      ),
    ).toThrow();
    expect(
      (await s.call({ operation: "create_issue", repo: "o/r", title: "A" }))
        .data.status,
    ).toBe("invalid_request");
    expect(
      (
        await s.call({
          operation: "read_issue",
          repo: "https://evil.test/o/r",
          issue_number: 1,
        })
      ).data.status,
    ).toBe("invalid_target");
  });
  it("persists pagination across service reload while isolating session and connection", async () => {
    const s = await setup();
    s.fixture.state.paged = true;
    const first = await s.call({ operation: "list_issues", repo: "o/r" });
    expect(first.data.complete).toBe(false);
    expect(first.data.continuation).toBeTruthy();
    expect(
      (
        await s.call(
          { operation: "continue", continuation: first.data.continuation },
          false,
          "other-session",
        )
      ).data.status,
    ).toBe("invalid_continuation");
    const next = await s.call({
      operation: "continue",
      continuation: first.data.continuation,
    });
    expect(next.data.data[0].number).toBe(2);
    expect(next.data.complete).toBe(true);
    await s.connections.save(s.input);
    expect(
      (
        await s.call({
          operation: "continue",
          continuation: first.data.continuation,
        })
      ).data.status,
    ).toBe("invalid_continuation");
    s.fixture.state.crossHostPage = true;
    expect(
      (await s.call({ operation: "list_issues", repo: "o/r" })).data.status,
    ).toBe("invalid_continuation");
  });
  it("reports search caps and stops at explicit rate-limit guidance", async () => {
    const s = await setup();
    const result = await s.call({
      operation: "search_issues",
      q: "repo:o/r is:issue",
    });
    expect(result.data.complete).toBe(false);
    expect(result.data.warnings).toHaveLength(2);
    s.fixture.state.responseStatus = 403;
    s.fixture.state.retryAfter = "120";
    expect(
      (await s.call({ operation: "read_issue", repo: "o/r", issue_number: 1 }))
        .data.status,
    ).toBe("rate_limit");
  });
  it("downloads exact bytes without executing them and preserves them on disconnect", async () => {
    const s = await setup();
    const result = await s.call({
      operation: "download_file",
      repo: "o/r",
      path: "README.md",
      ref: HEAD,
    });
    expect(result.data.status).toBe("success");
    const artifact = (
      result.result.details as { artifacts: { path: string }[] }
    ).artifacts[0];
    expect(await readFile(artifact.path, "utf8")).toBe("fixture file bytes");
    await s.connections.remove();
    expect(await readFile(artifact.path, "utf8")).toBe("fixture file bytes");
  });
  it("never forwards credentials on download redirects and rejects API host escapes", async () => {
    const seen: { url: string; init?: RequestInit }[] = [];
    const s = await setup((base) => async (input, init) => {
      const url = String(input);
      if (url.includes("/contents/")) {
        seen.push({ url, init });
        return new Response(null, {
          status: 302,
          headers: { location: "https://downloads.example/asset?sig=fixture" },
        });
      }
      if (url.startsWith("https://downloads.example")) {
        seen.push({ url, init });
        return new Response("downloaded");
      }
      return base(input, init);
    });
    expect(
      (
        await s.call({
          operation: "download_file",
          repo: "o/r",
          path: "README.md",
          ref: HEAD,
        })
      ).data.status,
    ).toBe("success");
    expect(new Headers(seen[0].init?.headers).has("authorization")).toBe(true);
    expect(new Headers(seen[1].init?.headers).has("authorization")).toBe(false);
    const http = new GitHubHttp(s.connections.snapshot(), async () => {
      throw new Error("must not fetch");
    });
    await expect(
      http.rest("GET https://evil.example/user"),
    ).rejects.toMatchObject({ code: "invalid_target" });
  });
});
describe("GitHub writes and recovery", () => {
  it("cancels queued requests before the active request finishes", async () => {
    const queue = new RequestQueue();
    let release!: () => void;
    const first = queue.run(
      new AbortController().signal,
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    const abort = new AbortController();
    let executed = false;
    const queued = queue.run(abort.signal, async () => {
      executed = true;
    });
    abort.abort(new Error("cancel waiting"));
    await expect(queued).rejects.toThrow("cancel waiting");
    expect(executed).toBe(false);
    release();
    await first;
    expect(
      await queue.run(new AbortController().signal, async () => "available"),
    ).toBe("available");
  });
  it("deduplicates concurrent same-run writes and preserves unknown outcomes", async () => {
    const s = await setup();
    const request = {
      operation: "add_comment",
      repo: "o/r",
      issue_number: 1,
      body: "Hello",
    };
    const results = await Promise.all([
      s.call(request, true, "session1", undefined, "same-call"),
      s.call(request, true, "session1", undefined, "same-call"),
    ]);
    expect(s.fixture.state.comments).toBe(1);
    expect(results[1].data.replayed).toBe(true);
    s.nextRun();
    s.fixture.state.loseWriteResponse = true;
    const lost = await s.call(
      request,
      true,
      "session1",
      undefined,
      "lost-call",
    );
    expect(lost.data.status).toBe("unknown");
    const retry = await s.call(
      request,
      true,
      "session1",
      undefined,
      "lost-call",
    );
    expect(retry.data.status).toBe("unknown");
    expect(s.fixture.state.comments).toBe(2);
    const record = await s.call({
      operation: "read_operation",
      operationId: lost.data.operationId,
    });
    expect(record.data.status).toBe("unknown");
    expect(
      (
        await s.call(
          { operation: "read_operation", operationId: lost.data.operationId },
          false,
          "other",
        )
      ).data.status,
    ).toBe("invalid_target");
  });
  it("does not send cancelled operations", async () => {
    const s = await setup();
    const controller = new AbortController();
    controller.abort();
    expect(
      (
        await s.call(
          { operation: "create_issue", repo: "o/r", title: "A" },
          true,
          "session1",
          controller.signal,
        )
      ).data.status,
    ).toBe("cancelled");
    expect(s.fixture.state.writes).toBe(0);
  });
  it("validates stale review SHAs and real diff anchors before submitting", async () => {
    const s = await setup();
    const request = {
      operation: "create_review",
      repo: "o/r",
      pull_number: 1,
      expectedHeadSha: HEAD,
      event: "COMMENT",
      comments: [
        { path: "README.md", body: "Check this", line: 2, side: "RIGHT" },
      ],
    };
    expect(diffLines(s.fixture.state.patch).RIGHT.has(2)).toBe(true);
    expect(
      (await s.call({ ...request, expectedHeadSha: OTHER_HEAD }, true)).data
        .status,
    ).toBe("conflict");
    expect(
      (
        await s.call(
          { ...request, comments: [{ ...request.comments[0], line: 40 }] },
          true,
        )
      ).data.status,
    ).toBe("invalid_anchor");
    expect(s.fixture.state.writes).toBe(0);
    expect((await s.call(request, true)).data.status).toBe("success");
    const sent = s.fixture.state.requests.find(
      (r) => r.method === "POST" && r.path.endsWith("/reviews"),
    );
    expect(sent?.body.commit_id).toBe(HEAD);
    expect(sent?.body).not.toHaveProperty("expectedHeadSha");
    s.fixture.state.reviewHead = OTHER_HEAD;
    expect(
      (
        await s.call(
          {
            operation: "submit_review",
            repo: "o/r",
            pull_number: 1,
            review_id: 1,
            expectedHeadSha: HEAD,
            event: "APPROVE",
          },
          true,
        )
      ).data.status,
    ).toBe("conflict");
  });
  it("merges against expected head without deleting branches and validates atomic commits", async () => {
    const s = await setup();
    expect(
      (
        await s.call(
          {
            operation: "merge_pr",
            repo: "o/r",
            pull_number: 1,
            expectedHeadSha: HEAD,
            merge_method: "squash",
          },
          true,
        )
      ).data.status,
    ).toBe("success");
    expect(
      s.fixture.state.requests.find((r) => r.path.endsWith("/merge"))?.body.sha,
    ).toBe(HEAD);
    expect(s.fixture.state.requests.some((r) => r.method === "DELETE")).toBe(
      false,
    );
    const commit = {
      operation: "commit_files",
      repo: "o/r",
      branch: "feature",
      expectedHeadSha: HEAD,
      message: "Update docs",
      additions: [{ path: "README.md", contents: "new text" }],
    };
    expect((await s.call(commit, true)).data.status).toBe("success");
    expect(s.fixture.state.schemaErrors).toEqual([]);
    expect(
      (await s.call({ ...commit, deletions: ["README.md"] }, true)).data.status,
    ).toBe("invalid_request");
    expect(
      (await s.call({ ...commit, expectedHeadSha: OTHER_HEAD }, true)).data
        .status,
    ).toBe("conflict");
  });
  it("validates workflow inputs and distinguishes dispatch from completion", async () => {
    const s = await setup();
    const request = {
      operation: "dispatch_workflow",
      repo: "o/r",
      workflow_id: 1,
      ref: "main",
    };
    expect((await s.call(request, true)).data.status).toBe("invalid_request");
    expect(
      (await s.call({ ...request, inputs: { target: "invalid" } }, true)).data
        .status,
    ).toBe("invalid_request");
    expect(s.fixture.state.writes).toBe(0);
    expect(
      (await s.call({ ...request, inputs: { target: "test" } }, true)).data
        .status,
    ).toBe("accepted");
  });
  it("previews explicit batch targets and rejects changed targets without modifying them", async () => {
    const s = await setup();
    const preview = await s.call({
      operation: "preview_batch",
      repo: "o/r",
      issue_numbers: [1, 2],
      action: "add_labels",
      changes: { labels: ["triaged"] },
    });
    expect(preview.data.status).toBe("success");
    expect(s.fixture.state.writes).toBe(0);
    s.fixture.state.updatedAt = "2026-09-15T00:00:00Z";
    const result = await s.call(
      { operation: "batch", preview: preview.data.preview },
      true,
    );
    expect(result.data.status).toBe("failed");
    expect(s.fixture.state.writes).toBe(0);
    expect(result.data.items.every((i: any) => i.status === "conflict")).toBe(
      true,
    );
  });
  it("defaults release creation to draft, requires existing tags, and uploads bounded local assets", async () => {
    const s = await setup();
    expect(
      (
        await s.call(
          {
            operation: "create_release",
            repo: "o/r",
            tag_name: "v1",
            body: "Notes",
          },
          true,
        )
      ).data.status,
    ).toBe("success");
    expect(
      s.fixture.state.requests.find(
        (r) => r.method === "POST" && r.path.endsWith("/releases"),
      )?.body.draft,
    ).toBe(true);
    const path = join(s.root, "notes.txt");
    await writeFile(path, "asset body");
    expect(
      (
        await s.call(
          {
            operation: "upload_release_asset",
            repo: "o/r",
            release_id: 1,
            path,
            expectedFile: "stale",
          },
          true,
        )
      ).data.status,
    ).toBe("conflict");
    expect(
      (
        await s.call(
          {
            operation: "upload_release_asset",
            repo: "o/r",
            release_id: 1,
            path,
          },
          true,
        )
      ).data.status,
    ).toBe("success");
  });
});
