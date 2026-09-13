import { z } from "zod";
import type { ConfluenceConnection } from "../../shared/contracts";
import {
  readOperations,
  writeOperations,
  type ReadRequest,
  type WriteRequest,
} from "./schema";
import { ServiceError } from "./http";

const cloudOnly = new Set<string>([
  "list_tasks",
  "read_task",
  "list_likes",
  "copy_page",
  "archive_page",
  "add_inline_comment",
  "resolve_comment",
  "set_task_status",
]);
export function availableOperations(
  settings: ConfluenceConnection,
  write: boolean,
) {
  if (write && settings.access === "read") return [];
  return [...(write ? writeOperations : readOperations)].filter(
    (schema) =>
      settings.deployment === "cloud" ||
      !cloudOnly.has(schema.shape.operation.value),
  );
}

/** The model discovers one strict operation contract at a time, without carrying all contracts. */
export function discoverySchema(
  settings: ConfluenceConnection,
  write: boolean,
) {
  return {
    type: "object",
    properties: {
      request: {
        type: "object",
        properties: {
          operation: {
            type: "string",
            enum: availableOperations(settings, write).map(
              (s) => s.shape.operation.value,
            ),
          },
          ...(!write
            ? {
                name: {
                  type: "string",
                  description: "Operation name for describe_operation.",
                },
              }
            : {}),
        },
        required: ["operation"],
        additionalProperties: true,
        description:
          "Get the exact contract using confluence_read describe_operation first. Place its fields alongside operation; runtime rejects unknown or invalid fields.",
      },
    },
    required: ["request"],
    additionalProperties: false,
  };
}
export function describeOperation(
  settings: ConfluenceConnection,
  name: string,
) {
  const schemas = [
    ...availableOperations(settings, false),
    ...availableOperations(settings, true),
  ];
  const schema = schemas.find((s) => s.shape.operation.value === name);
  if (!schema)
    throw new ServiceError(
      "unavailable_operation",
      "该操作不可用；请读取 capabilities 查看当前权限与部署支持的操作。",
    );
  return {
    name,
    tool: writeOperations.some((s) => s.shape.operation.value === name)
      ? "confluence_write"
      : "confluence_read",
    inputSchema: z.toJSONSchema(z.object({ request: schema }).strict(), {
      target: "draft-7",
      io: "input",
    }),
  };
}
export function parseRequest(raw: unknown, write: false): ReadRequest;
export function parseRequest(raw: unknown, write: true): WriteRequest;
export function parseRequest(
  raw: unknown,
  write: boolean,
): ReadRequest | WriteRequest {
  const envelope = z
    .object({ request: z.object({ operation: z.string() }).passthrough() })
    .strict()
    .safeParse(raw);
  if (!envelope.success)
    throw new ServiceError(
      "invalid_request",
      "需要 {request:{operation,...}}；先调用 describe_operation 获取参数。 ",
    );
  const schema = [...(write ? writeOperations : readOperations)].find(
    (s) => s.shape.operation.value === envelope.data.request.operation,
  );
  if (!schema)
    throw new ServiceError(
      "invalid_request",
      "未知操作；请调用 capabilities 查看可用操作。",
    );
  const parsed = schema.safeParse(envelope.data.request);
  if (!parsed.success)
    throw new ServiceError(
      "invalid_request",
      parsed.error.issues
        .slice(0, 6)
        .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
        .join("; ")
        .slice(0, 1200) +
        "; use describe_operation for this operation's contract.",
    );
  return parsed.data;
}
export function assertAvailable(
  settings: ConfluenceConnection,
  operation: string,
  write: boolean,
) {
  if (
    !availableOperations(settings, write).some(
      (s) => s.shape.operation.value === operation,
    )
  )
    throw new ServiceError(
      settings.access === "read" && write ? "permission" : "not_implemented",
      "当前连接权限或部署不支持此操作。请调用 capabilities。",
    );
}
