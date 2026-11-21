// Minecraft bot with an AI brain. Stays on the server SESSION_HOURS, logs in with AuthMe,
// reads chat, lets a local LLM decide whether/what to answer and which SAFE action to take.
// The AI can only chat and pick from a fixed list of harmless actions. It can never run commands.
const mineflayer = require("mineflayer");
const { pathfinder, Movements, goals } = require("mineflayer-pathfinder");
const { ask } = require("./ai");

const HOST = process.env.MC_HOST || "Oynatrtr.aternos.me";
const PORT = process.env.MC_PORT ? parseInt(process.env.MC_PORT, 10) : undefined;
const USERNAME = process.env.MC_USERNAME || "ceyobot";
const VERSION = process.env.MC_VERSION || undefined; // auto-detected when empty
const AUTH = process.env.MC_AUTH || "offline";
const PASSWORD = process.env.MC_PASSWORD;
if (!PASSWORD) { console.error("MC_PASSWORD is not set"); process.exit(1); }
const SESSION_MS = parseFloat(process.env.SESSION_HOURS || "5") * 3600 * 1000;
const ONCE = process.env.ONCE === "1";
const UNPROMPTED = process.env.UNPROMPTED !== "0";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(new Date().toISOString(), ...a);

// ---------- AI brain ----------
const ADDR_RE = new RegExp("(" + USERNAME + "|ceyo|\\bbot\\b)", "i");
const NAME_RE = /^\.?[A-Za-z0-9_]{3,16}$/;
const history = [];
const seen = new Map();
let current = null; // the connected bot
let busy = false, pending = null, lastThink = 0, lastSpoke = 0;

function clean(s) {
  s = String(s || "").replace(/[\r\n\t]+/g, " ").replace(/\u00a7./g, "").trim();
  while (s.startsWith("/")) s = s.slice(1).trim(); // never let the AI send a command
  if (PASSWORD) s = s.split(PASSWORD).join("***");
  return s.slice(0, 200);
}

function incoming(user, msg) {
  if (!user || !msg || user === USERNAME || !NAME_RE.test(user)) return;
  const key = user + "|" + msg, now = Date.now();
  if (seen.has(key) && now - seen.get(key) < 2000) return;
  seen.set(key, now);
  if (seen.size > 200) seen.clear();
  history.push(`${user}: ${String(msg).slice(0, 200)}`);
  if (history.length > 20) history.shift();
  const addressed = ADDR_RE.test(msg);
  if (!addressed && (!UNPROMPTED || now - lastThink < 20000)) return;
  pending = { user, msg, addressed };
  think();
}

async function act(bot, action, name) {
  const p = bot.players[name];
  const e = p && p.entity;
  switch (action) {
    case "jump":
      bot.setControlState("jump", true);
      setTimeout(() => bot.setControlState("jump", false), 300);
      break;
    case "wave": bot.swingArm(); break;
    case "look": if (e) await bot.lookAt(e.position.offset(0, e.height || 1.6, 0)); break;
    case "come": if (e) bot.pathfinder.setGoal(new goals.GoalNear(e.position.x, e.position.y, e.position.z, 2)); break;
    case "follow": if (e) bot.pathfinder.setGoal(new goals.GoalFollow(e, 2), true); break;
    case "stop": bot.pathfinder.setGoal(null); break;
    default: break;
  }
}

async function think() {
  if (busy || !pending) return;
  busy = true;
  const job = pending; pending = null; lastThink = Date.now();
  try {
    const t = Date.now();
    const r = await ask(history.slice(-10), job);
    log("AI (" + (Date.now() - t) + "ms):", JSON.stringify({ say: r.say, action: r.action, target: r.target }));
    const bot = current;
    if (bot) {
      const say = clean(r.say);
      if (say && (job.addressed || Date.now() - lastSpoke > 60000)) {
        bot.chat(say);
        lastSpoke = Date.now();
        history.push(`${USERNAME}: ${say}`);
      }
      await act(bot, r.action, r.target || job.user);
    }
  } catch (e) {
    log("AI error:", e.message);
  } finally {
    busy = false;
    if (pending) setTimeout(think, 500);
  }
}

// ---------- connection ----------
function connect(msLeft) {
  return new Promise((resolve) => {
    let finished = false, joinTimer;
    const timers = [];
    const bot = mineflayer.createBot({
      host: HOST, port: PORT, username: USERNAME, version: VERSION, auth: AUTH, hideErrors: true,
    });
    bot.loadPlugin(pathfinder);

    let authTries = 0, lastAuth = 0, authed = false;
    const doAuth = (kind) => {
      if (authed || authTries >= 6 || Date.now() - lastAuth < 2500) return;
      authTries++; lastAuth = Date.now();
      log("Sending", kind);
      try { bot.chat(kind === "register" ? `/register ${PASSWORD} ${PASSWORD}` : `/login ${PASSWORD}`); } catch (_) {}
    };

    bot.on("chat", (u, m) => incoming(u, m));
    bot.on("messagestr", (msg) => {
      const m = msg.toLowerCase();
      if (/success|giris yapildi|giriş yapıldı|basariyla|başarıyla|welcome back/.test(m) && authTries > 0) { authed = true; return; }
      if (/\/register|\/kayit|\/kayıt/.test(m) && !/already|zaten/.test(m)) { doAuth("register"); return; }
      if (/\/login|\/giris|\/giriş/.test(m)) { doAuth("login"); return; }
      const a = msg.match(/^<([^>\s]{3,17})>\s+(.+)$/);
      const b = msg.match(/^(?:\[[^\]]{1,24}\]\s*)*([A-Za-z0-9_.]{3,17})\s*(?:»|›|:|>>|>)\s*(.+)$/);
      const hit = a || b;
      if (hit && bot.players[hit[1]]) incoming(hit[1], hit[2]);
    });

    const end = (why) => {
      if (finished) return;
      finished = true;
      if (current === bot) current = null;
      timers.forEach((t) => { clearTimeout(t); clearInterval(t); });
      try { bot.end(); } catch (_) {}
      resolve(why);
    };

    bot.once("spawn", () => {
      clearTimeout(joinTimer);
      current = bot;
      log("Joined", HOST, "as", USERNAME);
      try {
        const mv = new Movements(bot);
        mv.canDig = false; mv.allow1by1towers = false; mv.allowParkour = false;
        bot.pathfinder.setMovements(mv);
      } catch (e) { log("Movements error:", e.message); }
      timers.push(setTimeout(() => { if (authTries === 0) doAuth("login"); }, 5000));
      timers.push(setTimeout(() => end("session-over"), msLeft));
      timers.push(setInterval(() => {
        try {
          if (bot.pathfinder && bot.pathfinder.goal) return; // busy walking
          bot.look(Math.random() * Math.PI * 2, (Math.random() - 0.5) * 0.6, true);
          bot.setControlState("jump", true);
          setTimeout(() => bot.setControlState("jump", false), 300);
        } catch (_) {}
      }, 25000));
    });
    bot.on("kicked", (r) => { log("Kicked:", typeof r === "string" ? r : JSON.stringify(r)); end("kicked"); });
    bot.on("error", (e) => { log("Error:", e.message); end("error"); });
    bot.on("end", () => end("ended"));
    joinTimer = setTimeout(() => end("join-timeout"), 90000);
    timers.push(joinTimer);
  });
}

async function runSession() {
  const start = Date.now();
  while (Date.now() - start < SESSION_MS) {
    const why = await connect(SESSION_MS - (Date.now() - start));
    if (why === "session-over") break;
    log("Disconnected (" + why + "), retrying in 30s");
    await sleep(30000);
  }
  log("Session finished");
}

(async () => {
  do {
    await runSession();
    if (ONCE) break;
    const wait = 10000 + Math.random() * 10000;
    log("Rejoining in", Math.round(wait / 1000), "seconds");
    await sleep(wait);
  } while (true);
})();
