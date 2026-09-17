import {
  test,
  expect,
  _electron as electron,
  type ElectronApplication,
} from "@playwright/test";
import { mkdtemp, mkdir, writeFile, readdir, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

test("Skills: bundled migration, isolated local files, concurrent IPC toggles and restart", async ({}, info) => {
  const root = await mkdtemp(join(tmpdir(), "worklens-skills-desktop-"));
  let app: ElectronApplication | undefined;
  const env: NodeJS.ProcessEnv = { ...process.env, WORKLENS_TEST_ROOT: root };
  delete env.ELECTRON_RUN_AS_NODE;
  for (const key of Object.keys(env))
    if (/(?:API_KEY|ACCESS_TOKEN|AUTH_TOKEN|GITHUB_TOKEN|GH_TOKEN)$/.test(key))
      delete env[key];
  const createSkill = async (base: string, name: string) => {
    await mkdir(join(root, base, name), { recursive: true });
    await writeFile(
      join(root, base, name, "SKILL.md"),
      `---\nname: ${name}\ndescription: Local ${name} instructions.\n---\nBody.`,
    );
  };
  const launch = async () => {
    app = await electron.launch({
      args: ["."],
      cwd: resolve("."),
      env: env as Record<string, string>,
    });
    const page = await app.firstWindow();
    await expect(page.locator(".sidebar-toggle")).toBeVisible();
    return page;
  };
  try {
    await createSkill("skills", "code-documentation");
    await createSkill("skills", "deep-research");
    await createSkill("skills", "retired-skill");
    await createSkill("local-skills", "alpha");
    await createSkill("local-skills", "beta");
    await createSkill("local-skills", "retired-skill");
    let page = await launch();
    const initial = await page.evaluate(() =>
      window.worklens.invoke("skillsList", undefined),
    );
    expect(initial.builtin).toEqual([]);
    expect(initial.local).toHaveLength(3);
    expect(
      initial.local.find((skill) => skill.name === "retired-skill"),
    ).toMatchObject({ enabled: true });
    expect(initial.local.every((skill) => !skill.shadowedBy)).toBe(true);
    const ids = initial.local
      .filter((skill) => !skill.shadowedBy)
      .map((skill) => skill.id);
    await page.evaluate(
      async (ids) =>
        Promise.all(
          ids.map((id) =>
            window.worklens.invoke("skillsToggle", { id, enabled: false }),
          ),
        ),
      ids,
    );
    expect(
      (
        await page.evaluate(() =>
          window.worklens.invoke("skillsList", undefined),
        )
      ).local.every((skill) => !skill.enabled),
    ).toBe(true);
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await page
      .locator(".settings-navigation")
      .getByRole("button", { name: "Skills", exact: true })
      .click();
    await expect(page.getByText("No built-in skills yet.")).toBeVisible();
    await createSkill("local-skills", "gamma");
    await page
      .getByRole("button", { name: "Refresh skills", exact: true })
      .click();
    await expect(
      page.getByRole("button", { name: "About gamma", exact: true }),
    ).toBeVisible();
    await page.screenshot({ path: info.outputPath("skills-desktop.png") });
    await app!.close();
    app = undefined;
    page = await launch();
    const restored = await page.evaluate(() =>
      window.worklens.invoke("skillsList", undefined),
    );
    expect(
      restored.local
        .filter((skill) => ids.includes(skill.id))
        .every((skill) => !skill.enabled),
    ).toBe(true);
    expect(
      restored.local.find((skill) => skill.name === "gamma")?.enabled,
    ).toBe(true);
    expect(await readdir(join(root, "local-skills"))).toEqual([
      "alpha",
      "beta",
      "gamma",
      "retired-skill",
    ]);
    expect(await readdir(join(root, "skills"))).not.toContain(
      "code-documentation",
    );
    expect(await readdir(join(root, "skills"))).not.toContain("deep-research");
    expect(await readdir(join(root, "skills"))).not.toContain("retired-skill");
    expect(restored.builtin).toEqual([]);
  } finally {
    await app?.close();
    await rm(root, { recursive: true, force: true });
  }
});
