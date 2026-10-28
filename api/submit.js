// Vercel serverless function: POST /api/submit
// Verifies CAPTCHA, validates fields, checks the application link, then calls
// submit_listing_v2 in Supabase with the service-role key (server only).
const crypto = require("crypto");
const dns = require("dns").promises;
const net = require("net");

const SB = process.env.SUPABASE_URL || "https://tfzrskibboylxfhsdxwo.supabase.co";
const CAUSES = ["Food security", "Youth leadership", "Education", "Recreation", "Animal welfare", "Social services",
  "Health", "Mental Health", "Community Safety", "Environment", "Arts", "Community"];
const PORTALS = /(^|\.)(betterimpact\.com|galaxydigital\.com|volgistics\.com|civicore\.com|volunteerhub\.com|samaritan\.com)$/i;
const CLOSED = /no longer accepting|not (currently )?accepting (new )?applications|applications? (are |is |have been )?closed|position (has been |is )?filled/i;

function sbHeaders() {
  const k = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const h = { apikey: k, "Content-Type": "application/json" };
  if (k && k.startsWith("eyJ")) h.Authorization = "Bearer " + k; // legacy JWT-style keys only
  return h;
}

function privateIp(ip) {
  if (net.isIPv6(ip)) {
    const l = ip.toLowerCase();
    if (l === "::1" || l === "::" || l.startsWith("fc") || l.startsWith("fd") || l.startsWith("fe8") || l.startsWith("fe9") || l.startsWith("fea") || l.startsWith("feb")) return true;
    const m = l.match(/::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    return m ? privateIp(m[1]) : false;
  }
  const p = ip.split(".").map(Number);
  return p[0] === 10 || p[0] === 127 || p[0] === 0 || p[0] >= 224 ||
    (p[0] === 169 && p[1] === 254) || (p[0] === 192 && p[1] === 168) ||
    (p[0] === 172 && p[1] >= 16 && p[1] <= 31) || (p[0] === 100 && p[1] >= 64 && p[1] <= 127);
}

// Never let the server be pointed at internal addresses.
async function hostAllowed(host) {
  if (net.isIP(host)) return false;
  if (/^localhost$|\.local$|\.internal$|\.localdomain$/i.test(host)) return false;
  const addrs = await dns.lookup(host, { all: true });
  return addrs.length > 0 && addrs.every((a) => !privateIp(a.address));
}

async function checkLink(startUrl) {
  const out = { status: null, finalUrl: startUrl, text: "", dead: false, flags: [] };
  const t0 = Date.now();
  let url = startUrl;
  try {
    for (let hop = 0; hop < 4; hop++) {
      const u = new URL(url);
      if (u.protocol !== "https:") { out.flags.push("Link redirects to a non-https page"); break; }
      if (!(await hostAllowed(u.hostname))) { out.dead = true; out.flags.push("Link points to a blocked address"); return out; }
      const left = 9000 - (Date.now() - t0);
      if (left < 500) { out.flags.push("Link check timed out"); break; }
      const r = await fetch(url, {
        redirect: "manual",
        signal: AbortSignal.timeout(Math.min(4500, left)),
        headers: { "User-Agent": "VolunNetBC-LinkCheck/1.0 (+https://volunnet-bc.vercel.app)", Accept: "text/html,*/*;q=0.5" },
      });
      out.status = r.status;
      const loc = r.headers.get("location");
      if (r.status >= 300 && r.status < 400 && loc) { url = new URL(loc, url).toString(); out.finalUrl = url; continue; }
      if (r.status === 404 || r.status === 410) { out.dead = true; return out; }
      if (r.status === 401 || r.status === 403 || r.status === 429) out.flags.push("The site blocked the automatic check (HTTP " + r.status + ")");
      else if (r.status >= 500) out.flags.push("The site returned an error (HTTP " + r.status + ")");
      else if (r.status >= 400) { out.dead = true; return out; }
      const ct = r.headers.get("content-type") || "";
      const len = +(r.headers.get("content-length") || 0);
      if (r.ok && /html|text/i.test(ct) && len < 3000000) out.text = (await r.text()).slice(0, 200000);
      break;
    }
  } catch (e) {
    const code = (e && (e.code || (e.cause && e.cause.code))) || "";
    if (code === "ENOTFOUND") out.dead = true;
    else out.flags.push("The link did not respond in time");
  }
  return out;
}

function classify(startUrl, res) {
  const flags = res.flags.slice();
  let portal = false;
  try {
    const s = new URL(startUrl), f = new URL(res.finalUrl);
    if (PORTALS.test(s.hostname) || PORTALS.test(f.hostname)) { portal = true; flags.push("Portal link (may need an account to view the role)"); }
    if (/(log-?in|sign-?in|signin|auth|account)/i.test(f.pathname) || /type=["']?password/i.test(res.text)) { portal = true; flags.push("Link leads to a login page"); }
    if ((s.pathname === "/" || s.pathname === "") && !s.search) flags.push("Link is a homepage, not a specific role page");
    else if ((f.pathname === "/" || f.pathname === "") && s.pathname.length > 1) flags.push("Link redirects to the site homepage");
  } catch (e) {}
  if (res.text && CLOSED.test(res.text)) flags.push("Page text suggests applications are closed or the role is filled");
  return { flags, portal };
}

module.exports = async function (req, res) {
  res.setHeader("Cache-Control", "no-store");
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });
  if (!process.env.SUPABASE_SERVICE_ROLE_KEY || !process.env.TURNSTILE_SECRET)
    return res.status(500).json({ error: "The server isn’t set up yet." });

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
    case "ok": return res.status(200).json({ ok: true, ref: out.ref, warnings: cl.flags });
    case "duplicate": return res.status(409).json({ error: "This role is already listed or waiting for review (same organization, title and link)." });
    case "ip_limit": return res.status(429).json({ error: "You’ve reached today’s submission limit. Please try again tomorrow." });
    case "busy": return res.status(503).json({ error: "We’re getting a lot of submissions right now. Please try again later." });
    default: return res.status(400).json({ error: "Something wasn’t right. Check the details and try again." });
  }
};
