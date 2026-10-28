// Admin token check (underscore prefix: not a route)
const crypto = require("crypto");
function isAdmin(req) {
  const want = process.env.ADMIN_TOKEN || "";
  if (want.length < 20) return false;
  const got = String(req.headers.authorization || "").replace(/^Bearer\s+/i, "");
  const a = Buffer.from(got), b = Buffer.from(want);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
module.exports = { isAdmin };
