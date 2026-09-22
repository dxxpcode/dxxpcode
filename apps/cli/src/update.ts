import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homeDir } from "@dxxpcode/sessions";

interface Cache {
  checkedAt: number;
  latest: string;
}

const DAY_MS = 24 * 60 * 60 * 1000;
const REGISTRY = "https://registry.npmjs.org/dxxpcode/latest";

function cachePath(env: NodeJS.ProcessEnv): string {
  return join(homeDir(env), "update-check.json");
}

function readCache(env: NodeJS.ProcessEnv): Cache | null {
  try {
    const raw = JSON.parse(readFileSync(cachePath(env), "utf8")) as Cache;
    return typeof raw.latest === "string" && typeof raw.checkedAt === "number" ? raw : null;
  } catch {
    return null;
  }
}

async function fetchLatest(): Promise<string | null> {
  try {
    const res = await fetch(REGISTRY, {
      signal: AbortSignal.timeout(2000),
      headers: { accept: "application/vnd.npm.install-v1+json" },
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { version?: string };
    return typeof body.version === "string" ? body.version : null;
  } catch {
    return null;
  }
}

/** Simple semver-ish compare: "0.2.0" > "0.1.9" */
export function isNewer(latest: string, current: string): boolean {
  const parse = (v: string) => v.replace(/^v/, "").split(".").map((n) => parseInt(n, 10) || 0);
  const a = parse(latest);
  const b = parse(current);
  for (let i = 0; i < 3; i++) {
    if ((a[i] ?? 0) > (b[i] ?? 0)) return true;
    if ((a[i] ?? 0) < (b[i] ?? 0)) return false;
  }
  return false;
}

/**
 * Resolve to the latest published version if it's newer than `current`,
 * otherwise null. Uses a 24h cache so the registry is hit at most once a day;
 * on a cache hit newer than current, returns immediately. Never throws.
 */
export async function checkForUpdate(
  current: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<string | null> {
  const cache = readCache(env);
  let latest: string | null;
  if (cache && Date.now() - cache.checkedAt < DAY_MS) {
    latest = cache.latest;
  } else {
    latest = await fetchLatest();
    if (latest === null) {
      // Failed lookups cache for a day too — offline users aren't re-hit.
      if (cache) {
        try {
          mkdirSync(homeDir(env), { recursive: true });
          writeFileSync(cachePath(env), JSON.stringify({ ...cache, checkedAt: Date.now() }));
        } catch {
          /* read-only home — fine */
        }
      }
      return null;
    }
    try {
      mkdirSync(homeDir(env), { recursive: true });
      writeFileSync(cachePath(env), JSON.stringify({ checkedAt: Date.now(), latest } satisfies Cache));
    } catch {
      /* read-only home — fine */
    }
  }
  return isNewer(latest, current) ? latest : null;
}
