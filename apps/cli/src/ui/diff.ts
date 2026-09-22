export interface DiffRow {
  num: number | null;
  kind: "add" | "del" | "ctx" | "hunk" | "meta";
  text: string;
}

/** Parse a unified diff into rows with new-file line numbers. */
export function parseDiff(diff: string): DiffRow[] {
  const rows: DiffRow[] = [];
  let oldN = 0;
  let newN = 0;
  for (const l of diff.split("\n")) {
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(l);
    if (hunk) {
      oldN = Number(hunk[1]);
      newN = Number(hunk[2]);
      rows.push({ num: null, kind: "hunk", text: l });
      continue;
    }
    if (l.startsWith("+++") || l.startsWith("---") || l.startsWith("diff ") || l.startsWith("index ")) {
      rows.push({ num: null, kind: "meta", text: l });
    } else if (l.startsWith("+")) {
      rows.push({ num: newN++, kind: "add", text: l.slice(1) });
    } else if (l.startsWith("-")) {
      rows.push({ num: oldN++, kind: "del", text: l.slice(1) });
    } else if (l.startsWith("\\")) {
      rows.push({ num: null, kind: "meta", text: l });
    } else if (oldN > 0 || newN > 0) {
      rows.push({ num: newN++, kind: "ctx", text: l.startsWith(" ") ? l.slice(1) : l });
      oldN++;
    } else {
      rows.push({ num: null, kind: "meta", text: l });
    }
  }
  return rows;
}
