import { createHash } from "node:crypto";
import { SerialQueue } from "./storage";
import { existsSync } from "node:fs";
import { cp, mkdir, rm } from "node:fs/promises";
import { loadSkillsFromDir } from "@earendil-works/pi-coding-agent";
import type { StateStore } from "./storage";
import type { SkillInfo, SkillsSnapshot } from "../shared/contracts";

/**
 * Two sources only, both directories of SKILL.md packages:
 * - builtin: shipped with the app, resynced from the bundled resource on
 *   every launch so it stays read-only from the user's perspective.
 * - local: ~/.agents/skills, the cross-tool location other agent
 *   harnesses (Claude Code, Codex, Pi itself) already read and write. We only
 *   read it; nothing here writes into it.
 */
const SUMMARY_LIMIT = 140;
/** SKILL.md descriptions are written for the model; rows show one sentence. */
export function summarize(description: string) {
  const text = description.replace(/\s+/g, " ").trim();
  // A period ends the sentence only before whitespace, and not inside
  // dotted abbreviations such as "e.g." or "i.e.".
  const sentence =
    text.match(/^.*?(?:(?<![A-Za-z]\.[A-Za-z])[.!?](?=\s|$)|[。！？])/)?.[0] ??
    text;
  return sentence.length > SUMMARY_LIMIT
    ? `${sentence.slice(0, SUMMARY_LIMIT - 1).trimEnd()}…`
    : sentence;
}
export class SkillsService {
  private queue = new SerialQueue();
  private generation = 0;
  private snapshot: SkillsSnapshot = { builtin: [], local: [] };
  constructor(
    readonly builtinDir: string,
    readonly localDir: string,
    private readonly bundledSource: string,
    private readonly state: StateStore,
  ) {}
  async initialize() {
    await mkdir(this.builtinDir, { recursive: true });
    if (existsSync(this.bundledSource)) {
      // The builtin directory mirrors the bundled resource exactly; wiping it
      // first drops skills removed from a newer app version.
      await rm(this.builtinDir, { recursive: true, force: true });
      await cp(this.bundledSource, this.builtinDir, { recursive: true });
    }
    this.refresh();
  }
  private disabledNames() {
    return new Set(this.state.value.disabledSkills ?? []);
  }
  private scan(dir: string, source: SkillInfo["source"]): SkillInfo[] {
    if (!existsSync(dir)) return [];
    const disabled = this.disabledNames();
    const { skills } = loadSkillsFromDir({ dir, source });
    return skills
      .map((skill) => ({
        id: createHash("sha256")
          .update(`${source}:${skill.filePath}`)
          .digest("hex"),
        name: skill.name,
        description: skill.description,
        summary: summarize(skill.description),
        path: skill.filePath,
        source,
        enabled: !disabled.has(skill.name),
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }
  refresh(): SkillsSnapshot {
    this.snapshot = {
      builtin: this.scan(this.builtinDir, "builtin"),
      local: this.scan(this.localDir, "local"),
    };
    const winners = new Map<string, SkillInfo>();
    for (const skill of [...this.snapshot.builtin, ...this.snapshot.local]) {
      const winner = winners.get(skill.name);
      if (winner) {
        skill.shadowedBy = winner.source;
        skill.enabled = false;
      } else winners.set(skill.name, skill);
    }
    this.generation++;
    return this.snapshot;
  }
  list() {
    return this.snapshot;
  }
  /** Opaque file identity prevents same-name rows revealing the wrong file. */
  private find(id: string) {
    const skill = [...this.snapshot.builtin, ...this.snapshot.local].find(
      (skill) => skill.id === id,
    );
    if (!skill) throw new Error("未找到该技能，请刷新列表");
    return skill;
  }
  pathOf(id: string) {
    return this.find(id).path;
  }
  setEnabled(id: string, enabled: boolean) {
    return this.queue.run("skills", async () => {
      const skill = this.find(id);
      if (skill.shadowedBy)
        throw new Error("同名技能已由其他来源提供，请修改生效版本的开关");
      const disabled = this.disabledNames();
      if (enabled) disabled.delete(skill.name);
      else disabled.add(skill.name);
      await this.state.update({ disabledSkills: [...disabled] });
      return this.refresh();
    });
  }
  /** Refresh invalidates cached sessions even when names/descriptions are unchanged. */
  configurationKey() {
    return JSON.stringify([this.generation, [...this.disabledNames()].sort()]);
  }
  skillPaths() {
    // Resolve once, using the same built-in-first precedence displayed in Settings.
    return [...this.snapshot.builtin, ...this.snapshot.local]
      .filter((skill) => !skill.shadowedBy)
      .map((skill) => skill.path);
  }
  disabledSkillNames() {
    return [...this.disabledNames()];
  }
}
