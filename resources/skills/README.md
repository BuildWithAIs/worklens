# Built-in skills

Each subdirectory here with a `SKILL.md` file ships with WorkLens as a
built-in skill (Settings → Skills → 内置). They are packaged via
`extraResources` in `package.json` and resynced into
`~/.worklens/skills` on every app launch (`SkillsService.initialize` in
`src/main/skills.ts`), so anything written directly into a user's copy of
that folder is overwritten on next start — edit the source here instead.

See `node_modules/@earendil-works/pi-coding-agent/docs/skills.md` for the
`SKILL.md` format (required `name`/`description` frontmatter, optional
`scripts/`, `references/`, `assets/`).

This directory intentionally ships empty for now; add skills as
subdirectories when there is real, reviewed content to bundle.
