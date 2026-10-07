import { marked } from "marked";

marked.setOptions({ breaks: true, gfm: true });
export const md = (t: string) => ({ __html: marked.parse(t, { async: false }) });

// Render a still-growing stream: close an unclosed ``` fence so it paints as a
// code block instead of flickering raw markers while it's being written.
export function closePartialMd(t: string): string {
  const fences = t.match(/(^|\n)```/g);
  if (fences && fences.length % 2 === 1) t += "\n```";
  return t;
}
