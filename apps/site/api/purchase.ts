import { cmd, toHash, upstashReady } from "./pricing-lib.js";

// GET /api/purchase?session_id=cs_… → the confirmed purchase for the success
// page. Reads only what the signed webhook wrote — never confirms from the
// client's claim alone.
export async function GET(req: Request) {
  if (!upstashReady()) return Response.json({ confirmed: false }, { status: 503 });
  const id = new URL(req.url).searchParams.get("session_id") ?? "";
  if (!id.startsWith("cs_")) return Response.json({ confirmed: false }, { status: 400 });
  const h = toHash(await cmd("HGETALL", `purchase:${id}`));
  if (!h.license_key) return Response.json({ confirmed: false });
  return Response.json(
    {
      confirmed: h.consumed === "1",
      license_key: h.license_key,
      price_paid_cents: Number(h.price_paid_cents ?? 0) || null,
      tier_id: Number(h.tier_id ?? 0) || null,
    },
    { headers: { "cache-control": "no-store" } },
  );
}
