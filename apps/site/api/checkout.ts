import { activeTier, getTiers, upstashReady } from "./pricing-lib";

const STRIPE_KEY = process.env.STRIPE_SECRET_KEY;

// POST /api/checkout → creates a Stripe Checkout Session priced from the
// authoritative active tier. Never trusts client-supplied price or tier.
export async function POST(req: Request) {
  if (!upstashReady() || !STRIPE_KEY) {
    return Response.json({ error: "checkout unavailable" }, { status: 503 });
  }
  const origin = new URL(req.url).origin;
  const tiers = await getTiers();
  const active = activeTier(tiers);
  if (!active) {
    return Response.json({ error: "sold_out", message: "The lifetime offer has ended." }, { status: 409 });
  }
  const body = new URLSearchParams({
    mode: "payment",
    "line_items[0][price_data][currency]": "usd",
    "line_items[0][price_data][unit_amount]": String(active.price_cents),
    "line_items[0][price_data][product_data][name]": "DxxpCode Lifetime License",
    "line_items[0][price_data][product_data][description]":
      "One payment — lifetime access to DxxpCode, all current and future versions.",
    "line_items[0][quantity]": "1",
    "metadata[tier_id]": String(active.id),
    "metadata[price_cents]": String(active.price_cents),
    success_url: `${origin}/pricing/success?session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${origin}/pricing`,
  });
  const res = await fetch("https://api.stripe.com/v1/checkout/sessions", {
    method: "POST",
    headers: {
      authorization: `Bearer ${STRIPE_KEY}`,
      "content-type": "application/x-www-form-urlencoded",
    },
    body,
  });
  const session = (await res.json().catch(() => null)) as { url?: string; error?: { message?: string } } | null;
  if (!res.ok || !session?.url) {
    return Response.json(
      { error: "checkout_failed", message: session?.error?.message ?? "Could not create checkout." },
      { status: 502 },
    );
  }
  return Response.json({ url: session.url });
}
