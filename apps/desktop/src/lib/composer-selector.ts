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

export function filterModels(models: string[], current: string, query: string) {
  const needle = query.trim().toLowerCase();
  return Array.from(new Set([current, ...models]))
    .filter((model) => model.trim() && `${model} ${modelLabel(model)}`.toLowerCase().includes(needle));
}

export function modelLabel(id: string): string {
  const base = id.replace(/-(?:\d{8}|\d{4}-\d{2}-\d{2})$/, "").replace(/-latest$/, "");
  const claude = base.match(/^claude-(opus|sonnet|haiku)-(\d+)(?:-(\d+))?$/);
  if (claude) return `Claude ${claude[1][0].toUpperCase() + claude[1].slice(1)} ${claude[2]}${claude[3] ? `.${claude[3]}` : ""}`;
  const gpt = base.match(/^gpt-(\d+(?:\.\d+)?[a-z]?)((?:-(?:mini|nano|sol|luna|terra|astra|codex|pro|max))*)$/);
  if (gpt) return `GPT-${gpt[1]}${gpt[2].split("-").filter(Boolean).map((word) => ` ${word[0].toUpperCase()}${word.slice(1)}`).join("")}`;
  return id;
}

export function selectorPosition(
  anchor: { left: number; top: number; bottom: number },
  viewport: { width: number; height: number },
) {
  const gutter = 12;
  const gap = 8;
  const width = Math.max(0, Math.min(328, viewport.width - gutter * 2));
  const left = Math.max(gutter, Math.min(anchor.left, viewport.width - width - gutter));
  const above = Math.max(0, anchor.top - gap - gutter);
  const below = Math.max(0, viewport.height - anchor.bottom - gap - gutter);
  const openAbove = below < 280 && above > below;
  return {
    left, width,
    maxHeight: Math.min(440, openAbove ? above : below),
    ...(openAbove ? { bottom: viewport.height - anchor.top + gap, top: undefined }
      : { top: anchor.bottom + gap, bottom: undefined }),
  };
}

export function nextOption(index: number, length: number, direction: number) {
  return length ? (index + direction + length) % length : -1;
}
