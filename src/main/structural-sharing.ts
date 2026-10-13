function sameValue(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (!a || !b || typeof a !== "object" || typeof b !== "object") return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const keys = Object.keys(a);
  if (keys.length !== Object.keys(b).length) return false;
  return keys.every(
    (key) =>
      Object.hasOwn(b, key) &&
      sameValue(
        (a as Record<string, unknown>)[key],
        (b as Record<string, unknown>)[key],
      ),
  );
}

// Keep unchanged items from the previous list so consumers can detect changes
// by reference. Items are compared by position.
export function shareUnchanged<T>(previous: readonly T[], next: T[]): T[] {
  return next.map((item, index) =>
    index < previous.length && sameValue(previous[index], item)
      ? previous[index]
      : item,
  );
}

// Index of the first item that is not the same reference in both lists.
export function firstChange<T>(previous: readonly T[], next: readonly T[]) {
  const length = Math.min(previous.length, next.length);
  let index = 0;
  while (index < length && previous[index] === next[index]) index++;
  return index;
}
