// What a page shows while its data loads for the first time, in place of the page, so a click
// moves to the new page at once. Shaped like a page header over a block of content.
export function PagePending() {
  return (
    <div aria-busy aria-label="Loading" className="animate-pulse">
      <div className="mb-8 grid gap-3">
        <div className="h-[26px] w-40 rounded-md bg-muted" />
        <div className="h-4 w-full max-w-[52ch] rounded bg-muted" />
      </div>
      <div className="grid gap-3">
        <div className="h-24 rounded-lg bg-muted" />
        <div className="h-24 rounded-lg bg-muted" />
        <div className="h-24 rounded-lg bg-muted/60" />
      </div>
    </div>
  );
}
