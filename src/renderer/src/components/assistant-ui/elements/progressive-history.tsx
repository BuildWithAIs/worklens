import { ThreadPrimitive, useAuiState } from "@assistant-ui/react";
import {
  startTransition,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ComponentProps,
  type RefObject,
} from "react";

export function useProgressiveHistory(
  messageCount: number,
  viewport: RefObject<HTMLDivElement | null>,
) {
  const [start, setStart] = useState<number>();
  const [ready, setReady] = useState(messageCount === 0);
  const batch = useRef({ size: 8, from: 0, startedAt: 0 });
  const initialStart = Math.max(0, messageCount - 2);
  const first = Math.min(start ?? initialStart, initialStart);
  useEffect(() => {
    if (start === undefined && messageCount) setStart(first);
  }, [start, messageCount, first]);
  useLayoutEffect(() => {
    if (batch.current.startedAt && first < batch.current.from) {
      // Measure through the commit, including interrupted render work. Cheap
      // messages can fill larger batches; expensive turns keep yielding.
      const elapsed = Math.max(1, performance.now() - batch.current.startedAt);
      const rendered = batch.current.from - first;
      batch.current.size = Math.max(
        2,
        Math.min(128, Math.floor((rendered * 8) / elapsed)),
      );
      batch.current.startedAt = 0;
    }
  }, [first]);
  useEffect(() => {
    if (!first) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const frame = requestAnimationFrame(() => {
      timer = setTimeout(() => {
        batch.current.from = first;
        batch.current.startedAt = performance.now();
        startTransition(() =>
          setStart(Math.max(0, first - batch.current.size)),
        );
      }, 0);
    });
    return () => {
      cancelAnimationFrame(frame);
      clearTimeout(timer);
    };
  }, [first]);
  useEffect(() => {
    if (first || ready) return;
    let frame = requestAnimationFrame(() => {
      const element = viewport.current;
      element?.scrollTo({ top: element.scrollHeight, behavior: "instant" });
      frame = requestAnimationFrame(() => setReady(true));
    });
    return () => cancelAnimationFrame(frame);
  }, [first, ready, viewport]);
  return { first, ready };
}

export function ProgressiveThreadMessages({
  first,
  components,
}: {
  first: number;
  components: ComponentProps<
    typeof ThreadPrimitive.MessageByIndex
  >["components"];
}) {
  const messages = useAuiState((s) => s.thread.messages);
  return (
    <div
      className="contents"
      data-slot="progressive-history"
      aria-busy={first > 0}
    >
      {messages.slice(first).map((_message, offset) => (
        <ThreadPrimitive.MessageByIndex
          key={first + offset}
          index={first + offset}
          components={components}
        />
      ))}
    </div>
  );
}
