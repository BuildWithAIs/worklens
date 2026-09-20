/** Count newly discovered IDs, independently of order, visibility or enabled state. */
export function countNewItems(
  before: readonly { id: string }[] | undefined,
  after: readonly { id: string }[],
): number {
  if (!before) return 0;
  const known = new Set(before.map((item) => item.id));
  return new Set(after.map((item) => item.id).filter((id) => !known.has(id)))
    .size;
}
