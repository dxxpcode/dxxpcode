export type OnboardingStep = "welcome" | "pick" | "key" | "project" | "first";

export const ONBOARDING_PHASES = ["Welcome", "Connect", "Project"];

export function onboardingPhase(step: OnboardingStep): number {
  return { welcome: 0, pick: 1, key: 1, project: 2, first: 3 }[step];
}

export function onboardingBack(step: OnboardingStep): OnboardingStep {
  return step === "key" ? "pick" : step === "pick" ? "welcome" : "pick";
}

export const ONBOARDING_PROVIDERS = [
  { id: "anthropic", name: "Anthropic", desc: "Claude models", keyUrl: "https://platform.claude.com/settings/keys" },
  { id: "openrouter", name: "OpenRouter", desc: "Claude, GPT, Gemini, and open models", keyUrl: "https://openrouter.ai/settings/keys", baseUrl: "https://openrouter.ai/api/v1" },
  { id: "openai", name: "OpenAI", desc: "GPT models", keyUrl: "https://platform.openai.com/api-keys" },
  { id: "gemini", name: "Gemini", desc: "Google AI Studio", keyUrl: "https://aistudio.google.com/apikey", baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai" },
  { id: "groq", name: "Groq", desc: "Fast open models", keyUrl: "https://console.groq.com/keys", baseUrl: "https://api.groq.com/openai/v1" },
  { id: "deepseek", name: "DeepSeek", desc: "DeepSeek models", keyUrl: "https://platform.deepseek.com/api_keys", baseUrl: "https://api.deepseek.com/v1" },
  { id: "xai", name: "xAI", desc: "Grok models", keyUrl: "https://console.x.ai/team/default/api-keys", baseUrl: "https://api.x.ai/v1" },
  { id: "mistral", name: "Mistral", desc: "Mistral models", keyUrl: "https://console.mistral.ai/api-keys", baseUrl: "https://api.mistral.ai/v1" },
  { id: "custom", name: "Other endpoint", desc: "Any OpenAI-compatible API" },
];

export function onboardingSetup(provider: string, key = "", baseUrl = "") {
  if (provider === "mock") return { type: "setup", provider: "mock" };
  return {
    type: "setup",
    provider: provider === "anthropic" ? "anthropic" : "openai",
    key: key.trim(),
    base_url: ONBOARDING_PROVIDERS.find((p) => p.id === provider)?.baseUrl ?? (baseUrl.trim() || undefined),
  };
}
