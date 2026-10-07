import { marked } from "marked";
import hljs from "highlight.js/lib/core";
import bash from "highlight.js/lib/languages/bash";
import c from "highlight.js/lib/languages/c";
import cpp from "highlight.js/lib/languages/cpp";
import css from "highlight.js/lib/languages/css";
import diff from "highlight.js/lib/languages/diff";
import go from "highlight.js/lib/languages/go";
import ini from "highlight.js/lib/languages/ini";
import java from "highlight.js/lib/languages/java";
import javascript from "highlight.js/lib/languages/javascript";
import json from "highlight.js/lib/languages/json";
import markdown from "highlight.js/lib/languages/markdown";
import python from "highlight.js/lib/languages/python";
import rust from "highlight.js/lib/languages/rust";
import sql from "highlight.js/lib/languages/sql";
import typescript from "highlight.js/lib/languages/typescript";
import xml from "highlight.js/lib/languages/xml";
import yaml from "highlight.js/lib/languages/yaml";

hljs.registerLanguage("bash", bash);
hljs.registerLanguage("sh", bash);
hljs.registerLanguage("zsh", bash);
hljs.registerLanguage("shell", bash);
hljs.registerLanguage("c", c);
hljs.registerLanguage("h", c);
hljs.registerLanguage("cpp", cpp);
hljs.registerLanguage("cxx", cpp);
hljs.registerLanguage("css", css);
hljs.registerLanguage("diff", diff);
hljs.registerLanguage("patch", diff);
hljs.registerLanguage("go", go);
hljs.registerLanguage("golang", go);
hljs.registerLanguage("ini", ini);
hljs.registerLanguage("toml", ini);
hljs.registerLanguage("java", java);
hljs.registerLanguage("javascript", javascript);
hljs.registerLanguage("js", javascript);
hljs.registerLanguage("jsx", javascript);
hljs.registerLanguage("mjs", javascript);
hljs.registerLanguage("json", json);
hljs.registerLanguage("jsonc", json);
hljs.registerLanguage("markdown", markdown);
hljs.registerLanguage("md", markdown);
hljs.registerLanguage("python", python);
hljs.registerLanguage("py", python);
hljs.registerLanguage("rust", rust);
hljs.registerLanguage("rs", rust);
hljs.registerLanguage("sql", sql);
hljs.registerLanguage("typescript", typescript);
hljs.registerLanguage("ts", typescript);
hljs.registerLanguage("tsx", typescript);
hljs.registerLanguage("xml", xml);
hljs.registerLanguage("html", xml);
hljs.registerLanguage("yaml", yaml);
hljs.registerLanguage("yml", yaml);

const escapeHtml = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

marked.setOptions({ breaks: true, gfm: true });
marked.use({
  renderer: {
    code({ text, lang, escaped }) {
      const language = (lang || "").trim().split(/\s+/)[0];
      if (escaped) {
        text = text
          .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
          .replace(/&quot;/g, '"').replace(/&#39;/g, "'");
      }
      let body: string;
      try {
        body =
          language && hljs.getLanguage(language)
            ? hljs.highlight(text, { language }).value
            : escapeHtml(text.replace(/\n$/, ""));
      } catch {
        body = escapeHtml(text.replace(/\n$/, ""));
      }
      const cls = language ? ` class="hljs language-${escapeHtml(language)}"` : ' class="hljs"';
      return `<pre class="codeblock"><button type="button" class="code-copy" data-code="${encodeURIComponent(text)}" aria-label="Copy code">copy</button><code${cls}>${body}</code></pre>`;
    },
  },
});

// Code-block copy buttons live inside dangerouslySetInnerHTML, so they get a
// single delegated listener instead of React handlers.
if (typeof document !== "undefined") {
  document.addEventListener("click", (e) => {
    const btn = (e.target as HTMLElement).closest?.(".code-copy") as HTMLButtonElement | null;
    if (!btn?.dataset.code) return;
    void navigator.clipboard.writeText(decodeURIComponent(btn.dataset.code)).then(() => {
      btn.classList.add("done");
      btn.textContent = "copied";
      setTimeout(() => {
        btn.classList.remove("done");
        btn.textContent = "copy";
      }, 1400);
    });
  });
}

export const md = (t: string) => ({ __html: marked.parse(t, { async: false }) });

// Render a still-growing stream: close an unclosed ``` fence so it paints as a
// code block instead of flickering raw markers while it's being written.
export function closePartialMd(t: string): string {
  const fences = t.match(/(^|\n)```/g);
  if (fences && fences.length % 2 === 1) t += "\n```";
  return t;
}
