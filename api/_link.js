// Shared link-checking helpers (underscore prefix: not exposed as a route)
const dns = require("dns").promises;
const net = require("net");
const PORTALS = /(^|\.)(betterimpact\.com|galaxydigital\.com|volgistics\.com|civicore\.com|volunteerhub\.com|samaritan\.com)$/i;
const CLOSED = /no longer accepting|not (currently )?accepting (new )?applications|applications? (are |is |have been )?closed|position (has been |is )?filled/i;

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


// normalized link: no scheme, no www, no query/fragment, no trailing slash, lowercase
function normKey(u) { return String(u || "").replace(/^https?:\/\/(www\.)?/i, "").replace(/[?#].*$/, "").replace(/\/+$/, "").toLowerCase(); }

module.exports = { checkLink, classify, normKey, hostAllowed };
