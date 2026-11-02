import { useLayoutEffect, useRef } from "react";

// Reuse equal arrays; abandoned renders must not replace the committed cache.
export function useStableArray<T extends readonly unknown[]>(
  next: T,
  isEqual: (previous: T[number], next: T[number]) => boolean = Object.is,
): T {
  const committed = useRef(next);
  const previous = committed.current;
  const stable =
    previous.length === next.length &&
    next.every((item, index) => isEqual(previous[index], item))
      ? previous
      : next;

  useLayoutEffect(() => {
    committed.current = stable;
  }, [stable]);

  return stable;
}
