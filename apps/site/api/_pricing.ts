const URL_ = process.env.UPSTASH_REDIS_REST_URL;
const TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;

export interface Tier {
  id: number;
  price_cents: number;
  total: number;
  sold: number;
  label: string;
}

// Canonical tier definitions — seeded into Redis on first read (values already
// in Redis win, so totals/price can be adjusted in the Upstash console without
// a code change).
export const TIERS: Omit<Tier, "sold">[] = [
  { id: 1, price_cents: 4900, total: 49, label: "now" },
  { id: 2, price_cents: 9900, total: 99, label: "next" },
  { id: 3, price_cents: 14900, total: 149, label: "final" },
];

export function upstashReady() {
  return Boolean(URL_ && TOKEN);
}

// Upstash REST accepts the full command as a JSON array in the POST body.
export async function cmd(...args: (string | number)[]): Promise<unknown> {
  const res = await fetch(`${URL_}`, {
    method: "POST",
    headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
    body: JSON.stringify(args),
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`upstash ${res.status}`);
  const body = await res.json();
  if (body.error) throw new Error(`upstash: ${body.error}`);
  return body.result;
}

const CONSUME_SCRIPT =
  "local s=redis.call('hget',KEYS[1],'sold') " +
  "if s and tonumber(s)<tonumber(ARGV[1]) then " +
  "redis.call('hincrby',KEYS[1],'sold',1) return 1 else return 0 end";

// Atomic conditional increment — true if a license was consumed, false if the
// tier is already sold out. A single Redis EVAL, so two buyers racing for the
// last license can never both succeed.
export async function consumeLicense(tier: Tier): Promise<boolean> {
  return (await cmd("EVAL", CONSUME_SCRIPT, 1, `tier:${tier.id}`, tier.total)) === 1;
}

export async function getTiers(): Promise<Tier[]> {
  return Promise.all(
    TIERS.map(async (t) => {
      const h = (await cmd("HGETALL", `tier:${t.id}`)) as Record<string, string> | null;
      return {
        ...t,
        price_cents: Number(h?.price_cents ?? t.price_cents),
        total: Number(h?.total ?? t.total),
        sold: Number(h?.sold ?? 0),
      };
    }),
  );
}

// Active tier = lowest-order tier with sold < total. Null = offer ended.
export function activeTier(tiers: Tier[]): Tier | null {
  return tiers.find((t) => t.sold < t.total) ?? null;
}

// Writes the default tier hashes only where keys are missing — safe on every request.
export async function seedTiersIfMissing() {
  for (const t of TIERS) {
    if (!(await cmd("EXISTS", `tier:${t.id}`))) {
      await cmd(
        "HSET", `tier:${t.id}`,
        "price_cents", t.price_cents,
        "total", t.total,
        "sold", 0,
        "label", t.label,
      );
    }
  }
}

export function licenseKeyFor(sessionId: string): string {
  return `dxxp-live-${sessionId.replace(/[^a-zA-Z0-9]/g, "").slice(-16)}`;
}
