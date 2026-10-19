export const EFFORT_OPTIONS = [
  { value: "default", label: "Default", description: "Use this model’s default reasoning setting." },
  { value: "none", label: "None", description: "Do not request additional reasoning." },
  { value: "minimal", label: "Minimal", description: "Least deliberation for simple, direct tasks." },
  { value: "low", label: "Low", description: "Light reasoning for straightforward changes." },
  { value: "medium", label: "Medium", description: "Balanced reasoning for everyday coding." },
  { value: "high", label: "High", description: "More deliberation for debugging and planning." },
  { value: "xhigh", label: "Extra high", description: "Deeper reasoning for complex, multi-step work." },
  { value: "max", label: "Maximum", description: "This model’s highest reasoning setting." },
  { value: "auto (Jev)", label: "Auto", description: "Jev picks a supported level per task." },
];

export function modelLabel(id: string, displayName?: string): string {
  if (displayName?.trim() && displayName !== id) return displayName;
  const base = id.replace(/-(?:\d{8}|\d{4}-\d{2}-\d{2})$/, "").replace(/-latest$/, "");
  const claude = base.match(/^claude-(opus|sonnet|haiku|fable|mythos)-(\d+)(?:-(\d+))?$/);
  if (claude) return `Claude ${title(claude[1])} ${claude[2]}${claude[3] ? `.${claude[3]}` : ""}`;
  const legacyClaude = base.match(/^claude-(\d+)-(\d+)-(opus|sonnet|haiku)$/);
  if (legacyClaude) return `Claude ${title(legacyClaude[3])} ${legacyClaude[1]}.${legacyClaude[2]}`;
  const gpt = base.match(/^gpt-(\d+(?:\.\d+)?[a-z]?)((?:-(?:mini|nano|sol|luna|terra|astra|codex|pro|max))*)$/);
  if (gpt) return `GPT-${gpt[1]}${gpt[2].split("-").filter(Boolean).map((word) => ` ${title(word)}`).join("")}`;
  if (/^o[134](?:-mini)?$/.test(base)) return base.replace("-mini", " mini");
  return id;
}

function title(value: string) {
  return value[0].toUpperCase() + value.slice(1);
}

export function availableEffortOptions(choices?: readonly string[]) {
  const allowed = new Set(["default", ...(choices ?? [])]);
  return EFFORT_OPTIONS.filter((option) => allowed.has(option.value));
}

export function selectedEffort(value: string, choices?: readonly string[]) {
  return availableEffortOptions(choices).find((option) => option.value === value) ?? EFFORT_OPTIONS[0];
}

export function filterModels(models: string[], current: string, query: string, names: Readonly<Record<string, string>> = {}) {
  const needle = query.trim().toLowerCase();
  return Array.from(new Set([current, ...models]))
    .filter((model) => model.trim() && `${model} ${modelLabel(model, names[model])}`.toLowerCase().includes(needle));
}

export function nextOption(index: number, length: number, direction: number) {
  return length ? (index + direction + length) % length : -1;
}
