import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import { listen } from "@tauri-apps/api/event";
import { Button } from "./components/ui/button";
import { Input } from "./components/ui/input";
import { ScrollArea } from "./components/ui/scroll-area";
import { Plus, Search, Minus, Square, X, ChevronDown, ChevronRight, Folder, SlidersHorizontal, Cpu, Palette, History, Info, ListEnd, GitBranch, PanelLeft, ArrowUp, CornerDownLeft, ArrowLeft, ArrowRight, Check, ExternalLink, Pin, ListChecks } from "lucide-react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { check } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import type { Approval, Item, MenuState, Plan, PromptState, ReadyInfo, Todo } from "./types";
import { closePartialMd, md } from "./lib/markdown";
import { ItemView, TGroup, ApprovalSummary, PlanApproval, Diff, diffStats, groupTurns, groupItems, Logo, Md } from "./transcript";
import { ModelPicker } from "./modelpicker";
import { TOOL_DISPLAY, toolArg } from "./types";
import { clampRailWidth, DEFAULT_RAIL_WIDTH, MAX_RAIL_WIDTH, MIN_RAIL_WIDTH, sessionAge } from "./lib/sidebar-layout";
import { composerAction } from "./lib/composer-layout";
import { ONBOARDING_PHASES, ONBOARDING_PROVIDERS, onboardingBack, onboardingPhase, onboardingSetup } from "./lib/onboarding-layout";
import type { OnboardingStep } from "./lib/onboarding-layout";
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
  const [planMode, setPlanMode] = useState(false);
  const [menu, setMenu] = useState<MenuState | null>(null);
  const [promptReq, setPromptReq] = useState<PromptState | null>(null);
  const [promptVal, setPromptVal] = useState("");
  const [cmdSel, setCmdSel] = useState(0);
  const [fileSugs, setFileSugs] = useState<{ id: number; items: { name: string; desc: string }[] }>({ id: -1, items: [] });
  const [modelOpts, setModelOpts] = useState<string[]>([]);
  const fileReqId = useRef(0);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [setQ, setSetPalQuery] = useState("");
  const [setI, setSetPalIdx] = useState(0);
  const [setPalOpen_, setSetPalOpen_] = useState(-1); // expanded row index within filtered list
  const [setPalOptIdx, setSetPalOptIdx] = useState(0);
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
  // Last submitted task — the "Re-plan" cue resubmits it after a denied plan.
  const lastSubmit = useRef<{ text: string; planOnly: boolean } | null>(null);
  const [wtasks, setWtasks] = useState<WTask[]>([]);
  const wbuf = useRef<Record<number, string>>({});
  const wPending = useRef<Record<number, string>>({});
  const rootRef = useRef<string>("");
  const [projectPath, setProjectPath] = useState("");
  const [onboarding, setOnboarding] = useState(false);
  const [obStep, setObStep] = useState<OnboardingStep>("welcome");
  const obTitleRef = useRef<HTMLHeadingElement>(null);
  const [obProvider, setObProvider] = useState<string>("anthropic");
  const OB_MAIN = ["anthropic", "openai"];
  const [obMore, setObMore] = useState(false);
  const [obKey, setObKey] = useState("");
  const [obBase, setObBase] = useState("");
  const [obBusy, setObBusy] = useState(false);
  const [obError, setObError] = useState<string | null>(null);
  const [obHelpError, setObHelpError] = useState<string | null>(null);
  const obPhase = onboardingPhase(obStep);
  const obSelected = ONBOARDING_PROVIDERS.find((p) => p.id === obProvider);
  const chooseObProvider = (id: string) => {
    setObProvider(id);
    setObStep("key");
    setObError(null);
    setObHelpError(null);
  };
  const submitObKey = () => {
    if (!obKey.trim() || obBusy) return;
    setObBusy(true);
    setObError(null);
    void send(onboardingSetup(obProvider, obKey, obBase));
  };
  useEffect(() => {
    if (onboarding && obStep !== "key") obTitleRef.current?.focus();
  }, [onboarding, obStep]);
  // Set when we respawn the sidecar for a project switch; the next ready
  // event then finishes onboarding instead of re-showing it.
  const projectSwitchPending = useRef(false);
  const [docView, setDocView] = useState<{ title: string; text: string } | null>(null);
  const [palOpen, setPalOpen] = useState(false);
  const [palQuery, setPalQuery] = useState("");
  const [palIdx, setPalIdx] = useState(0);
  const [railOpen, setRailOpen] = useState(() => localStorage.getItem("railOpen") !== "0");
  const [railWidth, setRailWidth] = useState(() => clampRailWidth(Number(localStorage.getItem("railWidth") ?? DEFAULT_RAIL_WIDTH)));
  const [projectExpanded, setProjectExpanded] = useState(() => localStorage.getItem("railProjectExpanded") !== "0");
  const [railResizing, setRailResizing] = useState(false);
  const [windowWidth, setWindowWidth] = useState(window.innerWidth);
  const maxRailWidth = Math.max(MIN_RAIL_WIDTH, Math.min(MAX_RAIL_WIDTH, Math.floor(windowWidth * 0.45)));
  const displayedRailWidth = Math.min(railWidth, maxRailWidth);
  const railDrag = useRef<{ x: number; width: number } | null>(null);
  const [bootGone, setBootGone] = useState(false);
  const [sessions, setSessions] = useState<{ id: string; title: string; desc: string; task?: string; files?: string[]; status?: string; when?: string; pinned?: boolean }[]>([]);
  const [sessMenu, setSessMenu] = useState<string | null>(null);
  const [renamingSess, setRenamingSess] = useState<string | null>(null);
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
    if (!railOpen) {
      railDrag.current = null;
      setRailResizing(false);
    }
  }, [railOpen]);
  useEffect(() => {
    const onResize = () => setWindowWidth(window.innerWidth);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);
  useEffect(() => {
    localStorage.setItem("railWidth", String(railWidth));
  }, [railWidth]);
  useEffect(() => {
    localStorage.setItem("railProjectExpanded", projectExpanded ? "1" : "0");
  }, [projectExpanded]);
  const scrollRef = useRef<HTMLDivElement>(null);
  const taRef = useRef<HTMLTextAreaElement>(null);
  useLayoutEffect(() => {
    const textarea = taRef.current;
    if (!textarea) return;
    textarea.style.height = "auto";
    textarea.style.height = Math.min(textarea.scrollHeight, 140) + "px";
  }, [input, windowWidth]);

  const push = (item: Item) => {
    flushText();
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
  // Per-turn stats for the Codex-style activity line: tools run since the
  // last user prompt (for "Worked for Ns · M tools") and the most recent
  // tool label for the live "Working…" row.
  const turnTools = useMemo(() => {
    const m = new Map<number, number>();
    let n = 0;
    items.forEach((it, i) => {
      if (it.k === "user") n = 0;
      else if (it.k === "tool") n++;
      else if (it.k === "done") m.set(i, n);
    });
    return m;
  }, [items]);
  const lastTool = useMemo(() => {
    for (let i = items.length - 1; i >= 0; i--) {
      const it = items[i];
      if (it.k === "user") break;
      if (it.k === "tool") return `${TOOL_DISPLAY[it.tool] ?? it.tool}${it.arg ? ` ${it.arg}` : ""}`;
    }
    return null;
  }, [items]);
  const turns = useMemo(() => groupTurns(groupItems(items)), [items]);
  const palette = input.startsWith("/")
    ? commands.filter((c) => c.name.startsWith(input.split(/\s/)[0]))
    : [];
  const atMatch = input.match(/(?:^|\s)@([^\s]*)$/);
  const atFrag = palette.length === 0 && atMatch ? atMatch[1].split("#")[0] : null;
  const files = atFrag !== null ? fileSugs.items : [];
  // Replies arrive as whole blocks, not a token stream: `appendText` just
  // accumulates into textBuf; the block is pushed when the next event lands
  // (push/done/idle). Think still streams dim inside its own row.
  const textBuf = useRef("");
  const thinkBuf = useRef("");
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
    const t = textBuf.current;
    textBuf.current = "";
    if (!t) return;
    setItems((prev) => {
      const last = prev[prev.length - 1];
      if (last?.k === "text") return [...prev.slice(0, -1), { k: "text", text: last.text + t }];
      return [...prev, { k: "text", text: t }];
    });
  }, []);
  // No per-token render: the reply accumulates and arrives as a whole block
  // when the next event lands — `push`/done/idle flush it. Structured
  // conversation, not a terminal stream.
  const appendText = (t: string) => {
    textBuf.current += t;
    countStream(t.length);
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
        // A new run supersedes any leftover "Build this plan" cue.
        setItems((prev) => prev.filter((it) => it.k !== "build" && it.k !== "replan"));
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
        setSessions(Array.isArray(ev.items) ? (ev.items as { id: string; title: string; desc: string; task?: string; files?: string[]; status?: string; when?: string; pinned?: boolean }[]) : []);
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
      case "plan": {
        const plan = { ...(ev.plan as Plan), amended: ev.amended === true };
        // A re-emitted plan (user edited steps before approving, or a
        // re-proposal) replaces the previous card rather than stacking.
        setItems((prev) => {
          const next = [...prev];
          let idx = -1;
          for (let i = next.length - 1; i >= 0; i--) {
            if (next[i].k === "plan") { idx = i; break; }
            if (next[i].k === "user" || next[i].k === "done") break;
          }
          if (idx >= 0) next[idx] = { k: "plan", plan };
          else next.push({ k: "plan", plan });
          return next;
        });
        break;
      }
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
      case "todo": {
        // One checklist card per turn: update the last todos item in place
        // instead of appending a new card for every write.
        flushText();
        closeThink();
        const items = ev.items as Todo[];
        setItems((prev) => {
          const next = [...prev];
          for (let i = next.length - 1; i >= 0; i--) {
            const it = next[i];
            if (it.k === "todos") {
              next[i] = { ...it, items };
              break;
            }
            if (it.k === "user" || it.k === "done") break;
          }
          if (!next.some((it) => it.k === "todos" && it.items === items)) next.push({ k: "todos", items });
          // Tick the plan card's steps from the same checklist (same matching
          // as persist_plan_file: step-N id or identical content).
          for (let i = next.length - 1; i >= 0; i--) {
            const it = next[i];
            if (it.k === "plan") {
              const stepStatus = it.plan.steps.map((s, si) => {
                const t = items.find((t) => t.id === `step-${si + 1}` || t.content.trim() === s.trim());
                return t ? t.status : "pending";
              });
              if (stepStatus.some((s) => s !== "pending")) {
                next[i] = { k: "plan", plan: { ...it.plan, stepStatus } };
              }
              break;
            }
            if (it.k === "user" || it.k === "done") break;
          }
          return next;
        });
        break;
      }
      case "checkpoint": {
        // Fold into the turn's existing checkpoint row — one ledger entry per
        // run, latest seq, union of snapshotted paths (Cursor-style).
        flushText();
        closeThink();
        const seq = Number(ev.seq);
        const paths = (ev.paths as string[]) ?? [];
        setItems((prev) => {
          const next = [...prev];
          for (let i = next.length - 1; i >= 0; i--) {
            const it = next[i];
            if (it.k === "checkpoint") {
              next[i] = { ...it, seq, paths: Array.from(new Set([...it.paths, ...paths])) };
              return next;
            }
            if (it.k === "user" || it.k === "done") break;
          }
          return [...next, { k: "checkpoint", seq, paths }];
        });
        break;
      }
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
            steps: Array.isArray(ev.steps) ? (ev.steps as string[]) : undefined,
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
          flushText();
          setItems((prev) => {
            const next = [...prev];
            for (let i = next.length - 1; i >= 0; i--) {
              const item = next[i];
              if (item.k === "text") {
                next[i] = { ...item, interrupted: true };
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
        // Plan-only runs park here — the saved plan waits for "Build".
        if (r.status === "plan_only") push({ k: "build" });
        break;
      }
      case "idle": {
        flushText();
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
            setTimeout(() => {
              lastSubmit.current = { text: next, planOnly: false };
              void send({ type: "submit", text: next });
            }, 120);
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

  // Project root for worktrees and onboarding — the sidecar's cwd.
  useEffect(() => {
    if (!ready) return;
    let active = true;
    setProjectPath("");
    void invoke<string>("session_cwd").then((r) => {
      if (active) {
        rootRef.current = r;
        setProjectPath(r);
      }
    }).catch(() => { if (active) setProjectPath("Project path unavailable"); });
    return () => { active = false; };
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

  const submitAction = composerAction(
    input, running, files.length > 0 && atFrag !== null,
    palette.length > 0 && !input.trim().includes(" ") && palette[Math.min(cmdSel, palette.length - 1)]?.name !== input.trim(),
  );
  const submitLabel = submitAction === "queue" ? "Queue task" : submitAction === "complete" ? "Complete suggestion" : "Send";

  const submit = () => {
    const text = input.trim();
    if (!ready || !text) return;
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
    if (submitAction === "queue") {
      // Typed during a run → backlog, not an in-session steer. /steer is the
      // escape hatch for the old inject-mid-run behavior.
      setQueue((q) => [...q, text]);
      return;
    }
    if (running && text.startsWith("/steer")) {
      void send({ type: "submit", text: text.slice(6).trim() });
      return;
    }
    lastSubmit.current = { text, planOnly: planMode };
    void send({ type: "submit", text, planOnly: planMode });
  };

  const pickMenu = (index: number) => {
    const m = menu;
    if (!m) return;
    setMenu({ ...m, answered: index });
    setTimeout(() => setMenu((cur) => (cur?.id === m.id ? null : cur)), 250);
    void send({ type: "select", id: m.id, index });
  };

  // Stable identity: memoized transcript rows take `cmd` as a prop.
  const cmd = useCallback((name: string) => {
    if (name === "build") {
      void send({ type: "build" });
      return;
    }
    if (name === "replan") {
      const ls = lastSubmit.current;
      if (ls) void send({ type: "submit", text: ls.text, planOnly: ls.planOnly });
      return;
    }
    setSettingsOpen(false);
    if (name === "/settings") {
      setSettingsOpen(true);
      return;
    }
    if (name === "/docs" || name === "/changelog" || name === "/help") setDocView({ title: "…", text: "" });
    void send({ type: "command", name });
  }, []);

  useEffect(() => {
    if (settingsOpen) void send({ type: "command", name: "/models" });
  }, [settingsOpen]);
  useEffect(() => {
    setModelOpts([]);
    if (ready && !ready.needsSetup) void send({ type: "command", name: "/models" });
  }, [ready?.provider, ready?.needsSetup]);

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

  const answer = (id: number, choice: string, steps?: string[]) => {
    const ap = approvals.find((a) => a.id === id);
    setApprovals((prev) => prev.map((a) => (a.id === id ? { ...a, answered: choice } : a)));
    void send({ type: "approve", id, choice, plan: steps ? { steps } : undefined });
    if (ap?.kind === "plan") {
      // Answered plans fold into a summary line; a denial adds a "Re-plan" cue.
      setItems((prev) => {
        const next = [...prev];
        for (let i = next.length - 1; i >= 0; i--) {
          const it = next[i];
          if (it.k === "plan") {
            next[i] = { k: "plan", plan: { ...it.plan, collapsed: true } };
            break;
          }
          if (it.k === "user" || it.k === "done") break;
        }
        if (choice === "n") next.push({ k: "replan" });
        return next;
      });
    }
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
      } else if ((e.metaKey || e.ctrlKey) && e.key === ",") {
        e.preventDefault();
        if (ready) setSettingsOpen((v) => !v);
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
  useEffect(() => {
    if (settingsOpen) {
      setSetPalQuery("");
      setSetPalIdx(0);
      setSetPalOpen_(-1);
      setSetPalOptIdx(0);
    }
  }, [settingsOpen]);

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
  const groupSessions = (query: string) => {
    const q = query.trim().toLowerCase();
    const filtered = q ? sessions.filter((s) => s.title.toLowerCase().includes(q)) : sessions;
    const today = new Date().toISOString().slice(0, 10);
    const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
    const groups: [string, typeof filtered][] = [];
    for (const s of filtered) {
      const date = s.desc.split("·")[0].trim();
      const label = s.pinned ? "Pinned" : date === today ? "Today" : date === yesterday ? "Yesterday" : "Earlier";
      const last = groups[groups.length - 1];
      if (last && last[0] === label) last[1].push(s);
      else groups.push([label, [s]]);
    }
    return groups;
  };
  const sessionGroups = groupSessions(palQuery);
  const railGroups = groupSessions("");
  // Something in the rail needs the user — a pending approval/diff decision or
  // a parallel task awaiting merge/discard. Surfaces as a dot on the rail
  // toggle when the sidebar is hidden.
  const needsAttention =
    approvals.some((a) => !a.answered) ||
    diffs.some((d) => !d.decided) ||
    wtasks.some((w) => w.phase === "done" || w.phase === "failed");
  // Settings palette: every setting is a searchable row. Select rows expand
  // their options inline under the row; action rows run immediately.
  type SetEntry = {
    id: string; label: string; group: string; value?: string;
    options?: string[]; onPick?: (v: string) => void; action?: () => void; danger?: boolean;
  };
  const setEntries: SetEntry[] = [
    { id: "provider", label: "Provider", group: "Providers & Models", value: ready?.provider,
      options: [...(ready?.providers?.length ? ready.providers : [ready?.provider ?? ""]), "connect a provider…"],
      onPick: (v) => v === "connect a provider…" ? cmd("/providers") : void send({ type: "command", name: `/provider ${v}` }) },
    { id: "model", label: "Model", group: "Providers & Models", value: ready?.model,
      options: [...(modelOpts.length ? modelOpts : [ready?.model ?? ""]), "custom…"],
      onPick: (v) => v === "custom…" ? cmd("/model") : void send({ type: "command", name: `/model ${v}` }) },
    { id: "effort", label: "Reasoning effort", group: "Providers & Models", value: ready?.effort ?? "default",
      options: [...EFFORT_LEVELS], onPick: (v) => void send({ type: "command", name: `/effort ${v}` }) },
    { id: "variant", label: "Model variant", group: "Providers & Models", value: ready?.variant ?? "default",
      options: ["default", ...(ready?.variants ?? [])], onPick: (v) => void send({ type: "command", name: `/variant ${v}` }) },
    { id: "approvals", label: "Approvals", group: "Providers & Models", value: ready?.mode === "smart" ? "smart (Jev)" : ready?.mode,
      options: ["ask", "always-approve", "smart (Jev)"], onPick: (v) => void send({ type: "command", name: `/approval ${v}` }) },
    { id: "theme", label: "Theme", group: "Appearance", value: artSrc ? "dark — set by art" : theme,
      ...(artSrc ? {} : { options: ["system", "light", "dark"], onPick: (v) => setTheme(v as "system" | "light" | "dark") }) },
    { id: "artwork", label: "Artwork", group: "Appearance", value: artLabel || artDirLabel || "None",
      options: ["None", ...ART_PIECES.map((p) => p.title), "Custom folder…"],
      onPick: (v) => {
        if (v === "None") { setArtPiece(""); setArtDir(""); }
        else if (v === "Custom folder…") {
          void invoke<string | null>("pick_folder").then((dir) => { if (dir) { setArtPiece(""); setArtDir(dir); } });
        } else {
          const p = ART_PIECES.find((x) => x.title === v);
          if (p) setArtPiece(artPiece === p.id ? "" : p.id);
        }
      } },
    { id: "project", label: "Open a project…", group: "Session", action: () => { setSettingsOpen(false); openProject(); } },
    { id: "setup", label: "Run setup…", group: "Session", action: () => cmd("/setup") },
    { id: "resume", label: "Resume a session…", group: "Session", action: () => { setSettingsOpen(false); setPalOpen(true); } },
    { id: "compact", label: "Compact context", group: "Session", action: () => cmd("/compact") },
    { id: "undo", label: "Undo checkpoint", group: "Session", action: () => cmd("/undo") },
    { id: "new", label: "New session", group: "Session", action: () => cmd("/new") },
    ...(update?.status === "ready" ? [{ id: "update", label: `Update ready — v${update.version}`, group: "DxxpCode", action: () => void relaunch() }] : []),
    ...(update?.status === "downloading" ? [{ id: "update", label: `Downloading update v${update.version}…`, group: "DxxpCode" }] : []),
    { id: "docs", label: "Documentation", group: "DxxpCode", action: () => cmd("/docs") },
    { id: "changelog", label: "Changelog", group: "DxxpCode", action: () => cmd("/changelog") },
    { id: "version", label: "Version", group: "DxxpCode", value: `v${ready?.version ?? ""}` },
    { id: "quit", label: "Quit dxxpcode", group: "DxxpCode", action: () => cmd("/exit"), danger: true },
  ];
  const setPalRows = setEntries.filter((e) => {
    const q = setQ.trim().toLowerCase();
    return !q || e.label.toLowerCase().includes(q) || (e.value ?? "").toLowerCase().includes(q);
  });
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
    <div className={artSrc ? "app has-art" : "app"} data-resizing={railResizing || undefined}>
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
        <aside className="rail" id="sessions-sidebar" aria-label="Sessions" style={{ width: displayedRailWidth }}>
          <div className="rail-brand" data-tauri-drag-region>
            <Logo className="logo-mark" />
            <Button variant="ghost" size="icon" className="rail-toggle" aria-label="Hide sidebar" title={IS_MAC ? "Hide sidebar (⌘B)" : "Hide sidebar (Ctrl B)"} onClick={() => setRailOpen(false)}>
              <PanelLeft size={15} />
            </Button>
          </div>
          <nav className="rail-head" aria-label="Session actions">
            <Button variant="ghost" className="rail-navrow" onClick={() => cmd("/new")}>
              <Plus size={15} />
              <span>New session</span>
            </Button>
            <Button variant="ghost" className="rail-navrow" onClick={() => setPalOpen(true)}>
              <Search size={15} />
              <span>Search sessions</span>
              <kbd className="rail-shortcut">{IS_MAC ? "⌘K" : "Ctrl K"}</kbd>
            </Button>
          </nav>
          <ScrollArea className="rail-list" onClick={() => setSessMenu(null)}>
            {queue.length > 0 && (
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
            {wtasks.some((w) => w.phase !== "merged" && w.phase !== "discarded") && (
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
            <div className="rail-section-head">
              <span>Projects</span>
              <Button variant="ghost" size="icon" aria-label="Open a project" title="Open a project" onClick={openProject}>
                <Plus size={14} />
              </Button>
            </div>
            <Button variant="ghost" className="rail-proj" aria-expanded={projectExpanded} aria-controls="project-sessions" onClick={() => setProjectExpanded((v) => !v)}>
              {projectExpanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
              <Folder size={14} />
              <span className="truncate">{ready.project.name}</span>
            </Button>
            <div id="project-sessions" className="rail-project-sessions" hidden={!projectExpanded}>
            {railGroups.length === 0 && <p className="pal-empty">No sessions yet.</p>}
            {railGroups.map(([label, group]) => (
              <div key={label}>
                <div className="pal-group-label">{label}</div>
                {group.map((s) => {
                  const current = s.id === sessionInfo.id;
                  return (
                    <div key={s.id} className="rail-sess">
                      <div
                        className="rail-sessrow"
                        data-active={current || undefined}
                        onContextMenu={(e) => {
                          e.preventDefault();
                          e.stopPropagation();
                          setSessMenu((m) => (m === s.id ? null : s.id));
                        }}
                      >
                        <Button
                          variant="ghost"
                          className="rail-sesspick"
                          aria-current={current || undefined}
                          title={s.title}
                          onClick={() => { if (!current) void send({ type: "resume", id: s.id }); }}
                        >
                          {current && running ? (
                            <span className="rail-glyph rail-live" />
                          ) : !s.status && s.files && s.files.length > 0 ? (
                            <span className="rail-glyph warn" title="Unreviewed changes" aria-label="Unreviewed changes" />
                          ) : null}
                          <span className="rail-sessmain">
                            {renamingSess === s.id ? (
                              <input
                                className="rail-rename"
                                defaultValue={s.title}
                                autoFocus
                                aria-label={`Rename ${s.title || "Untitled"}`}
                                onFocus={(e) => e.target.select()}
                                onClick={(e) => e.stopPropagation()}
                                onKeyDown={(e) => {
                                  e.stopPropagation();
                                  if (e.key === "Enter") {
                                    send({ type: "session_rename", id: s.id, title: e.currentTarget.value });
                                    setRenamingSess(null);
                                  } else if (e.key === "Escape") {
                                    setRenamingSess(null);
                                  }
                                }}
                                onBlur={(e) => {
                                  send({ type: "session_rename", id: s.id, title: e.currentTarget.value });
                                  setRenamingSess(null);
                                }}
                              />
                            ) : (
                              <span className={`truncate${sessGlyph(s.status) === "bad" ? " statbad" : ""}`}>{s.pinned && <Pin size={10} className="rail-pin" aria-label="Pinned" />}{s.title || "Untitled"}</span>
                            )}
                            {current && approvals.some((a) => !a.answered) && <span className="rail-sessmeta">Needs approval</span>}
                          </span>
                          <span className="rail-time">{sessionAge(s.when)}</span>
                        </Button>
                        {renamingSess !== s.id && (
                          <>
                            <button
                              className="rail-act rail-pinbtn"
                              aria-label={s.pinned ? `Unpin ${s.title || "Untitled"}` : `Pin ${s.title || "Untitled"}`}
                              title={s.pinned ? "Unpin" : "Pin"}
                              onClick={(e) => {
                                e.stopPropagation();
                                send({ type: "session_pin", id: s.id, pinned: !s.pinned });
                              }}
                            >
                              <Pin size={12} fill={s.pinned ? "currentColor" : "none"} />
                            </button>
                            <button
                              className="rail-act"
                              aria-label={`Actions for ${s.title || "Untitled"}`}
                              aria-expanded={sessMenu === s.id}
                              title="Session actions"
                              onClick={(e) => { e.stopPropagation(); setSessMenu((m) => (m === s.id ? null : s.id)); }}
                            >
                              ⋯
                            </button>
                          </>
                        )}
                      </div>
                      {sessMenu === s.id && (
                        <div className="rail-menu">
                          {s.status && <div className="rail-menu-info">{s.status}{s.files && s.files.length > 0 ? ` · ${s.files.length} files` : ""}</div>}
                          {s.task && (
                            <button className="rail-menu-btn" onClick={() => { setInput(s.task ?? ""); setSessMenu(null); taRef.current?.focus(); }}>re-run prompt</button>
                          )}
                          <button className="rail-menu-btn" onClick={() => { setRenamingSess(s.id); setSessMenu(null); }}>rename</button>
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
                          {!current && (
                            <>
                              <div className="rail-menu-divider" role="separator" />
                              <button className="rail-menu-btn danger" onClick={() => { send({ type: "session_delete", id: s.id }); setSessMenu(null); }}>delete</button>
                            </>
                          )}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            ))}
            </div>
          </ScrollArea>
          <div className="rail-footer">
            <Button variant="ghost" className="rail-navrow" onClick={() => cmd("/settings")}>
              <SlidersHorizontal size={15} />
              <span>Settings</span>
              <kbd className="rail-shortcut">{IS_MAC ? "⌘," : "Ctrl ,"}</kbd>
            </Button>
          </div>
          <div
            className="rail-resize"
            role="separator"
            aria-label="Sidebar width"
            aria-orientation="vertical"
            aria-controls="sessions-sidebar"
            aria-valuemin={MIN_RAIL_WIDTH}
            aria-valuemax={maxRailWidth}
            aria-valuenow={displayedRailWidth}
            tabIndex={0}
            onDoubleClick={() => setRailWidth(DEFAULT_RAIL_WIDTH)}
            onPointerDown={(e) => {
              if (!e.isPrimary || e.button !== 0) return;
              e.preventDefault();
              e.currentTarget.focus();
              railDrag.current = { x: e.clientX, width: displayedRailWidth };
              e.currentTarget.setPointerCapture(e.pointerId);
              setRailResizing(true);
            }}
            onPointerMove={(e) => {
              const drag = railDrag.current;
              if (drag && e.currentTarget.hasPointerCapture(e.pointerId)) setRailWidth(clampRailWidth(drag.width + e.clientX - drag.x, maxRailWidth));
            }}
            onPointerUp={(e) => {
              if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
              railDrag.current = null;
              setRailResizing(false);
            }}
            onLostPointerCapture={() => { railDrag.current = null; setRailResizing(false); }}
            onPointerCancel={() => { railDrag.current = null; setRailResizing(false); }}
            onKeyDown={(e) => {
              if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
                e.preventDefault();
                setRailWidth(clampRailWidth(displayedRailWidth + (e.key === "ArrowLeft" ? -10 : 10), maxRailWidth));
              } else if (e.key === "Home" || e.key === "End") {
                e.preventDefault();
                setRailWidth(e.key === "Home" ? MIN_RAIL_WIDTH : maxRailWidth);
              }
            }}
          />
        </aside>
      )}
      <div className="main">
      <header className={`header${IS_MAC ? " mac" : ""}`} data-tauri-drag-region>
        <div className="hctx" data-tauri-drag-region>
          {!onboarding && (!ready || !railOpen) && <Logo className="logo-mark" />}
          {ready && !onboarding && !railOpen && (
            <Button
              variant="ghost"
              size="icon"
              className={`rail-toggle${needsAttention ? " attn" : ""}`}
              aria-label="Show sidebar"
              aria-expanded={false}
              aria-controls="sessions-sidebar"
              title={`${IS_MAC ? "Show sidebar (⌘B)" : "Show sidebar (Ctrl B)"}${needsAttention ? " — attention needed" : ""}`}
              onClick={() => setRailOpen((v) => !v)}
            >
              <PanelLeft size={14} />
            </Button>
          )}
        </div>
        <span className="spacer" />
        {ready && !onboarding && !railOpen && (
          <Button variant="ghost" size="icon" aria-label="Settings" title="Settings" onClick={() => cmd("/settings")}>
            <SlidersHorizontal size={14} />
          </Button>
        )}
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
        <div className="sesspal" onClick={(e) => { if (e.target === e.currentTarget) setSettingsOpen(false); }}>
          <div className="sesspal-dialog setpal-dialog">
            <div className="pal-search">
              <Search size={13} />
              <input
                autoFocus
                type="text"
                placeholder="Search settings…"
                value={setQ}
                onChange={(e) => { setSetPalQuery(e.target.value); setSetPalIdx(0); setSetPalOpen_(-1); }}
                onKeyDown={(e) => {
                  const expanded = setPalOpen_ >= 0 ? setPalRows[setPalOpen_] : undefined;
                  if (e.key === "Escape") {
                    e.preventDefault();
                    if (expanded) setSetPalOpen_(-1);
                    else setSettingsOpen(false);
                  } else if (e.key === "ArrowDown") {
                    e.preventDefault();
                    if (expanded?.options) setSetPalOptIdx((i) => Math.min(i + 1, expanded.options!.length - 1));
                    else setSetPalIdx((i) => Math.min(i + 1, setPalRows.length - 1));
                  } else if (e.key === "ArrowUp") {
                    e.preventDefault();
                    if (expanded?.options) setSetPalOptIdx((i) => Math.max(i - 1, 0));
                    else setSetPalIdx((i) => Math.max(i - 1, 0));
                  } else if (e.key === "Enter") {
                    e.preventDefault();
                    if (expanded?.options) expanded.onPick?.(expanded.options[setPalOptIdx]);
                    else {
                      const row = setPalRows[setI];
                      if (!row) return;
                      if (row.options) { setSetPalOpen_(setI); setSetPalOptIdx(Math.max(0, row.options.indexOf(row.value ?? ""))); }
                      else row.action?.();
                    }
                  }
                }}
                spellCheck={false}
              />
            </div>
            <ScrollArea className="pal-list">
              {setPalRows.length === 0 && <p className="pal-empty">No matching settings.</p>}
              {(() => {
                let lastGroup = "";
                return setPalRows.map((row, idx) => (
                  <div key={row.id}>
                    {row.group !== lastGroup && <div className="pal-group-label">{(lastGroup = row.group)}</div>}
                    <Button
                      variant="ghost"
                      data-active={setI === idx || undefined}
                      className={`pal-row setpal-row${row.danger ? " danger" : ""}`}
                      onMouseEnter={() => setSetPalIdx(idx)}
                      onClick={() => {
                        if (row.options) { setSetPalOpen_(setPalOpen_ === idx ? -1 : idx); setSetPalOptIdx(Math.max(0, row.options.indexOf(row.value ?? ""))); }
                        else row.action?.();
                      }}
                    >
                      <span className="truncate">{row.label}</span>
                      {row.value && <span className="setpal-val">{row.value}</span>}
                      {row.options && <ChevronDown size={11} className={`setpal-caret${setPalOpen_ === idx ? " up" : ""}`} />}
                    </Button>
                    {setPalOpen_ === idx && row.options && (
                      <div className="setpal-opts">
                        {row.options.map((o, oi) => (
                          <Button
                            key={o}
                            variant="ghost"
                            data-active={setPalOptIdx === oi || undefined}
                            className="pal-row setpal-opt"
                            onMouseEnter={() => setSetPalOptIdx(oi)}
                            onClick={() => row.onPick?.(o)}
                          >
                            <span className="setpal-opt-check">{o === row.value ? "✓" : ""}</span>
                            <span className="truncate">{o}</span>
                          </Button>
                        ))}
                      </div>
                    )}
                  </div>
                ));
              })()}
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
            <Md className="doc-body text" text={docView.text} />
          </div>
        </div>
      )}
      {onboarding && !settingsOpen && !docView && (
        <section className="onboarding" aria-labelledby="ob-title">
          <div className="ob-frame">
            <header className="ob-header">
              <div className="ob-brand"><Logo className="ob-mark" /><span>Set up DxxpCode</span></div>
              <span className="ob-step-label">{obStep === "first" ? "Setup complete · Optional task" : `Step ${obPhase + 1} of ${ONBOARDING_PHASES.length}`}</span>
            </header>
            <ol className="ob-progress" aria-label="Setup progress">
              {ONBOARDING_PHASES.map((phase, i) => (
                <li key={phase} aria-current={i === obPhase ? "step" : undefined} data-state={i < obPhase ? "complete" : i === obPhase ? "current" : "upcoming"}>
                  <span className="ob-phase-number" aria-hidden="true">{i < obPhase ? <Check size={12} /> : i + 1}</span>
                  <span>{phase}</span>
                </li>
              ))}
            </ol>
            <div className="ob-content" key={obStep}>
              <h1 className="ob-title" id="ob-title" ref={obTitleRef} tabIndex={-1}>
                {{
                  welcome: "Your coding agent, on your desktop.",
                  pick: "Connect a provider.",
                  key: `${obSelected?.name ?? "Provider"} API key`,
                  project: "Choose your project.",
                  first: "Try your first task.",
                }[obStep]}
              </h1>
              <p className="ob-desc">
                {{
                  welcome: "Local. Private. Yours.",
                  pick: "Choose the model provider you want to work with.",
                  key: "Enter your provider’s API key to continue.",
                  project: "Choose the folder the agent will work in.",
                  first: ready?.provider === "mock" ? "Optional. Try a scripted reply in demo mode." : "Optional. Start with a small task in this project.",
                }[obStep]}
              </p>
              {obStep === "welcome" && (
                <p className="ob-hint">Connect your own provider, choose a project, and start coding. You can re-run setup anytime with /setup or Settings → Run setup.</p>
              )}
              {obStep === "pick" && (
                <>
                  <div className="ob-providers" aria-label="Providers">
                    {ONBOARDING_PROVIDERS.filter((p) => OB_MAIN.includes(p.id)).map((p) => (
                      <button key={p.id} className="ob-prov" disabled={obBusy} onClick={() => chooseObProvider(p.id)}>
                        <span className="ob-prov-copy"><span className="ob-prov-name">{p.name}</span><span className="ob-prov-desc">{p.desc}</span></span>
                        <ArrowRight size={16} aria-hidden="true" />
                      </button>
                    ))}
                  </div>
                  <button className="ob-more" disabled={obBusy} aria-expanded={obMore} aria-controls="ob-other-providers" onClick={() => setObMore((m) => !m)}>
                    {obMore ? "Fewer providers" : "More providers"}<ChevronDown size={14} className={obMore ? "up" : ""} aria-hidden="true" />
                  </button>
                  {obMore && (
                    <div className="ob-providers ob-other-providers" id="ob-other-providers">
                      {ONBOARDING_PROVIDERS.filter((p) => !OB_MAIN.includes(p.id)).map((p) => (
                        <button key={p.id} className="ob-prov" disabled={obBusy} onClick={() => chooseObProvider(p.id)}>
                          <span className="ob-prov-copy"><span className="ob-prov-name">{p.name}</span><span className="ob-prov-desc">{p.desc}</span></span>
                          <ArrowRight size={16} aria-hidden="true" />
                        </button>
                      ))}
                    </div>
                  )}
                  <div className="ob-demo">
                    <button className="ob-more" disabled={obBusy} onClick={() => { setObBusy(true); setObError(null); void send(onboardingSetup("mock")); }}>
                      {obBusy ? "Opening demo…" : "Explore demo mode"}<ArrowRight size={14} aria-hidden="true" />
                    </button>
                    <p className="ob-hint">No API key required. Scripted replies only; no files are read or changed.</p>
                  </div>
                </>
              )}
              {obStep === "key" && (
                <form id="ob-key-form" aria-busy={obBusy} onSubmit={(e) => { e.preventDefault(); submitObKey(); }}>
                  <div className="ob-field">
                    <div className="ob-field-heading">
                      <label htmlFor="ob-key">API key</label>
                      {obSelected?.keyUrl && (
                        <a className="ob-help-link" href={obSelected.keyUrl} target="_blank" rel="noreferrer" onClick={(e) => {
                          e.preventDefault();
                          setObHelpError(null);
                          void openUrl(obSelected.keyUrl!).catch(() => setObHelpError(`Open your browser and visit ${obSelected.keyUrl}`));
                        }}>Get an API key<ExternalLink size={12} aria-hidden="true" /></a>
                      )}
                    </div>
                    <div className="ob-keywrap">
                      <input
                        className="ob-input mono"
                        id="ob-key"
                        type="password"
                        autoFocus
                        autoComplete="off"
                        spellCheck={false}
                        disabled={obBusy}
                        aria-invalid={Boolean(obError)}
                        aria-describedby={obError ? "ob-key-hint ob-error" : "ob-key-hint"}
                        placeholder={{ anthropic: "sk-ant-…", openrouter: "sk-or-…", groq: "gsk_…", xai: "xai-…" }[obProvider] ?? "Paste your API key"}
                        value={obKey}
                        onChange={(e) => { setObKey(e.target.value.trim()); setObError(null); }}
                      />
                    </div>
                    <p className="ob-hint" id="ob-key-hint">Stored on this machine. Validated with your provider before it’s saved.</p>
                  </div>
                  {obHelpError && <p className="ob-error" role="alert">{obHelpError}</p>}
                  {obProvider === "custom" && (
                    <div className="ob-field">
                      <label htmlFor="ob-base">Base URL</label>
                      <input
                        className="ob-input mono"
                        id="ob-base"
                        type="url"
                        autoComplete="off"
                        spellCheck={false}
                        disabled={obBusy}
                        aria-describedby="ob-base-hint"
                        placeholder="https://api.openai.com/v1"
                        value={obBase}
                        onChange={(e) => setObBase(e.target.value)}
                      />
                      <p className="ob-hint" id="ob-base-hint">Your OpenAI-compatible endpoint. Leave blank to use api.openai.com.</p>
                    </div>
                  )}
                  {obBusy && <p className="ob-validation" role="status">Validating your API key…</p>}
                </form>
              )}
              {(obStep === "project" || obStep === "first") && (
                <div className="ob-project">
                  <Folder size={18} aria-hidden="true" />
                  <div className="ob-project-copy">
                    <div className="ob-project-name">{ready?.project.name ?? "Current project"}</div>
                    <div className="ob-project-path mono">{projectPath || "Loading project path…"}</div>
                  </div>
                </div>
              )}
              {obStep === "project" && (
                <>
                  <button className="ob-more" onClick={openProject}>Choose another folder<ArrowRight size={14} aria-hidden="true" /></button>
                  <p className="ob-hint">You can switch projects anytime in Settings.</p>
                </>
              )}
              {obStep === "first" && (
                <div className="ob-panel">
                  <div className="ob-panel-title">{ready?.provider === "mock" ? "Example task" : "Write a summary file"}</div>
                  <p className="ob-panel-sub">Create <code>DXXPCODE.md</code> with a one-sentence summary of the project above.</p>
                  <p className="ob-hint">{ready?.provider === "mock" ? "Demo mode only returns scripted replies. This example will not read or change your project." : "The agent will read this project and use your existing approval settings for any changes."}</p>
                </div>
              )}
              {obError && <p className="ob-error" id="ob-error" role="alert">{obError}</p>}
            </div>
            <footer className="ob-footer">
              {obStep === "welcome" ? (
                <button className="btn ghost ob-skip" onClick={() => setOnboarding(false)}>Skip for now</button>
              ) : (
                <button className="btn ghost ob-back" disabled={obBusy} onClick={() => { setObStep(onboardingBack(obStep)); setObError(null); setObHelpError(null); }}><ArrowLeft size={14} aria-hidden="true" />Back</button>
              )}
              <div className="ob-footer-actions">
                {obStep === "welcome" && <button className="btn primary" onClick={() => setObStep("pick")}>Get started<ArrowRight size={14} aria-hidden="true" /></button>}
                {obStep === "pick" && <span className="ob-footer-hint">Choose a provider above</span>}
                {obStep === "key" && <button className="btn primary ob-continue" type="submit" form="ob-key-form" disabled={!obKey.trim() || obBusy}>{obBusy ? "Validating…" : "Continue"}<ArrowRight size={14} aria-hidden="true" /></button>}
                {obStep === "project" && <button className="btn primary" onClick={() => setObStep("first")}>Use this project<ArrowRight size={14} aria-hidden="true" /></button>}
                {obStep === "first" && (
                  <>
                    <button className="btn ghost" onClick={() => setOnboarding(false)}>Not now</button>
                    <button className="btn primary" onClick={() => {
                      setOnboarding(false);
                      void send({ type: "submit", text: "Create a file named DXXPCODE.md in this project containing a one-sentence summary of what this project does." });
                    }}>{ready?.provider === "mock" ? "Try demo prompt" : "Run first task"}<ArrowRight size={14} aria-hidden="true" /></button>
                  </>
                )}
              </div>
            </footer>
          </div>
        </section>
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
        {turns.map((turn, ti) => (
          <div className="turn" key={ti}>
            {turn.map((seg, si) =>
              Array.isArray(seg) ? (
                <TGroup key={`g${si}`} seg={seg} running={running} lastIdx={items.length - 1} onCmd={cmd} />
              ) : (
                <ItemView key={seg.idx} item={seg.item} toolCount={turnTools.get(seg.idx)} onCmd={cmd} />
              ),
            )}
          </div>
        ))}
        {running && (
          <div className="workline row">
            <span className="think-shimmer">Working…</span>
            {lastTool && <span className="workline-tool">{lastTool}</span>}
          </div>
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
              {a.kind === "plan" && a.steps ? (
                <PlanApproval
                  summary={a.summary}
                  steps={a.steps}
                  extraChoice={a.extraChoice}
                  onAnswer={(choice, steps) => answer(a.id, choice, steps)}
                />
              ) : (
                <>
                  <ApprovalSummary text={a.summary} kind={a.kind} />
                  {a.reason && <div className="reason">Reason: {a.reason}</div>}
                  <div className="dec-acts">
                    <button className="pill allow" onClick={() => answer(a.id, "y")}>Allow</button>
                    <button className="pill deny" onClick={() => answer(a.id, "n")}>Deny</button>
                    {a.allowAlways && <button className="pill ghost" onClick={() => answer(a.id, "a")}>Always allow</button>}
                    {a.extraChoice && <button className="pill ghost" onClick={() => answer(a.id, a.extraChoice!.choice)}>{a.extraChoice.label}</button>}
                  </div>
                </>
              )}
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
        {ready && (
          <span className="statusline-ctx">
            <button className="inctx" aria-label={`Change project: ${ready.project.name}`} title={`Change project: ${ready.project.name}`} onClick={openProject}>
              <Folder size={12} />
              <span className="inctx-name">{ready.project.name}</span>
              {ready.project.git && (
                <span className="branch mono" title={ready.project.git.branch}>{ready.project.git.branch}{ready.project.git.dirty ? "*" : ""}</span>
              )}
              <ChevronDown size={11} />
            </button>
          </span>
        )}
        <span className="statusline-act">
          {(status || tokRate > 0 || approvals.some((a) => !a.answered) || diffs.some((d) => !d.decided)) && <><span className="pulse" /><span className="statustext">{approvals.some((a) => !a.answered) || diffs.some((d) => !d.decided) ? "Waiting for approval…" : status}</span>{tokRate > 0 && <span className="tokrate">{tokRate} tok/s</span>}</>}
          {queue.length > 0 && <span className="queuecount">{queue.length} queued</span>}
        </span>
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
          <textarea
            ref={taRef}
            rows={2}
            autoFocus
            aria-label={chatMode ? "Codebase question" : "Task prompt"}
            aria-describedby="composer-hints"
            placeholder={chatMode ? "Ask about this codebase…" : planMode ? "Describe the task — I'll plan it first…" : "Ask dxxpcode anything…"}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.nativeEvent.isComposing || e.nativeEvent.keyCode === 229) return;
              const rows = palette.length > 0 ? palette.length : files.length;
              if (rows > 0 && e.key === "ArrowDown") {
                e.preventDefault();
                setCmdSel((s) => (s + 1) % rows);
              } else if (rows > 0 && e.key === "ArrowUp") {
                e.preventDefault();
                setCmdSel((s) => (s - 1 + rows) % rows);
              } else if (e.key === "Tab" && e.shiftKey) {
                // ⇧Tab cycles plan mode (plan → approve → build).
                e.preventDefault();
                setPlanMode((v) => !v);
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
          <div className="composer-toolbar">
            <div className="composer-controls">
              {ready && (
                <>
                  <ModelPicker
                    model={ready.model}
                    modelOpts={modelOpts}
                    effort={ready.effort ?? "default"}
                    variant={ready.variant}
                    disabled={running || onboarding}
                    onOpen={() => void send({ type: "command", name: "/models" })}
                    onModel={(v) => v === "custom…" ? cmd("/model") : void send({ type: "command", name: `/model ${v}` })}
                    onEffort={(v) => void send({ type: "command", name: `/effort ${v}` })}
                  />
                  <button
                    type="button"
                    className={`plan-toggle${planMode ? " on" : ""}`}
                    title={planMode ? "Plan mode on (⇧Tab to cycle)" : "Plan mode (⇧Tab to cycle)"}
                    aria-pressed={planMode}
                    disabled={running || onboarding}
                    onClick={() => setPlanMode((v) => !v)}
                  ><ListChecks size={11} strokeWidth={2} />plan</button>
                </>
              )}
            </div>
            <div className="composer-actions">
              {running && <Button variant="ghost" size="icon" className="composer-stop" aria-label="Stop task" title="Stop task (Esc)" onClick={() => void send({ type: "cancel" })}><Square size={13} /></Button>}
              <Button size="icon" className="composer-submit" aria-label={submitLabel} title={submitLabel} disabled={!ready || !input.trim()} onClick={() => { submit(); taRef.current?.focus(); }}>
                {submitAction === "queue" ? <ListEnd size={16} /> : submitAction === "complete" ? <CornerDownLeft size={16} /> : <ArrowUp size={17} />}
              </Button>
            </div>
          </div>
        </div>
        <div className="composer-hints" id="composer-hints">
          <span><kbd>/</kbd> commands · <kbd>@</kbd> files</span>
          <span><kbd>↵</kbd> {submitAction === "queue" ? "queue" : submitAction === "complete" ? "complete" : "send"} · <kbd>⇧↵</kbd> newline{running && <> · <kbd>Esc</kbd> stop</>}</span>
        </div>
      </div>
      </div>
    </div>
  );
}

