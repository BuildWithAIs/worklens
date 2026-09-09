import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import {
  getSupportedThinkingLevels,
  type AuthPrompt,
  type AuthEvent,
} from "@earendil-works/pi-ai";
import { randomUUID } from "node:crypto";
import type { AuthStep, ProviderInfo, Selection } from "../shared/contracts";
import type { SecureCredentials } from "./storage";

export class ProviderService {
  private connections = new Map<
    string,
    { ok: boolean; message: string; checkedAt: string }
  >();
  private logins = new Map<
    string,
    {
      controller: AbortController;
      pending: Map<
        string,
        { resolve: (value: string) => void; reject: (reason: Error) => void }
      >;
    }
  >();
  constructor(
    readonly runtime: ModelRuntime,
    private credentials: SecureCredentials,
    private emit: (step: AuthStep) => void,
  ) {}
  async list(): Promise<ProviderInfo[]> {
    const available = await this.runtime.getAvailable(undefined, {
      signal: AbortSignal.timeout(15000),
    });
    const keys = new Set(available.map((m) => `${m.provider}/${m.id}`));
    return Promise.all(
      this.runtime
        .getProviders()
        .filter((provider) => this.runtime.getModels(provider.id).length > 0)
        .map(async (provider) => {
          const credential = await this.credentials.read(provider.id);
          return {
            id: provider.id,
            name: provider.name,
            configured: this.runtime.hasConfiguredAuth(provider.id),
            credentialType: credential?.type,
            credentialHint:
              credential?.type === "api_key" && credential.key
                ? `••••${credential.key.slice(-4)}`
                : undefined,
            credentialError: this.credentials.diagnosticFor(provider.id),
            connection: this.connections.get(provider.id),
            methods: [
              ...(provider.auth.apiKey
                ? [
                    {
                      type: "api_key" as const,
                      name: provider.auth.apiKey.name,
                      interactive: !!provider.auth.apiKey.login,
                    },
                  ]
                : []),
              ...(provider.auth.oauth
                ? [
                    {
                      type: "oauth" as const,
                      name:
                        provider.auth.oauth.loginLabel ??
                        provider.auth.oauth.name,
                      interactive: true,
                    },
                  ]
                : []),
            ],
            models: this.runtime.getModels(provider.id).map((model) => ({
              id: model.id,
              name: model.name,
              provider: model.provider,
              reasoning: !!model.reasoning,
              image: model.input.includes("image"),
              contextWindow: model.contextWindow,
              levels: getSupportedThinkingLevels(model),
              available: keys.has(`${model.provider}/${model.id}`),
            })),
          };
        }),
    );
  }
  async refreshModels(provider: string) {
    if (!this.runtime.getProvider(provider)) throw new Error("未知供应商");
    const result = await this.runtime.refresh({
      providers: [provider],
      allowNetwork: true,
      signal: AbortSignal.timeout(15000),
    });
    if (result.errors.size || result.aborted)
      throw new Error("模型目录刷新未完成，已保留缓存目录，请稍后重试");
    return "模型目录已刷新并缓存";
  }
  async login(provider: string, type: "api_key" | "oauth", loginId: string) {
    if (this.logins.has(loginId)) throw new Error("认证已在进行");
    if (!this.runtime.getProvider(provider)) throw new Error("未知供应商");
    const login = {
      controller: new AbortController(),
      pending: new Map<
        string,
        { resolve: (value: string) => void; reject: (reason: Error) => void }
      >(),
    };
    this.logins.set(loginId, login);
    const timeout = setTimeout(() => login.controller.abort(), 10 * 60 * 1000);
    try {
      await this.runtime.login(provider, type, {
        signal: login.controller.signal,
        prompt: (prompt: AuthPrompt) =>
          new Promise<string>((resolve, reject) => {
            const promptId = randomUUID();
            const signal = prompt.signal
              ? AbortSignal.any([prompt.signal, login.controller.signal])
              : login.controller.signal;
            const abort = () => {
              login.pending.delete(promptId);
              this.emit({ loginId, promptId, type: "prompt_cancelled" });
              reject(new Error("认证已取消"));
            };
            if (signal.aborted) {
              abort();
              return;
            }
            signal.addEventListener("abort", abort, { once: true });
            login.pending.set(promptId, {
              resolve: (value) => {
                signal.removeEventListener("abort", abort);
                resolve(value);
              },
              reject,
            });
            this.emit({
              loginId,
              promptId,
              type: prompt.type,
              message: prompt.message,
              ...("options" in prompt
                ? { options: [...prompt.options] }
                : { placeholder: prompt.placeholder }),
            });
          }),
        notify: (event: AuthEvent) => {
          if (event.type === "auth_url")
            this.emit({
              loginId,
              type: event.type,
              url: event.url,
              message: event.instructions,
            });
          else if (event.type === "device_code")
            this.emit({
              loginId,
              type: event.type,
              url: event.verificationUri,
              userCode: event.userCode,
              message: "在浏览器中输入设备码完成登录",
            });
          else
            this.emit({
              loginId,
              type: event.type,
              message: this.credentials.redact(event.message),
              url: event.type === "info" ? event.links?.[0]?.url : undefined,
            });
        },
      });
      this.connections.delete(provider);
      this.emit({
        loginId,
        type: "complete",
        message: "认证已完成，凭据已加密保存",
      });
    } finally {
      clearTimeout(timeout);
      for (const waiter of login.pending.values())
        waiter.reject(new Error("认证已结束"));
      this.logins.delete(loginId);
    }
  }
  reply(loginId: string, promptId: string, value: string) {
    const login = this.logins.get(loginId);
    const pending = login?.pending.get(promptId);
    if (!pending) throw new Error("认证步骤已过期");
    login!.pending.delete(promptId);
    pending.resolve(value);
  }
  cancel(loginId: string) {
    this.logins.get(loginId)?.controller.abort();
  }
  clearConnection(provider: string) {
    this.connections.delete(provider);
  }
  shutdown() {
    for (const login of this.logins.values()) login.controller.abort();
  }
  async azure(input: {
    baseUrl: string;
    resource: string;
    apiVersion: string;
    deployments: string;
  }) {
    if (input.baseUrl) {
      const url = new URL(input.baseUrl);
      if (url.protocol !== "https:")
        throw new Error("Azure 地址必须使用 HTTPS");
    }
    const env = {
      AZURE_OPENAI_BASE_URL: input.baseUrl,
      AZURE_OPENAI_RESOURCE_NAME: input.resource,
      AZURE_OPENAI_API_VERSION: input.apiVersion,
      AZURE_OPENAI_DEPLOYMENT_NAME_MAP: input.deployments,
    };
    await this.credentials.modify("azure-openai-responses", async (current) => {
      if (current?.type === "oauth")
        throw new Error("Azure 配置需要接口密钥认证");
      return { ...current, type: "api_key", env: { ...current?.env, ...env } };
    });
    await this.runtime.refresh({ allowNetwork: false });
  }
  async test(selection: Selection) {
    const model = this.runtime.getModel(selection.provider, selection.model);
    if (!model) throw new Error("模型不存在");
    try {
      const result = await this.runtime.completeSimple(
        model,
        {
          messages: [
            {
              role: "user",
              content: "Reply with OK only.",
              timestamp: Date.now(),
            },
          ],
        },
        { maxTokens: 32, signal: AbortSignal.timeout(20000) },
      );
      if (result.stopReason === "error" || result.stopReason === "aborted")
        throw new Error(result.errorMessage || result.stopReason);
      const message = `连接成功：${selection.provider} / ${selection.model}`;
      this.connections.set(selection.provider, {
        ok: true,
        message,
        checkedAt: new Date().toISOString(),
      });
      return message;
    } catch (error) {
      const text = this.credentials.redact(String(error));
      const category = /401|403|auth|credential|key/i.test(text)
        ? "认证失败，请重新配置凭据"
        : /429|rate.?limit/i.test(text)
          ? "供应商限流，请稍后重试"
          : /timeout|abort/i.test(text)
            ? "连接超时，请检查网络或服务地址"
            : /404|model|deployment/i.test(text)
              ? "模型或部署不可用，请检查模型和部署映射"
              : /endpoint|url/i.test(text)
                ? "服务端点配置错误"
                : "网络或服务请求失败";
      const message = `${category}。${text.slice(0, 400)}`;
      this.connections.set(selection.provider, {
        ok: false,
        message,
        checkedAt: new Date().toISOString(),
      });
      throw new Error(message);
    }
  }
}
