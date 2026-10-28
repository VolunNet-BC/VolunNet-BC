// POST /api/process  (admin only) — runs the automatic check on pending listings that haven't been checked yet.
// Body: { limit?: 1-12, publish?: boolean, ids?: [uuid], recheck?: boolean }
const { isAdmin } = require("./_admin");
const { processOne, sb } = require("./_verify");

module.exports = async function (req, res) {
  res.setHeader("Cache-Control", "no-store");
  if (!process.env.ADMIN_TOKEN || process.env.ADMIN_TOKEN.length < 20) return res.status(500).json({ error: "ADMIN_TOKEN isn’t set (use a long random value)." });
  if (!isAdmin(req)) return res.status(401).json({ error: "Wrong admin token." });
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });
  let b = {}; try { b = typeof req.body === "string" ? JSON.parse(req.body) : req.body || {}; } catch (e) {}
  const limit = Math.max(1, Math.min(12, parseInt(b.limit, 10) || 8));
  const publish = b.publish === undefined ? process.env.AUTO_PUBLISH === "true" : !!b.publish;

  let ids = Array.isArray(b.ids) ? b.ids.filter((x) => /^[0-9a-f-]{36}$/i.test(x)).slice(0, limit) : null;
  if (!ids) {
    const q = await sb("listings?select=id,listing_private!inner(ai_checked_at)&status=eq.pending&listing_private.ai_checked_at=is.null&order=created_at.asc&limit=" + limit);
    if (!q.ok) return res.status(502).json({ error: "Couldn’t read the queue." });
    ids = (q.json || []).map((x) => x.id);
  }
  const results = [];
  for (let i = 0; i < ids.length; i += 4) {
    const chunk = await Promise.all(ids.slice(i, i + 4).map((id) => processOne(id, { publish }).catch((e) => ({ id, error: "check failed" }))));
    results.push(...chunk);
  }
  const rem = await sb("listings?select=id,listing_private!inner(ai_checked_at)&status=eq.pending&listing_private.ai_checked_at=is.null&limit=1", "GET", null, { Prefer: "count=exact" });
  const total = parseInt(String(rem.headers.get("content-range") || "").split("/")[1], 10);
  res.status(200).json({ results, remaining: Number.isFinite(total) ? total : null, published_mode: publish });
};
