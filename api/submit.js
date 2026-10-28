// Vercel serverless function: POST /api/submit
// Verifies CAPTCHA, validates fields, checks the application link, then calls
// submit_listing_v2 in Supabase with the service-role key (server only).
const crypto = require("crypto");
const { checkLink, classify } = require("./_link");
const { processOne } = require("./_verify");

const SB = process.env.SUPABASE_URL || "https://tfzrskibboylxfhsdxwo.supabase.co";
const CAUSES = ["Food security", "Youth leadership", "Education", "Recreation", "Animal welfare", "Social services",
  "Health", "Mental Health", "Community Safety", "Environment", "Arts", "Community"];

function sbHeaders() {
  const k = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const h = { apikey: k, "Content-Type": "application/json" };
  if (k && k.startsWith("eyJ")) h.Authorization = "Bearer " + k; // legacy JWT-style keys only
  return h;
}

module.exports = async function (req, res) {
  res.setHeader("Cache-Control", "no-store");
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });
  const missing = ["SUPABASE_SERVICE_ROLE_KEY", "TURNSTILE_SECRET"].filter((n) => !process.env[n]);
  if (missing.length)
    return res.status(500).json({ error: "The server isn’t set up yet. Missing: " + missing.join(", ") + "." });

  let b = {};
  try { b = typeof req.body === "string" ? JSON.parse(req.body) : req.body || {}; } catch (e) {}
  const str = (v) => (typeof v === "string" ? v.trim() : "");
  const ip = str(req.headers["x-real-ip"]) || str((req.headers["x-forwarded-for"] || "").split(",")[0]) || "unknown";

  // 1. CAPTCHA
  try {
    const tr = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ secret: process.env.TURNSTILE_SECRET, response: str(b.captcha), remoteip: ip }),
      signal: AbortSignal.timeout(5000),
    });
    const tj = await tr.json();
    if (!tj.success) return res.status(400).json({ errors: { captcha: "Please complete the check above and try again." } });
  } catch (e) {
    return res.status(503).json({ error: "Couldn’t verify the spam check. Please try again." });
  }

  // 2. Field validation (reject too-long values instead of silently cutting them off)
  const f = {
    title: str(b.title), org: str(b.organization), city: str(b.city), cause: str(b.category),
    hours: str(b.hours_note), ageNote: str(b.age_note), url: str(b.apply_url), desc: str(b.description), email: str(b.contact_email),
  };
  const cityOther = !!b.city_other;
  const errors = {};
  const lim = (k, max, label) => { if (f[k].length > max) errors[k] = label + " is too long (max " + max + " characters)."; };
  if (!f.title) errors.title = "Enter the role title."; lim("title", 120, "Title");
  if (!f.org) errors.org = "Enter the organization."; lim("org", 120, "Organization");
  if (!f.city) errors.city = "Choose a city."; lim("city", 60, "City");
  if (!CAUSES.includes(f.cause)) errors.cause = "Choose a cause.";
  if (!f.hours) errors.hours = "Enter the time commitment."; lim("hours", 200, "Time commitment");
  lim("ageNote", 200, "Age rules"); lim("desc", 500, "Description");
  if (f.email && !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(f.email)) errors.email = "That email doesn’t look right.";
  let minAge = null;
  if (b.min_age !== null && b.min_age !== undefined && b.min_age !== "") {
    minAge = parseInt(b.min_age, 10);
    if (!Number.isInteger(minAge) || minAge < 5 || minAge > 25) errors.age = "Minimum age must be between 5 and 25.";
  }
  const cf = b.confirm || {};
  if (!(cf.role && cf.hours && cf.age)) errors.confirm = "Please confirm each section against the organization’s posting.";
  let parsed = null;
  try { parsed = new URL(f.url); } catch (e) {}
  if (!parsed || parsed.protocol !== "https:") errors.url = "Enter a full link starting with https://";
  if (Object.keys(errors).length) return res.status(400).json({ errors });

  // 3. City coverage (informational; "Other" is allowed but flagged for the reviewer)
  let cityCovered = false;
  try {
    const cr = await fetch(SB + "/rest/v1/covered_cities?select=name", { headers: sbHeaders(), signal: AbortSignal.timeout(4000) });
    const names = (await cr.json()).map((x) => x.name.toLowerCase());
    cityCovered = !cityOther && names.includes(f.city.toLowerCase());
  } catch (e) {}

  // 4. Link check
  const lr = await checkLink(f.url);
  if (lr.dead) return res.status(400).json({ errors: { url: "That link doesn’t work (page not found or address unreachable). Check it and try again." } });
  const cl = classify(f.url, lr);

  const checks = {
    city_covered: cityCovered, ai_used: !!b.ai_used, confirmed: { role: !!cf.role, hours: !!cf.hours, age: !!cf.age },
    adult_role: minAge !== null && minAge >= 19, link_final: lr.finalUrl, link_flags: cl.flags,
  };

  // 5. Save (duplicates and per-IP limits are enforced inside the database function)
  let out;
  try {
    const salt = process.env.IP_SALT || process.env.TURNSTILE_SECRET;
    const ipHash = crypto.createHash("sha256").update(salt + "|" + ip).digest("hex").slice(0, 32);
    const r = await fetch(SB + "/rest/v1/rpc/submit_listing_v2", {
      method: "POST", headers: sbHeaders(), signal: AbortSignal.timeout(8000),
      body: JSON.stringify({
        p_title: f.title, p_org: f.org, p_city: f.city, p_category: f.cause, p_hours: f.hours, p_min_age: minAge,
        p_age_note: f.ageNote, p_url: f.url, p_desc: f.desc, p_contact_email: f.email || null, p_ip_hash: ipHash,
        p_portal: cl.portal, p_link_http: lr.status, p_link_note: cl.flags.join("; ") || null, p_checks: checks,
      }),
    });
    out = await r.json();
    if (!r.ok) return res.status(502).json({ error: "Couldn’t save your listing. Please try again." });
  } catch (e) {
    return res.status(502).json({ error: "Couldn’t save your listing. Please try again." });
  }

  switch (out && out.result) {
    case "ok": {
      // Automatic check. If AUTO_PUBLISH=true and everything passes, the listing goes live; otherwise it just records the result.
      let published = false;
      try {
        const q = await fetch(SB + "/rest/v1/listing_private?status_ref=eq." + encodeURIComponent(out.ref) + "&select=listing_id", { headers: sbHeaders(), signal: AbortSignal.timeout(4000) });
        const lid = ((await q.json())[0] || {}).listing_id;
        if (lid) published = !!(await processOne(lid, { publish: process.env.AUTO_PUBLISH === "true", link: lr })).published;
      } catch (e) {}
      return res.status(200).json({ ok: true, ref: out.ref, warnings: cl.flags, published });
    }
    case "duplicate": return res.status(409).json({ error: "This role is already listed or waiting for review (same organization, title and link)." });
    case "ip_limit": return res.status(429).json({ error: "You’ve reached today’s submission limit. Please try again tomorrow." });
    case "busy": return res.status(503).json({ error: "We’re getting a lot of submissions right now. Please try again later." });
    default: return res.status(400).json({ error: "Something wasn’t right. Check the details and try again." });
  }
};
