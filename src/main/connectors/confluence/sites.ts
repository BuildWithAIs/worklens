import { randomUUID } from "node:crypto";
import { readFile, rename } from "node:fs/promises";
import { dirname, join } from "node:path";
import { z } from "zod";
import { atomicJson, SerialQueue, type Encryption } from "../../storage";
import {
  ConfluenceConnections,
  normalizeSettings,
  type ConnectionSnapshot,
} from "./connection";
import type {
  ConfluenceSite,
  ConfluenceSiteInput,
} from "../../../shared/contracts";

/** The original single-site file stays the primary site, so older versions keep reading it. */
export const PRIMARY_SITE = "primary";
const indexSchema = z
  .object({
    version: z.literal(1),
    sites: z
      .array(
        z
          .object({
            id: z.string().regex(/^(primary|[0-9a-f-]{36})$/),
            readOnly: z.boolean().optional(),
          })
          .strict(),
      )
      .max(50),
  })
  .strict();
export interface Site {
  id: string;
  readOnly: boolean;
  connections: ConfluenceConnections;
}

export class ConfluenceSites {
  readonly primary: ConfluenceConnections;
  private sites: Site[];
  private queue = new SerialQueue();
  constructor(
    private primaryPath: string,
    private encryption: Encryption,
    private fetcher: typeof fetch = fetch,
  ) {
    this.primary = new ConfluenceConnections(primaryPath, encryption, fetcher);
    this.sites = [
      { id: PRIMARY_SITE, readOnly: false, connections: this.primary },
    ];
  }
  private get indexPath() {
    return join(dirname(this.primaryPath), "confluence-sites.json");
  }
  private sitePath(id: string) {
    return id === PRIMARY_SITE
      ? this.primaryPath
      : join(dirname(this.primaryPath), "confluence-sites", `${id}.json`);
  }
  private create(id: string, readOnly = false): Site {
    return {
      id,
      readOnly,
      connections:
        id === PRIMARY_SITE
          ? this.primary
          : new ConfluenceConnections(
              this.sitePath(id),
              this.encryption,
              this.fetcher,
            ),
    };
  }
  async load() {
    let entries: z.infer<typeof indexSchema>["sites"] = [];
    try {
      entries = indexSchema.parse(
        JSON.parse(await readFile(this.indexPath, "utf8")),
      ).sites;
    } catch (error) {
      // Keep an unreadable list for recovery instead of overwriting it later.
      if ((error as NodeJS.ErrnoException).code !== "ENOENT")
        await rename(this.indexPath, `${this.indexPath}.invalid`).catch(
          () => {},
        );
    }
    const primary = entries.find((entry) => entry.id === PRIMARY_SITE);
    this.sites = [
      this.create(PRIMARY_SITE, primary?.readOnly),
      ...entries
        .filter((entry) => entry.id !== PRIMARY_SITE)
        .map((entry) => this.create(entry.id, entry.readOnly)),
    ];
    await Promise.all(this.sites.map((site) => site.connections.load()));
  }
  /** A site exists once it has saved settings, including ones that need attention. */
  private existing() {
    return this.sites.filter(
      (site) => site.connections.info().url || site.connections.info().error,
    );
  }
  info(): ConfluenceSite[] {
    return this.existing().map((site) => ({
      ...site.connections.info(),
      id: site.id,
      readOnly: site.readOnly,
    }));
  }
  configured(write: boolean) {
    return this.existing().filter(
      (site) => site.connections.info().configured && !(write && site.readOnly),
    );
  }
  configurationKey() {
    return JSON.stringify(
      this.existing().map((site) => [
        site.id,
        site.readOnly,
        site.connections.configurationKey(),
      ]),
    );
  }
  redact(text: string) {
    return this.sites.reduce(
      (value, site) => site.connections.redact(value),
      text,
    );
  }
  assertCurrent(snapshot: ConnectionSnapshot) {
    snapshot.signal.throwIfAborted();
    if (!this.sites.some((site) => site.connections.owns(snapshot)))
      throw new Error("Confluence 连接已变更，请重新读取目标");
  }
  private async writeIndex(sites: Site[]) {
    await atomicJson(this.indexPath, {
      version: 1,
      sites: sites.map(({ id, readOnly }) => ({ id, readOnly })),
    });
  }
  private find(id: string) {
    const site = this.existing().find((item) => item.id === id);
    if (!site) throw new Error("未找到该 Confluence 站点，请刷新后重试");
    return site;
  }
  private assertUnique(url: string, except?: string) {
    if (
      this.existing().some(
        (site) => site.id !== except && site.connections.info().url === url,
      )
    )
      throw new Error("该 Confluence 站点已添加");
  }
  async test({ site, readOnly: _readOnly, ...input }: ConfluenceSiteInput) {
    if (site) return this.find(site).connections.test(input);
    // A new site never reuses another site's saved token.
    return new ConfluenceConnections(
      this.sitePath(randomUUID()),
      this.encryption,
      this.fetcher,
    ).test(input);
  }
  save({ site: id, readOnly = false, ...input }: ConfluenceSiteInput) {
    return this.queue.run("sites", async () => {
      const url = normalizeSettings(input).url;
      this.assertUnique(url, id);
      if (id) {
        const site = this.find(id);
        // Like other settings, the choice is kept even if validation fails.
        site.readOnly = readOnly;
        await this.writeIndex(this.sites);
        await site.connections.save(input);
        return this.info().find((item) => item.id === id)!;
      }
      // A new site is added only after its credentials verify, so a failed
      // attempt never leaves a duplicate entry behind for the next retry.
      const primaryFree = !this.existing().some(
        (site) => site.id === PRIMARY_SITE,
      );
      const site = this.create(
        primaryFree ? PRIMARY_SITE : randomUUID(),
        readOnly,
      );
      await new ConfluenceConnections(
        this.sitePath(randomUUID()),
        this.encryption,
        this.fetcher,
      ).test(input);
      const sites = primaryFree
        ? this.sites.map((item) => (item.id === PRIMARY_SITE ? site : item))
        : [...this.sites, site];
      await this.writeIndex(sites);
      this.sites = sites;
      await site.connections.save(input);
      return this.info().find((item) => item.id === site.id)!;
    });
  }
  remove(id: string) {
    return this.queue.run("sites", async () => {
      // Removing an already removed site is a no-op, e.g. from a stale dialog.
      const site = this.existing().find((item) => item.id === id);
      if (!site) return;
      await site.connections.remove();
      const sites =
        id === PRIMARY_SITE
          ? this.sites.map((item) =>
              item.id === PRIMARY_SITE ? this.create(PRIMARY_SITE) : item,
            )
          : this.sites.filter((item) => item.id !== id);
      await this.writeIndex(sites);
      this.sites = sites;
    });
  }
}
