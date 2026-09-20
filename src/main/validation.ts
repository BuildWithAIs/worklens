import { z } from "zod";
import { connectorSchemas } from "./connectors/ipc";
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
  htmlFileAction: z
    .object({
      id,
      path: z.string().min(1).max(4096).optional(),
      code: z
        .string()
        .min(1)
        .max(2 * 1024 * 1024)
        .optional(),
      action: z.enum(["chrome", "reveal"]),
    })
    .strict()
    .refine(
      (value) => (value.path !== undefined) !== (value.code !== undefined),
    ),

  previewHtml: z.object({ id, path: z.string().min(1).max(4096) }).strict(),
  ...connectorSchemas,
  artifact: z
    .object({
      id: z.string().uuid(),
      action: z.enum(["open", "show", "saveAs"]),
    })
    .strict(),
  refreshModels: z.object({ provider: z.string().min(1).max(200) }).strict(),
  bootstrap: z.undefined(),
  providers: z.undefined(),
  dismissRecovery: z.object({ runId: id }).strict(),
  settings: z
    .object({
      theme: z.enum(["light", "dark", "system"]).optional(),
      backgroundEffect: z
        .enum(["none", "surface", "fluid", "aurora"])
        .optional(),
      backgroundIntensity: z
        .object({
          surface: z.number().int().min(0).max(100).optional(),
          fluid: z.number().int().min(0).max(100).optional(),
          aurora: z.number().int().min(0).max(100).optional(),
        })
        .strict()
        .optional(),
      backgroundTone: z
        .enum(["violet", "electric", "ice", "sunset"])
        .optional(),
      riskAccepted: z.boolean().optional(),
      defaults: selection.optional(),
      hiddenModels: z.array(z.string().min(1).max(400)).max(2000).optional(),
      lastConversation: id.optional(),
      pinnedConversationIds: z.array(id).max(2000).optional(),
      disabledSkills: z.array(z.string().min(1).max(200)).max(2000).optional(),
      disabledSkillIds: z
        .array(z.string().regex(/^[a-f0-9]{64}$/))
        .max(2000)
        .optional(),
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
  clearConnection: z.object({ provider: z.string().min(1).max(200) }).strict(),
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
    .object({
      which: z.enum(["root", "runtime", "sessions", "userData", "skills"]),
    })
    .strict(),
  skillsList: z.undefined(),
  skillsRefresh: z.undefined(),
  skillsToggle: z
    .object({ id: z.string().regex(/^[a-f0-9]{64}$/), enabled: z.boolean() })
    .strict(),
  skillsReveal: z.object({ id: z.string().regex(/^[a-f0-9]{64}$/) }).strict(),
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
