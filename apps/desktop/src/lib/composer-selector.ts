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
    .filter((model) => model.trim() && model.toLowerCase().includes(needle));
}

export function nextOption(index: number, length: number, direction: number) {
  return length ? (index + direction + length) % length : -1;
}
