import { cmd, toHash, upstashReady } from "./_pricing";

// GET /api/license?key=… → { valid, tier_id, price_paid_cents } — dormant until
// the app starts validating keys (option B); cheap to ship now.
export async function GET(req: Request) {
  if (!upstashReady()) return Response.json({ valid: false }, { status: 503 });
  const key = new URL(req.url).searchParams.get("key") ?? "";
  if (!key.startsWith("dxxp-live-")) return Response.json({ valid: false });
  const sessionId = (await cmd("GET", `license:${key}`)) as string | null;
  if (!sessionId) return Response.json({ valid: false });
  const h = toHash(await cmd("HGETALL", `purchase:${sessionId}`));
  return Response.json(
    {
      valid: h.consumed === "1",
      tier_id: Number(h.tier_id ?? 0) || null,
      price_paid_cents: Number(h.price_paid_cents ?? 0) || null,
    },
    { headers: { "cache-control": "no-store" } },
  );
}
