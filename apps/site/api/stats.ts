const URL = process.env.UPSTASH_REDIS_REST_URL;
const TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;

// GET /api/stats → { installs: n } — unique install count, cached at the edge for 5 min.
export async function GET() {
  if (!URL || !TOKEN) return Response.json({ installs: null }, { status: 503 });
  try {
    const res = await fetch(`${URL}/scard/installs`, {
      headers: { authorization: `Bearer ${TOKEN}` },
      next: { revalidate: 300 },
    });
    if (!res.ok) throw new Error(`redis ${res.status}`);
    const { result } = await res.json();
    return Response.json(
      { installs: typeof result === "number" ? result : null },
      { headers: { "cache-control": "public, s-maxage=300" } },
    );
  } catch {
    return Response.json({ installs: null }, { status: 502 });
  }
}
