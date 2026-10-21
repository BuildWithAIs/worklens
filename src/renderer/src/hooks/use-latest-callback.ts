import { useCallback, useLayoutEffect, useRef } from "react";

// Keep presentation callbacks stable without retaining a previous render's state.
export function useLatestCallback<Args extends unknown[], Result>(
  callback: (...args: Args) => Result,
): (...args: Args) => Result {
  const latest = useRef(callback);
  useLayoutEffect(() => {
    latest.current = callback;
  });
  return useCallback((...args: Args) => latest.current(...args), []);
}
