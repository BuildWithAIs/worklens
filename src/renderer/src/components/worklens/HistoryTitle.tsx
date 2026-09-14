import { useLayoutEffect, useRef, useState, type CSSProperties } from "react";

export function HistoryTitle({ title }: { title: string }) {
  const clip = useRef<HTMLSpanElement>(null);
  const text = useRef<HTMLSpanElement>(null);
  const [overflow, setOverflow] = useState(0);
  useLayoutEffect(() => {
    const measure = () => setOverflow(Math.max(0, (text.current?.scrollWidth ?? 0) - (clip.current?.clientWidth ?? 0)));
    measure();
    const observer = new ResizeObserver(measure);
    if (clip.current) observer.observe(clip.current);
    if (text.current) observer.observe(text.current);
    return () => observer.disconnect();
  }, [title]);
  return <span ref={clip} className="history-title-clip truncate" data-overflow={overflow > 0}
    style={{ "--title-travel": `${-overflow}px`, "--title-duration": `${overflow / 35}s` } as CSSProperties}>
    <span ref={text} className="history-title-text">{title}</span>
  </span>;
}
