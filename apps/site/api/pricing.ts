import { activeTier, getTiers, seedTiersIfMissing, upstashReady } from "./_pricing";

// GET /api/pricing → data-driven pricing state for the /pricing card.
// sold counts are authoritative — "0 of 49" until real purchases confirm.
export async function GET() {
  if (!upstashReady()) return Response.json({ error: "pricing unavailable" }, { status: 503 });
  try {
    await seedTiersIfMissing();
    const tiers = await getTiers();
    const active = activeTier(tiers);
    return Response.json(
      {
        active: active ? { price_cents: active.price_cents, sold: active.sold, total: active.total, label: active.label, id: active.id } : null,
        ended: !active,
        tiers: tiers.map((t, i) => ({
          id: t.id,
          price_cents: t.price_cents,
          sold: t.sold,
          total: t.total,
          label: t.label,
          status: t.sold >= t.total ? "sold_out" : active?.id === t.id ? "active" : "upcoming",
          order: i + 1,
        })),
      },
      { headers: { "cache-control": "no-store" } },
    );
  } catch {
    return Response.json({ error: "pricing unavailable" }, { status: 502 });
  }
}
