import { test, expect } from "vitest";
import { mkdtemp, mkdir, writeFile, rm, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { AgentService } from "../src/main/agent-service";
import { SkillsService, summarize } from "../src/main/skills";
import { resources } from "../src/main/resources";
import { StateStore } from "../src/main/storage";
import { schemas } from "../src/main/validation";
import { mockServer, fixtureModel } from "./mock-server";
import type { ChatEvent } from "../src/shared/contracts";

async function skillMd(dir: string, name: string, description: string) {
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, "SKILL.md"),
    `---\nname: ${name}\ndescription: ${description}\n---\n\nBody.\n`,
  );
}

test("built-in skills are synced from the bundled resource and scanned separately from the local directory", async () => {
  const root = await mkdtemp(join(tmpdir(), "worklens-skills-"));
  try {
    const bundled = join(root, "bundled");
    const local = join(root, "agents-skills");
    await skillMd(
      join(bundled, "pdf-tools"),
      "pdf-tools",
      "Extracts text from PDFs.",
    );
    await skillMd(join(local, "brave-search"), "brave-search", "Web search.");
    const state = new StateStore(join(root, "settings.json"));
    await state.load();
    const skills = new SkillsService(
      join(root, "builtin"),
      local,
      bundled,
      state,
    );
    await skills.initialize();
    const snapshot = skills.list();
    expect(snapshot.builtin).toEqual([
      {
        name: "pdf-tools",
        description: "Extracts text from PDFs.",
        summary: "Extracts text from PDFs.",
        path: join(root, "builtin", "pdf-tools", "SKILL.md"),
        source: "builtin",
        enabled: true,
      },
    ]);
    expect(snapshot.local).toEqual([
      {
        name: "brave-search",
        description: "Web search.",
        summary: "Web search.",
        path: join(local, "brave-search", "SKILL.md"),
        source: "local",
        enabled: true,
      },
    ]);
    // The local directory is read-only from WorkLens's perspective.
    expect(await readdir(local)).toEqual(["brave-search"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a newer app version drops built-in skills removed from the bundled resource", async () => {
  const root = await mkdtemp(join(tmpdir(), "worklens-skills-sync-"));
  try {
    const bundled = join(root, "bundled");
    const builtin = join(root, "builtin");
    await skillMd(join(bundled, "old-skill"), "old-skill", "Retired.");
    const state = new StateStore(join(root, "settings.json"));
    await state.load();
    await new SkillsService(
      builtin,
      join(root, "agents-skills"),
      bundled,
      state,
    ).initialize();
    expect(await readdir(builtin)).toContain("old-skill");
    await rm(join(bundled, "old-skill"), { recursive: true, force: true });
    await skillMd(join(bundled, "new-skill"), "new-skill", "Replacement.");
    const second = new SkillsService(
      builtin,
      join(root, "agents-skills"),
      bundled,
      state,
    );
    await second.initialize();
    expect(await readdir(builtin)).toEqual(["new-skill"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("toggling a skill persists across reloads without touching the skill file, and gates the session configuration key", async () => {
  const root = await mkdtemp(join(tmpdir(), "worklens-skills-toggle-"));
  try {
    const bundled = join(root, "bundled");
    await skillMd(join(bundled, "demo"), "demo", "Demo skill.");
    const state = new StateStore(join(root, "settings.json"));
    await state.load();
    const skills = new SkillsService(
      join(root, "builtin"),
      join(root, "agents-skills"),
      bundled,
      state,
    );
    await skills.initialize();
    const before = skills.configurationKey();
    expect(skills.list().builtin[0].enabled).toBe(true);
    await skills.setEnabled("demo", false);
    expect(skills.list().builtin[0].enabled).toBe(false);
    expect(skills.configurationKey()).not.toBe(before);
    const restored = new StateStore(join(root, "settings.json"));
    await restored.load();
    expect(restored.value.disabledSkills).toEqual(["demo"]);
    await skills.setEnabled("demo", true);
    expect(skills.list().builtin[0].enabled).toBe(true);
    expect(skills.configurationKey()).toBe(before);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("resources() feeds SkillsService's paths into the real Pi resource loader and skillsOverride hides disabled skills", async () => {
  const root = await mkdtemp(join(tmpdir(), "worklens-resources-skills-"));
  try {
    const skillsDir = join(root, "skills");
    await skillMd(join(skillsDir, "demo"), "demo", "Demo skill for testing.");
    const enabled = await resources(root, root, undefined, {
      paths: [skillsDir],
      disabledNames: [],
    });
    expect(
      enabled.resourceLoader.getSkills().skills.map((s) => s.name),
    ).toEqual(["demo"]);
    const disabled = await resources(root, root, undefined, {
      paths: [skillsDir],
      disabledNames: ["demo"],
    });
    expect(disabled.resourceLoader.getSkills().skills).toEqual([]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("toggling a local skill changes what the model is offered on the next turn of the same conversation", async () => {
  const root = await mkdtemp(join(tmpdir(), "worklens-skills-session-"));
  const server = await mockServer();
  const paths = {
    runtime: join(root, "runtime"),
    sessions: join(root, "sessions"),
    userData: join(root, "app"),
  };
  const local = join(root, "agents-skills");
  await skillMd(join(local, "brave-search"), "brave-search", "Web search.");
  const runtime = await ModelRuntime.create({ modelsPath: null });
  runtime.registerProvider("worklens-test", {
    name: "本地测试",
    api: "openai-completions",
    baseUrl: server.url,
    apiKey: "test-placeholder",
    models: [fixtureModel],
  });
  await runtime.refresh({ allowNetwork: false });
  const state = new StateStore(join(root, "settings.json"));
  await state.load();
  const skills = new SkillsService(
    join(root, "builtin"),
    local,
    join(root, "missing-bundled"),
    state,
  );
  await skills.initialize();
  const events: ChatEvent[] = [];
  const service = new AgentService(
    runtime,
    paths,
    (event) => events.push(event),
    (value) => value,
    undefined,
    skills,
  );
  await service.initialize();
  const selection = {
    provider: "worklens-test",
    model: "worklens-test",
    thinking: "off" as const,
  };
  const systemPrompt = () =>
    server.requests.at(-1).messages.find((m: any) => m.role === "system")
      .content as string;
  try {
    const first = await service.send({ requestId: "a", text: "hi", selection });
    await expect
      .poll(
        () =>
          events.findLast(
            (e) => e.conversationId === first.id && e.type === "run_end",
          ),
        { timeout: 25000 },
      )
      .toBeTruthy();
    expect(systemPrompt()).toContain("<available_skills>");
    expect(systemPrompt()).toContain("<name>brave-search</name>");

    await skills.setEnabled("brave-search", false);
    await service.send({
      conversationId: first.id,
      requestId: "b",
      text: "again",
      selection,
    });
    await expect
      .poll(
        () =>
          events.findLast(
            (e) =>
              e.conversationId === first.id &&
              e.runId !== first.runId &&
              e.type === "run_end",
          ),
        { timeout: 25000 },
      )
      .toBeTruthy();
    expect(systemPrompt()).not.toContain("brave-search");
    expect(systemPrompt()).not.toContain("<available_skills>");
  } finally {
    await service.shutdown();
    await server.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("skillsToggle input validates the skill name and keeps the request contract strict", () => {
  expect(schemas.skillsToggle.parse({ name: "demo", enabled: false })).toEqual({
    name: "demo",
    enabled: false,
  });
  for (const value of [
    { name: "", enabled: true },
    { enabled: true },
    { name: "demo" },
  ]) {
    expect(schemas.skillsToggle.safeParse(value).success).toBe(false);
  }
});

test("summarize keeps the first sentence of a model-facing description within one row", () => {
  expect(summarize("Web search.")).toBe("Web search.");
  expect(
    summarize(
      'Use this skill when the user wants X. Trigger on queries like "what is X"; never answer from memory.',
    ),
  ).toBe("Use this skill when the user wants X.");
  expect(summarize("用于生成周报。触发词：周报、汇报。")).toBe(
    "用于生成周报。",
  );
  expect(summarize("Version 2.0 handles e.g. PDFs and more.")).toBe(
    "Version 2.0 handles e.g. PDFs and more.",
  );
  const long = summarize(`${"word ".repeat(60)}end.`);
  expect(long.length).toBeLessThanOrEqual(140);
  expect(long.endsWith("…")).toBe(true);
  expect(summarize("  spaced\n\nout   text  ")).toBe("spaced out text");
});
