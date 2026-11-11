// A small unified diff for showing `init`'s edits before writing them. Workflow files are short,
// so a plain longest-common-subsequence table is fast enough.

export function unifiedDiff(before: string, after: string, file: string, context = 2) {
  const a = before.split("\n");
  const b = after.split("\n");
  const lcs: number[][] = Array.from({ length: a.length + 1 }, () =>
    Array.from<number>({ length: b.length + 1 }).fill(0),
  );
  for (let i = a.length - 1; i >= 0; i--)
    for (let j = b.length - 1; j >= 0; j--)
      lcs[i]![j] =
        a[i] === b[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);

  type Line = { kind: " " | "-" | "+"; text: string; a: number; b: number };
  const lines: Line[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) {
      lines.push({ kind: " ", text: a[i]!, a: i++, b: j++ });
    } else if (i < a.length && (j >= b.length || lcs[i + 1]![j]! >= lcs[i]![j + 1]!)) {
      lines.push({ kind: "-", text: a[i]!, a: i++, b: j });
    } else {
      lines.push({ kind: "+", text: b[j]!, a: i, b: j++ });
    }
  }

  const changed = lines.flatMap((line, index) => (line.kind === " " ? [] : [index]));
  if (!changed.length) return "";
  const out = [`--- a/${file}`, `+++ b/${file}`];
  let start = 0;
  while (start < changed.length) {
    let end = start;
    while (end + 1 < changed.length && changed[end + 1]! - changed[end]! <= context * 2 + 1) end++;
    const from = Math.max(0, changed[start]! - context);
    const to = Math.min(lines.length - 1, changed[end]! + context);
    const hunk = lines.slice(from, to + 1);
    const aCount = hunk.filter((line) => line.kind !== "+").length;
    const bCount = hunk.filter((line) => line.kind !== "-").length;
    out.push(`@@ -${hunk[0]!.a + 1},${aCount} +${hunk[0]!.b + 1},${bCount} @@`);
    for (const line of hunk) out.push(`${line.kind}${line.text}`);
    start = end + 1;
  }
  return out.join("\n");
}
