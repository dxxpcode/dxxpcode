import React from "react";
import { Text } from "ink";
import { SURFACE_HI } from "./shared.ts";

/**
 * Inline markdown → ink <Text> nodes: **bold**, *italic*, `code`,
 * ~~strike~~. Chosen over reusing the ANSI styler because ink's layout
 * engine can't measure escape sequences.
 */
export function mdInline(s: string): React.ReactNode[] {
  const re = /(\*\*[^*\n]+\*\*|`[^`\n]+`|~~[^~\n]+~~|\*[^*\n]+\*)/g;
  const out: React.ReactNode[] = [];
  let last = 0;
  let k = 0;
  for (const m of s.matchAll(re)) {
    if (m.index > last) out.push(s.slice(last, m.index));
    const t = m[0];
    if (t.startsWith("**")) out.push(<Text key={k++} bold>{t.slice(2, -2)}</Text>);
    else if (t.startsWith("`"))
      out.push(
        <Text key={k++} backgroundColor={SURFACE_HI}>
          {` ${t.slice(1, -1)} `}
        </Text>,
      );
    else if (t.startsWith("~~"))
      out.push(
        <Text key={k++} strikethrough>
          {t.slice(2, -2)}
        </Text>,
      );
    else out.push(<Text key={k++} italic>{t.slice(1, -1)}</Text>);
    last = m.index + t.length;
  }
  if (last < s.length) out.push(s.slice(last));
  return out;
}

/** One line of model text → a node (handles # headers, - bullets, > quotes). */
export function mdLine(line: string, key?: React.Key): React.ReactNode {
  const h = /^(#{1,6})\s+(.*)$/.exec(line);
  if (h) {
    return (
      <Text key={key} bold underline>
        {h[2]}
      </Text>
    );
  }
  if (/^[-+]\s+/.test(line)) {
    return (
      <Text key={key}>
        {"• "}
        {mdInline(line.replace(/^[-+]\s+/, ""))}
      </Text>
    );
  }
  if (/^>\s?/.test(line)) {
    return (
      <Text key={key} dimColor>
        {"│ "}
        {mdInline(line.replace(/^>\s?/, ""))}
      </Text>
    );
  }
  return <Text key={key}>{mdInline(line)}</Text>;
}
