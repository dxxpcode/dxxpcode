import { readFileSync } from "node:fs";
import { AnthropicProvider } from "./anthropic.ts";
import { OpenAIProvider } from "./openai.ts";
import { MockProvider } from "./mock.ts";
import type { ModelProvider } from "./types.ts";
import type { MockScript, MockTurn } from "./mock.ts";

/** Models offered in the in-CLI picker; the first entry is the default. */
export const KNOWN_MODELS: Record<string, string[]> = {
  anthropic: ["claude-opus-5-5", "claude-sonnet-4-5", "claude-haiku-4-5"],
  openai: ["gpt-6", "gpt-5", "gpt-4o"],
};

export const DEFAULT_MODELS: Record<string, string> = {
  anthropic: KNOWN_MODELS.anthropic[0],
  openai: KNOWN_MODELS.openai[0],
};

export interface ProviderSelection {
  provider: ModelProvider;
  model: string;
}

export interface SelectOptions {
  provider?: string;
  model?: string;
  /** For tests: inject a mock script. */
  mockScript?: MockScript;
  env?: NodeJS.ProcessEnv;
  /** Keys saved in ~/.dxxpcode/config.json — used when the env var is absent. */
  keys?: { anthropic?: string; openai?: string };
}

export class ProviderConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProviderConfigError";
  }
}

/** DXXPCODE_MOCK_SCRIPT points at a JSON file of MockTurn[] for offline demos/e2e. */
function loadMockScript(path: string | undefined): MockTurn[] | undefined {
  if (!path) return undefined;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    if (!Array.isArray(parsed)) throw new Error("expected a JSON array");
    return parsed as MockTurn[];
  } catch (e) {
    throw new ProviderConfigError(
      `DXXPCODE_MOCK_SCRIPT ${path}: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
}

export function resolveProvider(opts: SelectOptions = {}): ProviderSelection {
  const env = opts.env ?? process.env;
  const name = (opts.provider ?? env.DXXPCODE_PROVIDER ?? "").toLowerCase();

  if (name === "mock" || opts.mockScript) {
    const script = opts.mockScript ?? loadMockScript(env.DXXPCODE_MOCK_SCRIPT) ?? [{ text: "mock" }];
    return { provider: new MockProvider(script), model: opts.model ?? "mock" };
  }

  if (name === "anthropic" || (!name && (env.ANTHROPIC_API_KEY || opts.keys?.anthropic))) {
    const key = env.ANTHROPIC_API_KEY ?? opts.keys?.anthropic;
    if (!key) throw new ProviderConfigError("DXXPCODE_PROVIDER=anthropic requires ANTHROPIC_API_KEY");
    return {
      provider: new AnthropicProvider(key),
      model: opts.model ?? env.DXXPCODE_MODEL ?? DEFAULT_MODELS.anthropic,
    };
  }

  if (name === "openai" || (!name && (env.OPENAI_API_KEY || opts.keys?.openai))) {
    const key = env.OPENAI_API_KEY ?? opts.keys?.openai;
    if (!key) throw new ProviderConfigError("DXXPCODE_PROVIDER=openai requires OPENAI_API_KEY");
    return {
      provider: new OpenAIProvider(key, env.OPENAI_BASE_URL),
      model: opts.model ?? env.DXXPCODE_MODEL ?? DEFAULT_MODELS.openai,
    };
  }

  if (name) {
    throw new ProviderConfigError(`Unknown provider "${name}". Supported: anthropic, openai`);
  }
  throw new ProviderConfigError(
    "No model provider configured. Run `dxxpcode` in a terminal to connect " +
      "one, or set ANTHROPIC_API_KEY / OPENAI_API_KEY.",
  );
}
