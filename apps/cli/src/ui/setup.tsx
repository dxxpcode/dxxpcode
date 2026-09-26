import React, { useState } from "react";
import { Box, Text, render, useApp, useInput } from "ink";
import TextInput from "ink-text-input";
import { join } from "node:path";
import { homeDir } from "@dxxpcode/sessions";
import type { ReasoningEffort } from "@dxxpcode/providers";
import { SURFACE_HI } from "./shared.ts";

export interface SetupResult {
  provider: "anthropic" | "openai";
  apiKey: string;
  baseUrl?: string;
}

const PROVIDERS = [
  { id: "anthropic" as const, label: "Anthropic", desc: "Claude models" },
  { id: "openai" as const, label: "OpenAI-compatible", desc: "OpenAI, OpenRouter, local endpoints" },
];


/**
 * Connect a model provider: pick provider → paste key (masked) → optional
 * base URL for OpenAI-compatible endpoints. onDone(null) = cancelled.
 */
export function ProviderSetup({ onDone }: { onDone: (r: SetupResult | null) => void }) {
  const [step, setStep] = useState<0 | 1 | 2>(0);
  const [sel, setSel] = useState(0);
  const [provider, setProvider] = useState<SetupResult["provider"]>("anthropic");
  const [apiKey, setApiKey] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [err, setErr] = useState("");

  useInput((ch, key) => {
    if (key.escape) {
      onDone(null);
      return;
    }
    if (step === 0) {
      if (key.upArrow || ch === "k") setSel(0);
      else if (key.downArrow || ch === "j") setSel(1);
      else if (key.return) {
        setProvider(PROVIDERS[sel].id);
        setStep(1);
      }
    }
  });

  const finishKey = (value: string) => {
    const k = value.trim();
    if (!k) {
      setErr("key can't be empty");
      return;
    }
    setApiKey(k);
    setErr("");
    if (provider === "openai") setStep(2);
    else onDone({ provider, apiKey: k });
  };

  const finishBaseUrl = (value: string) => {
    const u = value.trim();
    onDone({ provider, apiKey, baseUrl: u || undefined });
  };

  return (
    <Box flexDirection="column">
      <Text>
        <Text bold>
          ◆ Connect a model provider
        </Text>
      </Text>
      <Text dimColor>
        {"  "}saved to {join(homeDir(), "config.json")} (owner-only) — env vars still take precedence
      </Text>
      <Text> </Text>
      {step === 0 && (
        <Box flexDirection="column">
          {PROVIDERS.map((p, i) => (
            <Box key={p.id} flexDirection="column">
              <Text backgroundColor={i === sel ? SURFACE_HI : undefined}>
                <Text dimColor={i !== sel} bold={i === sel}>
                  {i === sel ? " ● " : " ◯ "}
                  {p.label}
                  {" ".repeat(Math.max(0, 18 - p.label.length))}
                </Text>
              </Text>
              <Text dimColor>
                {"      "}
                {p.desc}
              </Text>
            </Box>
          ))}
          <Text dimColor>{"  "}↑/↓ navigate · Enter select · esc cancel</Text>
        </Box>
      )}
      {step === 1 && (
        <Box flexDirection="column">
          <Text>
            {"  "}
            {provider === "anthropic" ? "ANTHROPIC_API_KEY" : "OPENAI_API_KEY"}
            {": "}
            <TextInput value={apiKey} mask="*" onChange={setApiKey} onSubmit={finishKey} />
          </Text>
          {err ? <Text color="red">{"  "}{err}</Text> : null}
          <Text dimColor>{"  "}Enter save · esc cancel</Text>
        </Box>
      )}
      {step === 2 && (
        <Box flexDirection="column">
          <Text dimColor>{"  "}Base URL (optional — default https://api.openai.com/v1)</Text>
          <Text>
            {"  "}
            <TextInput
              value={baseUrl}
              placeholder="https://api.openai.com/v1"
              onChange={setBaseUrl}
              onSubmit={finishBaseUrl}
            />
          </Text>
          <Text dimColor>{"  "}Enter save · esc cancel</Text>
        </Box>
      )}
    </Box>
  );
}

function StandaloneSetup({ onDone }: { onDone: (r: SetupResult | null) => void }) {
  const { exit } = useApp();
  return (
    <Box flexDirection="column" paddingTop={1}>
      <ProviderSetup
        onDone={(r) => {
          onDone(r);
          exit();
        }}
      />
    </Box>
  );
}

/** First-run flow: mount the setup UI alone; resolves null when cancelled. */
export async function runProviderSetup(): Promise<SetupResult | null> {
  return new Promise<SetupResult | null>((resolve) => {
    const app = render(<StandaloneSetup onDone={resolve} />);
    app.waitUntilExit().catch(() => resolve(null));
  });
}

export interface WizardResult {
  provider?: SetupResult;
  effort?: ReasoningEffort;
  effortAuto?: boolean;
  typeSafeApiKey?: string;
}

const EFFORT_OPTS: { id: ReasoningEffort | "auto"; label: string; desc: string }[] = [
  { id: "minimal", label: "minimal", desc: "fastest — quick lookups, simple edits" },
  { id: "low", label: "low", desc: "modest reasoning — drafting, straightforward tasks" },
  { id: "medium", label: "medium", desc: "balanced — most coding workloads" },
  { id: "high", label: "high", desc: "hard reasoning — debugging, deep planning" },
  { id: "xhigh", label: "xhigh", desc: "larger budget for the hardest problems" },
  { id: "max", label: "max", desc: "unconstrained — high-stakes tasks" },
  { id: "auto", label: "auto (Jev)", desc: "Jev scores each task and picks the tier" },
];

/**
 * Guided onboarding: welcome → provider + key → effort → optional
 * TYPESAFE_API_KEY → done. esc cancels at any step; steps reuse the same
 * visual language as the menus.
 */
export function SetupWizard({ onDone }: { onDone: (r: WizardResult | null) => void }) {
  const [step, setStep] = useState(0);
  const [sel, setSel] = useState(2); // medium default
  const [result, setResult] = useState<WizardResult>({});
  const [jevKey, setJevKey] = useState("");

  useInput((ch, key) => {
    if (key.escape) {
      onDone(null);
      return;
    }
    if (step === 0 && key.return) setStep(1);
    else if (step === 2) {
      if (key.upArrow || ch === "k") setSel((s) => Math.max(0, s - 1));
      else if (key.downArrow || ch === "j") setSel((s) => Math.min(EFFORT_OPTS.length - 1, s + 1));
      else if (key.return) {
        const opt = EFFORT_OPTS[sel];
        setResult((r) => ({
          ...r,
          effortAuto: opt.id === "auto",
          effort: opt.id === "auto" ? undefined : (opt.id as ReasoningEffort),
        }));
        setStep(3);
      }
    }
  });

  return (
    <Box flexDirection="column">
      <Text>
        <Text bold>
          ◆ Setup — dxxpcode
        </Text>
      </Text>
      <Text dimColor>{"  "}esc skips everything · each step is optional after the first run</Text>
      <Text> </Text>
      {step === 0 && (
        <Box flexDirection="column">
          <Text>{"  "}This wizard connects a provider, sets reasoning effort,</Text>
          <Text>{"  "}and optionally enables Jev smart features.</Text>
          <Text dimColor>{"  "}Enter to begin</Text>
        </Box>
      )}
      {step === 1 && (
        <ProviderSetup
          onDone={(r) => {
            if (r) setResult((w) => ({ ...w, provider: r }));
            setStep(2);
          }}
        />
      )}
      {step === 2 && (
        <Box flexDirection="column">
          <Text>{"  "}Reasoning effort</Text>
          {EFFORT_OPTS.map((o, i) => (
            <Box key={o.id} flexDirection="column">
              <Text backgroundColor={i === sel ? SURFACE_HI : undefined}>
                <Text dimColor={i !== sel} bold={i === sel}>
                  {i === sel ? " ● " : " ◯ "}
                  {o.label}
                  {" ".repeat(Math.max(0, 12 - o.label.length))}
                </Text>
              </Text>
              <Text dimColor>
                {"      "}
                {o.desc}
              </Text>
            </Box>
          ))}
          <Text dimColor>{"  "}↑/↓ navigate · Enter select · esc skip</Text>
        </Box>
      )}
      {step === 3 && (
        <Box flexDirection="column">
          <Text dimColor>{"  "}TYPESAFE_API_KEY (optional — enables smart approvals + auto effort)</Text>
          <Text>
            {"  "}
            <TextInput
              value={jevKey}
              mask="*"
              placeholder="leave empty to skip"
              onChange={setJevKey}
              onSubmit={(v) => {
                const k = v.trim();
                if (k) setResult((r) => ({ ...r, typeSafeApiKey: k }));
                onDone({ ...result, typeSafeApiKey: k || undefined });
              }}
            />
          </Text>
          <Text dimColor>{"  "}Enter save/skip · esc cancel</Text>
        </Box>
      )}
    </Box>
  );
}
