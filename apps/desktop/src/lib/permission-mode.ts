export type PermissionMode = "ask" | "smart" | "always-approve";

export const PERMISSION_OPTIONS: { value: PermissionMode; label: string; short: string; description: string }[] = [
  { value: "ask", label: "Ask for approval", short: "Ask", description: "Asks before editing files or running commands." },
  { value: "smart", label: "Approve for me", short: "Auto-review", description: "Jev approves safe actions and asks about the rest. Requires a Jev key." },
  { value: "always-approve", label: "Full access", short: "Full access", description: "Edits files and runs commands without asking." },
];

export function permissionMode(mode: string | undefined): PermissionMode {
  if (mode === "smart" || mode === "smart (Jev)") return "smart";
  if (mode === "always-approve" || mode === "auto" || mode === "always") return "always-approve";
  return "ask";
}

export function permissionOption(mode: string | undefined) {
  const value = permissionMode(mode);
  return PERMISSION_OPTIONS.find((option) => option.value === value)!;
}
