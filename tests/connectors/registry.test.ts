import { copyFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test, vi } from "vitest";
import { ConnectorRegistry } from "../../src/main/connectors/registry";
import type { Connector } from "../../src/main/connectors/types";
import { createConnectors } from "../../src/main/connectors";
import { resources } from "../../src/main/resources";
import { setup } from "./confluence/setup";

test("registry aggregates connectors and exposes instructions only for enabled tools", async () => {
  let enabled = false;
  const connector = (id: string): Connector => ({
    id,
    instructions: `${id} instructions`,
    initialize: vi.fn(async () => {}),
    configurationKey: () => `${id}:${enabled}`,
    names: () => (enabled ? [`${id}_read`] : []),
    tools: vi.fn(() => []),
    redact: (text) => text.replace(`${id}-secret`, "[redacted]"),
  });
  const first = connector("first");
  const second = connector("second");
  const registry = new ConnectorRegistry([first, second]);
  await registry.initialize();
  expect(first.initialize).toHaveBeenCalledOnce();
  expect(second.initialize).toHaveBeenCalledOnce();
  const key = registry.configurationKey();
  expect(registry.names()).toEqual([]);
  expect(registry.instructions()).toBe("");
  enabled = true;
  expect(registry.configurationKey()).not.toBe(key);
  expect(registry.names()).toEqual(["first_read", "second_read"]);
  expect(registry.instructions()).toBe(
    "first instructions\nsecond instructions",
  );
  const runId = () => "run1";
  registry.tools("session1", runId);
  expect(first.tools).toHaveBeenCalledWith("session1", runId);
  expect(second.tools).toHaveBeenCalledWith("session1", runId);
  expect(registry.redact("first-secret second-secret")).toBe(
    "[redacted] [redacted]",
  );
  expect(() => new ConnectorRegistry([first, first])).toThrow("Duplicate");
});

test("composition reuses existing credentials and tools while configuration revisions refresh context", async () => {
  const f = await setup();
  const path = join(f.root, "confluence.json");
  await copyFile(join(f.root, "connection.json"), path);
  const original = await readFile(path, "utf8");
  const connectors = createConnectors(f.root, f.encryption, f.artifacts);
  expect(connectors.registry.names()).toEqual([]);
  await connectors.registry.initialize();
  expect(await readFile(path, "utf8")).toBe(original);
  expect(connectors.bootstrap().confluence.configured).toBe(true);
  expect(connectors.registry.names()).toEqual([
    "confluence_read",
    "confluence_write",
  ]);
  const key = connectors.registry.configurationKey();
  await connectors.requests("confluenceSave", {
    ...f.input,
    token: "replacement-secret",
  });
  expect(connectors.registry.configurationKey()).not.toBe(key);
  expect(connectors.registry.configurationKey()).not.toContain(
    "replacement-secret",
  );
  const local = await resources(f.root, join(f.root, "pi"), {
    tools: connectors.registry.names(),
    instructions: connectors.registry.instructions(),
  });
  expect(local.resourceLoader.getSystemPrompt()).toContain("storage 格式");
  await connectors.requests("confluenceRemove", undefined);
  expect(connectors.registry.names()).toEqual([]);
  expect(connectors.registry.instructions()).toBe("");
  const disconnected = await resources(f.root, join(f.root, "pi"));
  expect(disconnected.resourceLoader.getSystemPrompt()).not.toContain(
    "Confluence",
  );
});
