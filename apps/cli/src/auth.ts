/** Base URL for site endpoints (install tracking). Overridable for testing. */
export function authBase(env: NodeJS.ProcessEnv = process.env): string {
  return env.DXXPCODE_AUTH_URL ?? "https://dxxpcode.vercel.app";
}
