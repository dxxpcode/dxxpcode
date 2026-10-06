import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { marked } from "marked";
import { Button } from "./components/ui/button";
import { Input } from "./components/ui/input";
import { ScrollArea } from "./components/ui/scroll-area";
import { Plus, Search, Minus, Square, X, ChevronDown, SlidersHorizontal, Cpu, Palette, History, Info, ListEnd, GitBranch, PanelLeft } from "lucide-react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { check } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import type { Approval, Item, MenuState, Plan, PromptState, ReadyInfo, Todo } from "./types";
import { TOOL_DISPLAY, toolArg } from "./types";
import artStarryNight from "./assets/art/starry-night_van-gogh.jpg";
import artGreatWave from "./assets/art/great-wave_hokusai.jpg";
import artOhashiRain from "./assets/art/ohashi-rain_hiroshige.jpg";
import artWanderer from "./assets/art/wanderer_friedrich.jpg";
import artWaterLilies from "./assets/art/waterlilies_monet.jpg";
import artRedFuji from "./assets/art/red-fuji_hokusai.jpg";

// Curated built-in art backdrops — all public domain.
const ART_PIECES = [
  { id: "starry-night", title: "Starry Night", artist: "Vincent van Gogh", src: artStarryNight },
  { id: "great-wave", title: "The Great Wave off Kanagawa", artist: "Katsushika Hokusai", src: artGreatWave },
  { id: "ohashi-rain", title: "Sudden Shower over Shin-Ōhashi Bridge", artist: "Utagawa Hiroshige", src: artOhashiRain },
  { id: "wanderer", title: "Wanderer above the Sea of Fog", artist: "Caspar David Friedrich", src: artWanderer },
  { id: "water-lilies", title: "Water Lilies", artist: "Claude Monet", src: artWaterLilies },
  { id: "red-fuji", title: "Fine Wind, Clear Morning", artist: "Katsushika Hokusai", src: artRedFuji },
];

marked.setOptions({ breaks: true, gfm: true });
const md = (t: string) => ({ __html: marked.parse(t, { async: false }) });

// Render a still-growing stream: close an unclosed ``` fence so it paints as a
// code block instead of flickering raw markers while it's being written.
function closePartialMd(t: string): string {
  const fences = t.match(/(^|\n)```/g);
  if (fences && fences.length % 2 === 1) t += "\n```";
  return t;
}

// Streaming text: render everything but the newest fragment statically, and
// wrap the tail in an .ease span so only the freshly arrived words fade/slide
// in (re-mounting the tail is fine — it's the part that's animating anyway).
function mdStream(t: string) {
  const closed = closePartialMd(t);
  const cut = Math.max(0, closed.length - 28);
  const sp = closed.indexOf(" ", cut);
  const tail = sp > 0 ? closed.slice(sp + 1) : closed.slice(cut);
  const head = closed.slice(0, closed.length - tail.length);
  return { __html: `${marked.parse(head, { async: false })}<span class="ease">${marked.parseInline(tail, { async: false })}</span>` };
}

const EFFORT_LEVELS = ["default", "minimal", "low", "medium", "high", "xhigh", "max", "auto (Jev)"];
const send = (cmd: object) => invoke("pty_write", { data: JSON.stringify(cmd) + "\n" });

const win = getCurrentWindow();
// macOS gets native overlay traffic lights; Linux/Windows need our own.
const IS_MAC = navigator.userAgent.includes("Macintosh");

interface Ev { type: string; [k: string]: unknown }

// A queued prompt running in parallel: its own git worktree + sidecar.
interface WTask {
  id: number; text: string; dir: string; branch: string;
  phase: "running" | "done" | "failed" | "merged" | "discarded";
  status: string; calls: number; result?: string;
}

export default function App() {
  const [ready, setReady] = useState<ReadyInfo | null>(null);
  const [items, setItems] = useState<Item[]>([]);
  const [approvals, setApprovals] = useState<Approval[]>([]);
  const [diffs, setDiffs] = useState<{ id: number; path: string; diff: string; decided?: string }[]>([]);
  const [status, setStatus] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const [input, setInput] = useState("");
  const [chatMode, setChatMode] = useState(false);
  const [menu, setMenu] = useState<MenuState | null>(null);
  const [promptReq, setPromptReq] = useState<PromptState | null>(null);
  const [promptVal, setPromptVal] = useState("");
  const [cmdSel, setCmdSel] = useState(0);
  const [fileSugs, setFileSugs] = useState<{ id: number; items: { name: string; desc: string }[] }>({ id: -1, items: [] });
  const [modelOpts, setModelOpts] = useState<string[]>([]);
  const fileReqId = useRef(0);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsTab, setSettingsTab] = useState<"general" | "providers" | "appearance" | "session" | "about">("general");
  // In-app updates: checked once on launch, downloaded in the background,
  // then surfaced as a restart row in Settings → About.
  const [update, setUpdate] = useState<{ version: string; status: "downloading" | "ready" } | null>(null);
  useEffect(() => {
    check()
      .then((u) => {
        if (!u) return;
        setUpdate({ version: u.version, status: "downloading" });
        u.downloadAndInstall()
          .then(() => setUpdate({ version: u.version, status: "ready" }))
          .catch(() => setUpdate(null));
      })
      .catch(() => {});
  }, []);
  const [sessionInfo, setSessionInfo] = useState<{ id: string | null; tokens: number }>({ id: null, tokens: 0 });
  // Backlog of prompts typed while a run was active — each becomes its own
  // session once the current run finishes. Persisted per project.
  const [queue, setQueue] = useState<string[]>([]);
  const queueRef = useRef<string[]>([]);
  const lastDone = useRef<string | null>(null);
  const [wtasks, setWtasks] = useState<WTask[]>([]);
  const wbuf = useRef<Record<number, string>>({});
  const wPending = useRef<Record<number, string>>({});
  const rootRef = useRef<string>("");
  const [onboarding, setOnboarding] = useState(false);
  // Onboarding wizard: welcome → pick a provider → enter + validate the key.
  const [obStep, setObStep] = useState<"welcome" | "pick" | "key" | "project" | "first">("welcome");
  const [obDir, setObDir] = useState<"fwd" | "back">("fwd");
  const OB_ORDER: Record<string, number> = { welcome: 0, pick: 1, key: 2, project: 3, first: 4 };
  const goStep = (s: "welcome" | "pick" | "key" | "project" | "first") => {
    setObDir(OB_ORDER[s] >= OB_ORDER[obStep] ? "fwd" : "back");
    setObStep(s);
  };
  const [obProvider, setObProvider] = useState<string>("anthropic");
  const OB_BASE: Record<string, string | undefined> = {
    openrouter: "https://openrouter.ai/api/v1",
    gemini: "https://generativelanguage.googleapis.com/v1beta/openai",
    groq: "https://api.groq.com/openai/v1",
    deepseek: "https://api.deepseek.com/v1",
    xai: "https://api.x.ai/v1",
    mistral: "https://api.mistral.ai/v1",
  };
  const OB_PROVIDERS: { id: string; name: string; desc: string }[] = [
    { id: "anthropic", name: "Anthropic", desc: "Claude models" },
    { id: "openrouter", name: "OpenRouter", desc: "one key — Claude, GPT, Gemini, Llama" },
    { id: "openai", name: "OpenAI", desc: "GPT models" },
    { id: "gemini", name: "Gemini", desc: "Google AI Studio key" },
    { id: "groq", name: "Groq", desc: "fast open models — Llama, GPT-OSS" },
    { id: "deepseek", name: "DeepSeek", desc: "DeepSeek-V3 / R1" },
    { id: "xai", name: "xAI", desc: "Grok models" },
    { id: "mistral", name: "Mistral", desc: "Mistral models" },
    { id: "custom", name: "Other endpoint", desc: "any OpenAI-compatible API" },
  ];
  const OB_MAIN = ["anthropic", "openai"];
  const [obMore, setObMore] = useState(false);
  const [obKey, setObKey] = useState("");
  const [obBase, setObBase] = useState("");
  const [obBusy, setObBusy] = useState(false);
  const [obError, setObError] = useState<string | null>(null);
  // Set when we respawn the sidecar for a project switch; the next ready
  // event then finishes onboarding instead of re-showing it.
  const projectSwitchPending = useRef(false);
  const [docView, setDocView] = useState<{ title: string; text: string } | null>(null);
  const [palOpen, setPalOpen] = useState(false);
  const [palQuery, setPalQuery] = useState("");
  const [palIdx, setPalIdx] = useState(0);
  const [railOpen, setRailOpen] = useState(() => localStorage.getItem("railOpen") !== "0");
  const [railQuery, setRailQuery] = useState("");
  const [railTab, setRailTab] = useState<"sessions" | "tasks">("sessions");
  const [bootGone, setBootGone] = useState(false);
  const [sessions, setSessions] = useState<{ id: string; title: string; desc: string; task?: string; files?: string[]; status?: string; when?: string }[]>([]);
  const [sessMenu, setSessMenu] = useState<string | null>(null);
  const [theme, setTheme] = useState<"light" | "dark" | "system">(() => {
    const saved = localStorage.getItem("theme");
    return saved === "light" || saved === "dark" ? saved : "system";
  });
  const [sysDark, setSysDark] = useState(() => window.matchMedia?.("(prefers-color-scheme: dark)").matches ?? false);
  useEffect(() => {
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const on = (e: MediaQueryListEvent) => setSysDark(e.matches);
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, []);
  const [previewTheme, setPreviewTheme] = useState<"light" | "dark" | "system" | null>(null);
  const shownTheme = previewTheme ?? theme;
  const [artPiece, setArtPiece] = useState(() => localStorage.getItem("artPiece") ?? "");
  const [artDir, setArtDir] = useState(() => localStorage.getItem("artDir") ?? "");
  const [artSrc, setArtSrc] = useState<string | null>(null);
  useEffect(() => {
    const piece = ART_PIECES.find((p) => p.id === artPiece);
    localStorage.setItem("artPiece", piece ? artPiece : "");
    localStorage.setItem("artDir", artDir);
    if (piece) {
      setArtSrc(piece.src);
      return;
    }
    setArtSrc(null);
    if (!artDir) return;
    invoke<{ dataUrl: string }>("art_image", { dir: artDir })
      .then((r) => setArtSrc(r.dataUrl))
      .catch(() => {});
  }, [artPiece, artDir]);
  const artLabel = artPiece
    ? (ART_PIECES.find((p) => p.id === artPiece)?.title ?? artPiece)
    : artDir
      ? (artDir.split("/").filter(Boolean).pop() ?? "Folder")
      : "";
  const artDirLabel = artDir.split("/").filter(Boolean).pop() ?? "";
  const dark = artSrc != null || (shownTheme === "system" ? sysDark : shownTheme === "dark");
  useEffect(() => {
    document.documentElement.dataset.theme = dark ? "dark" : "light";
    localStorage.setItem("theme", theme);
  }, [dark, theme]);
  useEffect(() => {
    localStorage.setItem("railOpen", railOpen ? "1" : "0");
  }, [railOpen]);
  const scrollRef = useRef<HTMLDivElement>(null);
  const taRef = useRef<HTMLTextAreaElement>(null);

  const push = (item: Item) => {
    if (textBuf.current && flushTimer.current) { clearTimeout(flushTimer.current); flushText(); }
    closeThink();
    // Reasoning that directly precedes a tool call anchors to that tool's row.
    if (item.k === "tool") {
      setItems((prev) => {
        const last = prev[prev.length - 1];
        if (last?.k === "think" && !last.live)
          return [...prev.slice(0, -1), { ...item, think: { text: last.text, ms: last.ms } }];
        return [...prev, item];
      });
      return;
    }
    setItems((prev) => [...prev, item]);
  };
  const commands = ready?.commands ?? [];
  const palette = input.startsWith("/")
    ? commands.filter((c) => c.name.startsWith(input.split(/\s/)[0]))
    : [];
  const atMatch = input.match(/(?:^|\s)@([^\s]*)$/);
  const atFrag = palette.length === 0 && atMatch ? atMatch[1].split("#")[0] : null;
  const files = atFrag !== null ? fileSugs.items : [];
  // Batch streamed deltas: buffer and flush once per frame-ish so React
  // re-renders ~30x/sec max instead of once per NDJSON chunk.
  const textBuf = useRef("");
  const thinkBuf = useRef("");
  const flushTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const thinkTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Live token rate: count streamed chars, report ~tok/s while streaming.
  const [tokRate, setTokRate] = useState(0);
  const rateChars = useRef(0);
  const rateStart = useRef(0);
  const rateTimer = useRef<ReturnType<typeof setInterval> | null>(null);
  const runStart = useRef(0);
  const countStream = (n: number) => {
    if (!rateStart.current) {
      rateStart.current = Date.now();
      rateTimer.current = setInterval(() => {
        const el = (Date.now() - rateStart.current) / 1000;
        setTokRate(el > 0 ? Math.round(rateChars.current / 4 / el) : 0);
      }, 400);
    }
    rateChars.current += n;
  };
  const stopRate = useCallback(() => {
    if (rateTimer.current) { clearInterval(rateTimer.current); rateTimer.current = null; }
    rateChars.current = 0;
    rateStart.current = 0;
    setTokRate(0);
  }, []);
  const flushThink = useCallback(() => {
    thinkTimer.current = null;
    const t = thinkBuf.current;
    thinkBuf.current = "";
    if (!t) return;
    setItems((prev) => {
      const last = prev[prev.length - 1];
      if (last?.k === "think" && last.live) return [...prev.slice(0, -1), { ...last, text: last.text + t }];
      return [...prev, { k: "think", text: t, live: true, startedAt: Date.now() }];
    });
  }, []);
  const appendThink = (t: string) => {
    thinkBuf.current += t;
    countStream(t.length);
    if (!thinkTimer.current) thinkTimer.current = setTimeout(flushThink, 32);
  };
  const closeThink = useCallback(() => {
    if (thinkTimer.current) { clearTimeout(thinkTimer.current); flushThink(); }
    setItems((prev) => {
      const last = prev[prev.length - 1];
      if (last?.k === "think" && last.live)
        return [...prev.slice(0, -1), { ...last, live: false, ms: last.startedAt ? Date.now() - last.startedAt : undefined }];
      return prev;
    });
  }, [flushThink]);
  const flushText = useCallback(() => {
    flushTimer.current = null;
    const t = textBuf.current;
    textBuf.current = "";
    if (!t) return;
    setItems((prev) => {
      const last = prev[prev.length - 1];
      if (last?.k === "text") return [...prev.slice(0, -1), { k: "text", text: last.text + t }];
      return [...prev, { k: "text", text: t }];
    });
  }, []);
  const appendText = (t: string) => {
    textBuf.current += t;
    countStream(t.length);
    if (!flushTimer.current) flushTimer.current = setTimeout(flushText, 32);
  };

  const handle = useCallback((ev: Ev) => {
    switch (ev.type) {
      case "ready": {
        const r = ev as unknown as ReadyInfo;
        setReady(r);
        if (projectSwitchPending.current) {
          projectSwitchPending.current = false;
          setOnboarding(false);
          setObStep("welcome");
        } else if (r.needsSetup) { setOnboarding(true); setObStep("welcome"); }
        // A fresh ready = respawned sidecar (project switch) or first boot —
        // reset the transcript so the new session starts clean.
        setItems([]);
        setApprovals([]);
        setSessionInfo({ id: null, tokens: 0 });
        setChatMode(false);
        break;
      }
      case "user":
        push({ k: "user", text: String(ev.text) });
        setRunning(true);
        runStart.current = Date.now();
        break;
      case "state":
        setReady((prev) =>
          prev
            ? {
                ...prev,
                provider: String(ev.provider),
                model: String(ev.model),
                effort: ev.effort as string | undefined,
                variant: ev.variant as string | undefined,
                variants: ev.variants as string[] | undefined,
                providers: ev.providers as string[] | undefined,
                mode: String(ev.mode),
              }
            : prev,
        );
        break;
      case "menu":
        setMenu({
          id: Number(ev.id), title: String(ev.title),
          options: ev.options as MenuState["options"],
          current: ev.current as number | undefined,
        });
        break;
      case "prompt":
        setPromptReq({ id: Number(ev.id), title: String(ev.title), secret: ev.secret === true });
        setPromptVal("");
        break;
      case "table":
        push({ k: "table", title: String(ev.title), rows: ev.rows as [string, string][] });
        break;
      case "markdown":
        setDocView({ title: String(ev.title), text: String(ev.text) });
        break;
      case "diff_card":
        push({ k: "diffcard", title: String(ev.title), diff: String(ev.diff) });
        break;
      case "error":
        push({
          k: "error",
          text: String(ev.message ?? ev.text),
          hint: ev.hint != null ? String(ev.hint) : undefined,
          detail: ev.detail != null ? String(ev.detail) : undefined,
          code: ev.code != null ? String(ev.code) : undefined,
        });
        break;
      case "exit":
        void getCurrentWindow().close();
        break;
      case "session":
        setSessionInfo({ id: ev.id as string | null, tokens: Number(ev.tokens) });
        break;
      case "sessions":
        setSessions(Array.isArray(ev.items) ? (ev.items as { id: string; title: string; desc: string; task?: string; files?: string[]; status?: string; when?: string }[]) : []);
        break;
      case "files":
        if (Number(ev.id) === fileReqId.current)
          setFileSugs({ id: fileReqId.current, items: ev.items as { name: string; desc: string }[] });
        break;
      case "models":
        if (Array.isArray(ev.items)) setModelOpts(ev.items as string[]);
        break;
      case "setup_result": {
        setObBusy(false);
        if (ev.ok === true) {
          setObStep("project");
          setObKey("");
          setObBase("");
          setObError(null);
        } else {
          setObError(String(ev.error ?? "could not validate key"));
        }
        break;
      }
      case "status":
        setStatus(String(ev.message));
        break;
      case "think":
        appendThink(String(ev.text));
        break;
      case "text":
        // Text following a thinking block ends it.
        closeThink();
        appendText(String(ev.text));
        setStatus(null);
        break;
      case "history": {
        // Rebuild the transcript from a resumed session's stored messages.
        const msgs =
          (ev.messages as {
            role: string;
            content?: {
              type?: string;
              text?: string;
              name?: string;
              input?: Record<string, unknown>;
              id?: string;
              toolUseId?: string;
              content?: unknown;
              isError?: boolean;
            }[];
          }[]) ?? [];
        const restored: Item[] = [];
        const toolIdx = new Map<string, number>(); // tool_use id -> index in restored
        for (const m of msgs) {
          for (const b of m.content ?? []) {
            if (b.type === "text" && b.text) {
              restored.push(m.role === "user" ? { k: "user", text: b.text } : { k: "text", text: b.text });
            } else if (b.type === "tool_use" && b.name) {
              toolIdx.set(String(b.id), restored.length);
              restored.push({ k: "tool", tool: b.name, arg: toolArg(b.input ?? {}), pending: false });
            } else if (b.type === "tool_result") {
              const i = toolIdx.get(String(b.toolUseId));
              if (i !== undefined) {
                const it = restored[i];
                if (it.k === "tool") {
                  restored[i] = {
                    ...it,
                    out: typeof b.content === "string" ? b.content : JSON.stringify(b.content ?? ""),
                    isError: b.isError === true,
                  };
                }
              }
            }
          }
        }
        if (restored.length) setItems(restored);
        break;
      }
      case "plan":
        push({ k: "plan", plan: ev.plan as Plan });
        break;
      case "tool_start":
        push({
          k: "tool", tool: String(ev.tool),
          arg: toolArg((ev.input as Record<string, unknown>) ?? {}),
          pending: true, startedAt: Date.now(),
        });
        break;
      case "tool_delta": {
        // Live partial output from a running tool (e.g. run_command).
        const delta = String(ev.text);
        setItems((prev) => {
          const next = [...prev];
          for (let i = next.length - 1; i >= 0; i--) {
            const it = next[i];
            if (it.k === "tool" && it.pending && it.tool === ev.tool) {
              next[i] = { ...it, out: (it.out ?? "") + delta };
              return next;
            }
          }
          return next;
        });
        break;
      }
      case "tool_end": {
        const res = ev.result as { content?: string; isError?: boolean; diff?: string };
        setItems((prev) => {
          const next = [...prev];
          for (let i = next.length - 1; i >= 0; i--) {
            const it = next[i];
            if (it.k === "tool" && it.pending && it.tool === ev.tool) {
              next[i] = { ...it, pending: false, out: res.content, isError: res.isError, diff: res.diff };
              return next;
            }
          }
          return next;
        });
        setStatus("Thinking…");
        break;
      }
      case "todo":
        push({ k: "todos", items: ev.items as Todo[] });
        break;
      case "checkpoint":
        push({ k: "note", text: `checkpoint ${ev.seq} — /undo restores ${(ev.paths as string[]).join(", ")}` });
        break;
      case "denied":
        push({ k: "denied", tool: String(ev.tool), reason: String(ev.reason) });
        break;
      case "compacted":
        push({ k: "note", text: `compacted context — ${ev.blocks} old result(s) summarized` });
        break;
      case "approval":
        setApprovals((prev) => [
          ...prev,
          {
            id: Number(ev.id), kind: ev.kind as "plan" | "tool",
            summary: String(ev.summary), reason: ev.reason as string | undefined,
            allowAlways: ev.allowAlways === true,
            extraChoice: ev.extraChoice as { choice: string; label: string } | undefined,
          },
        ]);
        break;
      case "diff_review":
        setDiffs((prev) => [
          ...prev,
          { id: Number(ev.id), path: String(ev.path), diff: String(ev.diff) },
        ]);
        break;
      case "steer":
        push({ k: "note", text: `steering: ${ev.text}`, steer: true });
        break;
      case "note":
        push({ k: "note", text: String(ev.text) });
        break;
      case "mode": {
        const m = String(ev.mode) === "chat";
        setChatMode(m);
        push({ k: "note", text: `mode: ${m ? "chat" : "code"}` });
        break;
      }
      case "done": {
        const r = ev.result as {
          status: string; summary: string; filesChanged?: string[];
          usage?: { inputTokens?: number; outputTokens?: number };
        };
        if (r.status === "cancelled") {
          // Mark a text stream cut short by esc.
          if (flushTimer.current) { clearTimeout(flushTimer.current); flushText(); }
          setItems((prev) => {
            const next = [...prev];
            for (let i = next.length - 1; i >= 0; i--) {
              if (next[i].k === "text") {
                next[i] = { ...next[i], interrupted: true };
                break;
              }
              if (next[i].k === "user" || next[i].k === "done") break;
            }
            return next;
          });
        }
        lastDone.current = r.status;
        push({
          k: "done", status: r.status, summary: r.summary ?? "",
          filesChanged: r.filesChanged ?? [],
          secs: runStart.current ? Math.round((Date.now() - runStart.current) / 1000) : undefined,
          tokens: r.usage ? (r.usage.inputTokens ?? 0) + (r.usage.outputTokens ?? 0) : undefined,
        });
        break;
      }
      case "idle": {
        if (flushTimer.current) { clearTimeout(flushTimer.current); flushText(); }
        if (thinkTimer.current) { clearTimeout(thinkTimer.current); flushThink(); }
        closeThink();
        stopRate();
        setRunning(false);
        setStatus(null);
        // Auto-start the queued backlog as fresh sessions — but not after a
        // cancellation: esc means stop, not advance.
        if (lastDone.current === "completed" && queueRef.current.length > 0) {
          const [next, ...rest] = queueRef.current;
          setQueue(rest);
          setTimeout(() => {
            cmd("/new");
            push({ k: "note", text: `queued: ${next}` });
            setTimeout(() => void send({ type: "submit", text: next }), 120);
          }, 120);
        }
        break;
      }
      case "usage":
        break;
    }
  }, [stopRate]);

  useEffect(() => {
    let buf = "";
    const dec = new TextDecoder();
    const un = listen<number[]>("pty-out", (e) => {
      buf += dec.decode(new Uint8Array(e.payload), { stream: true });
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        const t = line.trim();
        if (!t) continue;
        try {
          handle(JSON.parse(t) as Ev);
        } catch {
          push({ k: "raw", text: t });
        }
      }
    });
    // Tell the backend the listener is attached; it replays early output.
    void un.then(() => invoke("ui_ready"));
    return () => {
      void un.then((f) => f());
    };
  }, [handle]);

  // Stick to bottom: auto-scroll only while the user is already at the bottom;
  // scrolling up pauses follow so the transcript doesn't fight the reader.
  const stickBottom = useRef(true);
  const onTranscriptScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    stickBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
  }, []);
  useEffect(() => {
    const el = scrollRef.current;
    if (el && stickBottom.current) el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
  }, [items, approvals, status]);

  // Queue persistence: one localStorage key per project, loaded on project
  // switch; queueRef mirrors state so the idle handler can read it synchronously.
  const queueKey = ready ? `dxxp_queue:${ready.project.name}` : null;
  useEffect(() => {
    queueRef.current = queue;
  }, [queue]);
  useEffect(() => {
    if (queueKey) {
      const saved = JSON.parse(localStorage.getItem(queueKey) ?? "[]") as string[];
      setQueue(saved);
      queueRef.current = saved;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [queueKey]);
  useEffect(() => {
    if (queueKey) localStorage.setItem(queueKey, JSON.stringify(queue));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [queueKey, queue]);

  // Project root for worktrees — the sidecar's cwd.
  useEffect(() => {
    if (ready) void invoke<string>("session_cwd").then((r) => { rootRef.current = r; });
  }, [ready]);

  // Worker sidecar events: NDJSON lines on `worker-out` tagged by worker id.
  const workerEvent = useCallback((id: number, ev: Ev) => {
    switch (ev.type) {
      case "ready": {
        const text = wPending.current[id];
        if (text) {
          void invoke("worker_write", { id, data: JSON.stringify({ type: "submit", text }) + "\n" });
          delete wPending.current[id];
        }
        break;
      }
      case "tool_start":
        setWtasks((ts) => ts.map((w) => w.id === id ? { ...w, calls: w.calls + 1, status: String(ev.tool) } : w));
        break;
      case "status":
        setWtasks((ts) => ts.map((w) => w.id === id ? { ...w, status: String(ev.text) } : w));
        break;
      case "done": {
        const r = ev.result as { status?: string; summary?: string };
        setWtasks((ts) => ts.map((w) => w.id === id ? {
          ...w, phase: r?.status === "completed" ? "done" : "failed",
          result: r?.summary || r?.status || "", status: "",
        } : w));
        break;
      }
      case "error":
        setWtasks((ts) => ts.map((w) => w.id === id ? { ...w, phase: "failed", result: String(ev.message ?? "error") } : w));
        break;
    }
  }, []);

  useEffect(() => {
    const dec = new TextDecoder();
    const un = listen<{ id: number; data: number[] }>("worker-out", (e) => {
      const { id, data } = e.payload;
      let buf = (wbuf.current[id] ?? "") + dec.decode(new Uint8Array(data), { stream: true });
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const t = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!t) continue;
        try { workerEvent(id, JSON.parse(t) as Ev); } catch { /* partial */ }
      }
      wbuf.current[id] = buf;
    });
    const un2 = listen<number>("worker-exit", (e) => {
      const id = e.payload;
      setWtasks((ts) => ts.map((w) =>
        w.id === id && w.phase === "running" ? { ...w, phase: "failed", result: "worker exited" } : w));
    });
    return () => { void un.then((f) => f()); void un2.then((f) => f()); };
  }, [workerEvent]);

  // Start a queued prompt immediately in a git worktree on its own sidecar.
  const startParallel = async (text: string, qi: number) => {
    const root = rootRef.current;
    if (!root) { push({ k: "note", text: "parallel needs a project" }); return; }
    const name = `w${Date.now().toString(36)}`;
    let wt: { dir: string; branch: string };
    try {
      wt = await invoke("worktree_create", { root, name });
    } catch (e) {
      push({ k: "note", text: `worktree failed — ${e}` });
      return;
    }
    const id = await invoke<number>("worker_start", { cwd: wt.dir });
    wPending.current[id] = text;
    setWtasks((ts) => [...ts, { id, text, dir: wt.dir, branch: wt.branch, phase: "running", status: "starting", calls: 0 }]);
    setQueue((q) => q.filter((_, j) => j !== qi));
  };

  const resolveWorker = async (id: number, merge: boolean) => {
    const t = wtasks.find((w) => w.id === id);
    if (!t) return;
    if (merge) {
      try {
        const stat = await invoke<string>("worktree_merge", { root: rootRef.current, dir: t.dir, branch: t.branch });
        push({ k: "note", text: stat === "no changes" ? `merged ${t.branch} — no changes` : `merged ${t.branch} — ${stat}` });
        setWtasks((ts) => ts.map((w) => w.id === id ? { ...w, phase: "merged" } : w));
      } catch (e) {
        push({ k: "note", text: String(e) });
        return;
      }
    } else {
      void invoke("worktree_discard", { root: rootRef.current, dir: t.dir, branch: t.branch }).catch(() => {});
      setWtasks((ts) => ts.map((w) => w.id === id ? { ...w, phase: "discarded" } : w));
    }
    void invoke("worker_stop", { id });
  };

  const stopWorker = (id: number) => {
    const t = wtasks.find((w) => w.id === id);
    void invoke("worker_stop", { id });
    if (t) void invoke("worktree_discard", { root: rootRef.current, dir: t.dir, branch: t.branch }).catch(() => {});
    setWtasks((ts) => ts.map((w) => w.id === id ? { ...w, phase: "discarded" } : w));
  };

  // Ask the CLI for @mention completions whenever the fragment changes.
  useEffect(() => {
    if (atFrag === null) return;
    const id = ++fileReqId.current;
    const t = setTimeout(() => {
      void send({ type: "list_files", id, text: atFrag });
    }, 120);
    return () => clearTimeout(t);
  }, [atFrag]);

  const completeMention = (name: string) => {
    setInput((v) => v.replace(/@[^\s]*$/, `@${name}`) + (name.endsWith("/") ? "" : " "));
    setFileSugs({ id: -1, items: [] });
    taRef.current?.focus();
  };

  const submit = () => {
    const text = input.trim();
    if (!text) return;
    if (files.length > 0 && atFrag !== null) {
      // File palette open — Enter completes the selected mention.
      completeMention(files[Math.min(cmdSel, files.length - 1)].name);
      setCmdSel(0);
      return;
    }
    if (palette.length > 0 && !text.includes(" ")) {
      // Palette open on an exact/partial command — take the selected suggestion.
      const pick = palette[Math.min(cmdSel, palette.length - 1)];
      if (pick && pick.name !== text) {
        setInput(pick.name);
        setCmdSel(0);
        return;
      }
    }
    setInput("");
    setCmdSel(0);
    if (text === "/clear") {
      setItems([]);
      return;
    }
    if (text === "/exit") {
      void getCurrentWindow().close();
      return;
    }
    if (text === "/settings") {
      setSettingsOpen(true);
      return;
    }
    if (running && !text.startsWith("/")) {
      // Typed during a run → backlog, not an in-session steer. /steer is the
      // escape hatch for the old inject-mid-run behavior.
      setQueue((q) => [...q, text]);
      return;
    }
    if (running && text.startsWith("/steer")) {
      void send({ type: "submit", text: text.slice(6).trim() });
      return;
    }
    void send({ type: "submit", text });
  };

  const pickMenu = (index: number) => {
    const m = menu;
    if (!m) return;
    setMenu({ ...m, answered: index });
    setTimeout(() => setMenu((cur) => (cur?.id === m.id ? null : cur)), 250);
    void send({ type: "select", id: m.id, index });
  };

  const cmd = (name: string) => {
    setSettingsOpen(false);
    if (name === "/settings") {
      setSettingsOpen(true);
      return;
    }
    if (name === "/docs" || name === "/changelog" || name === "/help") setDocView({ title: "…", text: "" });
    void send({ type: "command", name });
  };

  useEffect(() => {
    if (settingsOpen && settingsTab === "providers") void send({ type: "command", name: "/models" });
  }, [settingsOpen, settingsTab]);

  const openProject = () => {
    void invoke<string | null>("pick_folder").then((dir) => {
      if (dir) {
        projectSwitchPending.current = true;
        void invoke("restart_sidecar", { cwd: dir });
      }
    });
  };

  const submitPrompt = () => {
    const p = promptReq;
    if (!p) return;
    setPromptReq(null);
    void send({ type: "prompt_submit", id: p.id, text: promptVal });
  };

  const answer = (id: number, choice: string) => {
    setApprovals((prev) => prev.map((a) => (a.id === id ? { ...a, answered: choice } : a)));
    void send({ type: "approve", id, choice });
  };

  const decideDiff = (id: number, decision: string) => {
    setDiffs((prev) => prev.map((d) => (d.id === id ? { ...d, decided: decision } : d)));
    void send({ type: "diff_decide", id, decision });
  };

  // ⌘K/Ctrl+K toggles the session palette; Esc closes it from anywhere.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        if (ready) setPalOpen((v) => !v);
      } else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "b") {
        e.preventDefault();
        if (ready) setRailOpen((v) => !v);
      } else if (e.key === "Escape" && palOpen) {
        setPalOpen(false);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [ready, palOpen]);

  // Boot hand-off: when ready lands, the boot mark fades/scales out over
  // ~300ms while the hero fades in, then unmounts.
  useEffect(() => {
    if (ready) {
      const t = setTimeout(() => setBootGone(true), 300);
      return () => clearTimeout(t);
    }
    setBootGone(false);
  }, [ready]);

  useEffect(() => {
    if (palOpen) {
      setPalQuery("");
      setPalIdx(0);
    }
  }, [palOpen]);

  // Sessions feed both the ⌘K palette and the rail — refresh on ready, on
  // session change, and when a run settles (a first run assigns the title).
  useEffect(() => {
    if (ready) void send({ type: "sessions" });
  }, [ready, sessionInfo.id, running]);

  // Group sessions by recency: desc is "<yyyy-mm-dd> · N msg".
  const sessGlyph = (status?: string) => {
    const v = (status ?? "").toLowerCase();
    if (v.includes("fail") || v.includes("error") || v.includes("denied") || v.includes("cancel")) return "bad";
    if (v) return "ok";
    return "none";
  };
  const relTime = (when?: string) => {
    if (!when) return "";
    const t = Date.parse(when.replace(" ", "T"));
    if (Number.isNaN(t)) return "";
    const mins = Math.max(0, Math.round((Date.now() - t) / 60000));
    if (mins < 60) return `${mins}m ago`;
    const hrs = Math.round(mins / 60);
    if (hrs < 24) return `${hrs}h ago`;
    return `${Math.round(hrs / 24)}d ago`;
  };
  const groupSessions = (query: string) => {
    const q = query.trim().toLowerCase();
    const filtered = q ? sessions.filter((s) => s.title.toLowerCase().includes(q)) : sessions;
    const today = new Date().toISOString().slice(0, 10);
    const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
    const groups: [string, typeof filtered][] = [];
    for (const s of filtered) {
      const date = s.desc.split("·")[0].trim();
      const label = date === today ? "Today" : date === yesterday ? "Yesterday" : "Earlier";
      const last = groups[groups.length - 1];
      if (last && last[0] === label) last[1].push(s);
      else groups.push([label, [s]]);
    }
    return groups;
  };
  const sessionGroups = groupSessions(palQuery);
  const railGroups = groupSessions(railQuery);
  const palRows = sessionGroups.flatMap(([, g]) => g);
  // Queued backlog shows above session history — picking one loads it into the
  // composer for editing and drops it from the queue.
  const palQueueRows = queue
    .map((text, i) => ({ text, i }))
    .filter((r) => !palQuery || r.text.toLowerCase().includes(palQuery.trim().toLowerCase()));
  const palPick = (idx: number) => {
    setPalOpen(false);
    if (idx === 0) cmd("/new");
    else if (idx <= palQueueRows.length) {
      const r = palQueueRows[idx - 1];
      if (r) {
        setQueue((q) => q.filter((_, j) => j !== r.i));
        setInput(r.text);
        taRef.current?.focus();
      }
    } else {
      const s = palRows[idx - 1 - palQueueRows.length];
      if (s) void send({ type: "resume", id: s.id });
    }
  };

  return (
    <div className={artSrc ? "app has-art" : "app"}>
      {artSrc && <div className="art-bg" style={{ backgroundImage: `url(${artSrc})` }} />}
      {palOpen && ready && (
        <div className="sesspal" onClick={(e) => { if (e.target === e.currentTarget) setPalOpen(false); }}>
          <div className="sesspal-dialog">
            <div className="pal-search">
              <Search size={13} />
              <input
                autoFocus
                type="text"
                placeholder="Search sessions…"
                value={palQuery}
                onChange={(e) => { setPalQuery(e.target.value); setPalIdx(0); }}
                onKeyDown={(e) => {
                  if (e.key === "Escape") setPalOpen(false);
                  else if (e.key === "ArrowDown") { e.preventDefault(); setPalIdx((i) => Math.min(i + 1, palRows.length + palQueueRows.length)); }
                  else if (e.key === "ArrowUp") { e.preventDefault(); setPalIdx((i) => Math.max(i - 1, 0)); }
                  else if (e.key === "Enter") { e.preventDefault(); palPick(palIdx); }
                }}
                spellCheck={false}
              />
            </div>
            <ScrollArea className="pal-list">
              <Button
                variant="ghost"
                data-active={palIdx === 0 || undefined}
                className="pal-row"
                onMouseEnter={() => setPalIdx(0)}
                onClick={() => palPick(0)}
              >
                <Plus size={13} />
                <span>New session</span>
              </Button>
              {palQueueRows.length > 0 && (
                <div>
                  <div className="pal-group-label">Queued</div>
                  {palQueueRows.map((r, k) => {
                    const idx = k + 1;
                    return (
                      <Button
                        key={`q-${r.i}`}
                        variant="ghost"
                        data-active={palIdx === idx || undefined}
                        title={r.text}
                        className="pal-row"
                        onMouseEnter={() => setPalIdx(idx)}
                        onClick={() => palPick(idx)}
                      >
                        <ListEnd size={13} />
                        <span className="truncate">{r.text}</span>
                      </Button>
                    );
                  })}
                </div>
              )}
              {sessionGroups.length === 0 && <p className="pal-empty">{palQuery ? "No matches." : "No sessions in this project yet."}</p>}
              {(() => {
                let row = 0;
                return sessionGroups.map(([label, group]) => (
                  <div key={label}>
                    <div className="pal-group-label">{label}</div>
                    {group.map((s) => {
                      const idx = ++row + palQueueRows.length;
                      return (
                        <Button
                          key={s.id}
                          variant="ghost"
                          data-active={palIdx === idx || undefined}
                          title={s.title}
                          className="pal-row"
                          onMouseEnter={() => setPalIdx(idx)}
                          onClick={() => palPick(idx)}
                        >
                          <span className="truncate">{s.title || "Untitled"}</span>
                          {s.id === sessionInfo.id && <span className="pal-current">current</span>}
                        </Button>
                      );
                    })}
                  </div>
                ));
              })()}
            </ScrollArea>
          </div>
        </div>
      )}
      {ready && !onboarding && railOpen && (
        <aside className="rail">
          <div className="rail-head">
            <button className="rail-proj" title="Change project" onClick={openProject}>
              <span className="truncate">{ready.project.name}</span>
              <ChevronDown size={12} />
            </button>
            <button className="rail-new" onClick={() => cmd("/new")}>
              <Plus size={13} />
              <span>New session</span>
            </button>
            <span className="modeseg rail-seg">
              <button className={`modeseg-btn${railTab === "sessions" ? " cur" : ""}`} onClick={() => setRailTab("sessions")}>Sessions</button>
              <button className={`modeseg-btn${railTab === "tasks" ? " cur" : ""}`} onClick={() => setRailTab("tasks")}>Tasks</button>
            </span>
          </div>
          {railTab === "sessions" && (
            <div className="rail-tools">
              <div className="rail-search">
                <Search size={12} />
                <input
                  type="text"
                  placeholder="Search sessions…"
                  value={railQuery}
                  onChange={(e) => setRailQuery(e.target.value)}
                  spellCheck={false}
                />
              </div>
            </div>
          )}
          <ScrollArea className="rail-list" onClick={() => setSessMenu(null)}>
            {railTab === "tasks" && queue.length === 0 && !wtasks.some((w) => w.phase !== "merged" && w.phase !== "discarded") && (
              <p className="pal-empty">No running tasks.</p>
            )}
            {railTab === "tasks" && queue.length > 0 && (
              <div>
                <div className="pal-group-label">Queued</div>
                {queue.map((text, i) => (
                  <Button
                    key={`q-${i}`}
                    variant="ghost"
                    title={text}
                    className="pal-row"
                    onClick={() => { setQueue((q) => q.filter((_, j) => j !== i)); setInput(text); taRef.current?.focus(); }}
                  >
                    <ListEnd size={13} />
                    <span className="truncate">{text}</span>
                  </Button>
                ))}
              </div>
            )}
            {railTab === "tasks" && wtasks.some((w) => w.phase !== "merged" && w.phase !== "discarded") && (
              <div>
                <div className="pal-group-label">Parallel tasks</div>
                {wtasks
                  .filter((w) => w.phase !== "merged" && w.phase !== "discarded")
                  .map((w) => (
                    <div className="rail-worker" key={w.id}>
                      <div className="pal-row rail-worker-row" title={w.text}>
                        <span className="truncate">{w.text}</span>
                        <span className={`rail-phase ${w.phase}`}>
                          {w.phase === "running" ? "running" : w.phase === "done" ? "done" : "failed"}
                        </span>
                      </div>
                      <div className="rail-menu">
                        {w.phase === "running" && (
                          <button className="rail-menu-btn" title={w.status} onClick={() => stopWorker(w.id)}>stop + discard</button>
                        )}
                        {w.phase === "done" && (
                          <>
                            <button className="rail-menu-btn" onClick={() => void resolveWorker(w.id, true)}>merge</button>
                            <button className="rail-menu-btn" onClick={() => void resolveWorker(w.id, false)}>discard</button>
                          </>
                        )}
                        {w.phase === "failed" && (
                          <button className="rail-menu-btn" title={w.result} onClick={() => void resolveWorker(w.id, false)}>discard</button>
                        )}
                      </div>
                    </div>
                  ))}
              </div>
            )}
            {railTab === "sessions" && railGroups.length === 0 && <p className="pal-empty">{railQuery ? "No matches." : "No sessions in this project yet."}</p>}
            {railTab === "sessions" && railGroups.map(([label, group]) => (
              <div key={label}>
                <div className="pal-group-label">{label}</div>
                {group.map((s) => {
                  const current = s.id === sessionInfo.id;
                  return (
                    <div key={s.id} className="rail-sess">
                      <div
                        className="pal-row rail-sessrow"
                        data-active={current || undefined}
                        title={s.title}
                        onClick={() => { if (!current) void send({ type: "resume", id: s.id }); }}
                      >
                        {current && running ? (
                          <span className="rail-glyph rail-live" />
                        ) : (
                          <span className={`rail-glyph ${sessGlyph(s.status)}`} />
                        )}
                        <span className="rail-sessmain">
                          <span className="truncate">{s.title || "Untitled"}</span>
                          <span className="rail-sessmeta">
                            {current ? "current" : relTime(s.when)}
                            {s.files && s.files.length > 0 ? ` · ${s.files.length} files` : ""}
                          </span>
                        </span>
                        <button
                          className="rail-act"
                          title="Session actions"
                          onClick={(e) => { e.stopPropagation(); setSessMenu((m) => (m === s.id ? null : s.id)); }}
                        >
                          ⋯
                        </button>
                      </div>
                      {sessMenu === s.id && (
                        <div className="rail-menu">
                          {s.status && <div className="rail-menu-info">{s.status}{s.files && s.files.length > 0 ? ` · ${s.files.length} files` : ""}</div>}
                          {s.task && (
                            <button className="rail-menu-btn" onClick={() => { setInput(s.task ?? ""); setSessMenu(null); taRef.current?.focus(); }}>re-run prompt</button>
                          )}
                          {s.files && s.files.length > 0 && (
                            <button
                              className="rail-menu-btn"
                              onClick={() => {
                                setDocView({ title: `Changed files — ${s.title}`, text: `\`\`\`\n${s.files?.join("\n") ?? ""}\n\`\`\`` });
                                setSessMenu(null);
                              }}
                            >
                              view changed files
                            </button>
                          )}
                          {s.task && (
                            <button className="rail-menu-btn" onClick={() => { void navigator.clipboard.writeText(s.task ?? ""); setSessMenu(null); }}>copy task</button>
                          )}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            ))}
          </ScrollArea>
        </aside>
      )}
      <div className="main">
      <header className={`header${IS_MAC ? " mac" : ""}`} data-tauri-drag-region>
        <div className="hctx" data-tauri-drag-region>
          {!onboarding && <Logo className="logo-mark" />}
          {ready && !onboarding && (
            <Button
              variant="ghost"
              size="icon"
              className="rail-toggle"
              title={railOpen ? "Hide sidebar (⌘B)" : "Show sidebar (⌘B)"}
              onClick={() => setRailOpen((v) => !v)}
            >
              <PanelLeft size={14} />
            </Button>
          )}
        </div>
        <span className="spacer" />
        {ready && !IS_MAC && (
          <div className="hact">
            <Button variant="ghost" size="icon" title="Minimize" onClick={() => void win.minimize()}>
              <Minus size={14} />
            </Button>
            <Button variant="ghost" size="icon" title="Maximize" onClick={() => void win.toggleMaximize()}>
              <Square size={12} />
            </Button>
            <Button variant="ghost" size="icon" title="Close" className="win-close" onClick={() => void win.close()}>
              <X size={14} />
            </Button>
          </div>
        )}
      </header>

      {settingsOpen && ready && (
        <div className="settings" onClick={(e) => { if (e.target === e.currentTarget) setSettingsOpen(false); }}>
          <div className="settings-dialog">
            <nav className="settings-nav">
              <div className="settings-nav-title">Settings</div>
              {(["general", "providers", "appearance", "session", "about"] as const).map((tab) => {
                const Icon = { general: SlidersHorizontal, providers: Cpu, appearance: Palette, session: History, about: Info }[tab];
                return (
                  <Button
                    key={tab}
                    variant={settingsTab === tab ? "secondary" : "ghost"}
                    size="sm"
                    className="settings-navitem"
                    data-active={settingsTab === tab}
                    onClick={() => setSettingsTab(tab)}
                  >
                    <Icon size={14} />
                    {{ general: "General", providers: "Providers & Models", appearance: "Appearance", session: "Session", about: "About" }[tab]}
                  </Button>
                );
              })}
            </nav>
            <ScrollArea className="settings-pane">
              {settingsTab === "general" && (
                <div className="setgroup">
                  <div className="setgroup-title">General</div>
                  <div className="setlist">
                    <div className="setrow static"><span className="setlabel">Project</span><span className="setval mono">{ready.project.name}</span></div>
                    <SetAction label="Open a project…" onClick={openProject} />
                    <SetAction label="Run setup…" onClick={() => cmd("/setup")} />
                  </div>
                </div>
              )}
              {settingsTab === "providers" && (
                <div className="setgroup">
                  <div className="setgroup-title">Providers & Models</div>
                  <div className="setlist">
                    <SetSelect
                      label="Provider"
                      value={ready.provider}
                      options={ready.providers && ready.providers.length ? ready.providers : [ready.provider]}
                      extra={["connect a provider…"]}
                      onChange={(v) => v === "connect a provider…" ? cmd("/providers") : void send({ type: "command", name: `/provider ${v}` })}
                    />
                    <SetSelect
                      label="Model"
                      value={ready.model}
                      options={modelOpts.length ? modelOpts : [ready.model]}
                      onChange={(v) => v === "custom…" ? cmd("/model") : void send({ type: "command", name: `/model ${v}` })}
                      extra={["custom…"]}
                    />
                    <SetSelect
                      label="Reasoning effort"
                      value={ready.effort ?? "default"}
                      options={[...EFFORT_LEVELS]}
                      onChange={(v) => void send({ type: "command", name: `/effort ${v}` })}
                    />
                    <SetSelect
                      label="Model variant"
                      value={ready.variant ?? "default"}
                      options={["default", ...(ready.variants ?? [])]}
                      onChange={(v) => void send({ type: "command", name: `/variant ${v}` })}
                    />
                    <div className="setrow static">
                      <span className="setlabel">Approval mode</span>
                      <span className="modeseg">
                        {(["ask", "always-approve", "smart (Jev)"] as const).map((m) => (
                          <button
                            key={m}
                            className={`modeseg-btn${(ready.mode === "smart" ? "smart (Jev)" : ready.mode) === m ? " cur" : ""}`}
                            onClick={() => void send({ type: "command", name: `/approval ${m}` })}
                          >
                            {m}
                          </button>
                        ))}
                      </span>
                    </div>
                  </div>
                </div>
              )}
              {settingsTab === "appearance" && (
                <div className="setgroup">
                  <div className="setgroup-title">Appearance</div>
                  <div className="setlist">
                    <div className="setrow static">
                      <span className="setlabel">Theme{artSrc ? <span className="setdesc">Dark while art is set</span> : null}</span>
                      <span className="modeseg" onMouseLeave={() => setPreviewTheme(null)}>
                        {(["system", "light", "dark"] as const).map((t) => (
                          <button
                            key={t}
                            disabled={artSrc != null}
                            className={`modeseg-btn${theme === t ? " cur" : ""}`}
                            onMouseEnter={() => setPreviewTheme(t)}
                            onClick={() => { setTheme(t); setPreviewTheme(null); }}
                          >
                            {t}
                          </button>
                        ))}
                      </span>
                    </div>
                    <div className="setrow static artsect">
                      <span className="setlabel">Art</span>
                    </div>
                    <div className="artgrid">
                      {ART_PIECES.map((p) => (
                        <button
                          key={p.id}
                          className={`artthumb${artPiece === p.id ? " cur" : ""}`}
                          title={`${p.title} — ${p.artist}`}
                          onClick={() => setArtPiece(artPiece === p.id ? "" : p.id)}
                        >
                          <img src={p.src} alt={p.title} />
                          <span className="artthumb-name">{p.title}</span>
                        </button>
                      ))}
                    </div>
                    <SetRow
                      label="Custom folder"
                      value={artDirLabel || "None"}
                      onClick={() => void invoke<string | null>("pick_folder").then((dir) => { if (dir) { setArtPiece(""); setArtDir(dir); } })}
                    />
                    {artLabel && (
                      <SetAction label="Clear art" onClick={() => { setArtPiece(""); setArtDir(""); }} />
                    )}
                  </div>
                </div>
              )}
              {settingsTab === "session" && (
                <div className="setgroup">
                  <div className="setgroup-title">Session</div>
                  <div className="setlist">
                    <div className="setrow static"><span className="setlabel">Session ID</span><span className="setval mono">{sessionInfo.id ?? "—"}</span></div>
                    <div className="setrow static"><span className="setlabel">Context</span><span className="setval mono">{sessionInfo.tokens ? `~${sessionInfo.tokens >= 1000 ? (sessionInfo.tokens / 1000).toFixed(1) + "k" : sessionInfo.tokens} tok / 60k cap` : "—"}</span></div>
                    <SetAction label="Resume a session…" onClick={() => { setSettingsOpen(false); setPalOpen(true); }} />
                    <SetAction label="Compact context" onClick={() => cmd("/compact")} />
                    <SetAction label="Undo last checkpoint" onClick={() => cmd("/undo")} />
                    <SetAction label="Start new session" onClick={() => cmd("/new")} />
                  </div>
                </div>
              )}
              {settingsTab === "about" && (
                <div className="setgroup">
                  <div className="setgroup-title">About</div>
                  <div className="setlist">
                    <div className="setrow static"><span className="setlabel">Version</span><span className="setval mono">v{ready.version}</span></div>
                    {update?.status === "downloading" && (
                      <div className="setrow static"><span className="setlabel">Update</span><span className="setval mono">downloading v{update.version}…</span></div>
                    )}
                    {update?.status === "ready" && (
                      <SetAction label={`Update ready — v${update.version} · restart to apply`} onClick={() => void relaunch()} />
                    )}
                    <SetAction label="Documentation" onClick={() => cmd("/docs")} />
                    <SetAction label="Changelog" onClick={() => cmd("/changelog")} />
                    <SetAction label="Quit dxxpcode" onClick={() => cmd("/exit")} danger />
                  </div>
                </div>
              )}
            </ScrollArea>
          </div>
        </div>
      )}
      {docView && (
        <div className="docviewer" onClick={(e) => { if (e.target === e.currentTarget) setDocView(null); }}>
          <div className="card doc-card">
            <div className="card-title">
              {docView.title}
              <span className="spacer" />
              <button className="doc-close" onClick={() => setDocView(null)} aria-label="Close">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M18 6L6 18M6 6l12 12"/></svg>
              </button>
            </div>
            <div className="doc-body text" dangerouslySetInnerHTML={md(docView.text)} />
          </div>
        </div>
      )}
      {onboarding && !settingsOpen && !docView && (
        <div className="onboarding">
          <img className="ob-art" src={artSrc ?? artWanderer} alt="" />
          <div className="ob-veil" />
          {obStep === "welcome" && (
            <button className="ob-skip" onClick={() => setOnboarding(false)}>skip</button>
          )}
          {obStep !== "welcome" && (
            <button className="ob-back" onClick={() => goStep(obStep === "key" ? "pick" : obStep === "pick" ? "welcome" : "pick")} aria-label="Back">
              ‹
            </button>
          )}
          <div className={`ob-stage ${obDir}`} key={obStep}>
            {obStep === "welcome" && (
              <>
                <Logo className="ob-mark" />
                <div className="ob-title">The AI coding agent on your desktop.</div>
                <p className="ob-desc">Local. Private. Yours.</p>
                <div className="setbtns">
                  <button className="btn primary" onClick={() => goStep("pick")}>Get started</button>
                </div>
                <p className="ob-hint">Re-run anytime with /setup or Settings → Run setup</p>
              </>
            )}
            {obStep === "pick" && (
              <>
                <div className="ob-title">Connect a provider.</div>
                <div className="ob-seg">
                  {OB_PROVIDERS.filter((p) => OB_MAIN.includes(p.id)).map((p) => (
                    <button key={p.id} className="ob-seg-opt" onClick={() => { setObProvider(p.id); goStep("key"); setObError(null); }}>
                      {p.name}
                    </button>
                  ))}
                  <button className="ob-seg-opt" onClick={() => { setObBusy(true); void send({ type: "setup", provider: "mock" }); }}>
                    Just explore
                  </button>
                </div>
                <button className="ob-more" onClick={() => setObMore((m) => !m)}>
                  {obMore ? "Fewer providers" : "More providers"}
                  <span className={`ob-more-chev${obMore ? " up" : ""}`}>⌄</span>
                </button>
                {obMore && (
                  <div className="ob-providers">
                    {OB_PROVIDERS.filter((p) => !OB_MAIN.includes(p.id)).map((p) => (
                      <button key={p.id} className="ob-prov" onClick={() => { setObProvider(p.id); goStep("key"); setObError(null); }}>
                        <span className="ob-prov-name">{p.name}</span>
                        <span className="ob-prov-desc">{p.desc}</span>
                      </button>
                    ))}
                  </div>
                )}
              </>
            )}
            {obStep === "project" && (
              <>
                <div className="ob-title">Open a project.</div>
                <p className="ob-desc">Pick the folder dxxpcode works in.{ready ? ` Currently ${ready.project.name}.` : ""}</p>
                <div className="setbtns">
                  <button className="btn primary" onClick={() => goStep("first")}>Use {ready?.project.name ?? "this folder"}</button>
                  <button className="btn ghost" onClick={openProject}>Choose folder…</button>
                </div>
                <p className="ob-hint">Switch anytime with Settings → Open a project</p>
              </>
            )}
            {obStep === "first" && (
              <>
                <div className="ob-title">See it work.</div>
                <p className="ob-desc">One prompt, before you touch a real project.</p>
                <div className="ob-panel">
                  <div className="ob-panel-title">Write a summary file</div>
                  <div className="ob-panel-sub">The agent reads the project, proposes a plan, and asks before it writes anything.</div>
                </div>
                <div className="setbtns">
                  <button
                    className="btn primary"
                    onClick={() => {
                      setOnboarding(false);
                      void send({ type: "submit", text: "Create a file named DXXPCODE.md in this project containing a one-sentence summary of what this project does." });
                    }}
                  >
                    Run first task
                  </button>
                  <button className="btn ghost" onClick={() => setOnboarding(false)}>Not now</button>
                </div>
                <p className="ob-hint">You'll approve the change before anything lands</p>
              </>
            )}
            {obStep === "key" && (
              <>
                <div className="ob-title">{OB_PROVIDERS.find((p) => p.id === obProvider)?.name ?? "Provider"} API key</div>
                <p className="ob-desc">Stored on this machine — validated before it's saved.</p>
                <div className={`ob-keywrap${obError ? " err" : ""}`}>
                  <input
                    className="ob-input ob-key mono"
                    id="ob-key"
                    type="password"
                    autoFocus
                    placeholder={{ anthropic: "sk-ant-…", openrouter: "sk-or-…", groq: "gsk_…", xai: "xai-…" }[obProvider] ?? "API key"}
                    value={obKey}
                    onChange={(e) => { setObKey(e.target.value.trim()); setObError(null); }}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && obKey.trim() && !obBusy) {
                        setObBusy(true);
                        void send({ type: "setup", provider: obProvider === "anthropic" ? "anthropic" : "openai", key: obKey.trim(), base_url: OB_BASE[obProvider] ?? (obBase.trim() || undefined) });
                      }
                    }}
                  />
                  {obBusy && <span className="ob-spinner" />}
                </div>
                {obProvider === "custom" && (
                  <input
                    className="ob-input mono"
                    type="text"
                    placeholder="Base URL — blank for api.openai.com"
                    value={obBase}
                    onChange={(e) => setObBase(e.target.value)}
                  />
                )}
                {obError && <p className="ob-error">{obError}</p>}
                <div className="setbtns">
                  <button
                    className="btn primary ob-continue"
                    disabled={!obKey.trim() || obBusy}
                    onClick={() => {
                      setObBusy(true);
                      void send({ type: "setup", provider: obProvider === "anthropic" ? "anthropic" : "openai", key: obKey.trim(), base_url: OB_BASE[obProvider] ?? (obBase.trim() || undefined) });
                    }}
                  >
                    {obBusy ? "Validating" : "Continue"}<span className="ob-arrow">→</span>
                  </button>
                </div>
              </>
            )}
          </div>
          <div className="ob-progress">
            <div
              className="ob-progress-fill"
              style={{ width: `${(({ welcome: 1, pick: 2, key: 2, project: 3, first: 3 })[obStep] / 3) * 100}%` }}
            />
          </div>
        </div>
      )}
      <div className="transcript" ref={scrollRef} onScroll={onTranscriptScroll} style={settingsOpen ? { visibility: "hidden" } : undefined}>
        {(!ready || !bootGone) && (
          <div className={`boot${ready ? " out" : ""}`}>
            <div className="boot-logo">
              <Logo className="boot-mark" />
              <Logo className="boot-shine" />
            </div>
            <span className="boot-word">starting engine…</span>
          </div>
        )}
        {items.length === 0 && approvals.length === 0 && ready && !onboarding && (
          <div className="hero">
            <Logo className="hero-mark" />
            <div className="hero-title">What should we build in
              <button className="hero-proj" title="Change project" onClick={openProject}>
                {ready.project.name}
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="m6 9 6 6 6-6"/></svg>
              </button>?
            </div>
          </div>
        )}
        {groupItems(items).map((seg, si) =>
          Array.isArray(seg) ? (
            <TGroup key={`g${si}`} seg={seg} running={running} lastIdx={items.length - 1} />
          ) : (
            <ItemView key={seg.idx} item={seg.item} streaming={running && seg.idx === items.length - 1} />
          ),
        )}
        {approvals.map((a) => (
          a.answered ? (
            <div className={`dresolved row${a.answered === "n" ? " deny" : " ok"}`} key={`ap${a.id}`}>
              <span className="dres-mark">{a.answered === "n" ? "✗" : "✓"}</span>
              {a.answered === "n" ? "Denied" : a.answered === "a" ? "Always allow" : a.answered === "s" ? "Approved + saved" : "Allowed"}
              {a.tool && <span className="dres-tool">{TOOL_DISPLAY[a.tool] ?? a.tool}</span>}
            </div>
          ) : (
            <div className="row decision" key={`ap${a.id}`}>
              <div className="dec-head">
                <span className="dres-dot" />Approval required
                {a.tool && <span className="dec-tool">{TOOL_DISPLAY[a.tool] ?? a.tool}</span>}
              </div>
              <ApprovalSummary text={a.summary} kind={a.kind} />
              {a.reason && <div className="reason">Reason: {a.reason}</div>}
              <div className="dec-acts">
                <button className="pill allow" onClick={() => answer(a.id, "y")}>Allow</button>
                <button className="pill deny" onClick={() => answer(a.id, "n")}>Deny</button>
                {a.allowAlways && <button className="pill ghost" onClick={() => answer(a.id, "a")}>Always allow</button>}
                {a.extraChoice && <button className="pill ghost" onClick={() => answer(a.id, a.extraChoice!.choice)}>{a.extraChoice.label}</button>}
              </div>
            </div>
          )
        ))}
        {diffs.map((d) => {
          const st = diffStats(d.diff);
          if (d.decided) {
            return (
              <div className={`dresolved row${d.decided === "discard" ? " deny" : " ok"}`} key={`df${d.id}`}>
                <span className="dres-mark">{d.decided === "discard" ? "✗" : "✓"}</span>
                {d.path.split("/").pop()} {d.decided === "discard" ? "discarded" : "applied"}
                <span className="dres-tool">+{st.add} −{st.del}</span>
              </div>
            );
          }
          return (
            <div className="row decision" key={`df${d.id}`}>
              <div className="dec-head">
                <span className="dres-dot" />Review change <span className="dec-tool">{d.path}</span> <span className="diffstat"><span className="ds-add">+{st.add}</span><span className="ds-del">−{st.del}</span></span>
              </div>
              <Diff diff={d.diff} />
              <div className="dec-acts">
                <button className="pill allow" onClick={() => decideDiff(d.id, "apply")}>Apply</button>
                <button className="pill deny" onClick={() => decideDiff(d.id, "discard")}>Discard</button>
                <button className="pill ghost" onClick={() => decideDiff(d.id, "apply_all")}>Apply all</button>
              </div>
            </div>
          );
        })}
      </div>

      <div className="statusline">
        <span className="statusline-act">
          {(status || tokRate > 0 || approvals.some((a) => !a.answered) || diffs.some((d) => !d.decided)) && <><span className="pulse" /><span className="statustext">{approvals.some((a) => !a.answered) || diffs.some((d) => !d.decided) ? "Waiting for approval…" : status}</span>{tokRate > 0 && <span className="tokrate">{tokRate} tok/s</span>}{running && <span style={{ color: "var(--faint)" }}>· esc to interrupt</span>}</>}
          {queue.length > 0 && <span className="queuecount">+{queue.length} queued</span>}
        </span>
        {ready && (
          <span className="statusline-ctx">
            <button className="inctx" title="Change project" onClick={openProject}>
              <span className="inctx-name">{ready.project.name}</span>
              {ready.project.git && (
                <span className="branch mono">{ready.project.git.branch}{ready.project.git.dirty ? "*" : ""}</span>
              )}
              <ChevronDown size={11} />
            </button>
            <span className="statusline-model">
              {ready.model} · {ready.effort ?? "default"}{ready.variant ? ` · ${ready.variant}` : ""}
            </span>
          </span>
        )}
      </div>

      {menu && (
        <div className="menu-card">
          <div className="card-title">{menu.title}</div>
          <div className="menu-opts">
            {menu.options.map((o, i) => (
              <button
                key={i}
                className={`menu-opt${i === menu.current ? " cur" : ""}`}
                disabled={menu.answered !== undefined}
                onClick={() => pickMenu(i)}
              >
                <span className="menu-label">{o.label}</span>
                {o.desc && <span className="menu-desc">{o.desc}</span>}
              </button>
            ))}
          </div>
          <div className="btns">
            <button className="btn deny" onClick={() => pickMenu(-1)}>Cancel</button>
          </div>
        </div>
      )}
      {promptReq && (
        <div className="menu-card">
          <div className="card-title">{promptReq.title}</div>
          <div className="prompt-row">
            <input
              autoFocus
              type={promptReq.secret ? "password" : "text"}
              value={promptVal}
              onChange={(e) => setPromptVal(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") submitPrompt();
                else if (e.key === "Escape") {
                  setPromptReq(null);
                  void send({ type: "prompt_submit", id: promptReq.id, text: "" });
                }
              }}
            />
            <button className="btn allow" onClick={submitPrompt}>OK</button>
          </div>
        </div>
      )}
      <div className="composer">
        {palette.length > 0 && (
          <div className="palette">
            {palette.map((c, i) => (
              <button
                key={c.name}
                className={`palette-row${i === Math.min(cmdSel, palette.length - 1) ? " sel" : ""}`}
                onMouseDown={(e) => {
                  e.preventDefault();
                  setInput(c.name);
                  setCmdSel(0);
                  taRef.current?.focus();
                }}
              >
                <span className="mono pcmd">{c.name}</span>
                <span className="pdesc">{c.desc}</span>
              </button>
            ))}
          </div>
        )}
        {palette.length === 0 && files.length > 0 && (
          <div className="palette">
            {files.map((f, i) => (
              <button
                key={f.name}
                className={`palette-row${i === Math.min(cmdSel, files.length - 1) ? " sel" : ""}`}
                onMouseDown={(e) => {
                  e.preventDefault();
                  completeMention(f.name);
                }}
              >
                <span className="mono pcmd">{f.name}</span>
                <span className="pdesc">{f.desc}</span>
              </button>
            ))}
          </div>
        )}
        {queue.length > 0 && (
          <div className="queuelist">
            {queue.map((text, i) => (
              <div className="queuerow" key={`${i}-${text.slice(0, 12)}`}>
                <span className="qlabel mono">{i === 0 ? "next" : `+${i}`}</span>
                <span className="qtext truncate">{text}</span>
                {ready?.project.git && (
                  <button
                    className="qdrop"
                    title="Run now in a git worktree"
                    onClick={() => void startParallel(text, i)}
                  >
                    <GitBranch size={11} />
                  </button>
                )}
                <button
                  className="qdrop"
                  title="Drop from queue"
                  onClick={() => setQueue((q) => q.filter((_, j) => j !== i))}
                >
                  <X size={11} />
                </button>
              </div>
            ))}
          </div>
        )}
        {wtasks.some((w) => w.phase !== "merged" && w.phase !== "discarded") && (
          <div className="queuelist">
            {wtasks
              .filter((w) => w.phase !== "merged" && w.phase !== "discarded")
              .map((w) => (
                <div className="queuerow workerrow" key={w.id}>
                  <span className="qlabel mono">{w.phase === "running" ? "‖" : w.phase === "done" ? "✓" : "×"}</span>
                  <span className="qtext truncate">{w.text}</span>
                  {w.phase === "running" && (
                    <>
                      <span className="wstatus mono truncate">{w.status}</span>
                      <button className="qdrop" title="Stop + discard worktree" onClick={() => stopWorker(w.id)}>
                        <X size={11} />
                      </button>
                    </>
                  )}
                  {w.phase === "done" && (
                    <>
                      <button className="wact mono" onClick={() => void resolveWorker(w.id, true)}>merge</button>
                      <button className="wact mono" onClick={() => void resolveWorker(w.id, false)}>discard</button>
                    </>
                  )}
                  {w.phase === "failed" && (
                    <button className="wact mono" title={w.result} onClick={() => void resolveWorker(w.id, false)}>discard</button>
                  )}
                </div>
              ))}
          </div>
        )}
        <div className="inputbox">
          <div className="inputrow">
          <span className="prompt-glyph">❯</span>
          <div className="ghost-wrap">
            {input && (
              <div className="ghost-mirror" aria-hidden="true">
                <span className="ghost-src">{input}</span>
                <span className="ghost-hint"> · / commands · @ files</span>
              </div>
            )}
            <textarea
            ref={taRef}
            rows={1}
            autoFocus
            placeholder={chatMode ? "Ask about this codebase…" : "Ask dxxpcode anything…"}
            value={input}
            onChange={(e) => {
              setInput(e.target.value);
              e.target.style.height = "auto";
              e.target.style.height = Math.min(e.target.scrollHeight, 140) + "px";
            }}
            onKeyDown={(e) => {
              const rows = palette.length > 0 ? palette.length : files.length;
              if (rows > 0 && e.key === "ArrowDown") {
                e.preventDefault();
                setCmdSel((s) => (s + 1) % rows);
              } else if (rows > 0 && e.key === "ArrowUp") {
                e.preventDefault();
                setCmdSel((s) => (s - 1 + rows) % rows);
              } else if (e.key === "Tab" && files.length > 0) {
                e.preventDefault();
                completeMention(files[Math.min(cmdSel, files.length - 1)].name);
                setCmdSel(0);
              } else if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                submit();
              } else if (e.key === "Escape") {
                if (palette.length > 0 || files.length > 0) {
                  setFileSugs({ id: -1, items: [] });
                  if (palette.length > 0) setInput("");
                } else if (running) void send({ type: "cancel" });
              }
            }}
            />
          </div>
          {input.trim() && (
            <button
              className="sendhint"
              title="Send"
              onMouseDown={(e) => {
                e.preventDefault();
                submit();
              }}
            >→</button>
          )}
          </div>
          {ready && (
            <div className={`subline${running ? " dim" : ""}`}>
              <span className="subline-hint">
                {running ? "esc to interrupt" : "⏎ send · ⇧⏎ newline"}
              </span>
            </div>
          )}
        </div>
      </div>
      </div>
    </div>
  );
}

function ItemView({ item, streaming }: { item: Item; streaming?: boolean }) {
  switch (item.k) {
    case "user":
      return <div className="usermsg row"><span className="chev">❯</span>{item.text}</div>;
    case "text":
      return (
        <div className="text row">
          <span dangerouslySetInnerHTML={streaming ? mdStream(item.text) : md(item.text)} />
          {streaming && <span className="caret" aria-hidden />}
          {item.interrupted && <span className="interrupted">— interrupted</span>}
        </div>
      );
    case "think":
      // Reasoning tokens: live dim stream while arriving, collapsible after.
      return item.live ? (
        <div className="think row">
          <div className="think-head"><span className="think-dot" /><span className="think-shimmer">Thinking</span></div>
          <div className="think-text">{item.text}<span className="caret tool-caret" aria-hidden /></div>
        </div>
      ) : (
        <details className="think row">
          <summary>
            {item.ms != null ? `Thought for ${Math.max(1, Math.round(item.ms / 1000))}s` : "Thought"}
            <span className="think-n">{item.text.trim().split("\n")[0].slice(0, 64)}{(item.text.trim().split("\n")[0] ?? "").length > 64 || item.text.includes("\n") ? "…" : ""}</span>
          </summary>
          <div className="think-text">{item.text}</div>
        </details>
      );
    case "tool":
      return <ToolRow item={item} />;
    case "plan":
      return (
        <div className="card plan row">
          <div className="card-title">Plan</div>
          <div className="card-body">
            {item.plan.summary && <div style={{ marginBottom: 6, color: "var(--dim)" }}>{item.plan.summary}</div>}
            {item.plan.steps.map((s, i) => (
              <div className="plan-step" key={i}><span className="n">{i + 1}</span><span>{s}</span></div>
            ))}
          </div>
        </div>
      );
    case "todos":
      return (
        <div className="card todos row">
          <div className="card-title">Tasks</div>
          <div className="card-body">
            {item.items.map((t, i) => (
              <div className={`todo-item ${t.status === "completed" ? "done" : t.status === "in_progress" ? "active" : ""}`} key={i}>
                <span className="mark">{t.status === "completed" ? "✓" : t.status === "in_progress" ? "▶" : "○"}</span>
                <span className="lbl">{t.status === "in_progress" && t.activeForm ? t.activeForm : t.content}</span>
              </div>
            ))}
          </div>
        </div>
      );
    case "table":
      return (
        <div className="card row">
          <div className="card-title">{item.title}</div>
          <div className="card-body">
            <table className="kv">
              <tbody>
                {item.rows.map(([k, v], i) => (
                  <tr key={i}><td className="k">{k}</td><td className="v mono">{v}</td></tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      );
    case "markdown":
      return (
        <div className="card row">
          <div className="card-title">{item.title}</div>
          <div className="card-body text" dangerouslySetInnerHTML={md(item.text)} />
        </div>
      );
    case "diffcard":
      return (
        <div className="card row">
          <div className="card-title">{item.title}</div>
          <div className="card-body" style={{ padding: "8px 0" }}>
            <Diff diff={item.diff} />
          </div>
        </div>
      );
    case "note":
      return <div className={`note row${item.steer ? " steer" : ""}`}>{item.steer ? "⎿ " : ""}{item.text}</div>;
    case "error":
      return (
        <div className="errrow row">
          <span className="erricon">✗</span>
          <div className="errbody">
            <div>{item.text}</div>
            {item.hint && <div className="errhint">{item.hint}</div>}
            {item.detail && (
              <details className="errdetail"><summary>details</summary><pre>{item.detail}</pre></details>
            )}
          </div>
        </div>
      );
    case "denied":
      return <div className="note row" style={{ color: "var(--red)" }}>⎿ Denied: {item.reason} ({item.tool})</div>;
    case "done": {
      const bits = [
        item.filesChanged.length > 0 ? `${item.filesChanged.length} file${item.filesChanged.length === 1 ? "" : "s"}` : null,
        item.secs != null ? fmtDuration(item.secs) : null,
        item.tokens ? fmtK(item.tokens) + " tok" : null,
      ].filter(Boolean).join(" · ");
      return (
        <div className="done row">
          <span className={`st ${item.status === "completed" ? "ok" : item.status === "error" ? "err" : "warn"}`}>
            {item.status === "completed" ? "Completed" : item.status}
          </span>
          {bits && <span className="meta">{bits}</span>}
          {item.filesChanged.length > 0 && (
            <ul>{item.filesChanged.map((f) => <li className="mono" key={f}>{f}</li>)}</ul>
          )}
        </div>
      );
    }
    case "raw":
      return <div className="note row mono">{item.text}</div>;
  }
}

const Chevron = (
  <svg className="chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M9 6l6 6-6 6"/></svg>
);

function SetSelect({ label, desc, value, options, extra, onChange }: { label: string; desc?: string; value: string; options: string[]; extra?: string[]; onChange: (v: string) => void }) {
  const opts = [...options, ...(extra ?? [])];
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false); };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => { window.removeEventListener("mousedown", onDown); window.removeEventListener("keydown", onKey); };
  }, [open]);
  return (
    <div className="setrow static" ref={ref}>
      <span className="setlabel">{label}{desc && <span className="setdesc">{desc}</span>}</span>
      <div className="setdd">
        <button type="button" className="setdd-btn" onClick={() => setOpen((o) => !o)}>
          <span className="setdd-val">{value}</span>
          <ChevronDown size={11} className="setdd-caret" />
        </button>
        {open && (
          <div className="setdd-menu" role="listbox">
            {opts.map((o) => (
              <button
                key={o}
                type="button"
                role="option"
                aria-selected={o === value}
                className={`setdd-item${o === value ? " cur" : ""}`}
                onClick={() => { setOpen(false); onChange(o); }}
              >
                <span className="setdd-check">{o === value ? "✓" : ""}</span>
                {o}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function SetRow({ label, desc, value, onClick }: { label: string; desc?: string; value: string; onClick: () => void }) {
  return (
    <button className="setrow link" onClick={onClick}>
      <span className="setlabel">{label}{desc && <span className="setdesc">{desc}</span>}</span>
      <span className="setval">{value}</span>
      {Chevron}
    </button>
  );
}

function SetAction({ label, desc, onClick, danger }: { label: string; desc?: string; onClick: () => void; danger?: boolean }) {
  return (
    <button className={`setrow link${danger ? " danger" : ""}`} onClick={onClick}>
      <span className="setlabel">{label}{desc && <span className="setdesc">{desc}</span>}</span>
      {Chevron}
    </button>
  );
}

function fmtDuration(secs: number) {
  if (secs < 60) return `${secs}s`;
  const m = Math.floor(secs / 60);
  const s = secs % 60;
  return s ? `${m}m ${s}s` : `${m}m`;
}

function fmtK(n: number) {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : `${n}`;
}

function Elapsed({ since }: { since: number }) {
  const [, tick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, []);
  const s = Math.floor((Date.now() - since) / 1000);
  return <span className="elapsed">{s}s</span>;
}

function TGroup({ seg, running, lastIdx }: { seg: Grouped[]; running: boolean; lastIdx: number }) {
  const anyPending = seg.some((g) => g.item.k === "tool" && g.item.pending);
  const [open, setOpen] = useState(true);
  useEffect(() => {
    setOpen(anyPending || seg.length === 1);
  }, [anyPending, seg.length]);
  // A single tool stays as one quiet line; a finished run collapses to "N tools".
  if (seg.length === 1) {
    const it = seg[0];
    return (
      <div className="tgroup">
        <ItemView item={it.item} streaming={running && it.idx === lastIdx} />
      </div>
    );
  }
  return (
    <div className="tgroup">
      <button
        className="tg-summary"
        onClick={() => setOpen((v) => !v)}
      >
        <span className={`tg-dot${anyPending ? " live" : ""}`} />{seg.length} tools
      </button>
      {open && (
        <div className="tg-body">
          {seg.map((it) => (
            <ItemView key={it.idx} item={it.item} streaming={running && it.idx === lastIdx} />
          ))}
        </div>
      )}
    </div>
  );
}

function ToolRow({ item }: { item: Extract<Item, { k: "tool" }> }) {
  const name = TOOL_DISPLAY[item.tool] ?? item.tool;
  const first = item.out?.split("\n").filter((l) => l.trim())[0]?.slice(0, 120);
  // While running, show the tail of the streamed output; once finished it
  // collapses into the usual details/summary.
  const tail = item.pending && item.out?.trim()
    ? item.out.trimEnd().split("\n").slice(-6).join("\n")
    : null;
  return (
    <div className={`tool row${item.isError ? " err" : ""}`}>
      <div className="head">
        <span className="name">{name}</span>
        {item.arg && <span className="arg">{item.arg}</span>}
        {item.pending && (
          <>
            <span className="caret tool-caret" aria-hidden />
            {item.startedAt && <Elapsed since={item.startedAt} />}
          </>
        )}
      </div>
      {item.think && (
        <details className="think tool-think">
          <summary>
            {item.think.ms != null ? `Thought for ${Math.max(1, Math.round(item.think.ms / 1000))}s` : "Thought"}
            <span className="think-n">{item.think.text.trim().split("\n")[0].slice(0, 64)}…</span>
          </summary>
          <div className="think-text">{item.think.text}</div>
        </details>
      )}
      {tail && <div className="out live">{tail}</div>}
      {item.diff ? (
        <div className="card" style={{ margin: "6px 0 0 22px" }}>
          <div className="card-body" style={{ padding: "8px 0" }}>
            <Diff diff={item.diff} />
          </div>
        </div>
      ) : !item.pending && item.out && item.out.trim() ? (
        <details>
          <summary className={item.isError ? "" : ""}>{item.isError ? "error: " : ""}{first}{item.out.split("\n").length > 1 ? ` (+${item.out.split("\n").length - 1} lines)` : ""}</summary>
          <div className={`out${item.isError ? " err" : ""}`}>{item.out}</div>
        </details>
      ) : null}
    </div>
  );
}

type Grouped = { idx: number; item: Item };

function groupItems(items: Item[]): (Grouped | Grouped[])[] {
  const segs: (Grouped | Grouped[])[] = [];
  items.forEach((item, idx) => {
    const last = segs[segs.length - 1];
    if (item.k === "tool") {
      if (Array.isArray(last)) last.push({ idx, item });
      else segs.push([{ idx, item }]);
    } else {
      segs.push({ idx, item });
    }
  });
  return segs;
}

const SUMMARY_CLAMP_LINES = 6;

function ApprovalSummary({ text, kind }: { text: string; kind: "plan" | "tool" }) {
  const [open, setOpen] = useState(false);
  const long = text.split("\n").length > SUMMARY_CLAMP_LINES + 2;
  return (
    <div className={`summary-md${long && !open ? " clamped" : ""}`}>
      <div className="summary-cap">{kind === "plan" ? "Plan" : "Command"}</div>
      <div className="text" dangerouslySetInnerHTML={md(text)} />
      {long && (
        <button className="summary-more" onClick={() => setOpen((v) => !v)}>
          {open ? "show less" : `show ${text.split("\n").length - SUMMARY_CLAMP_LINES} more lines`}
        </button>
      )}
    </div>
  );
}

export function diffStats(diff: string): { add: number; del: number } {
  let add = 0, del = 0;
  for (const l of diff.split("\n")) {
    if (l.startsWith("+") && !l.startsWith("+++")) add++;
    else if (l.startsWith("-") && !l.startsWith("---")) del++;
  }
  return { add, del };
}

type DiffRow = { cls: string; gutter: string; text: string; chg?: [number, number] };

// Pair each run of deletions with the following run of additions and highlight
// the differing infix inside each paired line (common prefix/suffix trimmed).
function wordChanges(rows: DiffRow[]) {
  let i = 0;
  while (i < rows.length) {
    if (rows[i].cls !== "del") { i++; continue; }
    let j = i;
    while (j < rows.length && rows[j].cls === "del") j++;
    let k = j;
    while (k < rows.length && rows[k].cls === "add") k++;
    const dels = rows.slice(i, j), adds = rows.slice(j, k);
    for (let n = 0; n < Math.min(dels.length, adds.length); n++) {
      const a = dels[n].text.slice(1), b = adds[n].text.slice(1);
      let pre = 0;
      while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre++;
      let suf = 0;
      while (suf < a.length - pre && suf < b.length - pre && a[a.length - 1 - suf] === b[b.length - 1 - suf]) suf++;
      if (a.length - pre - suf > 0) dels[n].chg = [pre + 1, a.length - suf + 1];
      if (b.length - pre - suf > 0) adds[n].chg = [pre + 1, b.length - suf + 1];
    }
    i = k;
  }
}

export function Diff({ diff }: { diff: string }) {
  const [expanded, setExpanded] = useState(false);
  const rows: DiffRow[] = [];
  let oldN = 0, newN = 0;
  for (const l of diff.split("\n")) {
    const h = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@\s*(.*)$/.exec(l);
    if (h) {
      oldN = Number(h[1]); newN = Number(h[2]);
      rows.push({ cls: "hunk", gutter: "", text: h[3]?.trim() ? `in ${h[3].trim()}` : "" });
    } else if (l.startsWith("+++") || l.startsWith("---") || l.startsWith("diff ") || l.startsWith("index ")) {
      rows.push({ cls: "meta", gutter: "", text: l });
    } else if (l.startsWith("+")) {
      rows.push({ cls: "add", gutter: String(newN++), text: l });
    } else if (l.startsWith("-")) {
      rows.push({ cls: "del", gutter: String(oldN++), text: l });
    } else if (l.startsWith("\\")) {
      rows.push({ cls: "ctx", gutter: "", text: l });
    } else if (oldN > 0 || newN > 0) {
      rows.push({ cls: "ctx", gutter: String(newN++), text: l }); oldN++;
    } else {
      rows.push({ cls: "ctx", gutter: "", text: l });
    }
  }
  wordChanges(rows);
  // Fold long runs of context lines (keep head+tail, collapse the middle).
  const FOLD_KEEP = 2;
  const view: (DiffRow | { fold: number })[] = [];
  let n = 0;
  while (n < rows.length) {
    if (rows[n].cls === "ctx" && rows[n].gutter !== "") {
      let m = n;
      while (m < rows.length && rows[m].cls === "ctx" && rows[m].gutter !== "") m++;
      const run = m - n;
      if (!expanded && run > FOLD_KEEP * 2 + 1) {
        view.push(...rows.slice(n, n + FOLD_KEEP), { fold: run - FOLD_KEEP * 2 }, ...rows.slice(m - FOLD_KEEP, m));
      } else {
        view.push(...rows.slice(n, m));
      }
      n = m;
    } else {
      view.push(rows[n]); n++;
    }
  }
  const renderText = (r: DiffRow) => {
    const hasSign = r.cls === "add" || r.cls === "del";
    const off = hasSign ? 1 : 0;
    const body = r.chg
      ? <span>{syntaxSpans(r.text.slice(off, r.chg[0]))}<mark className="chg">{syntaxSpans(r.text.slice(r.chg[0], r.chg[1]))}</mark>{syntaxSpans(r.text.slice(r.chg[1]))}</span>
      : <span>{syntaxSpans(r.text.slice(off))}</span>;
    return hasSign ? <><span className="sign">{r.text[0]}</span>{body}</> : body;
  };
  let hunkN = 0;
  return (
    <div className="diff">
      {view.map((r, i) =>
        "fold" in r ? (
          <button className="ln fold" key={i} onClick={() => setExpanded(true)}>
            <span className="gutter" /><span>⋮ {r.fold} unchanged lines</span>
          </button>
        ) : r.cls === "hunk" ? (
          <div className="ln hunk" key={i}><span className="gutter" /><span className="hunkchip">{r.text || `hunk ${++hunkN}`}</span></div>
        ) : (
          <div className={`ln ${r.cls}`} key={i}><span className="gutter">{r.gutter}</span>{renderText(r)}</div>
        ),
      )}
    </div>
  );
}

const SYN_RE = /("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`)|(\/\/.*|\/\*.*\*\/|#(?!include)[^\n]*)|\b(\d[\d_]*(?:\.\d+)?)\b|\b(const|let|var|function|return|if|else|elif|for|while|do|switch|case|break|continue|import|from|export|default|class|extends|new|this|self|struct|enum|fn|pub|use|impl|trait|def|print|None|True|False|null|undefined|async|await|try|catch|except|finally|match|mod|type|interface|static|void|int|float|str|bool|mut|ref|move|where|in|is|and|or|not)\b/g;

function syntaxSpans(text: string) {
  const out: React.ReactNode[] = [];
  let last = 0, k = 0;
  for (const m of text.matchAll(SYN_RE)) {
    const i = m.index!;
    if (i > last) out.push(text.slice(last, i));
    const cls = m[1] ? "syn-str" : m[2] ? "syn-com" : m[3] ? "syn-num" : "syn-kw";
    out.push(<span key={k++} className={cls}>{m[0]}</span>);
    last = i + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

function Logo({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 442 270" fill="currentColor" role="img" aria-label="DxxpCode" className={className}>
      <path pathLength={1000} d="M0 0L95 135L0 270H66L257 0H191L128.5 88L66 0ZM375 0L185.5 270H252L314 183L375.5 270H441L347 135L441.5 0ZM267 23L234 70L272 123.5L305.5 76.5ZM171 148L138 195L176 248.5L209.5 201.5Z" />
    </svg>
  );
}
