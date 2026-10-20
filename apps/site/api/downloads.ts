const REPO = "dxxpcode/dxxpcode";
const TOKEN = process.env.GITHUB_TOKEN;

// GET /api/downloads → { downloads: n } — total GitHub release asset
// download_count across desktop-v* releases, cached at the edge for 1 hour.
export async function GET() {
  try {
    const res = await fetch(`https://api.github.com/repos/${REPO}/releases?per_page=100`, {
      headers: {
        accept: "application/vnd.github+json",
        "user-agent": "dxxpcode-site",
        ...(TOKEN ? { authorization: `Bearer ${TOKEN}` } : {}),
      },
    });
    if (!res.ok) throw new Error(`github ${res.status}`);
    const releases = await res.json();
    const downloads = Array.isArray(releases)
      ? releases
          .filter((r) => typeof r?.tag_name === "string" && r.tag_name.startsWith("desktop-v"))
          .reduce(
            (total, r) =>
              total +
              (Array.isArray(r.assets)
                ? r.assets.reduce(
                    (sum: number, a: { download_count?: number }) =>
                      sum + (typeof a.download_count === "number" ? a.download_count : 0),
                    0,
                  )
                : 0),
            0,
          )
      : null;
    return Response.json(
      { downloads },
      { headers: { "cache-control": "public, s-maxage=3600, stale-while-revalidate=86400" } },
    );
  } catch {
    return Response.json({ downloads: null }, { status: 502 });
  }
}
