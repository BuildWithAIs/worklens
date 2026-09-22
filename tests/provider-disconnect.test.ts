import { afterEach, expect, test, vi } from "vitest";
import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { OAuthCredential } from "@earendil-works/pi-ai";
import { ProviderService } from "../src/main/providers";
import { SecureCredentials } from "../src/main/storage";
import type { AuthStep } from "../src/shared/contracts";

const services: ProviderService[] = [];
afterEach(() => {
  for (const service of services.splice(0)) service.shutdown();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

async function setup() {
  for (const name of Object.keys(process.env)) {
    if (/(?:API_KEY|ACCESS_TOKEN|AUTH_TOKEN|GITHUB_TOKEN|GH_TOKEN)$/.test(name))
      vi.stubEnv(name, undefined);
  }
  const credentials = new SecureCredentials(
    await mkdtemp(join(tmpdir(), "worklens-disconnect-")),
    {
      isEncryptionAvailable: () => true,
      encryptString: (value) => Buffer.from(value),
      decryptString: (value) => value.toString(),
    },
  );
  const runtime = await ModelRuntime.create({
    credentials,
    modelsPath: null,
    refreshOnCreate: false,
  });
  const events: AuthStep[] = [];
  const service = new ProviderService(runtime, credentials, (step) =>
    events.push(step),
  );
  services.push(service);
  const seed = async (provider: string) => {
    await credentials.modify(provider, async () => ({
      type: "api_key",
      key: "isolated-placeholder",
    }));
    await runtime.refresh({ providers: [provider], allowNetwork: false });
  };
  const prompt = async (loginId: string) => {
    await vi.waitFor(() =>
      expect(
        events.some((event) => event.loginId === loginId && event.promptId),
      ).toBe(true),
    );
    return events.find((event) => event.loginId === loginId && event.promptId)!;
  };
  return { credentials, runtime, service, seed, prompt, events };
}

for (const provider of [
  "openrouter",
  "deepseek",
  "openai",
  "anthropic",
  "azure-openai-responses",
]) {
  test(`${provider}: disconnect cancels an unanswered API-key login and deletes its credential`, async () => {
    const { credentials, runtime, service, seed, prompt } = await setup();
    await seed(provider);
    const pending = service.login(provider, "api_key", "pending").then(
      () => "completed",
      () => "cancelled",
    );
    await prompt("pending");
    await service.logout(provider);
    expect(await pending).toBe("cancelled");
    expect(await credentials.read(provider)).toBeUndefined();
    expect(runtime.hasConfiguredAuth(provider)).toBe(false);
  }, 5000);
}

test("disconnect cancels every queued login for that provider, leaving other providers' logins intact", async () => {
  const { credentials, service, seed, prompt } = await setup();
  await seed("openrouter");
  await seed("deepseek");
  const first = service
    .login("openrouter", "api_key", "first")
    .catch(() => "cancelled");
  await prompt("first");
  const queued = service
    .login("openrouter", "api_key", "queued")
    .catch(() => "cancelled");
  const other = service.login("deepseek", "api_key", "other");
  const otherPrompt = await prompt("other");
  await service.logout("openrouter");
  expect(await Promise.all([first, queued])).toEqual([
    "cancelled",
    "cancelled",
  ]);
  expect(await credentials.read("deepseek")).toBeDefined();
  service.reply("other", otherPrompt.promptId!, "new-isolated-placeholder");
  await other;
  expect(await credentials.read("deepseek")).toMatchObject({
    key: "new-isolated-placeholder",
  });
}, 5000);

test("OAuth waiting for the browser is cancelled and a late response cannot restore its credential", async () => {
  const { runtime, credentials, service, events } = await setup();
  const provider = runtime.getProvider("openrouter")!;
  let complete!: (credential: OAuthCredential) => void;
  const credential: OAuthCredential = {
    type: "oauth",
    access: "test-access",
    refresh: "test-refresh",
    expires: Date.now() + 3600000,
  };
  runtime.registerNativeProvider({
    ...provider,
    auth: {
      oauth: {
        name: "Isolated OAuth",
        login: async (interaction) => {
          interaction.notify({
            type: "auth_url",
            url: "https://example.test/login",
          });
          return new Promise<OAuthCredential>((resolve) => {
            complete = resolve;
          });
        },
        refresh: async (current) => current,
        toAuth: async (current) => ({ apiKey: current.access }),
      },
    },
  });
  await credentials.modify("openrouter", async () => credential);
  await runtime.refresh({ providers: ["openrouter"], allowNetwork: false });
  const pending = service
    .login("openrouter", "oauth", "browser")
    .catch(() => "cancelled");
  await vi.waitFor(() =>
    expect(events.some((event) => event.type === "auth_url")).toBe(true),
  );
  await service.logout("openrouter");
  expect(await pending).toBe("cancelled");
  complete(credential);
  await new Promise((resolve) => setImmediate(resolve));
  expect(await credentials.read("openrouter")).toBeUndefined();
  expect(runtime.hasConfiguredAuth("openrouter")).toBe(false);
}, 5000);

test("a failed credential deletion remains visible to the caller and can be retried", async () => {
  const { credentials, runtime, service, seed, prompt } = await setup();
  await seed("openrouter");
  const pending = service
    .login("openrouter", "api_key", "pending")
    .catch(() => "cancelled");
  await prompt("pending");
  vi.spyOn(credentials, "delete").mockRejectedValueOnce(
    new Error("Local deletion failure"),
  );
  await expect(service.logout("openrouter")).rejects.toThrow();
  expect(await pending).toBe("cancelled");
  expect(await credentials.read("openrouter")).toBeDefined();
  expect(runtime.hasConfiguredAuth("openrouter")).toBe(true);
  await service.logout("openrouter");
  expect(await credentials.read("openrouter")).toBeUndefined();
}, 5000);
