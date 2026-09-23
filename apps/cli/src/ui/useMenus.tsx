import { useCallback, type Dispatch, type MutableRefObject, type SetStateAction } from "react";
import type { ModelProvider, ReasoningEffort } from "@dxxpcode/providers";
import { KNOWN_MODELS, resolveProvider } from "@dxxpcode/providers";
import { estimateTokens } from "@dxxpcode/agent";
import { detectGit } from "@dxxpcode/project";
import { homeDir, loadConfig, saveConfig, type SessionRecord } from "@dxxpcode/sessions";
import { join } from "node:path";
import { fmtTokens } from "./shared.ts";
import type { AppProps, ItemInput, Pending } from "./types.ts";

export interface MenuDeps {
  props: AppProps;
  push: (item: ItemInput) => void;
  setPending: Dispatch<SetStateAction<Pending>>;
  setMenuSel: Dispatch<SetStateAction<number>>;
  setSpinLabel: Dispatch<SetStateAction<string | null>>;
  setProv: Dispatch<SetStateAction<{ provider: ModelProvider; model: string }>>;
  setModeOverride: Dispatch<SetStateAction<string | null>>;
  setSetup: Dispatch<SetStateAction<boolean>>;
  provRef: MutableRefObject<{ provider: ModelProvider; model: string }>;
  autoRef: MutableRefObject<boolean>;
  effortRef: MutableRefObject<ReasoningEffort | undefined>;
  sessionRef: MutableRefObject<SessionRecord | undefined>;
  modeOverride: string | null;
  tok: number;
}

/** The /model, /effort, and /settings(+tab) menus plus the Session status rows. */
export function useConfigMenus(d: MenuDeps) {
  const { props, push, setPending, setMenuSel, setSpinLabel, setProv, setModeOverride, setSetup } = d;
  const { provRef, autoRef, effortRef, sessionRef } = d;

  const openModelMenu = useCallback(() => {
    const name = provRef.current.provider.name;
    const fallback = [...(KNOWN_MODELS[name] ?? [])];
    // OpenAI-compatible endpoints (xAI Grok, Google Gemini, local) get their models too.
    if (name === "openai" && loadConfig().openaiBaseUrl) {
      fallback.push("grok-4", "gemini-3-pro");
    }
    const cur = provRef.current.model;
    const listModels = provRef.current.provider.listModels?.bind(provRef.current.provider);
    if (listModels) {
      setSpinLabel("Fetching models…");
      listModels()
        .catch(() => fallback)
        .then((known) => {
          setSpinLabel(null);
          showMenu(known.length > 0 ? known : fallback);
        });
    } else {
      showMenu(fallback);
    }
    function showMenu(known: string[]) {
      const opts = cur && !known.includes(cur) ? [cur, ...known] : known;
      const applyModel = (m: string) => {
        setProv({ ...provRef.current, model: m });
        saveConfig({ ...loadConfig(), model: m });
        const eff = effortRef.current ?? "default";
        push({ kind: "note", text: `model: ${m} · effort ${eff} (saved)` });
      };
      const openCustomPrompt = () => {
        setPending({
          kind: "prompt",
          title: "model name:",
          resolve: (v) => {
            if (v && v.trim()) applyModel(v.trim());
          },
        });
      };
      setMenuSel(Math.max(0, opts.indexOf(cur)));
      setPending({
        kind: "config",
        title: `Model — ${name} · applies to the next task and is saved to config`,
        options: [...opts, "custom…"],
        resolve: (i) => {
          if (i === null) return;
          if (opts[i] === undefined) openCustomPrompt();
          else applyModel(opts[i]);
        },
      });
    }
  }, [push, provRef, effortRef, setPending, setMenuSel, setSpinLabel, setProv]);

  const openEffortMenu = useCallback(() => {
    const opts = ["default", "minimal", "low", "medium", "high", "xhigh", "max"];
    const cur = effortRef.current ?? "default";
    setMenuSel(opts.indexOf(cur));
    setPending({
      kind: "config",
      title: "Reasoning effort — applies to the next task (ignored on models without support)",
      options: opts,
      descs: [
        "provider default",
        "fastest — quick lookups, simple formatting",
        "modest reasoning — drafting, straightforward tasks",
        "balanced — agentic coding, research, most workloads",
        "hard reasoning — complex debugging, deep planning",
        "larger budget for the hardest multi-step problems",
        "unconstrained budget — high-stakes, hardest tasks",
      ],
      resolve: (i) => {
        if (i === null) return;
        const next = opts[i];
        effortRef.current = next === "default" ? undefined : (next as ReasoningEffort);
        saveConfig({ ...loadConfig(), effort: effortRef.current });
        push({ kind: "note", text: `reasoning effort: ${next} (saved)` });
      },
    });
  }, [push, effortRef, setPending, setMenuSel]);

  const openProviderMenu = useCallback(() => {
    const cfg = loadConfig();
    const env = process.env;
    const avail: string[] = [];
    if (env.ANTHROPIC_API_KEY || cfg.anthropicApiKey) avail.push("anthropic");
    if (env.OPENAI_API_KEY || cfg.openaiApiKey) avail.push("openai");
    if (env.DXXPCODE_PROVIDER === "mock" || env.DXXPCODE_MOCK_SCRIPT || provRef.current.provider.name === "mock") {
      avail.push("mock");
    }
    const cur = provRef.current.provider.name;
    const opts = [...new Set([cur, ...avail])];
    setMenuSel(Math.max(0, opts.indexOf(cur)));
    setPending({
      kind: "config",
      title: "Provider — switches providers for the next task and is saved to config",
      options: [...opts, "connect a provider\u2026"],
      resolve: (i) => {
        if (i === null) return;
        if (opts[i] === undefined) {
          setSetup(true);
          return;
        }
        const name = opts[i];
        if (name === cur) return;
        try {
          const fresh = loadConfig();
          const models = { ...(fresh.models ?? {}) };
          models[cur] = provRef.current.model; // remember this provider's model
          const sel = resolveProvider({
            provider: name,
            model: models[name],
            env,
            keys: { anthropic: fresh.anthropicApiKey, openai: fresh.openaiApiKey },
          });
          provRef.current = sel;
          setProv(sel);
          saveConfig({ ...fresh, provider: name, model: sel.model, models });
          push({ kind: "note", text: `provider: ${name} \u00b7 ${sel.model} (saved)` });
        } catch (e) {
          push({ kind: "error", text: e instanceof Error ? e.message : String(e) });
        }
      },
    });
  }, [push, provRef, setPending, setMenuSel, setProv, setSetup]);

  const openConfigMenu = useCallback(
    (tab = 0) => {
      const openApprovalMenu = () => {
        const opts = ["ask", "always-approve"];
        setMenuSel(autoRef.current ? 1 : 0);
        setPending({
          kind: "config",
          title: "Approval mode — applied to the next task and saved to config",
          options: opts,
          resolve: (i) => {
            if (i === null) return;
            const next = opts[i] === "always-approve";
            autoRef.current = next;
            setModeOverride(next ? "always-approve" : "ask");
            saveConfig({ ...loadConfig(), approvalMode: next ? "auto" : "ask" });
            push({ kind: "note", text: `approval mode: ${opts[i]} (saved)` });
          },
        });
      };
      const entries = ["Approval mode", "Provider", "Model", "Reasoning effort"];
      setMenuSel(0);
      setPending({
        kind: "config",
        title: "Settings",
        options: entries,
        tabs: ["Settings", "Session"],
        tab,
        resolve: (i) => {
          if (i === 0) openApprovalMenu();
          else if (i === 1) openProviderMenu();
          else if (i === 2) openModelMenu();
          else if (i === 3) openEffortMenu();
        },
      });
    },
    [push, autoRef, setPending, setMenuSel, setModeOverride, openModelMenu, openProviderMenu, openEffortMenu],
  );

  const statusRows = useCallback((): [string, string][] => {
    const p = props.project;
    const cur = provRef.current;
    const git = detectGit(props.root) ?? p.git;
    const effMode =
      d.modeOverride ?? (props.planOnly ? "plan" : autoRef.current ? "always-approve" : "ask");
    return [
      ["provider", `${cur.provider.name} · ${cur.model}`],
      ["mode", effMode],
      ["effort", effortRef.current ?? "default"],
      ["version", `v${props.version}`],
      ["project", `${p.name} — ${p.root}`],
      ["git", git ? `${git.branch}${git.dirty ? " (dirty)" : " (clean)"}` : "not a repository"],
      ["session", sessionRef.current?.id ?? "—"],
      [
        "context",
        sessionRef.current
          ? `~${fmtTokens(estimateTokens(sessionRef.current.messages))} tok / 60k cap`
          : "—",
      ],
      ["usage", `${fmtTokens(d.tok)} tok this turn`],
      ["config", join(homeDir(), "config.json")],
    ];
  }, [props, provRef, autoRef, effortRef, sessionRef, d.modeOverride, d.tok]);

  return { openModelMenu, openProviderMenu, openEffortMenu, openConfigMenu, statusRows };
}
