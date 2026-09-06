"use client";
import { useEffect, useRef, useState, type ReactNode } from "react";

export function ScrollFade({ children }: { children: ReactNode }) {
  const viewport = useRef<HTMLDivElement>(null);
  const [overflow, setOverflow] = useState(false);
  const update = () => {
    const element = viewport.current;
    if (element) setOverflow(element.scrollTop + element.clientHeight < element.scrollHeight - 1);
  };
  useEffect(() => {
    const element = viewport.current;
    if (!element) return;
    const observer = new ResizeObserver(update);
    observer.observe(element);
    update();
    return () => observer.disconnect();
  }, []);
  return (
    <div className="relative">
      <div ref={viewport} onScroll={update} className="max-h-[220px] overflow-y-auto p-1">
        {children}
      </div>
      {overflow && (
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-x-0 bottom-0 h-7 bg-linear-to-b from-transparent to-popover"
        />
      )}
    </div>
  );
}
