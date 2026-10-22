import { randomUUID } from "node:crypto";
import { z } from "zod";
import { PermissionError } from "./types";

export interface ExecutionBoundary {
  readonly id: string;
  readonly target: "vm" | "host-srt";
  readonly workspaceId: string;
  readonly conversationId: string;
  readonly runId: string;
  readonly revision: string;
}
const boundaries = new WeakSet<object>();
/** Main-only P3 attestation handoff. Never accept this data from tools, guest or IPC. */
export function attestExecutionBoundary(input: {
  target: "vm" | "host-srt";
  workspaceId: string;
  conversationId: string;
  runId: string;
  revision: string;
  files: boolean;
  network: boolean;
  termination: boolean;
}): ExecutionBoundary {
  const value = z
    .object({
      conversationId: z.string().min(1).max(180),
      runId: z.string().min(1).max(180),
      target: z.enum(["vm", "host-srt"]),
      workspaceId: z.string().min(1).max(4096),
      revision: z.string().min(1).max(180),
      files: z.literal(true),
      network: z.literal(true),
      termination: z.literal(true),
    })
    .strict()
    .safeParse(input);
  if (!value.success) throw new PermissionError("CAPABILITY_UNSUPPORTED");
  const token = Object.freeze({
    id: randomUUID(),
    conversationId: value.data.conversationId,
    runId: value.data.runId,
    target: value.data.target,
    workspaceId: value.data.workspaceId,
    revision: value.data.revision,
  });
  boundaries.add(token);
  return token;
}
export function assertExecutionBoundary(value: ExecutionBoundary): void {
  if (!boundaries.has(value))
    throw new PermissionError("CAPABILITY_UNSUPPORTED");
}
/** A boot/generation change retires every old attestation at its source. */
export function retireExecutionBoundary(value: ExecutionBoundary): void {
  boundaries.delete(value);
}

const completions = new WeakSet<object>();
export interface ConfirmedResult<T> {
  readonly status: "completed";
  readonly value: T;
}
/** Called by the trusted adapter only AFTER all its commits/publications finish. */
export function confirmedResult<T>(value: T): ConfirmedResult<T> {
  const result = Object.freeze({ status: "completed" as const, value });
  completions.add(result);
  return result;
}
export function isConfirmedResult(
  value: unknown,
): value is ConfirmedResult<unknown> {
  return typeof value === "object" && value !== null && completions.has(value);
}
