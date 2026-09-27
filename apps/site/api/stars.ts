const REPO = "dxxpcode/DxxpCode-Terminal";
const TOKEN = process.env.GITHUB_TOKEN;

// GET /api/stars → { stars: n } — GitHub stargazer count, cached at the edge for 1 hour.
export async function GET() {
  try {
    const res = await fetch(`https://api.github.com/repos/${REPO}`, {
      headers: {
        accept: "application/vnd.github+json",
        "user-agent": "dxxpcode-site",
        ...(TOKEN ? { authorization: `Bearer ${TOKEN}` } : {}),
      },
    });
    if (!res.ok) throw new Error(`github ${res.status}`);
    const { stargazers_count, private: isPrivate } = await res.json();
    return Response.json(
      { stars: !isPrivate && typeof stargazers_count === "number" ? stargazers_count : null },
      { headers: { "cache-control": "public, s-maxage=3600, stale-while-revalidate=86400" } },
    );
  } catch {
    return Response.json({ stars: null }, { status: 502 });
  }
}
