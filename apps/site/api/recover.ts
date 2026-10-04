import { cmd, toHash, upstashReady } from "./pricing-lib.js";
import { mailReady, sendLicenseEmail } from "./mail.js";

// GET /api/recover?email=… → resends the license key for the purchase tied to
// that checkout email. Always answers {ok:true} so it can't probe whether an
// email bought anything.
export async function GET(req: Request) {
  if (!upstashReady() || !mailReady()) return Response.json({ ok: true });
  const email = (new URL(req.url).searchParams.get("email") ?? "").trim().toLowerCase();
  if (!email.includes("@")) return Response.json({ ok: true });
  const sessionId = (await cmd("GET", `email:${email}`)) as string | null;
  if (!sessionId) return Response.json({ ok: true });
  const h = toHash(await cmd("HGETALL", `purchase:${sessionId}`));
  if (h.consumed === "1" && h.refunded !== "1" && h.license_key) {
    try {
      await sendLicenseEmail(email, h.license_key);
    } catch {
      return Response.json({ ok: true });
    }
  }
  return Response.json({ ok: true }, { headers: { "cache-control": "no-store" } });
}
