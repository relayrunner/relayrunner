import { type ReactNode, useLayoutEffect, useRef, useState } from "react";

/**
 * Opens and closes its content by animating to the content's measured height, and follows the
 * content as it grows (jobs arriving or a live run adding one) so the rows below glide rather
 * than jump. Content stays mounted until it has finished closing.
 */
export function Collapse({ open, children }: { open: boolean; children: ReactNode }) {
  const outer = useRef<HTMLDivElement>(null);
  const inner = useRef<HTMLDivElement>(null);
  const [mounted, setMounted] = useState(open);
  const [height, setHeight] = useState(0);
  if (open && !mounted) setMounted(true);
  useLayoutEffect(() => {
    const content = inner.current;
    if (!mounted || !content) return;
    // Flush the closed height first, so the browser has something to transition from.
    void outer.current?.offsetHeight;
    setHeight(content.offsetHeight);
    const observer = new ResizeObserver(() => setHeight(content.offsetHeight));
    observer.observe(content);
    return () => observer.disconnect();
  }, [mounted]);
  if (!mounted) return null;
  return (
    <div
      ref={outer}
      inert={!open}
      style={{ height: open ? height : 0, opacity: open ? 1 : 0 }}
      onTransitionEnd={(event) => {
        if (event.target !== event.currentTarget || open) return;
        setMounted(false);
        setHeight(0);
      }}
      className="overflow-hidden transition-[height,opacity] duration-200 ease-out motion-reduce:transition-opacity"
    >
      <div ref={inner}>{children}</div>
    </div>
  );
}
