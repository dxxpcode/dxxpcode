import { randomUUID } from "node:crypto";
import type { DxxpConfig } from "@dxxpcode/sessions";
import { saveConfig } from "@dxxpcode/sessions";
import { authBase } from "./auth.ts";

/**
 * One-shot install ping: generates a random install ID on first run and POSTs it
 * to the stats endpoint. No machine/user data — the ID exists only to dedupe.
 * Fire-and-forget; failures are ignored so a blocked network never affects startup.
 */
export function trackInstall(config: DxxpConfig, env: NodeJS.ProcessEnv = process.env): void {
  if (config.installId) return;
  const installId = randomUUID();
  try {
    saveConfig({ ...config, installId }, env);
  } catch {
    return; // can't persist the ID — pinging would count every run
  }
  fetch(`${authBase(env)}/api/track`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ install_id: installId }),
  }).catch(() => {});
}
