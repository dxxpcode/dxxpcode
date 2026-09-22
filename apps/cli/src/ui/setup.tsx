import React, { useState } from "react";
import { Box, Text, render, useApp, useInput } from "ink";
import TextInput from "ink-text-input";
import { join } from "node:path";
import { homeDir } from "@dxxpcode/sessions";

export interface SetupResult {
  provider: "anthropic" | "openai";
  apiKey: string;
  baseUrl?: string;
}

const PROVIDERS = [
  { id: "anthropic" as const, label: "Anthropic", desc: "Claude models" },
  { id: "openai" as const, label: "OpenAI-compatible", desc: "OpenAI, OpenRouter, local endpoints" },
];

const SURFACE_HI = "#262838";

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
        <Text color="cyan" bold>
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
