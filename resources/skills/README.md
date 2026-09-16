# Built-in skills

Each subdirectory here with a `SKILL.md` file ships with WorkLens as a
built-in skill (Settings → Skills → Built-in). They are packaged via
`extraResources` in `package.json` and resynced into
`~/.worklens/skills` on every app launch (`SkillsService.initialize` in
`src/main/skills.ts`), so anything written directly into a user's copy of
that folder is overwritten on next start — edit the source here instead.

See `node_modules/@earendil-works/pi-coding-agent/docs/skills.md` for the
`SKILL.md` format (required `name`/`description` frontmatter, optional
`scripts/`, `references/`, `assets/`).

## Bundled skills

Third-party skills are vendored verbatim; each directory carries the
upstream license as `LICENSE.txt`. To update one, re-copy from the pinned
source and bump the commit below.

| Skill | Source | Commit | License |
|---|---|---|---|
| `deep-research` | [bytedance/deer-flow](https://github.com/bytedance/deer-flow/tree/main/skills/public/deep-research) `skills/public/deep-research` | `f7f4a02` | MIT |
| `code-documentation` | [bytedance/deer-flow](https://github.com/bytedance/deer-flow/tree/main/skills/public/code-documentation) `skills/public/code-documentation` | `f7f4a02` | MIT |
