import { cmd, consumeLicense, licenseKeyFor, upstashReady } from "../_pricing";

const WH_SECRET = process.env.STRIPE_WEBHOOK_SECRET;

async function hmac(key: string, msg: string): Promise<string> {
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(key),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", cryptoKey, new TextEncoder().encode(msg));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function verifyStripeSignature(payload: string, header: string | null): Promise<boolean> {
  if (!WH_SECRET || !header) return false;
  const parts = Object.fromEntries(
    header.split(",").map((p) => p.split("=") as [string, string]),
  );
  const ts = parts.t;
  const v1 = parts.v1;
  if (!ts || !v1) return false;
  const expected = await hmac(WH_SECRET, `${ts}.${payload}`);
  return expected === v1;
}

// POST /api/webhooks/stripe — the ONLY place a license is ever consumed.
// Signature-verified checkout.session.completed → atomic sold+1 → record purchase.
// Idempotent on stripe session id (duplicate deliveries are no-ops).
export async function POST(req: Request) {
  if (!upstashReady() || !WH_SECRET) return new Response("unavailable", { status: 503 });
  const payload = await req.text();
  if (!(await verifyStripeSignature(payload, req.headers.get("stripe-signature")))) {
    return new Response("invalid signature", { status: 400 });
  }
  const event = JSON.parse(payload) as {
    type?: string;
    data?: {
      object?: {
        id?: string;
        metadata?: { tier_id?: string; price_cents?: string };
        customer_details?: { email?: string };
      };
    };
  };
  if (event.type !== "checkout.session.completed") return new Response("ok");
  const session = event.data?.object;
  const sessionId = session?.id;
  const tierId = Number(session?.metadata?.tier_id);
  const priceCents = Number(session?.metadata?.price_cents);
  if (!sessionId || !tierId || !priceCents) return new Response("bad session", { status: 400 });

  // Idempotency: first writer wins, duplicate webhook deliveries are no-ops.
  const claimed = (await cmd("SETNX", `purchase:${sessionId}`, "pending")) as number;
  if (!claimed) return new Response("ok");

  const total = Number(((await cmd("HGET", `tier:${tierId}`, "total")) as string) ?? 0);
  const consumed = await consumeLicense({
    id: tierId,
    price_cents: priceCents,
    total,
    sold: 0,
    label: "",
  });
  const license = licenseKeyFor(sessionId);
  await cmd(
    "HSET", `purchase:${sessionId}`,
    "tier_id", tierId,
    "price_paid_cents", priceCents,
    "license_key", license,
    "email", session?.customer_details?.email ?? "",
    "consumed", consumed ? 1 : 0,
  );
  await cmd("SET", `license:${license}`, sessionId);
  // consumed=false = payment succeeded but the tier had just sold out — the
  // purchase is still recorded (with consumed=0) for support/refund handling.
  return new Response("ok");
}
