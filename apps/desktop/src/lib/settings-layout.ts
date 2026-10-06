export const SETTINGS_TABS = [
  { id: "general", label: "General", desc: "Project and setup" },
  { id: "providers", label: "Providers & Models", desc: "Connection, model, and approval preferences" },
  { id: "appearance", label: "Appearance", desc: "Theme and optional background artwork" },
  { id: "session", label: "Session", desc: "Current context and session actions" },
  { id: "about", label: "About", desc: "Version, updates, and resources" },
] as const;

export type SettingsTab = typeof SETTINGS_TABS[number]["id"];

export const APPROVAL_OPTIONS = [
  { value: "ask", label: "Ask", desc: "Ask before actions that require approval." },
  { value: "always-approve", label: "Always", desc: "Automatically approve actions without asking." },
  { value: "smart (Jev)", label: "Smart", desc: "Let Jev decide which actions require approval." },
] as const;

export function settingsApprovalValue(mode: string): string {
  return mode === "smart" ? "smart (Jev)" : mode;
}

export function settingsMenuPlacement(
  anchor: { left: number; right: number; top: number; bottom: number },
  viewport: { width: number; height: number },
) {
  const margin = 12;
  const gap = 4;
  const width = Math.min(Math.max(224, anchor.right - anchor.left), viewport.width - margin * 2);
  const below = viewport.height - margin - anchor.bottom - gap;
  const above = anchor.top - margin - gap;
  const maxHeight = Math.max(0, Math.min(240, Math.max(below, above)));
  const upward = below < Math.min(240, above);
  return {
    left: Math.max(margin, Math.min(anchor.right - width, viewport.width - margin - width)),
    top: upward ? undefined : anchor.bottom + gap,
    bottom: upward ? viewport.height - anchor.top + gap : undefined,
    width,
    maxHeight,
  };
}
