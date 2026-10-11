import { cmd, consumeLicense, licenseKeyFor, toHash, upstashReady } from "../pricing-lib.js";
import { mailReady, sendLicenseEmail } from "../mail.js";

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

function timingSafeEq(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

const TOLERANCE_SECS = 300; // Stripe's recommended replay window

async function verifyStripeSignature(payload: string, header: string | null): Promise<boolean> {
  if (!WH_SECRET || !header) return false;
  const parts = Object.fromEntries(
    header.split(",").map((p) => p.split("=") as [string, string]),
  );
  const ts = parts.t;
  const v1 = parts.v1;
  if (!ts || !v1) return false;
  const tsNum = Number(ts);
  if (!Number.isFinite(tsNum) || Math.abs(Date.now() / 1000 - tsNum) > TOLERANCE_SECS) {
    return false;
  }
  const expected = await hmac(WH_SECRET, `${ts}.${payload}`);
  return timingSafeEq(expected, v1);
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
        payment_intent?: string;
        metadata?: { tier_id?: string; price_cents?: string };
        customer_details?: { email?: string };
      };
    };
  };
  const obj = event.data?.object;

  // checkout.session.expired → the buyer abandoned before paying; clear the
  // "pending" claim so a later completed delivery isn't misread as a duplicate.
  if (event.type === "checkout.session.expired" && obj?.id) {
    await cmd("DEL", `purchase:${obj.id}`);
    return new Response("ok");
  }

  // charge.refunded → revoke the license tied to the checkout session that
  // produced this charge (looked up via the payment_intent index we write at
  // purchase time). License validation keys off refunded=1.
  if (event.type === "charge.refunded" && obj?.payment_intent) {
    const sessionId = (await cmd("GET", `pi:${obj.payment_intent}`)) as string | null;
    if (!sessionId) return new Response("ok");
    const h = toHash(await cmd("HGETALL", `purchase:${sessionId}`));
    if (!h.license_key) return new Response("ok");
    await cmd("HSET", `purchase:${sessionId}`, "refunded", 1);
    return new Response("ok");
  }

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
  const email = session?.customer_details?.email ?? "";
  await cmd(
    "HSET", `purchase:${sessionId}`,
    "tier_id", tierId,
    "price_paid_cents", priceCents,
    "license_key", license,
    "email", email,
    "consumed", consumed ? 1 : 0,
  );
  await cmd("SET", `license:${license}`, sessionId);
  // Indexes for refunds and lost-key recovery.
  if (session?.payment_intent) await cmd("SET", `pi:${session.payment_intent}`, sessionId);
  if (email) await cmd("SET", `email:${email.toLowerCase()}`, sessionId);
  if (consumed && email && mailReady()) {
    try {
      await sendLicenseEmail(email, license);
      await cmd("HSET", `purchase:${sessionId}`, "emailed", 1);
    } catch {
      await cmd("HSET", `purchase:${sessionId}`, "emailed", 0);
    }
  }
  // consumed=false = payment succeeded but the tier had just sold out — the
  // purchase is still recorded (with consumed=0) for support/refund handling.
  return new Response("ok");
}
