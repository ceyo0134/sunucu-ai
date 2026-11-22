// Command safety: only owners may make the bot run "/" commands, and a few destructive
// commands are always refused (an AI or a spoofed chat line must never be able to op someone or stop the server).
const OWNERS = (process.env.MC_OWNERS || "ceyo0134")
  .split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);

const DENY = new Set([
  "op", "deop", "stop", "restart", "reload", "rl", "ban", "ban-ip", "banip", "pardon", "pardon-ip",
  "whitelist", "save-off", "setidletimeout", "debug", "perf", "transfer", "publish",
  "lp", "luckperms", "pex", "permissions", "perms", "authme", "login", "register", "l", "reg",
  "changepassword", "unregister", "plugman", "plugins", "pl", "bukkit", "rcon",
]);

function isOwner(user) {
  return OWNERS.includes(String(user || "").toLowerCase());
}

function firstWord(cmd) {
  const w = cmd.trim().split(/\s+/)[0] || "";
  return w.toLowerCase().replace(/^[a-z0-9_.-]+:/, ""); // minecraft:op, bukkit:op ...
}

// Always blocked, even for the owner: they would change or leak the bot's own login.
const CRED = new Set(["login", "register", "l", "reg", "changepassword", "unregister"]);

function denied(cmd, depth = 0, full = false) {
  const w = firstWord(cmd);
  if (full ? CRED.has(w) : DENY.has(w)) return w;
  if (w === "execute" && depth < 5) {
    const i = cmd.toLowerCase().lastIndexOf(" run ");
    if (i >= 0) return denied(cmd.slice(i + 5), depth + 1, full);
  }
  return null;
}

// returns { ok, cmd, reason }
// full=true: the owner typed it themselves (in-game "ceyobot /cmd" or the token-protected panel) -> every command works.
// full=false: the AI picked it -> the DENY list also applies, so a model mistake can never op/ban/stop.
function sanitizeCommand(raw, secret, full = false) {
  let s = String(raw || "").replace(/[\r\n\t]+/g, " ").replace(/\u00a7./g, "").trim();
  while (s.startsWith("/")) s = s.slice(1).trim();
  if (!s) return { ok: false, reason: "empty" };
  if (s.length > (full ? 250 : 200)) return { ok: false, reason: "too-long" };
  if (secret && s.includes(secret)) return { ok: false, reason: "secret" };
  const d = denied(s, 0, full);
  if (d) return { ok: false, reason: "denied:" + d };
  return { ok: true, cmd: s };
}


// What did the server answer after we sent a command? lines = chat lines that arrived right after it.
const NOOP_RE = /permission|izniniz yok|yetkin yok|yetkiniz yok|unknown or incomplete|unknown command|bilinmeyen komut|do not have/i;
const FAIL_RE = new RegExp(NOOP_RE.source + "|no entity was found|no player was found|player not found|bulunamad|incorrect argument|expected |invalid ", "i");
function summarizeReply(lines) {
  const ls = (lines || []).map((l) => String(l || "").replace(/\u00a7./g, "").replace(/\s+/g, " ").trim())
    .filter((l) => l && !/clearlag|will be cleared/i.test(l));
  const failed = ls.find((l) => FAIL_RE.test(l));
  return { failed: !!failed, noOp: ls.some((l) => NOOP_RE.test(l)), text: (failed || ls[0] || "").slice(0, 110) };
}

module.exports = { isOwner, sanitizeCommand, summarizeReply, OWNERS };
