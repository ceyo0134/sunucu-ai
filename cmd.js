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

function denied(cmd, depth = 0) {
  const w = firstWord(cmd);
  if (DENY.has(w)) return w;
  if (w === "execute" && depth < 5) {
    const i = cmd.toLowerCase().lastIndexOf(" run ");
    if (i >= 0) return denied(cmd.slice(i + 5), depth + 1);
  }
  return null;
}

// returns { ok, cmd, reason }
function sanitizeCommand(raw, secret) {
  let s = String(raw || "").replace(/[\r\n\t]+/g, " ").replace(/\u00a7./g, "").trim();
  while (s.startsWith("/")) s = s.slice(1).trim();
  if (!s) return { ok: false, reason: "empty" };
  if (s.length > 200) return { ok: false, reason: "too-long" };
  if (secret && s.includes(secret)) return { ok: false, reason: "secret" };
  const d = denied(s);
  if (d) return { ok: false, reason: "denied:" + d };
  return { ok: true, cmd: s };
}

module.exports = { isOwner, sanitizeCommand, OWNERS };
