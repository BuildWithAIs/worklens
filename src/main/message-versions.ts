import type { SessionManager } from "@earendil-works/pi-coding-agent";

// Versions are links between immutable user entries, kept in the Pi journal.
// Non-message markers never enter the model's conversation context.
export function messageVersions(manager: SessionManager) {
  const roots = new Map<string, string>();
  const groups = new Map<string, string[]>();
  const runEdits = new Map<string, string>();
  const runForEntry = new Map<string, string | undefined>();
  for (const entry of manager.getEntries()) {
    let run = entry.parentId ? runForEntry.get(entry.parentId) : undefined;
    if (entry.type === "custom" && entry.customType === "worklens.run-start") {
      run = entry.id;
      const data = entry.data as { editOf?: unknown } | undefined;
      if (typeof data?.editOf === "string") runEdits.set(run, data.editOf);
    }
    runForEntry.set(entry.id, run);
    if (entry.type !== "message" || entry.message.role !== "user") continue;
    const original = run ? runEdits.get(run) : undefined;
    const root = (original && roots.get(original)) || entry.id;
    roots.set(entry.id, root);
    const group = groups.get(root) ?? [];
    group.push(entry.id);
    groups.set(root, group);
    // A run can contain injected user messages. Only its initial prompt is edited.
    if (run) runEdits.delete(run);
  }
  return { roots, groups };
}

export function versionLeaf(manager: SessionManager, messageId: string) {
  const descendants = new Set([messageId]);
  let leaf = messageId;
  for (const entry of manager.getEntries()) {
    if (entry.parentId && descendants.has(entry.parentId)) {
      descendants.add(entry.id);
      leaf = entry.id;
    }
  }
  return leaf;
}

export function editParent(manager: SessionManager, messageId: string) {
  const path = manager.getBranch(messageId);
  const message = path.pop()!;
  // Exclude the old run's attribution marker as well as its prompt and replies.
  for (const entry of path.reverse()) {
    if (entry.type === "message") break;
    if (entry.type === "custom" && entry.customType === "worklens.run-start")
      return entry.parentId;
  }
  return message.parentId;
}
