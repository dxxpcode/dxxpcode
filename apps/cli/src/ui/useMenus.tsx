import { useCallback, type Dispatch, type MutableRefObject, type SetStateAction } from "react";
import type { ModelProvider, ReasoningEffort } from "@dxxpcode/providers";
import { KNOWN_MODELS } from "@dxxpcode/providers";
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
  provRef: MutableRefObject<{ provider: ModelProvider; model: string }>;
  autoRef: MutableRefObject<boolean>;
  effortRef: MutableRefObject<ReasoningEffort | undefined>;
  sessionRef: MutableRefObject<SessionRecord | undefined>;
  modeOverride: string | null;
  tok: number;
}

/** The /model, /effort, and /settings(+tab) menus plus the Session status rows. */
export function useConfigMenus(d: MenuDeps) {
  const { props, push, setPending, setMenuSel, setSpinLabel, setProv, setModeOverride } = d;
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
      const entries = ["Approval mode", "Model", "Reasoning effort"];
      setMenuSel(0);
      setPending({
        kind: "config",
        title: "Settings",
        options: entries,
        tabs: ["Settings", "Session"],
        tab,
        resolve: (i) => {
          if (i === 0) openApprovalMenu();
          else if (i === 1) openModelMenu();
          else if (i === 2) openEffortMenu();
        },
      });
    },
    [push, autoRef, setPending, setMenuSel, setModeOverride, openModelMenu, openEffortMenu],
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
      ["usage", `${fmtTokens(d.tok)} tok this turn`],
      ["config", join(homeDir(), "config.json")],
    ];
  }, [props, provRef, autoRef, effortRef, sessionRef, d.modeOverride, d.tok]);

  return { openModelMenu, openEffortMenu, openConfigMenu, statusRows };
}
