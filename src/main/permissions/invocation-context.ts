import { randomUUID } from "node:crypto";
import type { InvocationContext } from "./types";
import { PermissionError } from "./types";
interface Task {
  runId: string;
  epoch: string;
  controller: AbortController;
  contexts: Set<InvocationContext>;
}
/** Only main-process lifecycle code creates tasks and invocation objects. */
export class InvocationContexts {
  private tasks = new Map<string, Task>();
  private issued = new WeakSet<InvocationContext>();
  begin(conversationId: string, runId: string) {
    if (
      ![conversationId, runId].every(
        (v) => typeof v === "string" && v.length > 0 && v.length <= 180,
      )
    )
      throw new PermissionError("PERMISSION_DENIED");
    this.end(conversationId);
    this.tasks.set(conversationId, {
      runId,
      epoch: randomUUID(),
      controller: new AbortController(),
      contexts: new Set(),
    });
  }
  current(conversationId: string) {
    const t = this.tasks.get(conversationId);
    return t ? { runId: t.runId, epoch: t.epoch } : undefined;
  }
  create(
    conversationId: string,
    runId: string,
    toolCallId: string,
    origin: InvocationContext["origin"],
    parent?: InvocationContext,
  ): InvocationContext {
    if (
      !toolCallId ||
      toolCallId.length > 180 ||
      !["agent", "user-ui", "internal"].includes(origin)
    )
      throw new PermissionError("PERMISSION_DENIED");
    const task = this.tasks.get(conversationId);
    if (!task || task.runId !== runId || task.controller.signal.aborted)
      throw new PermissionError("PERMISSION_STALE");
    if (parent) {
      this.assert(parent);
      if (parent.conversationId !== conversationId || parent.runId !== runId)
        throw new PermissionError("PERMISSION_DENIED");
    }
    if (task.contexts.size >= 4096)
      throw new PermissionError("PERMISSION_DENIED");
    const context = Object.freeze({
      id: randomUUID(),
      executionId: randomUUID(),
      conversationId,
      runId,
      toolCallId,
      origin,
      ...(parent
        ? { parentInvocationId: parent.id, parentToolCallId: parent.toolCallId }
        : {}),
      epoch: task.epoch,
      signal: task.controller.signal,
    });
    this.issued.add(context);
    task.contexts.add(context);
    return context;
  }
  assert(context: InvocationContext) {
    const task = this.tasks.get(context.conversationId);
    if (
      !this.issued.has(context) ||
      !task ||
      task.runId !== context.runId ||
      task.epoch !== context.epoch ||
      context.signal.aborted
    )
      throw new PermissionError("PERMISSION_STALE");
  }
  invalidate(conversationId: string) {
    const task = this.tasks.get(conversationId);
    if (!task) return;
    task.epoch = randomUUID();
    const previous = task.controller;
    task.controller = new AbortController();
    task.contexts.clear();
    previous.abort();
  }
  end(conversationId: string, runId?: string) {
    const task = this.tasks.get(conversationId);
    if (!task || (runId && task.runId !== runId)) return;
    this.tasks.delete(conversationId);
    task.controller.abort();
  }
  close() {
    for (const id of this.tasks.keys()) this.end(id);
  }
}
