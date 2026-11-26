import { orderName, type RouteWalk, walkLines } from "@/lib/route-walk";

const LINE_STATES = {
  skipped: "skipped",
  ran: "ran it",
  not_tried: "not tried",
} as const;

// How the pick walked the runner order, one log line per step: "├ 1 machine  skipped · no
// machine with macOS was online and idle".
export function WalkLines({ walk, runner }: { walk: RouteWalk; runner: string | null }) {
  const lines = walkLines(walk, runner);
  const order = orderName(walk, false);
  return (
    <ul
      aria-label={`How RelayRunner walked ${order}`}
      className="mt-1 grid gap-0.5 font-mono text-xs text-muted-foreground"
    >
      {/* The workspace's order needs no saying; a repo's own does. */}
      {walk.ownOrder && <li>{order}</li>}
      {lines.map((line, index) => (
        <li
          key={index}
          className="break-words sm:truncate"
          ref={(el) => {
            if (el) el.title = el.textContent ?? "";
          }}
        >
          <span aria-hidden className="text-muted-foreground/50">
            {index === lines.length - 1 ? "└ " : "├ "}
          </span>
          <span className="text-foreground/75">
            {line.position ?? "–"} {line.key}
          </span>{" "}
          <span className={line.state === "ran" ? "text-go" : undefined}>
            {LINE_STATES[line.state]}
          </span>
          {line.text && (line.state === "ran" ? ` ${line.text}` : ` · ${line.text}`)}
        </li>
      ))}
    </ul>
  );
}
