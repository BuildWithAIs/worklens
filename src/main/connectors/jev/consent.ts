import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { z } from "zod";
import { atomicJson, SerialQueue } from "../../storage";
import type { JevApproval, JevSessionConsent } from "../../../shared/contracts";

const savedSession = z
  .object({
    blocked: z.boolean(),
    autoAllowFor: z.uuid().optional(),
    grants: z.array(z.string().regex(/^[a-f0-9]{64}$/)).max(256),
  })
  .strict();
type SavedSession = z.infer<typeof savedSession>;
type Pending = {
  approval: JevApproval;
  fingerprint: string;
  connectionRevision: string;
  signal: AbortSignal;
  finish: (allowed: boolean) => void;
};

/** The renderer may answer a pending request; tool arguments cannot grant consent. */
export class JevConsent {
  private sessions = new Map<string, SavedSession>();
  private pending = new Map<string, Pending>();
  private controllers = new Map<string, AbortController>();
  private queue = new SerialQueue();
  constructor(
    private readonly path: string,
    private readonly changed: (sessionId: string) => void = () => {},
    private readonly currentRevision: () => string | undefined = () => undefined,
  ) {}
  async load() {
    try {
      const data = z
        .object({
          version: z.literal(1),
          sessions: z.record(z.string(), savedSession),
        })
        .strict()
        .parse(JSON.parse(await readFile(this.path, "utf8")));
      this.sessions = new Map(Object.entries(data.sessions));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT")
        throw new Error(
          "Jev consent records could not be read; Jev was not started.",
        );
    }
  }
  view(sessionId: string): JevSessionConsent {
    const session = this.sessions.get(sessionId);
    return {
      blocked: session?.blocked ?? false,
      autoAllowed: !!session?.autoAllowFor && session.autoAllowFor === this.currentRevision(),
      approvedBatches: session?.grants.length ?? 0,
      pending: [...this.pending.values()]
        .filter(({ approval }) => approval.conversationId === sessionId)
        .map(({ approval }) => ({ ...approval })),
    };
  }
  signal(sessionId: string) {
    let controller = this.controllers.get(sessionId);
    if (!controller) {
      controller = new AbortController();
      this.controllers.set(sessionId, controller);
    }
    return controller.signal;
  }
  private async persist(next: Map<string, SavedSession>) {
    // Only fingerprints and the user's deny preference are persisted, never input text.
    await atomicJson(this.path, {
      version: 1,
      sessions: Object.fromEntries(next),
    });
    this.sessions = next;
  }
  async authorize(
    input: Omit<JevApproval, "id">,
    connectionRevision: string,
    signal: AbortSignal,
  ): Promise<boolean> {
    signal.throwIfAborted();
    const session = this.sessions.get(input.conversationId);
    if (session?.blocked) return false;
    const fingerprint = createHash("sha256")
      .update(
        JSON.stringify([
          connectionRevision,
          input.endpoint,
          input.purpose,
          input.payload,
        ]),
      )
      .digest("hex");
    if (session?.autoAllowFor === connectionRevision || session?.grants.includes(fingerprint)) return true;
    const approval = { ...input, id: randomUUID() };
    return new Promise<boolean>((resolve) => {
      const abort = () => finish(false);
      const finish = (allowed: boolean) => {
        if (!this.pending.delete(approval.id)) return;
        signal.removeEventListener("abort", abort);
        this.changed(input.conversationId);
        resolve(allowed);
      };
      this.pending.set(approval.id, { approval, fingerprint, connectionRevision, signal, finish });
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) abort();
      else this.changed(input.conversationId);
    });
  }
  reply(sessionId: string, requestId: string, allow: boolean, autoAllow = false) {
    return this.queue.run("consent", async () => {
      if (autoAllow && !allow) throw new Error("Automatic approval requires Allow.");
      const pending = this.pending.get(requestId);
      if (
        !pending ||
        pending.approval.conversationId !== sessionId ||
        pending.signal.aborted
      )
        throw new Error(
          "Jev approval is no longer pending. No new request was authorized.",
        );
      const previous = this.sessions.get(sessionId) ?? {
        blocked: false,
        grants: [],
      };
      if (previous.blocked)
        throw new Error("Jev is not allowed in this conversation.");
      const next = new Map(this.sessions);
      next.set(
        sessionId,
        allow
          ? {
              blocked: false,
              ...(autoAllow ? { autoAllowFor: pending.connectionRevision } : {}),
              grants: [
                ...new Set([...previous.grants, pending.fingerprint]),
              ].slice(-256),
            }
          : { blocked: true, grants: [] },
      );
      await this.persist(next);
      if (!allow) this.abortSession(sessionId);
      else pending.finish(true);
      this.changed(sessionId);
    });
  }
  private abortSession(sessionId: string) {
    this.controllers.get(sessionId)?.abort();
    this.controllers.delete(sessionId);
    for (const pending of [...this.pending.values()])
      if (pending.approval.conversationId === sessionId) pending.finish(false);
  }
  reset(sessionId: string, blocked: boolean) {
    return this.queue.run("consent", async () => {
      const next = new Map(this.sessions);
      next.set(sessionId, { blocked, grants: [] });
      await this.persist(next);
      this.abortSession(sessionId);
      this.changed(sessionId);
    });
  }
  forget(sessionId: string) {
    return this.queue.run("consent", async () => {
      const next = new Map(this.sessions);
      next.delete(sessionId);
      await this.persist(next);
      this.abortSession(sessionId);
    });
  }
}
