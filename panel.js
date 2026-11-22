// Web control panel for ceyobot. Token login, live status, inventory, map, chat/log and manual control.
// Enable with PANEL_TOKEN (>= 12 chars). PANEL_TUNNEL=1 exposes it through a Cloudflare quick tunnel (needs `cloudflared`).
const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { spawn } = require("child_process");
const { goals } = require("mineflayer-pathfinder");

const TOKEN = process.env.PANEL_TOKEN || "";
const PORT = parseInt(process.env.PANEL_PORT || "8787", 10);
const OWNER = (process.env.GITHUB_REPOSITORY_OWNER || "").toLowerCase();
const REPO = process.env.GITHUB_REPOSITORY || "";
const ORIGIN = process.env.PANEL_ORIGIN || (OWNER ? `https://${OWNER}.github.io` : "");
const SITE = process.env.PANEL_SITE || (OWNER && REPO ? `https://${OWNER}.github.io/${REPO.split("/")[1]}/` : "");
const ring = []; // {id, t, kind, text}
let nextId = 1, url = "", ctx = null;

function push(text) {
  text = String(text).slice(0, 300);
  const kind = text.startsWith("SAY:") ? "say" : text.startsWith("CHAT:") ? "chat" : "log";
  ring.push({ id: nextId++, t: Date.now(), kind, text: text.replace(/^(SAY|CHAT):\s*/, "") });
  if (ring.length > 400) ring.shift();
}

const safeEq = (a, b) => { const x = Buffer.from(a), y = Buffer.from(b); return x.length === y.length && crypto.timingSafeEqual(x, y); };
const fails = new Map(); // ip -> [timestamps]
function limited(ip) { const now = Date.now(), l = (fails.get(ip) || []).filter((t) => now - t < 600000); fails.set(ip, l); return l.length >= 10; }

function nameOf(it) { return it ? { name: it.name, display: it.displayName, count: it.count } : null; }

function state(bot) {
  if (!bot || !bot.entity) return { connected: false };
  const me = bot.entity.position;
  const inv = [];
  bot.inventory.slots.forEach((it, i) => { if (it) inv.push({ slot: i, ...nameOf(it) }); });
  const near = Object.values(bot.entities)
    .filter((e) => e !== bot.entity && e.position && e.position.distanceTo(me) < 24)
    .map((e) => ({ type: e.type, name: e.username || e.displayName || e.name || "?", dx: +(e.position.x - me.x).toFixed(1), dy: +(e.position.y - me.y).toFixed(1), dz: +(e.position.z - me.z).toFixed(1) }))
    .slice(0, 80);
  const s = ctx.status();
  return {
    connected: true, username: bot.username, health: bot.health, food: bot.food, gm: bot.game && bot.game.gameMode, dim: bot.game && bot.game.dimension,
    pos: { x: +me.x.toFixed(1), y: +me.y.toFixed(1), z: +me.z.toFixed(1) }, yaw: bot.entity.yaw, pitch: bot.entity.pitch,
    time: bot.time && bot.time.timeOfDay, raining: bot.isRaining, quick: bot.quickBarSlot, held: nameOf(bot.heldItem),
    task: s.task ? { name: s.task.name, text: s.task.text } : null, queue: s.queue, guarding: s.guarding, inv, near,
    players: Object.keys(bot.players || {}), eventId: nextId - 1,
  };
}

function mapOf(bot, R = 12) {
  if (!bot || !bot.entity) return null;
  const c = bot.entity.position.floored(), names = [], idx = new Map(), grid = [];
  for (let dz = -R; dz <= R; dz++) for (let dx = -R; dx <= R; dx++) {
    let found = "air";
    for (let y = c.y + 6; y >= c.y - 12; y--) {
      const b = bot.blockAt(c.offset(dx, y - c.y, dz));
      if (b && b.name !== "air" && b.name !== "cave_air" && b.name !== "void_air") { found = b.name; break; }
    }
    if (!idx.has(found)) { idx.set(found, names.length); names.push(found); }
    grid.push(idx.get(found));
  }
  return { R, names, grid };
}

async function act(bot, a) {
  const need = () => { if (!bot || !bot.entity) throw new Error("Bot sunucuda değil"); };
  const item = (slot) => { const it = bot.inventory.slots[slot]; if (!it) throw new Error("Slot boş"); return it; };
  switch (a.type) {
    case "chat": need(); ctx.say(bot, String(a.text || "")); return "ok";
    case "persona": { const t = ctx.setPersona(String(a.text || "")); const ok = await savePersona(t); push("PANEL: kişilik " + (t ? "→ " + t.slice(0, 80) : "sıfırlandı")); return ok ? (t ? "Kişilik kaydedildi, artık böyle konuşacak" : "Kişilik sıfırlandı") : "Aktif oldu ama kaydedilemedi (sonraki turda gider)"; }
    case "ask": ctx.ask(String(a.text || "").slice(0, 300)); return "AI'ya iletildi";
    case "cmd": need(); { const r = await ctx.cmd(bot, String(a.text || "")); return r && r.ok === false ? "Reddedildi: " + r.reason : "Komut gönderildi"; }
    case "stop": need(); ctx.stop(bot); return "Durduruldu";
    case "goto": need(); ctx.stop(bot); bot.pathfinder.setGoal(new goals.GoalNear(+a.x, +a.y, +a.z, 1)); return "Gidiyor";
    case "come": need(); { const p = bot.players[a.player || ctx.owner()]; if (!p || !p.entity) throw new Error("Oyuncu görünmüyor"); ctx.stop(bot); bot.pathfinder.setGoal(new goals.GoalNear(p.entity.position.x, p.entity.position.y, p.entity.position.z, 2)); return "Geliyor"; }
    case "move": { need(); const d = { f: "forward", b: "back", l: "left", r: "right", j: "jump", s: "sneak" }[a.dir]; if (!d) throw new Error("Yön?"); bot.setControlState(d, true); setTimeout(() => { try { bot.setControlState(d, false); } catch (_) {} }, Math.min(+a.ms || 400, 2000)); return "ok"; }
    case "look": need(); await bot.look(bot.entity.yaw + (+a.dyaw || 0), Math.max(-1.5, Math.min(1.5, bot.entity.pitch + (+a.dpitch || 0))), true); return "ok";
    case "equip": need(); await bot.equip(item(+a.slot), a.dest); return "Takıldı";
    case "hotbar": need(); bot.setQuickBarSlot(Math.max(0, Math.min(8, +a.n))); return "ok";
    case "drop": { need(); const it = item(+a.slot); await bot.toss(it.type, it.metadata, a.all ? it.count : 1); return "Atıldı"; }
    case "eat": need(); await bot.equip(item(+a.slot), "hand"); await bot.consume(); return "Yedi";
    case "swap": need(); await bot.moveSlotItem(+a.from, +a.to); return "Taşındı";
    case "use": need(); await bot.equip(item(+a.slot), "hand"); bot.activateItem(); return "Kullandı";
    default: throw new Error("Bilinmeyen eylem");
  }
}

function server() {
  const html = fs.readFileSync(path.join(__dirname, "docs", "index.html"));
  return http.createServer(async (req, res) => {
    const ip = String(req.headers["cf-connecting-ip"] || req.socket.remoteAddress);
    const send = (code, obj, type) => { res.writeHead(code, { "Content-Type": type || "application/json", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" }); res.end(type ? obj : JSON.stringify(obj)); };
    if (ORIGIN) { res.setHeader("Access-Control-Allow-Origin", ORIGIN); res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type"); res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS"); res.setHeader("Vary", "Origin"); }
    if (req.method === "OPTIONS") { res.writeHead(204); return res.end(); }
    const u = new URL(req.url, "http://x");
    if (u.pathname === "/" || u.pathname === "/index.html") return send(200, html, "text/html; charset=utf-8");
    if (!u.pathname.startsWith("/api/")) return send(404, { error: "yok" });
    if (limited(ip)) return send(429, { error: "Çok fazla yanlış deneme, 10 dk bekle" });
    const m = /^Bearer (.+)$/.exec(req.headers.authorization || "");
    if (!m || !safeEq(m[1], TOKEN)) { fails.get(ip).push(Date.now()); return send(401, { error: "Token yanlış" }); }
    try {
      const bot = ctx.bot();
      if (u.pathname === "/api/state") return send(200, state(bot));
      if (u.pathname === "/api/map") return send(200, mapOf(bot) || { error: "bot yok" });
      if (u.pathname === "/api/persona") return send(200, { text: ctx.getPersona(), max: ctx.maxPersona });
      if (u.pathname === "/api/events") { const since = +u.searchParams.get("since") || 0; return send(200, ring.filter((e) => e.id > since)); }
      if (u.pathname === "/api/act" && req.method === "POST") {
        let body = ""; for await (const c of req) { body += c; if (body.length > 4000) break; }
        const out = await act(bot, JSON.parse(body || "{}"));
        push("PANEL: " + body.slice(0, 120));
        return send(200, { ok: true, msg: out });
      }
      send(404, { error: "yok" });
    } catch (e) { send(400, { ok: false, error: e.message }); }
  });
}

// The tunnel address changes every run: publish it AES-encrypted with the panel token (key = PBKDF2(token)) to the
// `panel-data` branch, so the GitHub Pages site can find it, and nobody without the token can read it.
async function publishUrl(log) {
  const gh = process.env.GH_TOKEN;
  if (!gh || !REPO || !url) return;
  const salt = crypto.randomBytes(16), iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv("aes-256-gcm", crypto.pbkdf2Sync(TOKEN, salt, 100000, 32, "sha256"), iv);
  const ct = Buffer.concat([c.update(url, "utf8"), c.final(), c.getAuthTag()]);
  const content = Buffer.from(JSON.stringify({ s: salt.toString("base64"), i: iv.toString("base64"), c: ct.toString("base64") })).toString("base64");
  const api = `https://api.github.com/repos/${REPO}/contents/panel-url.json`;
  const h = { Authorization: "Bearer " + gh, Accept: "application/vnd.github+json", "User-Agent": "ceyobot" };
  for (let n = 0; n < 4; n++) {
    try {
      const g = await fetch(api + "?ref=panel-data", { headers: h });
      const sha = g.ok ? (await g.json()).sha : undefined;
      const r = await fetch(api, { method: "PUT", headers: h, body: JSON.stringify({ message: "panel url", content, branch: "panel-data", sha }) });
      if (r.ok) { log("Panel URL published (encrypted) ->", SITE); return; }
      log("Panel URL publish failed:", r.status);
    } catch (e) { log("Panel URL publish error:", e.message); }
    await new Promise((r) => setTimeout(r, 5000));
  }
}

// ---- persona storage ----
// The bot runs in short GitHub Actions rounds, so the persona is kept in the `panel-data` branch (persona.json), encrypted with the
// panel token like the tunnel URL. Without GH_TOKEN (local run) it falls back to ./persona.json.
const LOCAL_PERSONA = path.join(__dirname, "persona.json");
const seal = (text) => {
  const salt = crypto.randomBytes(16), iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv("aes-256-gcm", crypto.pbkdf2Sync(TOKEN, salt, 100000, 32, "sha256"), iv);
  const ct = Buffer.concat([c.update(text, "utf8"), c.final(), c.getAuthTag()]);
  return { s: salt.toString("base64"), i: iv.toString("base64"), c: ct.toString("base64") };
};
const unseal = (f) => {
  const ct = Buffer.from(f.c, "base64"), tag = ct.subarray(ct.length - 16), body = ct.subarray(0, ct.length - 16);
  const d = crypto.createDecipheriv("aes-256-gcm", crypto.pbkdf2Sync(TOKEN, Buffer.from(f.s, "base64"), 100000, 32, "sha256"), Buffer.from(f.i, "base64"));
  d.setAuthTag(tag);
  return Buffer.concat([d.update(body), d.final()]).toString("utf8");
};
const ghApi = () => `https://api.github.com/repos/${REPO}/contents/persona.json`;
const ghHeaders = () => ({ Authorization: "Bearer " + process.env.GH_TOKEN, Accept: "application/vnd.github+json", "User-Agent": "ceyobot" });

async function savePersona(text) {
  if (!process.env.GH_TOKEN || !REPO) { fs.writeFileSync(LOCAL_PERSONA, JSON.stringify(seal(text))); return true; }
  const content = Buffer.from(JSON.stringify(seal(text))).toString("base64");
  for (let n = 0; n < 4; n++) {
    try {
      const g = await fetch(ghApi() + "?ref=panel-data", { headers: ghHeaders() });
      const sha = g.ok ? (await g.json()).sha : undefined;
      const r = await fetch(ghApi(), { method: "PUT", headers: ghHeaders(), body: JSON.stringify({ message: "persona", content, branch: "panel-data", sha }) });
      if (r.ok) return true;
      ctx.log("Persona save failed:", r.status);
    } catch (e) { ctx.log("Persona save error:", e.message); }
    await new Promise((r) => setTimeout(r, 2000));
  }
  return false;
}

async function loadPersona() {
  try {
    let f;
    if (!process.env.GH_TOKEN || !REPO) { if (!fs.existsSync(LOCAL_PERSONA)) return ""; f = JSON.parse(fs.readFileSync(LOCAL_PERSONA, "utf8")); }
    else {
      const r = await fetch(ghApi() + "?ref=panel-data", { headers: ghHeaders() });
      if (!r.ok) return "";
      f = JSON.parse(Buffer.from((await r.json()).content.replace(/\n/g, ""), "base64").toString("utf8"));
    }
    const text = ctx.setPersona(unseal(f));
    if (text) ctx.log("Persona loaded:", text.slice(0, 60));
    return text;
  } catch (e) { ctx.log("Persona load failed:", e.message); return ""; }
}

function startTunnel(log) {
  let p;
  try { p = spawn("cloudflared", ["tunnel", "--no-autoupdate", "--url", `http://127.0.0.1:${PORT}`], { stdio: ["ignore", "pipe", "pipe"] }); }
  catch (e) { log("Panel tunnel failed:", e.message); return; }
  p.on("error", (e) => log("cloudflared not available:", e.message));
  const scan = (d) => {
    const m = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/.exec(String(d));
    if (m && !url) {
      url = m[0];
      log("PANEL tunnel up:", SITE || url);
      try { if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `### ceyobot paneli\n${SITE || url}\n`); } catch (_) {}
      publishUrl(log);
    }
  };
  p.stdout.on("data", scan); p.stderr.on("data", scan);
  process.on("exit", () => { try { p.kill(); } catch (_) {} });
}

// Whispers the panel link to the owner once per connection (the tunnel URL changes every run).
function announce() {
  let last = null;
  setInterval(() => {
    const bot = ctx.bot();
    if (!url || !bot || !bot.entity || bot === last) return;
    last = bot;
    try { bot.chat(`/msg ${ctx.owner()} Panel: ${SITE || url}`); } catch (_) {}
  }, 20000);
}

function start(c) {
  if (!TOKEN || TOKEN.length < 12) { c.log("Panel off (set PANEL_TOKEN, at least 12 characters)"); return; }
  ctx = c;
  server().listen(PORT, "127.0.0.1", () => c.log("Panel listening on 127.0.0.1:" + PORT));
  if (process.env.PANEL_TUNNEL === "1") { startTunnel(c.log); announce(); }
}

module.exports = { start, push, loadPersona };
