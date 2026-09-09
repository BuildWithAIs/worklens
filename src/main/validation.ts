import { z } from "zod";
const id = z
  .string()
  .min(1)
  .max(180)
  .regex(/^[a-zA-Z0-9_-]+$/);
export const selection = z
  .object({
    provider: z.string().min(1).max(200),
    model: z.string().min(1).max(300),
    thinking: z.enum([
      "off",
      "minimal",
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
    ]),
  })
  .strict();
export const schemas = {
  refreshModels: z.object({ provider: z.string().min(1).max(200) }).strict(),
  bootstrap: z.undefined(),
  providers: z.undefined(),
  dismissRecovery: z.object({ runId: id }).strict(),
  settings: z
    .object({
      theme: z.enum(["light", "dark", "system"]).optional(),
      riskAccepted: z.boolean().optional(),
      defaults: selection.optional(),
      lastConversation: id.optional(),
    })
    .strict(),
  login: z
    .object({
      provider: z.string().min(1).max(200),
      type: z.enum(["api_key", "oauth"]),
      loginId: id,
    })
    .strict(),
  authReply: z
    .object({ loginId: id, promptId: id, value: z.string().max(20000) })
    .strict(),
  authCancel: z.object({ loginId: id }).strict(),
  logout: z.object({ provider: z.string().min(1).max(200) }).strict(),
  azure: z
    .object({
      baseUrl: z.string().max(2000),
      resource: z.string().max(200),
      apiVersion: z.string().max(100),
      deployments: z.string().max(20000),
    })
    .strict(),
  test: selection,
  open: z.object({ id }).strict(),
  rename: z.object({ id, title: z.string().trim().min(1).max(120) }).strict(),
  delete: z.object({ id }).strict(),
  send: z
    .object({
      conversationId: id.optional(),
      requestId: id,
      text: z
        .string()
        .min(1)
        .max(100000)
        .refine((value) => value.trim().length > 0, "消息不能为空"),
      selection,
    })
    .strict(),
  cancel: z.object({ conversationId: id, runId: id }).strict(),
  model: z.object({ id, selection }).strict(),
  external: z.object({ url: z.string().url().max(10000) }).strict(),
  showPath: z
    .object({ which: z.enum(["root", "runtime", "sessions", "userData"]) })
    .strict(),
};
export function externalUrl(value: string) {
  const url = new URL(value);
  if (
    !["https:", "http:"].includes(url.protocol) ||
    url.username ||
    url.password
  )
    throw new Error("只允许打开 HTTP 或 HTTPS 网页链接");
  return url.href;
}
