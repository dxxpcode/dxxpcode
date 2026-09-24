const URL = process.env.UPSTASH_REDIS_REST_URL;
const TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// POST /api/track { install_id } — records a unique install once (SADD is idempotent).
export async function POST(req: Request) {
  if (!URL || !TOKEN) return Response.json({ ok: false }, { status: 503 });
  const body = await req.json().catch(() => null);
  const id = typeof body?.install_id === "string" ? body.install_id : "";
  if (!UUID_RE.test(id)) return Response.json({ ok: false }, { status: 400 });
  try {
    const res = await fetch(`${URL}/sadd/installs/${encodeURIComponent(id)}`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    if (!res.ok) throw new Error(`redis ${res.status}`);
    return Response.json({ ok: true });
  } catch {
    return Response.json({ ok: false }, { status: 502 });
  }
}
