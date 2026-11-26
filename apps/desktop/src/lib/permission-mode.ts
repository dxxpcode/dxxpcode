export type PermissionMode = "ask" | "smart" | "always-approve";

export const PERMISSION_OPTIONS: { value: PermissionMode; label: string; short: string; description: string }[] = [
  { value: "ask", label: "Ask for approval", short: "Ask", description: "Review each edit and command." },
  { value: "smart", label: "Approve for me", short: "Auto-review", description: "Jev reviews safe actions for you." },
  { value: "always-approve", label: "Full access", short: "Full access", description: "Run without approval prompts." },
];

export type ComposerMode = PermissionMode | "plan";

export const PLAN_OPTION: { value: "plan"; label: string; short: string; description: string } = {
  value: "plan", label: "Plan first", short: "Plan", description: "Review a plan before changes.",
};

export const MODE_OPTIONS = [...PERMISSION_OPTIONS, PLAN_OPTION];

export function composerMode(mode: string | undefined, plan: boolean): ComposerMode {
  return plan ? "plan" : permissionMode(mode);
}

export function permissionMode(mode: string | undefined): PermissionMode {
  if (mode === "smart" || mode === "smart (Jev)") return "smart";
  if (mode === "always-approve" || mode === "auto" || mode === "always") return "always-approve";
  return "ask";
}

export function permissionOption(mode: string | undefined) {
  const value = permissionMode(mode);
  return PERMISSION_OPTIONS.find((option) => option.value === value)!;
}
