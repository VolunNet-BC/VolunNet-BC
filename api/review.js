// /api/review  (admin only)
// GET  ?view=pending|flagged&offset=0  -> list items for the reviewer page
// POST { action: approve|reject|changes|publish_passed|dismiss_flag|close, id?, reason? }
const { isAdmin } = require("./_admin");
const { sb } = require("./_verify");

const COLS = "id,title,organization,city,category,hours_note,min_age,age_note,apply_url,description,source,status,created_at,verified_date,expires_at";
const PRIV = "ai_pass,ai_checked_at,link_note,portal_flag,flagged,flag_reason,checks,status_ref";
const today = () => new Date().toISOString().slice(0, 10);
const in90 = () => new Date(Date.now() + 90 * 864e5).toISOString();

module.exports = async function (req, res) {
  res.setHeader("Cache-Control", "no-store");
  if (!process.env.ADMIN_TOKEN || process.env.ADMIN_TOKEN.length < 20) return res.status(500).json({ error: "ADMIN_TOKEN isn’t set (use a long random value)." });
  if (!isAdmin(req)) return res.status(401).json({ error: "Wrong admin token." });

  if (req.method === "GET") {
    const q = req.query || {};
    const offset = Math.max(0, parseInt(q.offset, 10) || 0);
    const flagged = q.view === "flagged";
    const path = "listings?select=" + COLS + ",listing_private" + (flagged ? "!inner" : "") + "(" + PRIV + ")" +
      (flagged ? "&status=eq.published&listing_private.flagged=eq.true" : "&status=eq.pending") + "&order=created_at.asc&limit=100&offset=" + offset;
    const r = await sb(path, "GET", null, { Prefer: "count=exact" });
    if (!r.ok) return res.status(502).json({ error: "Couldn’t read the list." });
    const items = r.json || [];
    if (flagged && items.length) {
      const rp = await sb("reports?select=listing_id,reason,note,created_at&resolved=eq.false&listing_id=in.(" + items.map((x) => x.id).join(",") + ")");
      const by = {}; (rp.json || []).forEach((x) => { (by[x.listing_id] = by[x.listing_id] || []).push(x); });
      items.forEach((x) => { x.reports = by[x.id] || []; });
    }
    const pc = await sb("listings?select=id,listing_private!inner(ai_pass)&status=eq.pending&listing_private.ai_pass=eq.true&limit=1", "GET", null, { Prefer: "count=exact" });
    return res.status(200).json({ items, total: parseInt(String(r.headers.get("content-range") || "").split("/")[1], 10) || 0,
      passed: parseInt(String(pc.headers.get("content-range") || "").split("/")[1], 10) || 0 });
  }
  if (req.method !== "POST") return res.status(405).json({ error: "GET or POST only" });

  let b = {}; try { b = typeof req.body === "string" ? JSON.parse(req.body) : req.body || {}; } catch (e) {}
  const id = /^[0-9a-f-]{36}$/i.test(b.id || "") ? b.id : null;
  const reason = String(b.reason || "").trim().slice(0, 300);
  const now = new Date().toISOString();
  const priv = (body) => sb("listing_private?listing_id=eq." + id, "PATCH", body);

  if (b.action === "publish_passed") {
    const g = await sb("listings?select=id,listing_private!inner(ai_pass)&status=eq.pending&listing_private.ai_pass=eq.true&limit=500");
    const ids = (g.json || []).map((x) => x.id); let n = 0;
    for (let i = 0; i < ids.length; i += 40) {
      const u = await sb("listings?status=eq.pending&id=in.(" + ids.slice(i, i + 40).join(",") + ")", "PATCH",
        { status: "published", verified_date: today(), expires_at: in90(), review_kind: "auto", last_checked_at: now });
      if (u.ok) n += Math.min(40, ids.length - i);
    }
    return res.status(200).json({ ok: true, published: n });
  }
  if (!id) return res.status(400).json({ error: "Missing id." });

  if (b.action === "approve") {
    const u = await sb("listings?id=eq." + id + "&status=in.(pending,changes_requested)", "PATCH", { status: "published", verified_date: today(), expires_at: in90(), review_kind: "person" });
    await priv({ reviewed_at: now, flagged: false });
    return res.status(u.ok ? 200 : 502).json({ ok: u.ok });
  }
  if (b.action === "reject" || b.action === "changes") {
    if (!reason) return res.status(400).json({ error: "A reason is required." });
    const u = await sb("listings?id=eq." + id, "PATCH", { status: b.action === "reject" ? "rejected" : "changes_requested" });
    await priv({ rejection_reason: reason, reviewed_at: now });
    return res.status(u.ok ? 200 : 502).json({ ok: u.ok });
  }
  if (b.action === "dismiss_flag") {
    await priv({ flagged: false, flag_reason: null });
    await sb("reports?listing_id=eq." + id + "&resolved=eq.false", "PATCH", { resolved: true, resolved_at: now });
    return res.status(200).json({ ok: true });
  }
  if (b.action === "close") {
    const u = await sb("listings?id=eq." + id + "&status=eq.published", "PATCH", { status: "closed", closed_at: now });
    await priv({ flagged: false });
    await sb("reports?listing_id=eq." + id + "&resolved=eq.false", "PATCH", { resolved: true, resolved_at: now });
    return res.status(u.ok ? 200 : 502).json({ ok: u.ok });
  }
  return res.status(400).json({ error: "Unknown action." });
};
