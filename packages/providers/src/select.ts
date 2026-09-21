import { AnthropicProvider } from "./anthropic.ts";
import { OpenAIProvider } from "./openai.ts";
import { MockProvider } from "./mock.ts";
import type { ModelProvider } from "./types.ts";
import type { MockScript } from "./mock.ts";

export const DEFAULT_MODELS: Record<string, string> = {
  anthropic: "claude-sonnet-4-5",
  openai: "gpt-4o",
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
}

export class ProviderConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProviderConfigError";
  }
}

export function resolveProvider(opts: SelectOptions = {}): ProviderSelection {
  const env = opts.env ?? process.env;
  const name = (opts.provider ?? env.DXXPCODE_PROVIDER ?? "").toLowerCase();

  if (name === "mock" || opts.mockScript) {
    return { provider: new MockProvider(opts.mockScript ?? [{ text: "mock" }]), model: opts.model ?? "mock" };
  }

  if (name === "anthropic" || (!name && env.ANTHROPIC_API_KEY)) {
    const key = env.ANTHROPIC_API_KEY;
    if (!key) throw new ProviderConfigError("DXXPCODE_PROVIDER=anthropic requires ANTHROPIC_API_KEY");
    return {
      provider: new AnthropicProvider(key),
      model: opts.model ?? env.DXXPCODE_MODEL ?? DEFAULT_MODELS.anthropic,
    };
  }

  if (name === "openai" || (!name && env.OPENAI_API_KEY)) {
    const key = env.OPENAI_API_KEY;
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
    "No model provider configured. Set ANTHROPIC_API_KEY or OPENAI_API_KEY " +
      "(or DXXPCODE_PROVIDER/DXXPCODE_MODEL).",
  );
}
