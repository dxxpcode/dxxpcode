export const EFFORT_OPTIONS = [
  { value: "default", label: "Default", description: "Use the provider’s default reasoning budget.", tier: 0 },
  { value: "minimal", label: "Minimal", description: "Least deliberation for simple, direct tasks.", tier: 1 },
  { value: "low", label: "Low", description: "Light reasoning for straightforward changes.", tier: 2 },
  { value: "medium", label: "Medium", description: "Balanced reasoning for everyday coding.", tier: 3 },
  { value: "high", label: "High", description: "More deliberation for debugging and planning.", tier: 4 },
  { value: "xhigh", label: "Extra high", description: "A larger budget for complex, multi-step work.", tier: 5 },
  { value: "max", label: "Maximum", description: "The highest reasoning budget.", tier: 6 },
  { value: "auto (Jev)", label: "Auto", description: "Jev picks a level per task. Requires a Jev key.", tier: 0 },
];

export const EFFORT_LEVELS = EFFORT_OPTIONS.map((option) => option.value);

export function effortOption(value: string) {
  return EFFORT_OPTIONS.find((option) => option.value === value)
    ?? { value, label: value, description: "Current reasoning effort.", tier: 0 };
}

const PROVIDER_NAMES: Record<string, string> = {
  anthropic: "Anthropic",
  openai: "OpenAI",
  openrouter: "OpenRouter",
  gemini: "Gemini",
  google: "Google",
  groq: "Groq",
  deepseek: "DeepSeek",
  xai: "xAI",
  mistral: "Mistral",
  ollama: "Ollama",
  azure: "Azure",
  bedrock: "Bedrock",
  vertex: "Vertex AI",
  mock: "Demo",
  custom: "Custom",
};

export function displayProvider(id: string) {
  const key = id.trim().toLowerCase();
  if (PROVIDER_NAMES[key]) return PROVIDER_NAMES[key];
  return id.replace(/(^|[-_/])([a-z])/g, (_m, sep, ch: string) => (sep ? " " : "") + ch.toUpperCase()).replace(/[-_/]+/g, " ").trim() || id;
}

const MODEL_TOKENS: Record<string, string> = {
  claude: "Claude", opus: "Opus", sonnet: "Sonnet", haiku: "Haiku",
  gpt: "GPT", oss: "OSS", codex: "Codex",
  gemini: "Gemini", flash: "Flash", pro: "Pro",
  grok: "Grok", deepseek: "DeepSeek",
  mistral: "Mistral", mixtral: "Mixtral", codestral: "Codestral",
  devstral: "Devstral", ministral: "Ministral", magistral: "Magistral", nemo: "Nemo",
  qwen: "Qwen", qwq: "QwQ", llama: "Llama", kimi: "Kimi", glm: "GLM",
  phi: "Phi", nova: "Nova", jamba: "Jamba", command: "Command",
  o1: "o1", o3: "o3", o4: "o4",
};

const QUALIFIERS = new Set([
  "mini", "nano", "turbo", "chat", "latest", "preview", "thinking",
  "instruct", "fast", "lite", "free", "reasoner", "research", "coder",
  "air", "beta", "experimental", "base", "it",
]);

const VERSION = /^\d[\d.]*$/;
const COMPACT_FAMILY = /^(GPT|o\d)$/;

export function displayModel(id: string) {
  const base = (id.split("/").pop() ?? id).split(":")[0];
  const raw = base.split(/[-_]+/).filter(Boolean);
  if (!raw.length) return id;
  const out: string[] = [];
  for (const token of raw) {
    const lower = token.toLowerCase();
    const prev = out[out.length - 1];
    if (prev !== undefined && COMPACT_FAMILY.test(prev) && /^\d/.test(token)) {
      // gpt-5 / gpt-4o / o3 -> GPT-5, GPT-4o
      out[out.length - 1] = `${prev}-${token}`;
      continue;
    }
    if (VERSION.test(token) && prev !== undefined && VERSION.test(prev)) {
      // merge consecutive version tokens: 4 5 -> 4.5
      if (!prev.includes(".")) { out[out.length - 1] = `${prev}.${token}`; continue; }
      out.push(token);
      continue;
    }
    if (VERSION.test(token)) { out.push(token); continue; }
    const mapped = MODEL_TOKENS[lower];
    if (mapped) { out.push(mapped); continue; }
    if (QUALIFIERS.has(lower)) {
      // o3-mini style: qualifiers after o-series stay hyphenated
      if (prev && /^o\d/.test(prev)) out[out.length - 1] = `${prev}-${lower}`;
      else out.push(lower);
      continue;
    }
    out.push(token[0].toUpperCase() + token.slice(1));
  }
  return out.join(" ") || id;
}

export function filterModels(models: string[], current: string, query: string) {
  const needle = query.trim().toLowerCase();
  return Array.from(new Set([current, ...models]))
    .filter((model) => model.trim()
      && (model.toLowerCase().includes(needle) || displayModel(model).toLowerCase().includes(needle)));
}

export function nextOption(index: number, length: number, direction: number) {
  return length ? (index + direction + length) % length : -1;
}
