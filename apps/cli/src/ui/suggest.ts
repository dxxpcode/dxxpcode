import { basename } from "node:path";

export interface FileIndex {
  files: string[];
  dirs: string[];
}

/** Trailing `@fragment` in the input (before any `#lines` suffix), or null. */
export function atFragment(input: string): string | null {
  const m = input.match(/(?:^|\s)@([^\s]*)$/);
  return m ? m[1].split("#")[0] : null;
}

/** Ranked file/dir completions for an `@` fragment — dirs first, top 8. */
export function fileSuggestions(idx: FileIndex, frag: string): { name: string; desc: string }[] {
  const f = frag.toLowerCase();
  const base = basename(f);
  const seen = new Set<string>();
  const score = (p: string): number => {
    const lp = p.toLowerCase();
    if (lp === f) return 0;
    if (lp.startsWith(f)) return basename(lp).startsWith(base) ? 1 : 2;
    if (basename(lp).startsWith(base)) return 3;
    if (lp.includes(f)) return 4;
    return -1;
  };
  const entries: { p: string; s: number; dir: boolean }[] = [];
  for (const d of idx.dirs) {
    const s = score(d + "/");
    if (s >= 0 && seen.add(d)) entries.push({ p: d + "/", s, dir: true });
  }
  for (const p of idx.files) {
    const s = score(p);
    if (s >= 0 && seen.add(p)) entries.push({ p, s, dir: false });
  }
  return entries
    .sort((a, b) => a.s - b.s || (a.dir === b.dir ? a.p.localeCompare(b.p) : a.dir ? -1 : 1))
    .slice(0, 8)
    .map((e) => ({ name: e.p, desc: e.dir ? "dir" : "file" }));
}
