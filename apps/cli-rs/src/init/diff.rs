//! A small unified diff for showing `init`'s edits before writing them. Workflow files are short,
//! so a plain longest-common-subsequence table is fast enough. A port of apps/cli/diff.ts.

pub fn unified(before: &str, after: &str, file: &str) -> String {
    const CONTEXT: usize = 2;
    let a: Vec<&str> = before.split('\n').collect();
    let b: Vec<&str> = after.split('\n').collect();
    let mut lcs = vec![vec![0usize; b.len() + 1]; a.len() + 1];
    for i in (0..a.len()).rev() {
        for j in (0..b.len()).rev() {
            lcs[i][j] = if a[i] == b[j] {
                lcs[i + 1][j + 1] + 1
            } else {
                lcs[i + 1][j].max(lcs[i][j + 1])
            };
        }
    }

    // Each line: its kind, text, and where it is in each file.
    let mut lines: Vec<(char, &str, usize, usize)> = Vec::new();
    let (mut i, mut j) = (0, 0);
    while i < a.len() || j < b.len() {
        if i < a.len() && j < b.len() && a[i] == b[j] {
            lines.push((' ', a[i], i, j));
            i += 1;
            j += 1;
        } else if i < a.len() && (j >= b.len() || lcs[i + 1][j] >= lcs[i][j + 1]) {
            lines.push(('-', a[i], i, j));
            i += 1;
        } else {
            lines.push(('+', b[j], i, j));
            j += 1;
        }
    }

    let changed: Vec<usize> = (0..lines.len()).filter(|&k| lines[k].0 != ' ').collect();
    if changed.is_empty() {
        return String::new();
    }
    let mut out = vec![format!("--- a/{file}"), format!("+++ b/{file}")];
    let mut start = 0;
    while start < changed.len() {
        let mut end = start;
        while end + 1 < changed.len() && changed[end + 1] - changed[end] <= CONTEXT * 2 + 1 {
            end += 1;
        }
        let from = changed[start].saturating_sub(CONTEXT);
        let to = (changed[end] + CONTEXT).min(lines.len() - 1);
        let hunk = &lines[from..=to];
        let a_count = hunk.iter().filter(|l| l.0 != '+').count();
        let b_count = hunk.iter().filter(|l| l.0 != '-').count();
        out.push(format!(
            "@@ -{},{a_count} +{},{b_count} @@",
            hunk[0].2 + 1,
            hunk[0].3 + 1
        ));
        out.extend(
            hunk.iter()
                .map(|(kind, text, _, _)| format!("{kind}{text}")),
        );
        start = end + 1;
    }
    out.join("\n")
}

#[cfg(test)]
mod tests {
    #[test]
    fn removed_lines_before_added_ones_with_context() {
        assert_eq!(
            super::unified("a\nb\nc\nd\n", "a\nb\nC\nd\n", "f.yml"),
            [
                "--- a/f.yml",
                "+++ b/f.yml",
                "@@ -1,5 +1,5 @@",
                " a",
                " b",
                "-c",
                "+C",
                " d",
                " "
            ]
            .join("\n")
        );
        assert_eq!(super::unified("same\n", "same\n", "f.yml"), "");
    }
}
