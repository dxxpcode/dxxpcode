import React from "react";
import { Box, Text } from "ink";
import { XX_MARK } from "../banner.ts";
import { TOOL_DISPLAY, TOOL_ICONS } from "../render.ts";
import { mdLine } from "./md.tsx";
import { SURFACE, SURFACE_HI, fmtTokens, segWidth, type Seg } from "./shared.ts";
import type { AppProps, Item } from "./types.ts";

export const MAJOR_ITEMS = new Set(["banner", "pill", "plan", "diff", "footer"]);

function SurfaceLine({ segs, w, bg }: { segs: Seg[]; w: number; bg?: string }) {
  return (
    <Text backgroundColor={bg ?? SURFACE}>
      {" "}
      {segs.map((s, i) => (
        <Text key={i} color={s.c} backgroundColor={s.bg} bold={s.bold} dimColor={s.dim}>
          {s.t}
        </Text>
      ))}
      {" ".repeat(Math.max(0, w - segWidth(segs)) + 1)}
    </Text>
  );
}

/** Tinted surface card — subtle bg fill instead of a border. */
export function Card({
  lines,
  accent,
  fills,
}: {
  lines: Seg[][];
  accent?: string;
  fills?: (string | undefined)[];
}) {
  const w = Math.max(0, ...lines.map(segWidth));
  return (
    <Box flexDirection="row">
      {accent ? (
        <Text backgroundColor={accent}>{Array(lines.length).fill("  ").join("\n")}</Text>
      ) : null}
      <Box flexDirection="column">
        {lines.map((l, i) => (
          <SurfaceLine key={i} segs={l} w={w} bg={fills?.[i]} />
        ))}
      </Box>
    </Box>
  );
}

export function TabBar({ tabs, sel }: { tabs: string[]; sel: number }) {
  return (
    <Box gap={2}>
      {tabs.map((t, i) => (
        <Text
          key={t}
          bold={i === sel}
          dimColor={i !== sel}
          backgroundColor={i === sel ? SURFACE_HI : undefined}
        >
          {` ${t} `}
        </Text>
      ))}
      <Text dimColor>←/→ switch tab</Text>
    </Box>
  );
}

export function Menu({
  title,
  options,
  sel,
  descriptions,
}: {
  title?: string;
  options: string[];
  sel: number;
  descriptions?: string[];
}) {
  return (
    <Box flexDirection="column" marginTop={1}>
      {title ? <Text dimColor>{title}</Text> : null}
      {options.map((o, i) => (
        <Box key={o} flexDirection="column">
          <Text backgroundColor={i === sel ? SURFACE_HI : undefined}>
            <Text dimColor={i !== sel} bold={i === sel}>
              {i === sel ? " ● " : " ◯ "}
              {o}
            </Text>
            {i === sel
              ? " ".repeat(Math.max(0, Math.max(...options.map((x) => x.length)) - o.length) + 1)
              : ""}
          </Text>
          {descriptions?.[i] ? (
            <Text dimColor>{"      "}{descriptions[i]}</Text>
          ) : null}
        </Box>
      ))}
      <Text dimColor>{"  "}↑/↓ navigate · Enter select · esc cancel</Text>
    </Box>
  );
}

const TABLE_LINE = /^\s*\|.*\|\s*$/;
const TABLE_SEP = /^:?-+:?$/;

/** Rendered markdown table: header bold, `│` separators become dim, rows aligned. */
function Table({ rows }: { rows: string[][] }) {
  const cols = Math.max(...rows.map((r) => r.length));
  const w = Array.from({ length: cols }, (_, c) =>
    Math.max(...rows.map((r) => r[c]?.length ?? 0)),
  );
  const row = (r: string[], bold: boolean, key: number) => (
    <Text key={key}>
      {"  "}
      {r.map((cell, c) => (
        <React.Fragment key={c}>
          {c > 0 ? "  " : ""}
          <Text bold={bold}>{(cell ?? "").padEnd(w[c])}</Text>
        </React.Fragment>
      ))}
    </Text>
  );
  const out: React.ReactNode[] = [];
  let i = 0;
  let headerDone = false;
  while (i < rows.length) {
    const r = rows[i];
    if (r.every((c) => TABLE_SEP.test(c))) {
      out.push(
        <Text key={`sep${i}`} dimColor>
          {"  "}{w.map((x) => "─".repeat(x)).join("  ")}
        </Text>,
      );
      i++;
      continue;
    }
    out.push(row(r, !headerDone, i));
    headerDone = true;
    i++;
  }
  return <Box flexDirection="column">{out}</Box>;
}

/** Streamed text burst: normal lines via mdLine, `|…|` runs become Tables. */
function TextBlock({ text }: { text: string }) {
  const lines = text.split("\n");
  const out: React.ReactNode[] = [];
  let i = 0;
  let k = 0;
  while (i < lines.length) {
    if (TABLE_LINE.test(lines[i])) {
      const rows: string[][] = [];
      while (i < lines.length && TABLE_LINE.test(lines[i])) {
        rows.push(
          lines[i].split("|").slice(1, -1).map((c) => c.trim()),
        );
        i++;
      }
      out.push(<Table key={k++} rows={rows} />);
      continue;
    }
    out.push(
      <Text key={k++}>
        {i === 0 ? <Text color="cyan">⏺ </Text> : "  "}
        {mdLine(lines[i])}
      </Text>,
    );
    i++;
  }
  return <Box flexDirection="column">{out}</Box>;
}

export function ItemView({ it, props }: { it: Item; props: AppProps }) {
  switch (it.kind) {
    case "banner":
      return (
        <Box flexDirection="column">
          <Box flexDirection="row">
            <Box flexDirection="column" marginRight={2}>
              {XX_MARK.map((r, i) => (
                <Text key={i} bold>
                  {r}
                </Text>
              ))}
            </Box>
            <Box flexDirection="column">
              <Text bold color="cyan">
                DxxpCode
              </Text>
              <Text dimColor>
                v{props.version} · {props.provider.name} · {props.model}
              </Text>
            </Box>
          </Box>
          <Text>
            <Text bold>{props.project.name}</Text>
            <Text dimColor>
              {props.project.languages.length ? ` (${props.project.languages.join(", ")})` : ""}
              {props.project.git
                ? ` · ${props.project.git.branch}${props.project.git.dirty ? "*" : ""}`
                : ""}
            </Text>
          </Text>
          <Text dimColor>{props.root}</Text>
          {props.session ? (
            <Text dimColor>
              resumed session {props.session.id} ({props.session.messages.length} messages)
            </Text>
          ) : null}
          <Text> </Text>
          <Text bold dimColor>
            Tips for getting started
          </Text>
          {[
            `Describe a task in plain language — "fix the failing test in math.js"`,
            `Attach context inline: @file, @file#5-10, @dir/ (type @ to browse)`,
            `Preview without changes: dxxpcode --plan "<task>"`,
            `Review diffs anytime: /review in-session, or dxxpcode --review`,
            `Pick up where you left off: dxxpcode --resume`,
            `Project instructions live in .dxxpcode/instructions.md`,
          ].map((t, i) => (
            <Text key={i}>
              {"  "}
              <Text color="cyan">{i + 1}</Text>
              {`. ${t}`}
            </Text>
          ))}
          <Text> </Text>
        </Box>
      );
    case "pill":
      return <Card lines={[[{ t: "❯ ", c: "cyan" }, { t: it.text }]]} />;
    case "status":
      return (
        <Card
          lines={it.rows.map(([k, v]) => [
            { t: `${k.padEnd(9)}`, dim: true },
            { t: v },
          ])}
        />
      );
    case "note":
      return <Text dimColor>  {it.text}</Text>;
    case "thought":
      return (
        <Text dimColor>
          {"  "}
          <Text color="magenta">◆</Text> Thought for {it.secs.toFixed(1)}s
        </Text>
      );
    case "text":
      return <TextBlock text={it.text} />;
    case "tree":
      return (
        <Box flexDirection="column">
          <Text dimColor>{"  ⎿  "}Listed {it.lines.length} entries</Text>
          {it.lines.slice(0, 40).map((l, i) => (
            <Text key={i} dimColor>
              {"     "}{i === it.lines.length - 1 || i === 39 ? "└─" : "├─"} {l}
            </Text>
          ))}
          {it.lines.length > 40 ? (
            <Text dimColor>{"     "}… {it.lines.length - 40} more</Text>
          ) : null}
        </Box>
      );
    case "tool": {
      const name = TOOL_DISPLAY[it.name] ?? it.name;
      const icon = TOOL_ICONS[it.name] ?? "⏺";
      return (
        <Text>
          <Text color="cyan">{icon} </Text>
          <Text bold>{name}</Text>
          {it.arg ? <Text dimColor>({it.arg})</Text> : null}
        </Text>
      );
    }
    case "result":
      return (
        <Text>
          {"  "}
          <Text color={it.isError ? "red" : undefined} dimColor={!it.isError}>
            ⎿  {it.text}
          </Text>
        </Text>
      );
    case "plan": {
      const lines: Seg[][] = [
        [{ t: "plan", bold: true }, { t: "  ×", dim: true }],
        ...(it.summary ? [[{ t: it.summary, dim: true }]] : []),
        ...it.steps.map((s, i) => [{ t: `${i + 1}`, c: "cyan" }, { t: `. ${s}` }]),
      ];
      return <Card lines={lines} />;
    }
    case "todo": {
      const done = it.items.filter((t) => t.status === "completed").length;
      const lines: Seg[][] = [
        [{ t: "tasks", bold: true }, { t: `  ${done}/${it.items.length}  ×`, dim: true }],
        ...it.items.map((t) => {
          const mark =
            t.status === "completed"
              ? { t: "✓ ", c: "green" }
              : t.status === "in_progress"
                ? { t: "▶ ", c: "cyan" }
                : { t: "○ ", dim: true };
          const label = t.status === "in_progress" && t.activeForm ? t.activeForm : t.content;
          return [mark, { t: label, dim: t.status !== "in_progress" }];
        }),
      ];
      return <Card lines={lines} />;
    }
    case "diff": {
      const rows = it.rows.filter((r) => r.kind !== "meta");
      const lines: Seg[][] = [
        [{ t: it.path, bold: true }, { t: "  ×", dim: true }],
        ...rows.map((r) => [
          {
            t: `${r.num !== null ? String(r.num).padStart(4) : "    "}  ${
              r.kind === "add" ? "+" : r.kind === "del" ? "−" : " "
            } ${r.text}`,
            c:
              r.kind === "hunk"
                ? "cyan"
                : r.kind === "add"
                  ? "green"
                  : r.kind === "del"
                    ? "red"
                    : undefined,
            dim: r.kind === "ctx",
          },
        ]),
      ];
      const fills = [
        undefined,
        ...rows.map((r) =>
          r.kind === "add" ? "#0c2b16" : r.kind === "del" ? "#3b0f12" : undefined,
        ),
      ];
      return <Card lines={lines} fills={fills} />;
    }
    case "denied":
      return (
        <Text color="red">
          {"  ⎿  Denied: "}
          {it.reason}
        </Text>
      );
    case "footer": {
      const r = it.result;
      const ok = r.status === "completed";
      const tokens =
        r.usage && (r.usage.inputTokens || r.usage.outputTokens)
          ? ` · ${fmtTokens(r.usage.inputTokens + r.usage.outputTokens)} tokens`
          : "";
      return (
        <Box flexDirection="column">
          <Text>
            <Text color={ok ? "green" : "yellow"}>{ok ? "✓" : "⚠"} </Text>
            <Text bold>{ok ? "Completed" : r.status}</Text>
            <Text dimColor>
              {" · "}
              {it.secs.toFixed(1)}s{tokens}
            </Text>
          </Text>
          {r.summary && !ok ? <Text dimColor>{r.summary}</Text> : null}
          {r.filesChanged.length > 0 && (
            <Text dimColor>  Changed: {r.filesChanged.join(", ")}</Text>
          )}
          {r.error ? <Text color="red">{r.error}</Text> : null}
          <Text dimColor>{"─".repeat(24)}</Text>
        </Box>
      );
    }
    case "error":
      return <Text color="red">{it.text}</Text>;
  }
}
