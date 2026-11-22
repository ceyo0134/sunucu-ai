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
  const html = fs.readFileSync(path.join(__dirname, "panel.html"));
  return http.createServer(async (req, res) => {
    const ip = String(req.headers["cf-connecting-ip"] || req.socket.remoteAddress);
    const send = (code, obj, type) => { res.writeHead(code, { "Content-Type": type || "application/json", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" }); res.end(type ? obj : JSON.stringify(obj)); };
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

function startTunnel(log) {
  let p;
  try { p = spawn("cloudflared", ["tunnel", "--no-autoupdate", "--url", `http://127.0.0.1:${PORT}`], { stdio: ["ignore", "pipe", "pipe"] }); }
  catch (e) { log("Panel tunnel failed:", e.message); return; }
  p.on("error", (e) => log("cloudflared not available:", e.message));
  const scan = (d) => {
    const m = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/.exec(String(d));
    if (m && !url) {
      url = m[0];
      log("PANEL URL:", url);
      try { if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `### ceyobot paneli\n${url}\n`); } catch (_) {}
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
    try { bot.chat(`/msg ${ctx.owner()} Panel: ${url}`); } catch (_) {}
  }, 20000);
}

function start(c) {
  if (!TOKEN || TOKEN.length < 12) { c.log("Panel off (set PANEL_TOKEN, at least 12 characters)"); return; }
  ctx = c;
  server().listen(PORT, "127.0.0.1", () => c.log("Panel listening on 127.0.0.1:" + PORT));
  if (process.env.PANEL_TUNNEL === "1") { startTunnel(c.log); announce(); }
}

module.exports = { start, push };
