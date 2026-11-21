// Friend-like Minecraft bot with an AI brain (local LLM).
// The AI can only chat and choose from a fixed list of actions (see ai.js). It can never run commands:
// every chat message is stripped of a leading "/" before sending.
const mineflayer = require("mineflayer");
const { pathfinder, Movements, goals } = require("mineflayer-pathfinder");
const { Vec3 } = require("vec3");
const makeItem = require("prismarine-item");
const { ask, SHAPES } = require("./ai");

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
const TEST_ACTIONS = process.env.TEST_ACTIONS || "";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(new Date().toISOString(), ...a);

// ---------- state ----------
const ADDR_RE = new RegExp("(" + USERNAME + "|ceyo|\\bbot\\b)", "i");
const NAME_RE = /^\.?[A-Za-z0-9_]{3,16}$/;
const history = [];
const seen = new Map();
let current = null;
let task = null; // { name, text, cancel }
let busy = false, pending = null, lastThink = 0, lastSpoke = 0;

// ---------- helpers ----------
function clean(s) {
  s = String(s || "").replace(/[\r\n\t]+/g, " ").replace(/\u00a7./g, "").trim();
  while (s.startsWith("/")) s = s.slice(1).trim(); // never send a command
  if (PASSWORD) s = s.split(PASSWORD).join("***");
  return s.slice(0, 200);
}

function say(bot, text) {
  const s = clean(text);
  if (!s) return;
  try { bot.chat(s); } catch (_) {}
  lastSpoke = Date.now();
  history.push(`${USERNAME}: ${s}`);
  if (history.length > 20) history.shift();
}

const PROTECTED = /(bedrock|barrier|command_block|structure_block|jigsaw|spawner|chest|barrel|shulker_box|furnace|smoker|hopper|dispenser|dropper|beacon|ender|portal|_bed$|sign|lectern|jukebox|crafting_table|enchanting|anvil|brewing|spawn)/;
const isProtected = (name) => PROTECTED.test(name);

const BLOCK_ALIAS = {
  odun: "_log", agac: "_log", "ağaç": "_log", log: "_log",
  tas: "stone", "taş": "stone", komur: "coal_ore", "kömür": "coal_ore",
  demir: "iron_ore", elmas: "diamond_ore", altin: "gold_ore", "altın": "gold_ore",
  kum: "sand", toprak: "dirt", cakil: "gravel", "çakıl": "gravel",
};
const PLACE_ALIAS = {
  tas: "cobblestone", "taş": "cobblestone", kirik_tas: "cobblestone",
  odun: "oak_planks", tahta: "oak_planks", toprak: "dirt", cam: "glass",
  tugla: "bricks", "tuğla": "bricks", kum: "sand",
};
const norm = (s) => String(s || "").toLowerCase().replace(/^minecraft:/, "").trim().replace(/\s+/g, "_");

function blockMatcher(item) {
  item = norm(item);
  if (BLOCK_ALIAS[item]) item = BLOCK_ALIAS[item];
  if (!/^_?[a-z0-9_]+$/.test(item)) return null;
  return (b) => {
    if (!b || isProtected(b.name)) return false;
    return item.startsWith("_") ? b.name.endsWith(item) : (b.name === item || b.name.endsWith("_" + item));
  };
}

function status(bot) {
  const inv = {};
  bot.inventory.items().forEach((i) => { inv[i.name] = (inv[i.name] || 0) + i.count; });
  const invText = Object.entries(inv).slice(0, 12).map(([k, v]) => `${k} x${v}`).join(", ") || "boş";
  const me = bot.entity.position;
  const near = Object.values(bot.players)
    .filter((p) => p.entity && p.username !== USERNAME)
    .map((p) => `${p.username} (${Math.round(p.entity.position.distanceTo(me))}m)`)
    .slice(0, 5).join(", ") || "yok";
  return `can ${Math.round(bot.health)}/20, açlık ${bot.food}/20, oyun modu ${bot.game.gameMode}, ` +
    `envanter: ${invText}, yakındaki oyuncular: ${near}, şu an yaptığın iş: ${task ? task.text : "yok"}`;
}

async function gotoNear(bot, pos, range, ms = 20000) {
  const goal = new goals.GoalNear(pos.x, pos.y, pos.z, range);
  let timer;
  try {
    await Promise.race([
      bot.pathfinder.goto(goal),
      new Promise((_, rej) => { timer = setTimeout(() => rej(new Error("goto timeout")), ms); }),
    ]);
  } finally {
    clearTimeout(timer);
    try { bot.pathfinder.setGoal(null); } catch (_) {}
  }
}

async function digBlock(bot, block) {
  try {
    const tool = bot.pathfinder.bestHarvestTool && bot.pathfinder.bestHarvestTool(block);
    if (tool) await bot.equip(tool, "hand");
  } catch (_) {}
  await bot.dig(block, true);
}

async function ensureItem(bot, name) {
  name = norm(name);
  if (PLACE_ALIAS[name]) name = PLACE_ALIAS[name];
  const def = bot.registry.itemsByName[name];
  if (!def) return null;
  let it = bot.inventory.items().find((i) => i.name === name);
  if (!it && bot.game.gameMode === "creative") {
    const Item = makeItem(bot.registry);
    await bot.creative.setInventorySlot(36, new Item(def.id, 64));
    await sleep(200);
    it = bot.inventory.items().find((i) => i.name === name) || null;
  }
  if (!it) return null;
  await bot.equip(it, "hand");
  return it;
}

// ---------- tasks ----------
function cancelTask() { if (task) task.cancel = true; }

function runTask(bot, name, text, fn) {
  if (task) task.cancel = true;
  const t = { name, text, cancel: false };
  task = t;
  return (async () => {
    try { await sleep(200); await fn(t); }
    catch (e) { log("task error:", e.message); }
    finally {
      if (task === t) task = null;
      try { bot.pathfinder.setGoal(null); } catch (_) {}
    }
  })();
}

async function mineTask(bot, t, item, count) {
  const match = blockMatcher(item);
  if (!match) { say(bot, "Bu bloğun adını anlayamadım."); return; }
  let got = 0;
  const bad = new Set();
  while (!t.cancel && got < count) {
    const found = bot.findBlocks({ matching: match, maxDistance: 32, count: 12 }).filter((p) => !bad.has(p.toString()));
    if (!found.length) {
      say(bot, got ? `${got} tane aldım, yakında başka yok.` : "Yakında bulamadım.");
      return;
    }
    const pos = found[0];
    t.text = `${item} topluyorum (${got}/${count})`;
    try {
      await gotoNear(bot, pos, 3);
      if (t.cancel) return;
      const b = bot.blockAt(pos);
      if (!b || !match(b)) continue;
      await digBlock(bot, b);
      got++;
      await gotoNear(bot, pos, 1, 6000).catch(() => {}); // walk over the drop
    } catch (e) {
      log("mine error:", e.message);
      bad.add(pos.toString());
    }
  }
  if (!t.cancel) say(bot, `${got} tane ${item} topladım!`);
}

async function breakTask(bot, t, e) {
  const b = e && bot.blockAtEntityCursor(e, 6);
  if (!b || b.name === "air" || isProtected(b.name)) { say(bot, "Neye baktığını göremiyorum ya da onu kıramam."); return; }
  await gotoNear(bot, b.position, 3);
  const cur = bot.blockAt(b.position);
  if (!cur || cur.name === "air") return;
  await digBlock(bot, cur);
  say(bot, "Kırdım!");
}

const DIRS = [new Vec3(0, -1, 0), new Vec3(1, 0, 0), new Vec3(-1, 0, 0), new Vec3(0, 0, 1), new Vec3(0, 0, -1), new Vec3(0, 1, 0)];
const REPLACEABLE = new Set(["air", "cave_air", "void_air", "short_grass", "grass", "tall_grass", "snow"]);

async function placeAt(bot, pos, itemName) {
  const cur = bot.blockAt(pos);
  if (!cur) return "fail";
  if (!REPLACEABLE.has(cur.name)) return "occupied";
  let ref = null, face = null;
  for (const d of DIRS) {
    const nb = bot.blockAt(pos.plus(d));
    if (nb && nb.boundingBox === "block") { ref = nb; face = new Vec3(-d.x, -d.y, -d.z); break; }
  }
  if (!ref) return "noref";
  await gotoNear(bot, pos, 2, 15000).catch(() => {});
  const p = bot.entity.position;
  if (Math.floor(p.x) === pos.x && Math.floor(p.z) === pos.z && Math.abs(Math.floor(p.y) - pos.y) <= 1) {
    await gotoNear(bot, pos.offset(3, 0, 3), 1, 8000).catch(() => {}); // step out of the way
  }
  const it = await ensureItem(bot, itemName);
  if (!it) return "noitem";
  try {
    await bot.lookAt(pos.offset(0.5, 0.5, 0.5));
    await bot.placeBlock(ref, face);
    return "ok";
  } catch (e) {
    log("place error:", e.message);
    return "fail";
  }
}

async function placeTask(bot, t, e, item) {
  const ref = e && bot.blockAtEntityCursor(e, 6);
  if (!ref || ref.name === "air") { say(bot, "Nereye koyacağımı göremiyorum."); return; }
  const r = await placeAt(bot, ref.position.offset(0, 1, 0), item || "cobblestone");
  if (r === "noitem") say(bot, `Bende ${item || "o blok"} yok.`);
  else if (r === "ok") say(bot, "Koydum!");
  else say(bot, "Oraya koyamadım.");
}

function shapePositions(shape, base, n) {
  const out = [];
  if (shape === "tower") {
    for (let y = 1; y <= Math.min(n, 4); y++) out.push(base.offset(0, y, 0));
  } else if (shape === "wall") {
    const w = Math.max(2, Math.min(n, 10));
    for (let y = 1; y <= 3; y++) for (let x = 0; x < w; x++) out.push(base.offset(x, y, 0));
  } else if (shape === "platform") {
    const s = Math.max(2, Math.min(n, 7));
    for (let x = 0; x < s; x++) for (let z = 0; z < s; z++) out.push(base.offset(x, 1, z));
  } else if (shape === "house") {
    const s = 5;
    for (let y = 1; y <= 3; y++) {
      for (let x = 0; x < s; x++) {
        for (let z = 0; z < s; z++) {
          const edge = x === 0 || z === 0 || x === s - 1 || z === s - 1;
          const door = x === 2 && z === 0 && y <= 2;
          if (edge && !door) out.push(base.offset(x, y, z));
        }
      }
    }
  }
  return out;
}

async function buildTask(bot, t, e, shape, item, n) {
  if (!e) { say(bot, "Seni göremiyorum, yakına gel."); return; }
  shape = SHAPES.includes(shape) ? shape : "tower";
  item = norm(item) || "cobblestone";
  const dx = -Math.sin(e.yaw), dz = -Math.cos(e.yaw);
  const bx = Math.floor(e.position.x) + Math.round(dx * 3);
  const bz = Math.floor(e.position.z) + Math.round(dz * 3);
  const py = Math.floor(e.position.y);
  let base = null;
  for (let y = py + 2; y >= py - 5; y--) {
    const b = bot.blockAt(new Vec3(bx, y, bz));
    if (b && b.boundingBox === "block") { base = b.position; break; }
  }
  if (!base) { say(bot, "Buraya kuramıyorum."); return; }
  const list = shapePositions(shape, base, n);
  let ok = 0;
  for (const pos of list) {
    if (t.cancel) break;
    t.text = `${shape} kuruyorum (${ok}/${list.length})`;
    const r = await placeAt(bot, pos, item).catch(() => "fail");
    if (r === "ok") { ok++; await sleep(150); }
    else if (r === "noitem") { say(bot, `Bende ${item} yok, bana verir misin?`); return; }
  }
  if (!t.cancel) say(bot, ok ? `Bitti! ${ok} blok koydum.` : "Kuramadım.");
}

async function giveTask(bot, t, e, item, n) {
  if (!e) { say(bot, "Seni göremiyorum, yakına gel."); return; }
  let name = norm(item);
  if (PLACE_ALIAS[name]) name = PLACE_ALIAS[name];
  const it = bot.inventory.items().find((i) => i.name === name);
  if (!it) { say(bot, `Bende ${item || "o"} yok.`); return; }
  await gotoNear(bot, e.position, 3, 15000).catch(() => {});
  await bot.lookAt(e.position.offset(0, e.height || 1.6, 0));
  await bot.toss(it.type, null, Math.min(n, it.count));
  say(bot, "Al bakalım!");
}

// ---------- AI brain ----------
async function act(bot, r, job) {
  const name = r.target || job.user;
  const p = bot.players[name];
  const e = p && p.entity;
  const n = Math.max(1, Math.min(64, r.count || 1));
  switch (r.action) {
    case "jump":
      bot.setControlState("jump", true);
      setTimeout(() => bot.setControlState("jump", false), 300);
      break;
    case "wave": bot.swingArm(); break;
    case "look": if (e) await bot.lookAt(e.position.offset(0, e.height || 1.6, 0)); break;
    case "come":
      cancelTask();
      if (e) bot.pathfinder.setGoal(new goals.GoalNear(e.position.x, e.position.y, e.position.z, 2));
      else say(bot, "Seni göremiyorum, biraz yaklaş.");
      break;
    case "follow":
      cancelTask();
      if (e) bot.pathfinder.setGoal(new goals.GoalFollow(e, 2), true);
      else say(bot, "Seni göremiyorum, biraz yaklaş.");
      break;
    case "stop": cancelTask(); bot.pathfinder.setGoal(null); break;
    case "mine": runTask(bot, "mine", `${r.item} topluyorum`, (t) => mineTask(bot, t, r.item, n)); break;
    case "break": runTask(bot, "break", "blok kırıyorum", (t) => breakTask(bot, t, e)); break;
    case "place": runTask(bot, "place", "blok koyuyorum", (t) => placeTask(bot, t, e, r.item)); break;
    case "build": runTask(bot, "build", "bir şey kuruyorum", (t) => buildTask(bot, t, e, r.shape, r.item, n)); break;
    case "give": runTask(bot, "give", "eşya veriyorum", (t) => giveTask(bot, t, e, r.item, n)); break;
    default: break;
  }
}

async function think() {
  if (busy || !pending) return;
  busy = true;
  const job = pending; pending = null; lastThink = Date.now();
  try {
    const bot = current;
    if (!bot) return;
    job.status = status(bot);
    const t = Date.now();
    const r = await ask(history.slice(-10), job);
    log("AI (" + (Date.now() - t) + "ms):", JSON.stringify({ say: r.say, action: r.action, item: r.item, shape: r.shape, count: r.count, target: r.target }));
    if (current === bot) {
      if (r.say && (job.addressed || job.system || Date.now() - lastSpoke > 60000)) say(bot, r.say);
      await act(bot, r, job);
    }
  } catch (e) {
    log("AI error:", e.message);
  } finally {
    busy = false;
    if (pending) setTimeout(think, 500);
  }
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

// ---------- idle behaviour (friend-like) ----------
function startIdle(bot, timers) {
  // look at nearby players
  timers.push(setInterval(() => {
    try {
      if (task || (bot.pathfinder && bot.pathfinder.goal)) return;
      const me = bot.entity.position;
      const near = bot.nearestEntity((e) => e.type === "player" && e.username !== USERNAME && e.position.distanceTo(me) < 8);
      if (near) bot.lookAt(near.position.offset(0, near.height || 1.6, 0));
    } catch (_) {}
  }, 2000));
  // defend against hostile mobs
  let lastHit = 0;
  timers.push(setInterval(() => {
    try {
      if (task && task.name === "build") return;
      const me = bot.entity.position;
      const mob = bot.nearestEntity((e) => e.type === "hostile" && e.position.distanceTo(me) < 4.5);
      if (mob && Date.now() - lastHit > 600) {
        lastHit = Date.now();
        const sword = bot.inventory.items().find((i) => i.name.endsWith("_sword"));
        if (sword && !(bot.heldItem && bot.heldItem.name === sword.name)) bot.equip(sword, "hand").catch(() => {});
        bot.lookAt(mob.position.offset(0, mob.height || 1, 0)).then(() => bot.attack(mob)).catch(() => {});
      }
    } catch (_) {}
  }, 500));
  // eat when hungry
  let eating = false;
  timers.push(setInterval(async () => {
    try {
      if (eating || bot.food > 14) return;
      const food = bot.inventory.items().find((i) => bot.registry.foods && bot.registry.foods[i.type]);
      if (!food) return;
      eating = true;
      await bot.equip(food, "hand");
      await bot.consume();
    } catch (_) {} finally { eating = false; }
  }, 5000));
  // optional anti-AFK wiggle (off by default, a friendly bot does not spin around)
  if (process.env.AFK_MOVE === "1") {
    timers.push(setInterval(() => {
      try {
        if (task || (bot.pathfinder && bot.pathfinder.goal)) return;
        bot.setControlState("jump", true);
        setTimeout(() => bot.setControlState("jump", false), 300);
      } catch (_) {}
    }, 25000));
  }
}

async function runTests(bot) {
  for (const spec of TEST_ACTIONS.split(";").map((s) => s.trim()).filter(Boolean)) {
    const [k, a, b, c] = spec.split(":");
    log("TEST", spec);
    if (k === "mine") await runTask(bot, "mine", "test", (t) => mineTask(bot, t, a, parseInt(b, 10) || 1));
    if (k === "build") await runTask(bot, "build", "test", (t) => buildTask(bot, t, bot.entity, a, b, parseInt(c, 10) || 2));
    log("TEST done", spec, "|", status(bot));
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

    let readyAt = Infinity;
    bot.on("playerJoined", (p) => {
      if (Date.now() < readyAt || !p || p.username === USERNAME) return;
      pending = { user: p.username, msg: "(sunucuya yeni girdi)", addressed: false, system: true };
      think();
    });
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
      cancelTask();
      timers.forEach((t) => { clearTimeout(t); clearInterval(t); });
      try { bot.end(); } catch (_) {}
      resolve(why);
    };

    bot.once("spawn", () => {
      clearTimeout(joinTimer);
      current = bot;
      readyAt = Date.now() + 20000;
      log("Joined", HOST, "as", USERNAME, "version", bot.version);
      try {
        const mv = new Movements(bot);
        mv.canDig = false; mv.allow1by1towers = false; mv.allowParkour = false;
        bot.pathfinder.setMovements(mv);
      } catch (e) { log("Movements error:", e.message); }
      timers.push(setTimeout(() => { if (authTries === 0) doAuth("login"); }, 5000));
      timers.push(setTimeout(() => end("session-over"), msLeft));
      startIdle(bot, timers);
      if (TEST_ACTIONS) timers.push(setTimeout(() => runTests(bot).catch((e) => log("test error:", e.message)), 25000));
    });
    bot.on("death", () => log("Died"));
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
