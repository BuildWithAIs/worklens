import { z } from "zod";
const id = z
  .string()
  .min(1)
  .max(180)
  .regex(/^[a-zA-Z0-9_-]+$/);
export const permissionSchemas = {
  permissionsGet: z.object({ conversationId: id }).strict(),
  permissionReply: z
    .object({
      conversationId: id,
      requestId: z.uuid(),
      decision: z.enum(["allow", "deny"]),
      scope: z.enum(["once", "task"]),
    })
    .strict()
    .refine((v) => v.decision === "allow" || v.scope === "once"),
  permissionRevoke: z
    .object({ conversationId: id, grantId: z.uuid() })
    .strict(),
  permissionRulesUpdate: z
    .object({
      conversationId: id,
      expectedRevision: z.string().min(1).max(200),
      updates: z
        .array(z.object({ ruleId: z.uuid(), enabled: z.boolean() }).strict())
        .min(1)
        .max(512),
    })
    .strict()
    .refine(
      (v) => new Set(v.updates.map((r) => r.ruleId)).size === v.updates.length,
    ),
  permissionSelectFiles: z
    .object({ conversationId: id, intent: z.enum(["read", "write"]) })
    .strict(),
};
