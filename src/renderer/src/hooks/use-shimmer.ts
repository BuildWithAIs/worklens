import { useCallback } from "react";

// Measure the visible track (including CSS truncation), so long tool labels
// move at the same pixels/second as short Thinking labels.
export function useShimmer() {
  return useCallback((node: HTMLSpanElement | null) => {
    if (!node) return;
    node.style.setProperty("--shimmer-speed", "120");
    node.style.setProperty("--shimmer-repeat-delay", "400");
    const measure = () => {
      node.style.setProperty("--shimmer-track-width", `${node.clientWidth}px`);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, []);
}
