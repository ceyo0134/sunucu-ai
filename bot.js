// Friend-like Minecraft bot with an AI brain (local LLM).
// The AI can only chat and choose from a fixed list of actions (see ai.js). It can never run commands:
// every chat message is stripped of a leading "/" before sending.
const mineflayer = require("mineflayer");
const { pathfinder, Movements, goals } = require("mineflayer-pathfinder");
const { Vec3 } = require("vec3");
const makeItem = require("prismarine-item");
const { ask, warmup, getStats, SHAPES } = require("./ai");
const { isOwner, sanitizeCommand, summarizeReply } = require("./cmd");
const { planCraft, toolTierFor, tierRank, bestPickaxeRank, isLog, smeltOutputFor, SMELT } = require("./plan");
const { trItem, missingFor, askText, classifyReply, gotSome } = require("./need");
const makeExtra = require("./extra");
const panel = require("./panel");

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
const log = (...a) => { console.log(new Date().toISOString(), ...a); try { panel.push(a.map((x) => (typeof x === "string" ? x : JSON.stringify(x))).join(" ")); } catch (_) {} };

// ---------- state ----------
const ADDR_RE = new RegExp("(" + USERNAME + "|ceyo|\\bbot\\b)", "i");
const NAME_RE = /^\.?[A-Za-z0-9_]{3,16}$/;
const history = [];
const seen = new Map();
let current = null;
let task = null; // { name, text, cancel }
let busy = false, pending = null, lastThink = 0, lastSpoke = 0;
let guarding = null; // name of the player we are guarding
const queue = []; // pending jobs {a, job}; the model fills it, "stop" empties it
const QUEUE_MAX = 1000;
let pumping = false, stopEpoch = 0;
let lastCmdAt = 0, noOpAt = 0; // last command time / last "no permission" reply
// Missing materials: the bot asks the owner, parks the job (+ the rest of the queue) here and remembers why.
let need = null; // { user, a, job, rest, items, watch, forItem, askedAt, snap, last, nudging }
let curJob = null; // queue entry that is running right now
const ASK_OWNER = process.env.ASK_OWNER === "1"; // default: the bot gathers everything itself (ASK_OWNER=1 -> asks the owner for missing materials) // ASK_OWNER=0 -> always gather everything itself
const ASK_ALL = process.env.ASK_ALL === "1"; // also ask for cheap basics (logs, cobblestone ...)
const NEED_TTL = 15 * 60 * 1000;
const cmdReplies = []; // chat lines that came back right after a command (the server's answer)


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
  log("SAY:", s);
  try { bot.chat(s); } catch (_) {}
  lastSpoke = Date.now();
  history.push(`${USERNAME}: ${s}`);
  if (history.length > 20) history.shift();
}

// Runs a "/" command. Only called for owners (or by the bot itself for owner requests); denylist always applies.
async function runCommand(bot, raw, full) {
  const r = sanitizeCommand(raw, PASSWORD, !!full);
  if (!r.ok) { log("CMD refused:", r.reason); return r; }
  const wait = 700 - (Date.now() - lastCmdAt);
  if (wait > 0) await sleep(wait);
  lastCmdAt = Date.now();
  log("CMD:", r.cmd);
  try { bot.chat("/" + r.cmd); } catch (_) {}
  return r;
}

// Sends the command, waits for the server's answer and tells the owner what really happened
// (not op, unknown command, player not found ...). quiet=true: only speak up when it failed.
// Turkish filler words players put after a command ("/skin set Yener yaz") that the server reads as one argument too many.
const FILLER_RE = /(?:\s+(?:yaz|yap|et|ver|koy|lütfen|lutfen|hadi|çalıştır|calistir|kullan|dene|len|ya|be|abi))+\s*$/i;
const SYNTAX_FAIL_RE = /invalid|incorrect|syntax|usage|argument|too many|kullanım|geçersiz|gecersiz/i;

async function commandAndTell(bot, raw, quiet, retried, full) {
  cmdReplies.length = 0;
  const res = await runCommand(bot, raw, full);
  if (!res.ok) { say(bot, String(res.reason).startsWith("denied") ? "O komut güvenlik için yasak." : "Bu komutu çalıştıramam."); return res; }
  await sleep(1600); // the answer arrives as a chat line
  const sum = summarizeReply(cmdReplies.splice(0));
  if (sum.failed && !sum.noOp && !retried && SYNTAX_FAIL_RE.test(sum.text || "")) {
    const trimmed = String(raw).replace(FILLER_RE, "");
    if (trimmed && trimmed !== String(raw).trim() && trimmed.split(/\s+/).length >= 1) { // retry once without the trailing filler word(s)
      log("CMD retry without filler:", trimmed);
      return commandAndTell(bot, trimmed, quiet, true, full);
    }
  }
  if (sum.failed) say(bot, sum.noOp ? `Komut çalışmadı, sunucu: "${sum.text}". Muhtemelen op değilim: /op ${USERNAME}` : `Komut çalışmadı, sunucu: "${sum.text}"`);
  else if (!quiet) say(bot, sum.text ? `Sunucu: ${sum.text}` : "Komutu gönderdim, sunucu cevap vermedi.");
  return res;
}

const PROTECTED = /(bedrock|barrier|command_block|structure_block|jigsaw|spawner|chest|barrel|shulker_box|furnace|smoker|hopper|dispenser|dropper|beacon|ender|portal|_bed$|sign|lectern|jukebox|crafting_table|enchanting|anvil|brewing|spawn)/;
const isProtected = (name) => PROTECTED.test(name);

const BLOCK_ALIAS = {
  odun: "_log", agac: "_log", "ağaç": "_log", log: "_log", oak_log: "_log", // "odun" = any tree (the model writes oak_log for it)
  beyaz_odun: "birch_log", hus: "birch_log", "huş": "birch_log", ladin: "spruce_log", akasya: "acacia_log", koyu_odun: "dark_oak_log", "koyu_meşe": "dark_oak_log", orman_odunu: "jungle_log",
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
    if (item === "_log" && b.name.startsWith("stripped_")) return false; // stripped logs belong to player builds
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
  const xp = bot.experience ? bot.experience.level : 0;
  return `${needLine()}can ${Math.round(bot.health)}/20, açlık ${bot.food}/20, oyun modu ${bot.game.gameMode}, konum ${Math.round(me.x)} ${Math.round(me.y)} ${Math.round(me.z)}, xp seviyesi ${xp}, ` +
    `envanter: ${invText}, yakındaki oyuncular: ${near}, şu an yaptığın iş: ${task ? task.text : "yok"}, ` +
    `kuyrukta bekleyen iş: ${queue.length}${queue.length ? " (sıradakiler: " + queue.slice(0, 5).map((q) => q.a.action + (q.a.item ? ":" + q.a.item : "") + (q.a.count > 1 ? " x" + q.a.count : "")).join(", ") + ")" : ""}`;
}

async function gotoNear(bot, pos, range, ms = 20000) {
  return gotoGoal(bot, new goals.GoalNear(pos.x, pos.y, pos.z, range), ms);
}
async function gotoGoal(bot, goal, ms = 20000) {
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

async function ensureItem(bot, name, allowGive) {
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
  if (!it && allowGive && Date.now() - noOpAt > 60000) {
    // owner asked for this job and the bot is op: give itself the materials
    await runCommand(bot, `give ${USERNAME} minecraft:${name} 64`);
    await sleep(1000);
    it = bot.inventory.items().find((i) => i.name === name) || null;
  }
  if (!it) return null;
  await bot.equip(it, "hand");
  return it;
}

// ---------- tasks ----------
function cancelTask() { if (task) task.cancel = true; }

function runTask(bot, name, text, fn, owner) {
  if (task) task.cancel = true;
  guarding = null;
  const t = { name, text, cancel: false, owner: !!owner };
  task = t;
  return (async () => {
    try { await sleep(200); await fn(t); }
    catch (e) { log("task error:", e.stack || e.message); if (owner) say(bot, `Bir hata oldu: ${String(e.message || e).slice(0, 70)}`); }
    finally {
      if (task === t) task = null;
      try { bot.pathfinder.setGoal(null); } catch (_) {}
    }
  })();
}

// Pathfinder may only dig while we are mining (never while it just walks around among player builds).
let digDepth = 0;
function digMode(bot, on) {
  digDepth += on ? 1 : -1;
  try { bot.pathfinder.movements.canDig = digDepth > 0; } catch (_) {}
}
// ---------- scanning ----------
// The bot only sees chunks the server has sent, so "far" means as far as is loaded. Nearby first, then wider.
const SCAN_RADII = [32, 64, 128];

// Unreachable spots (bad) never use up the candidates: we ask for 64 positions, not 12.
function scanBlocks(bot, match, bad) {
  for (const r of SCAN_RADII) {
    const found = bot.findBlocks({ matching: match, maxDistance: r, count: 64 }).filter((p) => !bad.has(p.toString()));
    if (found.length) return found;
  }
  return [];
}

// Nothing in sight, not even in the farthest loaded chunk: walk to new ground (loads more chunks) and look again.
async function wanderFor(bot, t, match, hops = 6) {
  say(bot, "Burada yok, etrafa bakıyorum.");
  const D = [[1, 0], [0, 1], [-1, 0], [0, -1]];
  let dir = Math.floor(Math.random() * 4);
  for (let h = 0; h < hops && !t.cancel; h++) {
    const before = bot.entity.position.clone();
    const goal = new goals.GoalNearXZ(Math.round(before.x + D[dir][0] * 48), Math.round(before.z + D[dir][1] * 48), 4);
    try { await gotoGoal(bot, goal, 30000); } catch (_) {}
    if (before.distanceTo(bot.entity.position) < 12) dir = (dir + 1) % 4; // blocked (water, cliff) -> turn
    if (scanBlocks(bot, match, new Set()).length) return true;
  }
  return false;
}

// "odun" is asked for as oak_log / oak_planks, but whatever wood we hold is fine.
function findInvItem(bot, name) {
  const items = bot.inventory.items();
  const exact = items.find((i) => i.name === name);
  if (exact) return exact;
  const kind = name === "oak_log" ? /_log$/ : name === "oak_planks" ? /_planks$/ : null;
  if (!kind) return null;
  return items.filter((i) => kind.test(i.name)).sort((a, b) => b.count - a.count)[0] || null;
}

async function mineTask(bot, t, item, count, quiet) {
  digMode(bot, true);
  try { return await mineTaskInner(bot, t, item, count, quiet); }
  finally { digMode(bot, false); }
}

async function mineTaskInner(bot, t, item, count, quiet) {
  const match = blockMatcher(item);
  if (!match) { say(bot, "Bu bloğun adını anlayamadım."); return 0; }
  let nm = norm(item); if (BLOCK_ALIAS[nm]) nm = BLOCK_ALIAS[nm];
  if (!(await ensurePickaxe(bot, t, nm))) return 0;
  let got = 0, explores = 0;
  const bad = new Set();
  while (!t.cancel && got < count) {
    const found = scanBlocks(bot, match, bad);
    if (!found.length) {
      if (explores < 3 && !t.cancel) {
        explores++;
        if (await X.exploreFor(bot, t, match, nm)) continue; // ores: dig a tunnel at the right height
        if (!/(_ore|debris)$/.test(nm) && (await wanderFor(bot, t, match))) { bad.clear(); continue; } // trees, sand, dirt ...: look around on the surface
      }
      say(bot, got ? `${got} tane aldım, yakında başka yok.` : "Yakında bulamadım.");
      return got;
    }
    const pos = found[0];
    t.text = `${item} topluyorum (${got}/${count})`;
    try {
      await gotoNear(bot, pos, 3);
      if (t.cancel) return got;
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
  if (!t.cancel && !quiet) say(bot, `${got} tane ${item} topladım!`);
  return got;
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

async function placeAt(bot, pos, itemName, allowGive) {
  const cur = bot.blockAt(pos);
  if (!cur) return "fail";
  if (!REPLACEABLE.has(cur.name)) return "occupied";
  let ref = null, face = null;
  for (const d of DIRS) {
    const nb = bot.blockAt(pos.plus(d));
    if (nb && nb.boundingBox === "block") { ref = nb; face = new Vec3(-d.x, -d.y, -d.z); break; }
  }
  if (!ref) return "noref";
  if (bot.entity.position.distanceTo(pos.offset(0.5, 0.5, 0.5)) > 4.2) await gotoNear(bot, pos, 2, 15000).catch(() => {});
  const p = bot.entity.position;
  if (Math.floor(p.x) === pos.x && Math.floor(p.z) === pos.z && Math.abs(Math.floor(p.y) - pos.y) <= 1) {
    await gotoNear(bot, pos.offset(3, 0, 3), 1, 8000).catch(() => {}); // step out of the way
  }
  const it = await ensureItem(bot, itemName, allowGive);
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
  const r = await placeAt(bot, ref.position.offset(0, 1, 0), item || "cobblestone", t.owner);
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
    const s = n >= 5 ? Math.min(n, 7) : 5;
    const mid = Math.floor(s / 2);
    for (let y = 1; y <= 3; y++) {
      for (let x = 0; x < s; x++) {
        for (let z = 0; z < s; z++) {
          const edge = x === 0 || z === 0 || x === s - 1 || z === s - 1;
          const door = x === mid && z === 0 && y <= 2;
          const win = y === 2 && ((x === mid && z === s - 1) || ((x === 0 || x === s - 1) && z === mid));
          if (edge && !door && !win) out.push(base.offset(x, y, z));
        }
      }
    }
    for (let x = 0; x < s; x++) for (let z = 0; z < s; z++) out.push(base.offset(x, 4, z)); // roof
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
    if (shape === "house" && pos.y === base.y + 4) {
      // roof: stand inside the house so every roof block is within reach
      const s = n >= 5 ? Math.min(n, 7) : 5;
      const sx = base.x + Math.max(1, Math.min(pos.x - base.x, s - 2));
      const sz = base.z + Math.max(1, Math.min(pos.z - base.z, s - 2));
      const sp = new Vec3(sx, base.y + 1, sz);
      if (bot.entity.position.distanceTo(sp.offset(0.5, 0, 0.5)) > 1.5) await gotoNear(bot, sp, 1, 8000).catch(() => {});
    }
    const r = await placeAt(bot, pos, item, t.owner).catch(() => "fail");
    if (r === "ok") { ok++; await sleep(150); }
    else if (r === "noitem") { say(bot, `Bende ${item} yok, bana verir misin?`); return; }
  }
  if (!t.cancel) say(bot, ok ? `Bitti! ${ok} blok koydum.` : "Kuramadım.");
}

async function giveTask(bot, t, e, item, n) {
  if (!e) { say(bot, "Seni göremiyorum, yakına gel."); return; }
  let name = norm(item);
  if (PLACE_ALIAS[name]) name = PLACE_ALIAS[name];
  const it = findInvItem(bot, name);
  if (!it) { say(bot, `Bende ${item || "o"} yok.`); return; }
  await gotoNear(bot, e.position, 3, 15000).catch(() => {});
  await bot.lookAt(e.position.offset(0, e.height || 1.6, 0));
  await bot.toss(it.type, null, Math.min(n, it.count));
  say(bot, "Al bakalım!");
}

async function healTask(bot, t, name) {
  if (!NAME_RE.test(name)) { say(bot, "Kimi iyileştireyim?"); return; }
  const before = noOpAt;
  await runCommand(bot, `effect give ${name} minecraft:instant_health 1 10 true`);
  await runCommand(bot, `effect give ${name} minecraft:saturation 1 20 true`);
  await runCommand(bot, `effect give ${name} minecraft:regeneration 15 2 true`);
  await sleep(1500);
  if (noOpAt > before) {
    const food = bot.inventory.items().find((i) => bot.registry.foods && bot.registry.foods[i.type]);
    const p = bot.players[name];
    if (food && p && p.entity) { await giveTask(bot, t, p.entity, food.name, 4); say(bot, "Op yetkim yok ama yemek verdim."); }
    else say(bot, "Op yetkim yok, beni op yaparsan iyileştirebilirim.");
  } else {
    say(bot, "İyileştirdim, afiyet olsun!");
  }
}

async function gotoTask(bot, t, x, y, z) {
  if (![x, y, z].every((v) => Number.isFinite(v) && Math.abs(v) < 30000000)) { say(bot, "Koordinatları anlayamadım."); return; }
  t.text = `${Math.round(x)} ${Math.round(y)} ${Math.round(z)} koordinatına gidiyorum`;
  try {
    await gotoNear(bot, new Vec3(x, y, z), 2, 120000);
    if (!t.cancel) say(bot, "Vardım!");
  } catch (e) {
    say(bot, "Oraya gidemedim.");
  }
}

const CRAFT_ALIAS = {
  kazma: "wooden_pickaxe", balta: "wooden_axe", kilic: "wooden_sword", "kılıç": "wooden_sword", kurek: "wooden_shovel", "kürek": "wooden_shovel",
  capa: "wooden_hoe", "çapa": "wooden_hoe", tezgah: "crafting_table", masa: "crafting_table", sopa: "stick", firin: "furnace", "fırın": "furnace",
  sandik: "chest", "sandık": "chest", mesale: "torch", "meşale": "torch", merdiven: "ladder", tahta: "oak_planks", odun: "oak_planks",
  olta: "fishing_rod", kalkan: "shield", yay: "bow", kova: "bucket", yatak: "white_bed", ekmek: "bread",
  iron: "iron_ingot", gold: "gold_ingot", copper: "copper_ingot", demir: "iron_ingot", "altın": "gold_ingot", altin: "gold_ingot", demir_kulce: "iron_ingot", "demir_külçe": "iron_ingot", altin_kulce: "gold_ingot", "altın_külçe": "gold_ingot",
};

// "taş kazma", "demir kılıç", "elmas zırh" ... (the model normally writes the English id, this is a fallback)
(function addToolAliases() {
  const tiers = { "tahta": "wooden", taş: "stone", "taş": "stone", tas: "stone", demir: "iron", elmas: "diamond", "altın": "golden", altin: "golden" };
  const tools = { kazma: "pickaxe", balta: "axe", "kılıç": "sword", kilic: "sword", "kürek": "shovel", kurek: "shovel", "çapa": "hoe", capa: "hoe",
    "miğfer": "helmet", migfer: "helmet", "zırh": "chestplate", zirh: "chestplate", pantolon: "leggings", bot: "boots" };
  for (const [tr, tier] of Object.entries(tiers)) for (const [tt, tool] of Object.entries(tools)) CRAFT_ALIAS[`${tr}_${tt}`] = `${tier}_${tool}`;
  Object.assign(CRAFT_ALIAS, { "yemek": "cooked_beef", biftek: "cooked_beef", "cam": "glass", "tuğla": "bricks", tugla: "bricks", "çubuk": "stick", cubuk: "stick" });
})();

function invCounts(bot) {
  const inv = {};
  bot.inventory.items().forEach((i) => { inv[i.name] = (inv[i.name] || 0) + i.count; });
  // any wood type counts for the planner (it plans with oak, the executor substitutes)
  inv.oak_log = Object.keys(inv).filter(isLog).reduce((a, k) => a + inv[k], 0) || inv.oak_log || 0;
  inv.oak_planks = Object.keys(inv).filter((k) => /_planks$/.test(k)).reduce((a, k) => a + (k === "oak_planks" ? 0 : inv[k]), inv.oak_planks || 0);
  return inv;
}

async function ensurePickaxe(bot, t, block) {
  const tier = toolTierFor(block);
  if (!tier) return true;
  if (bestPickaxeRank(invCounts(bot)) >= tierRank(tier)) return true;
  say(bot, `${{ wooden: "Tahta", stone: "Taş", iron: "Demir", diamond: "Elmas" }[tier] || tier} kazma lazım, önce onu yapıyorum.`);
  return craftItem(bot, t, `${tier}_pickaxe`, 1, true);
}

// Puts a block (crafting table, furnace ...) somewhere near the bot. Free spot first; in a cave or tunnel there is none,
// so it digs a block of rock out next to it and puts the item into the hole.
async function placeNearby(bot, t, itemName) {
  const me = bot.entity.position.floored();
  const offs = [];
  for (let r = 1; r <= 3; r++) for (let dx = -r; dx <= r; dx++) for (let dz = -r; dz <= r; dz++) {
    if (Math.max(Math.abs(dx), Math.abs(dz)) !== r) continue;
    for (const dy of [0, 1, -1]) offs.push([dx, dy, dz]);
  }
  for (const [dx, dy, dz] of offs) {
    if (t && t.cancel) return null;
    const pos = me.offset(dx, dy, dz);
    const r = await placeAt(bot, pos, itemName, false).catch(() => "fail");
    if (r === "ok") { await sleep(300); return bot.blockAt(pos); }
    if (r === "noitem") return null;
  }
  for (const [dx, dy, dz] of offs) { // nothing free: break a block out of the way and use its place
    if (t && t.cancel) return null;
    const pos = me.offset(dx, dy, dz);
    const b = bot.blockAt(pos);
    if (!b || b.boundingBox !== "block" || isProtected(b.name) || /(_ore|debris|_log|leaves)$/.test(b.name)) continue;
    try {
      await gotoNear(bot, pos, 3, 8000).catch(() => {});
      await digBlock(bot, bot.blockAt(pos));
      await sleep(200);
      const r = await placeAt(bot, pos, itemName, false).catch(() => "fail");
      if (r === "ok") { await sleep(300); return bot.blockAt(pos); }
    } catch (e) { log("placeNearby dig error:", e.message); }
  }
  return null;
}

async function getTable(bot, t) {
  const tb = bot.registry.blocksByName.crafting_table;
  const near = bot.findBlock({ matching: tb.id, maxDistance: 24 });
  if (near) { await gotoNear(bot, near.position, 3, 20000).catch(() => {}); return near; }
  return placeNearby(bot, t, "crafting_table");
}

let lastCraftErr = "";
async function craftOnce(bot, name, times, table) {
  lastCraftErr = "";
  const names = [name];
  if (/_planks$/.test(name)) {
    // use whatever wood we have: birch_log -> birch_planks ...
    bot.inventory.items().filter((i) => isLog(i.name)).forEach((i) => names.unshift(i.name.replace(/_(log|stem)$/, "") + "_planks"));
  }
  for (const nm of names) {
    const def = bot.registry.itemsByName[nm];
    if (!def) continue;
    for (let attempt = 0; attempt < 3; attempt++) {
      const tb = table ? (bot.blockAt(table.position) || table) : null;
      const recipe = bot.recipesFor(def.id, null, 1, tb || null)[0];
      if (!recipe) { lastCraftErr = "malzeme eksik"; break; }
      try {
        if (tb && bot.entity.position.distanceTo(tb.position.offset(0.5, 0.5, 0.5)) > 3.5) await gotoNear(bot, tb.position, 2, 10000).catch(() => {});
        await bot.craft(recipe, times, tb || undefined);
        return true;
      } catch (e) {
        lastCraftErr = String(e.message || e).slice(0, 70);
        log("craft error:", nm, e.message);
        await sleep(800);
      }
    }
  }
  return false;
}

// ---------- missing materials: ask the owner, remember why, continue when they give it ----------
const capTr = (x) => { const t = trItem(x); return t.charAt(0).toLocaleUpperCase("tr") + t.slice(1); };

function canAsk() { return !!(ASK_OWNER && curJob && curJob.job && curJob.job.owner && !curJob.job.noAsk); }

function needLine() {
  if (!need) return "";
  const list = Object.entries(need.items).map(([k, v]) => `${v} ${trItem(k)}`).join(", ");
  return `${need.user} kişisinden ${list} bekliyorsun (${trItem(need.forItem)} için; verince ya da "kendin topla" deyince işe devam edersin), `;
}

// Parks the running job and the rest of the queue, tells the owner what is missing, walks over to them.
async function requestFromOwner(bot, miss, forItem) {
  const q = curJob;
  const watch = {};
  for (const k of Object.keys(miss)) { watch[k] = true; (SMELT[k] || []).forEach((i) => { watch[i] = true; }); } // raw ore also counts for ingots
  const n = need = {
    user: q.job.user, a: q.a, job: q.job, rest: queue.splice(0), items: miss, watch, forItem,
    askedAt: Date.now(), snap: gotSome(invCounts(bot), watch, 0).sum, last: -1, nudging: false,
  };
  say(bot, askText(miss, forItem));
  const e = (bot.players[n.user] || {}).entity;
  if (e) await gotoNear(bot, e.position, 3, 15000).catch(() => {});
  return false;
}

// Puts the parked job (and what was queued behind it) back at the front of the queue.
// self=true: the owner said "kendin topla" -> this job never asks again.
function resumeNeed(bot, self) {
  const n = need;
  if (!n) return false;
  need = null;
  const job = Object.assign({}, n.job, self ? { noAsk: true } : {});
  queue.unshift({ a: n.a, job }, ...n.rest);
  say(bot, self ? "Tamam, kendim toplarım!" : `Sağ ol! ${capTr(n.forItem)} için devam ediyorum.`);
  pump(bot);
  return true;
}

// The owner says they gave it: pick up drops, wait a few seconds for the items, then continue.
async function nudgeNeed(bot) {
  const n = need;
  if (!n || n.nudging) return;
  n.nudging = true;
  try {
    for (let i = 0; i < 6 && need === n && !gotSome(invCounts(bot), n.watch, n.snap).more; i++) {
      if (!task) await runTask(bot, "pickup", "eşya topluyorum", (t) => X.collectDrops(bot, t, 24, 40), false);
      await sleep(1000);
    }
  } finally { n.nudging = false; }
  if (need !== n) return;
  if (gotSome(invCounts(bot), n.watch, n.snap).more) resumeNeed(bot, false);
  else say(bot, `Bir şey alamadım. ${Object.entries(n.items).map(([k, v]) => `${v} ${trItem(k)}`).join(", ")} lazım, ya da "kendin topla" de.`);
}

// Plans the whole chain (trees -> planks -> sticks -> table -> tool, stone for stone tools ...) and does it step by step.
async function craftItem(bot, t, name, count, quiet) {
  const tb = bot.registry.blocksByName.crafting_table;
  const inv = invCounts(bot);
  if (tb && bot.findBlock({ matching: tb.id, maxDistance: 24 })) inv.crafting_table = Math.max(1, inv.crafting_table || 0);
  const fu = bot.registry.blocksByName.furnace;
  if (fu && bot.findBlock({ matching: fu.id, maxDistance: 24 })) inv.furnace = Math.max(1, inv.furnace || 0);
  let steps;
  try { steps = planCraft(bot.registry, name, count, inv); }
  catch (e) { log("plan error:", e.message); say(bot, "Bunun nasıl yapılacağını çözemedim."); return false; }
  if (canAsk()) { // owner job + materials we do not have -> ask the owner first
    const miss = missingFor(steps, ASK_ALL);
    if (Object.keys(miss).length) return requestFromOwner(bot, miss, name);
  }
  const bad = steps.find((s) => s.kind === "unsupported");
  if (bad) { say(bot, `${bad.item} lazım ama onu yapamıyorum (Nether/boss gerekiyor). Bana ${bad.item} verirsen yaparım.`); return false; }
  if (!quiet && steps.some((s) => s.kind === "gather")) say(bot, "Malzemeleri toplayıp yapıyorum, biraz sürer.");
  for (const st of steps) {
    if (t.cancel) return false;
    try {
      if (st.kind === "gather") {
        t.text = `${st.item} topluyorum`;
        const countOf = () => { const c = invCounts(bot); return c[st.item] || 0; };
        const target = countOf() + st.count;
        for (let tries = 0; tries < 4 && countOf() < target && !t.cancel; tries++) {
          const got = await mineTask(bot, t, st.block, target - countOf(), true);
          if (!got) break;
        }
        if (countOf() < target) { if (!t.cancel) say(bot, `${st.item} yetmedi, yakında bulamadım.`); return false; }
      } else if (st.kind === "hunt") {
        t.text = `${st.item} için ${st.mob} avlıyorum`;
        const countOf = () => invCounts(bot)[st.item] || 0;
        const target = countOf() + st.count;
        for (let tries = 0; tries < st.count * 4 + 4 && countOf() < target && !t.cancel; tries++) {
          if (!(await X.huntTask(bot, t, st.mob, 1, true))) break;
        }
        if (countOf() < target) { if (!t.cancel) say(bot, `${st.item} yetmedi, yakında ${st.mob} bulamadım.`); return false; }
      } else if (st.kind === "smelt") {
        if (!(await X.smeltStep(bot, t, st))) return false;
        await sleep(300);
      } else if (st.kind === "craft") {
        t.text = `${st.item} üretiyorum`;
        let table = null;
        if (st.table) {
          table = await getTable(bot, t);
          if (!table) { say(bot, "Tezgah koyacak yer bulamadım."); return false; }
        }
        if (!(await craftOnce(bot, st.item, st.times, table))) { say(bot, `${st.item} üretemedim${lastCraftErr ? " (" + lastCraftErr + ")" : ""}.`); return false; }
        await sleep(300);
      }
    } catch (e) {
      log("craft step error:", e.stack || e.message);
      say(bot, `Yaparken bir şey ters gitti: ${String(e.message || e).slice(0, 70)}`);
      return false;
    }
  }
  return true;
}

async function craftTask(bot, t, item, n, smelt) {
  let name = norm(item);
  name = CRAFT_ALIAS[name] || PLACE_ALIAS[name] || name;
  if (!bot.registry.itemsByName[name]) { say(bot, "Bu eşyayı tanımıyorum."); return; }
  if (smelt && smeltOutputFor(name)) name = smeltOutputFor(name); // "raw_iron" / "beef" -> what the furnace makes
  const ok = await craftItem(bot, t, name, n, false);
  if (ok && !t.cancel) say(bot, `${item} hazır!`);
}

async function sleepTask(bot, t) {
  const bed = bot.findBlock({ matching: (b) => b.name.endsWith("_bed"), maxDistance: 32 });
  if (!bed) { say(bot, "Yakında yatak yok."); return; }
  await gotoNear(bot, bed.position, 2, 15000).catch(() => {});
  try { await bot.sleep(bed); say(bot, "İyi geceler!"); }
  catch (e) { say(bot, "Şu an uyuyamıyorum."); }
}

async function fightTask(bot, t) {
  const end = Date.now() + 60000;
  let kills = 0, idle = 0;
  while (!t.cancel && Date.now() < end && idle < 6) {
    const me = bot.entity.position;
    const mob = bot.nearestEntity((e) => e.type === "hostile" && e.position.distanceTo(me) < 24);
    if (!mob) { idle++; await sleep(1000); continue; }
    idle = 0;
    t.text = "canavarla savaşıyorum";
    try {
      const sword = X.bestWeapon(bot);
      if (sword) await bot.equip(sword, "hand").catch(() => {});
      await gotoNear(bot, mob.position, 2, 6000).catch(() => {});
      for (let k = 0; k < 8 && mob.isValid && !t.cancel; k++) {
        await bot.lookAt(mob.position.offset(0, mob.height || 1, 0));
        if (bot.entity.position.distanceTo(mob.position) < 4) bot.attack(mob);
        await sleep(600);
      }
      if (!mob.isValid) kills++;
    } catch (e) { log("fight error:", e.message); }
  }
  if (!t.cancel) say(bot, kills ? `${kills} canavarı hallettim!` : "Yakında canavar kalmadı.");
}


// ---------- nether portal ----------
// Finds a flat 4x5 spot in front of the bot. Frame cell (i, j): i = 0..3 along the frame, j = 0..4 up.
function findPortalSite(bot) {
  const p = bot.entity.position, yaw = bot.entity.yaw;
  const bx = Math.floor(p.x), bz = Math.floor(p.z), by = Math.floor(p.y);
  const fw = Math.abs(Math.sin(yaw)) > Math.abs(Math.cos(yaw)) ? [-Math.sign(Math.sin(yaw)), 0] : [0, -Math.sign(Math.cos(yaw)) || 1];
  const side = [Math.abs(fw[1]), Math.abs(fw[0])];
  const air = (b) => !b || REPLACEABLE.has(b.name);
  const solid = (b) => b && b.boundingBox === "block";
  for (let f = 4; f <= 12; f += 2) for (const lat of [0, -3, 3, -6, 6]) for (const dy of [0, -1, 1]) {
    const o = new Vec3(bx + fw[0] * f + side[0] * lat, by + dy, bz + fw[1] * f + side[1] * lat);
    let ok = true;
    for (let i = 0; i < 4 && ok; i++) {
      if (!solid(bot.blockAt(o.offset(side[0] * i, -1, side[1] * i)))) ok = false;
      for (let j = 0; j < 5 && ok; j++) if (!air(bot.blockAt(o.offset(side[0] * i, j, side[1] * i)))) ok = false;
    }
    if (ok) return { o, a: new Vec3(side[0], 0, side[1]), n: new Vec3(fw[0], 0, fw[1]) };
  }
  return null;
}

const inNether = (bot) => /nether/.test(String(bot.game.dimension || ""));

async function portalTask(bot, t) {
  if (inNether(bot)) { say(bot, "Zaten Nether'dayım."); return; }
  const have = (n) => invCounts(bot)[n] || 0;
  // 1) obsidian (10 for the frame)
  if (have("obsidian") < 10) {
    say(bot, "Portal için obsidiyen topluyorum.");
    await mineTask(bot, t, "obsidian", 10 - have("obsidian"), true).catch(() => 0);
    if (t.cancel) return;
  }
  if (have("obsidian") < 10) {
    if (t.owner && Date.now() - noOpAt > 60000) {
      say(bot, "Doğada obsidiyen bulamadım, komutla alıyorum.");
      await runCommand(bot, `give ${USERNAME} minecraft:obsidian ${10 - have("obsidian")}`);
      await sleep(1200);
    }
    if (have("obsidian") < 10) { say(bot, "Portal için 10 obsidiyen lazım, bulamadım."); return; }
  }
  // 2) 3 cobblestone helpers + flint and steel
  if (have("cobblestone") < 3) await mineTask(bot, t, "stone", 3 - have("cobblestone"), true).catch(() => 0);
  if (t.cancel) return;
  if (!have("flint_and_steel")) {
    say(bot, "Çakmak yapıyorum.");
    if (!(await craftItem(bot, t, "flint_and_steel", 1, true)) || t.cancel) return;
  }
  // 3) build the frame
  const site = findPortalSite(bot);
  if (!site) { say(bot, "Portal kuracak düz bir yer bulamadım, başka yere gidince tekrar söyle."); return; }
  const P = (i, j) => site.o.plus(site.a.scaled(i)).offset(0, j, 0);
  const plan = [
    [0, 0, "cobblestone"], [1, 0, "obsidian"], [2, 0, "obsidian"], [3, 0, "cobblestone"],
    [0, 1, "obsidian"], [0, 2, "obsidian"], [0, 3, "obsidian"], [3, 1, "obsidian"], [3, 2, "obsidian"], [3, 3, "obsidian"],
    [0, 4, "cobblestone"], [1, 4, "obsidian"], [2, 4, "obsidian"],
  ];
  let k = 0;
  for (const [i, j, item] of plan) {
    if (t.cancel) return;
    t.text = `portal kuruyorum (${++k}/${plan.length})`;
    let r = await placeAt(bot, P(i, j), item, false).catch(() => "fail");
    if (r === "fail") { await sleep(300); r = await placeAt(bot, P(i, j), item, false).catch(() => "fail"); }
    if (r === "noitem") { say(bot, `Bende ${item} bitti.`); return; }
    if (r === "noref" || r === "fail") { say(bot, "Portalı kuramadım."); return; }
    await sleep(150);
  }
  // 4) light it
  const lightFrom = P(1, 1).minus(site.n.scaled(2));
  for (const i of [1, 2, 1]) {
    if (t.cancel) return;
    t.text = "portalı yakıyorum";
    const fs = findInvItem(bot, "flint_and_steel");
    if (!fs) { say(bot, "Çakmağım kayboldu."); return; }
    await bot.equip(fs, "hand").catch(() => {});
    await gotoNear(bot, lightFrom, 1, 8000).catch(() => {});
    const base = bot.blockAt(P(i, 0));
    if (base) {
      await bot.lookAt(base.position.offset(0.5, 1, 0.5)).catch(() => {});
      try { await bot.activateBlock(base, new Vec3(0, 1, 0)); } catch (e) { log("light error:", e.message); }
    }
    await sleep(1500);
    const inner = bot.blockAt(P(1, 1));
    if (inner && inner.name === "nether_portal") break;
  }
  const lit = bot.blockAt(P(1, 1));
  if (!lit || lit.name !== "nether_portal") { say(bot, "Portal yanmadı, çakmakla uğraştım ama olmadı."); return; }
  say(bot, "Portal yandı, giriyorum!");
  // 5) walk in and wait for the dimension change
  const inside = P(1, 1);
  await gotoGoal(bot, new goals.GoalBlock(inside.x, inside.y, inside.z), 10000).catch(() => {});
  for (let w = 0; w < 25 && !t.cancel && !inNether(bot); w++) await sleep(1000);
  if (inNether(bot)) say(bot, "Nether'dayım!");
  else say(bot, "Portalın içindeyim ama geçiş olmadı, biraz bekleyip tekrar dene.");
}

// ---------- extra abilities (extra.js) ----------
const X = makeExtra({
  say, log, sleep, gotoNear, digBlock, placeAt, norm, isProtected,
  craftItem: (...a) => craftItem(...a),
  placeNearby: (...a) => placeNearby(...a),
  mineTask: (...a) => mineTask(...a),
});

// ---------- AI brain ----------
// Runs ONE action now and waits until it is finished (long jobs return when done).
async function execute(bot, a, job) {
  const name = a.target || job.user;
  const p = bot.players[name];
  const e = p && p.entity;
  const n = Math.max(1, Math.min(["mine", "break", "craft", "smelt", "hunt", "tunnel", "fish", "take"].includes(a.action) ? 1000 : 64, a.count || 1));
  switch (a.action) {
    case "come":
      cancelTask(); guarding = null;
      if (e) bot.pathfinder.setGoal(new goals.GoalNear(e.position.x, e.position.y, e.position.z, 2));
      else say(bot, "Seni göremiyorum, biraz yaklaş.");
      break;
    case "follow":
      cancelTask(); guarding = null;
      if (e) bot.pathfinder.setGoal(new goals.GoalFollow(e, 2), true);
      else say(bot, "Seni göremiyorum, biraz yaklaş.");
      break;
    case "guard":
      cancelTask();
      if (e) { guarding = name; bot.pathfinder.setGoal(new goals.GoalFollow(e, 3), true); }
      else say(bot, "Seni göremiyorum, biraz yaklaş.");
      break;
    case "mine": await runTask(bot, "mine", `${a.item} topluyorum`, (t) => mineTask(bot, t, a.item, n), job.owner); break;
    case "break":
      if (a.item) await runTask(bot, "mine", `${a.item} kırıyorum`, (t) => mineTask(bot, t, a.item, n), job.owner);
      else await runTask(bot, "break", "blok kırıyorum", (t) => breakTask(bot, t, e), job.owner);
      break;
    case "place": await runTask(bot, "place", "blok koyuyorum", (t) => placeTask(bot, t, e, a.item), job.owner); break;
    case "build": await runTask(bot, "build", "bir şey kuruyorum", (t) => buildTask(bot, t, e, a.shape, a.item, n), job.owner); break;
    case "give": await runTask(bot, "give", "eşya veriyorum", (t) => giveTask(bot, t, e, a.item, n), job.owner); break;
    case "heal": await runTask(bot, "heal", "iyileştiriyorum", (t) => healTask(bot, t, name), job.owner); break;
    case "fight": await runTask(bot, "fight", "savaşıyorum", (t) => fightTask(bot, t), job.owner); break;
    case "goto":
      if (a.x === null || a.y === null || a.z === null) say(bot, "Koordinatları tam söyler misin? (x y z)");
      else await runTask(bot, "goto", "yürüyorum", (t) => gotoTask(bot, t, a.x, a.y, a.z), job.owner);
      break;
    case "craft": await runTask(bot, "craft", `${a.item} üretiyorum`, (t) => craftTask(bot, t, a.item, n), job.owner); break;
    case "portal": await runTask(bot, "portal", "nether portalı kuruyorum", (t) => portalTask(bot, t), job.owner); break;
    case "sleep": await runTask(bot, "sleep", "uyuyorum", (t) => sleepTask(bot, t), job.owner); break;
    case "smelt": await runTask(bot, "craft", `${a.item} eritiyorum`, (t) => craftTask(bot, t, a.item, n, true), job.owner); break;
    case "armor": await runTask(bot, "armor", "zırh giyiyorum", (t) => X.armorTask(bot, t), job.owner); break;
    case "store": await runTask(bot, "store", "sandığa koyuyorum", (t) => X.storeTask(bot, t, a.item), job.owner); break;
    case "take": await runTask(bot, "take", "sandıktan alıyorum", (t) => X.takeTask(bot, t, a.item, n), job.owner); break;
    case "farm": await runTask(bot, "farm", "çiftçilik yapıyorum", (t) => X.farmTask(bot, t), job.owner); break;
    case "fish": await runTask(bot, "fish", "balık tutuyorum", (t) => X.fishTask(bot, t, Math.min(a.count || 1, 100)), job.owner); break;
    case "hunt": await runTask(bot, "hunt", "avlanıyorum", (t) => X.huntTask(bot, t, a.item, n, false), job.owner); break;
    case "tunnel": await runTask(bot, "tunnel", "tünel açıyorum", (t) => X.tunnelTask(bot, t, e, n), job.owner); break;
    case "digdown": await runTask(bot, "digdown", "aşağı kazıyorum", (t) => X.digDownTask(bot, t, e, a.y), job.owner); break;
    case "trade": await runTask(bot, "trade", "takas yapıyorum", (t) => X.tradeTask(bot, t, a.item, n), job.owner); break;
    case "enchant": await runTask(bot, "enchant", "büyülüyorum", (t) => X.enchantTask(bot, t, a.item), job.owner); break;
    case "ride": await runTask(bot, "ride", "bir şeye biniyorum", (t) => X.rideTask(bot, t, a.item), job.owner); break;
    case "dismount": try { await bot.dismount(); } catch (_) {} break;
    case "pickup": await runTask(bot, "pickup", "eşya topluyorum", (t) => X.pickupTask(bot, t), job.owner); break;
    case "cmd": {
      if (!job.owner) { say(bot, "Komutları sadece sahibim verebilir."); break; }
      await commandAndTell(bot, a.command, true);
      break;
    }
    default: break;
  }
}

function stopAll(bot) {
  stopEpoch++;
  need = null;
  queue.length = 0;
  cancelTask();
  guarding = null;
  try { bot.pathfinder.setGoal(null); } catch (_) {}
}

// Works through the queue one job at a time. Jobs added while it runs are picked up.
async function pump(bot) {
  if (pumping) return;
  pumping = true;
  let ran = 0;
  const epoch = stopEpoch;
  try {
    while (queue.length && current === bot) {
      const q = queue.shift();
      log("JOB:", JSON.stringify({ action: q.a.action, item: q.a.item, count: q.a.count, left: queue.length }));
      curJob = q;
      try { await execute(bot, q.a, q.job); } catch (e) { log("job error:", e.message); }
      finally { curJob = null; }
      ran++;
    }
    if (ran >= 2 && !queue.length && !need && current === bot && epoch === stopEpoch) say(bot, "Tüm işler bitti!");
  } finally {
    pumping = false;
    if (queue.length && current === bot) setTimeout(() => pump(bot), 200); // something was added at the very end
  }
}

// Instant actions happen right away, everything else goes to the queue in the model's order.
async function act(bot, r, job) {
  const e = (bot.players[r.target || job.user] || {}).entity;
  let added = 0;
  for (const a of r.actions) {
    switch (a.action) {
      case "stop": stopAll(bot); break;
      case "skip": cancelTask(); break;
      case "retry": nudgeNeed(bot).catch(() => {}); break;
      case "selfgather": resumeNeed(bot, true); break;
      case "jump":
        bot.setControlState("jump", true);
        setTimeout(() => bot.setControlState("jump", false), 300);
        break;
      case "wave": bot.swingArm(); break;
      case "look": { const pl = (bot.players[a.target || job.user] || {}).entity || e; if (pl) await bot.lookAt(pl.position.offset(0, pl.height || 1.6, 0)); break; }
      default:
        if (queue.length >= QUEUE_MAX) { say(bot, "Kuyruk dolu, biraz bekle."); return; }
        if (a.action === "cmd" && !job.owner) { say(bot, "Komutları sadece sahibim verebilir."); break; }
        queue.push({ a, job: { user: job.user, owner: job.owner } });
        added++;
    }
  }
  if (added) pump(bot);
}

async function think() {
  if (busy || !pending) return;
  busy = true;
  const job = pending; pending = null; lastThink = Date.now();
  job.followUp = history.slice(-4).some((l) => l.startsWith(USERNAME + ":") && /\?\s*$/.test(l)); // did the bot just ask something?
  try {
    const bot = current;
    if (!bot) return;
    job.status = status(bot);
    const t = Date.now();
    const mayTalk = () => job.addressed || job.system || Date.now() - lastSpoke > 60000;
    let saidEarly = false;
    // the model writes "say" first, so the answer goes to chat while the actions are still being generated
    let r = await ask(history.slice(-6), job, (text) => {
      if (job.owner && DENIAL_RE.test(text)) { log("AI denial suppressed:", text); return; }
      if (current === bot && mayTalk()) { saidEarly = true; log("AI said after", Date.now() - t, "ms"); say(bot, text); }
    });
    if (!r.actions.length && job.addressed && !job.system && !job.retried && CLAIM_RE.test(r.say || "")) {
      job.retried = true; // it said it is doing something but wrote no actions: ask once more, this time insisting
      log("AI said it works but gave no actions -> retry");
      const r2 = await ask(history.slice(-6), job, () => {});
      if (r2.actions.length) r = { say: saidEarly ? "" : r.say, actions: r2.actions };
    }
    log("LLM stats:", JSON.stringify(getStats()));
    log("AI (" + (Date.now() - t) + "ms):", JSON.stringify({ say: r.say, actions: r.actions.map((a) => [a.action, a.item, a.shape, a.count > 1 ? a.count : "", a.target, a.command, a.x, a.y, a.z].filter((v) => v !== "" && v !== null && v !== undefined)) }));
    if (current === bot) {
      if (job.owner && DENIAL_RE.test(r.say || "")) {
        r.say = r.actions.some((a) => a.action === "cmd")
          ? "Tamam, komutu gönderiyorum."
          : `Komutu şöyle yaz, hemen çalıştırırım: ${USERNAME} /komut`;
      }
      if (r.say && !saidEarly && mayTalk()) say(bot, r.say);
      await act(bot, r, job);
    }
  } catch (e) {
    log("AI error:", e.message);
  } finally {
    busy = false;
    if (pending) setTimeout(think, 500);
  }
}

// "ceyobot /time set day", "ceyobot/tp ceyo0134" (no space) -> strict form, everyone
const CLAIM_RE = /(yapıyorum|yapayım|yapıyoruz|başlıyorum|başlayayım|topluyorum|kuruyorum|kazıyorum|eritiyorum|pişiriyorum|hallediyorum|hallederim|geliyor!|geliyorum|hazırlıyorum|üretiyorum|getiriyorum|gidiyorum)/i;
const DIRECT_RE = new RegExp("^\\s*(?:" + USERNAME + "|ceyo|bot)\\b[,:]?\\s*\\/(\\S.*)$", "i");
// "ceyobot şunu kullan /tp ceyo0134 yaz" -> looser form, only for owners (a "/" a few words after the name)
const LOOSE_RE = new RegExp("^\\s*(?:" + USERNAME + "|ceyo|bot)\\b[^\\/]{0,40}\\/([a-z0-9_:.-]+(?:\\s.*)?)$", "i");
// The model sometimes says "I can't use commands" to its owner even though it can (and does) -> never let that through
const DENIAL_RE = /komut\w*[^.!?]{0,40}(kullanam|yapam|çalıştıram|calistiram|veremem|elimde yok|yetkim yok)|(kullanam|yapam|çalıştıram|calistiram)[^.!?]{0,20}komut/i;

function incoming(user, msg) {
  if (!user || !msg || user === USERNAME || !NAME_RE.test(user)) return;
  const key = user + "|" + msg, now = Date.now();
  if (seen.has(key) && now - seen.get(key) < 2000) return;
  seen.set(key, now);
  if (seen.size > 200) seen.clear();
  history.push(`${user}: ${String(msg).slice(0, 200)}`);
  if (history.length > 20) history.shift();
  try { panel.push("CHAT: " + user + ": " + String(msg).slice(0, 200)); } catch (_) {}
  const direct = String(msg).match(DIRECT_RE) || (isOwner(user) ? String(msg).match(LOOSE_RE) : null);
  if (direct) { // "ceyobot /time set day" -> run the command directly (owners only)
    const b = current;
    if (!b) return;
    if (!isOwner(user)) { say(b, "Komutları sadece sahibim verebilir."); return; }
    commandAndTell(b, direct[1], false, false, true).catch(() => {});
    return;
  }
  if (need && user === need.user && current && (ADDR_RE.test(msg) || now - need.askedAt < 120000)) {
    const kind = classifyReply(msg); // "Al elmas" / "kendin topla" / "vazgeç" while we wait for the owner
    if (kind) {
      if (kind === "self") resumeNeed(current, true);
      else if (kind === "cancel") { need = null; say(current, "Tamam, vazgeçtim."); }
      else nudgeNeed(current).catch(() => {});
      return;
    }
  }
  if (current && isOwner(user) && new RegExp("^\\W*(?:" + USERNAME + "|ceyo|bot)\\W+(?:süre|sure|gecikme|latency|ping)\\W*$", "i").test(msg)) {
    const st = getStats(); // owner diagnostic: "ceyobot süre" shows where the time of the last answer went
    const sec = (ms) => (ms === undefined || ms === null ? "?" : (ms / 1000).toFixed(1) + "sn");
    say(current, st
      ? `Son cevap ${sec(st.totalMs)}: ilk söz ${sec(st.sayMs)}, prompt ${st.promptN ?? "?"} token (${st.cacheN ?? "?"} önbellekten) ${sec(st.promptMs)}, üretim ${st.predN ?? "?"} token ${sec(st.predMs)}.`
      : "Henüz cevap vermedim, ölçecek bir şey yok.");
    return;
  }
  const addressed = ADDR_RE.test(msg) || (isOwner(user) && (now - lastSpoke < 60000 || queue.length > 0 || !!task) && !/^\W*(?:haha|ha ha|xd|lol|ok|tmm)\W*$/i.test(msg)); // the owner keeps talking to the bot without repeating its name
  if (!addressed && (!UNPROMPTED || now - lastThink < 20000)) return;
  if (pending && pending.user === user && now - pending.at < 20000) { // two messages in a row = one request (nothing gets lost)
    pending.msg = (pending.msg + ". " + msg).slice(0, 256);
    pending.addressed = pending.addressed || addressed;
    pending.at = now;
    return;
  }
  pending = { user, msg, addressed, owner: isOwner(user), at: now };
  think();
}

// ---------- idle behaviour (friend-like) ----------
let armoring = false;
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
  // defend against hostile mobs (wider radius and chasing while guarding a player)
  let lastHit = 0;
  timers.push(setInterval(() => {
    try {
      if (task && task.name === "build") return;
      const me = bot.entity.position;
      const reach = guarding ? 10 : 4.5;
      const mob = bot.nearestEntity((e) => e.type === "hostile" && e.position.distanceTo(me) < reach);
      if (mob) {
        const d = mob.position.distanceTo(me);
        if (guarding && d > 3) bot.pathfinder.setGoal(new goals.GoalNear(mob.position.x, mob.position.y, mob.position.z, 2));
        if (d < 4 && Date.now() - lastHit > 600) {
          lastHit = Date.now();
          const sword = X.bestWeapon(bot);
          if (sword && !(bot.heldItem && bot.heldItem.name === sword.name)) bot.equip(sword, "hand").catch(() => {});
          bot.lookAt(mob.position.offset(0, mob.height || 1, 0)).then(() => bot.attack(mob)).catch(() => {});
        }
      } else if (guarding) {
        const pe = bot.players[guarding] && bot.players[guarding].entity;
        if (pe && !(bot.pathfinder.goal && bot.pathfinder.goal.entity === pe)) bot.pathfinder.setGoal(new goals.GoalFollow(pe, 3), true);
      }
    } catch (_) {}
  }, 500));
  // wear the best armor we have (picked up, crafted or given)
  timers.push(setInterval(() => {
    if (!armoring) { armoring = true; X.equipBest(bot).catch(() => {}).finally(() => { armoring = false; }); }
  }, 10000));
  // keep a Totem of Undying in the off-hand (re-equip fast after one pops or one is picked up)
  let totemBusy = false;
  timers.push(setInterval(() => {
    if (totemBusy) return;
    totemBusy = true;
    X.equipTotem(bot).catch(() => {}).finally(() => { totemBusy = false; });
  }, 1000));
  // waiting for the owner: continue as soon as the wanted items show up in the inventory (given, dropped or /give)
  timers.push(setInterval(() => {
    const n = need;
    if (!n || n.nudging || current !== bot) return;
    if (Date.now() - n.askedAt > NEED_TTL) { need = null; return; }
    const g = gotSome(invCounts(bot), n.watch, n.snap);
    if (!g.more) { n.last = -1; return; }
    if (g.sum === n.last) resumeNeed(bot, false); else n.last = g.sum; // unchanged for one poll = the drop is finished
  }, 1500));
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

const NATURAL = new Set(["dirt", "grass_block", "coarse_dirt", "stone", "sand", "red_sand", "gravel", "netherrack", "sandstone", "oak_log", "birch_log", "spruce_log", "jungle_log", "acacia_log", "dark_oak_log"]);

async function runTests(bot) {
  let auto = null;
  for (const spec of TEST_ACTIONS.split(";").map((s) => s.trim()).filter(Boolean)) {
    const [k, a, b, c] = spec.split(":");
    log("TEST", spec);
    if (k === "mine") {
      let item = a;
      if (a === "auto") {
        const pos = bot.findBlocks({ matching: (bl) => NATURAL.has(bl.name), maxDistance: 8, count: 300 });
        const hist = {};
        pos.forEach((p) => { const n = bot.blockAt(p).name; hist[n] = (hist[n] || 0) + 1; });
        log("TEST nearby natural blocks:", JSON.stringify(hist));
        item = Object.keys(hist).sort((x, y) => hist[y] - hist[x])[0];
        if (!item) { log("TEST no natural blocks nearby, skipping"); continue; }
        auto = item;
      }
      await runTask(bot, "mine", "test", (t) => mineTask(bot, t, item, parseInt(b, 10) || 1));
    }
    if (k === "build") {
      let item = b;
      if (b === "auto") {
        const inv = bot.inventory.items().sort((x, y) => y.count - x.count)[0];
        item = inv ? inv.name : auto;
        log("TEST building with:", item);
      }
      await runTask(bot, "build", "test", (t) => buildTask(bot, t, bot.entity, a, item, parseInt(c, 10) || 2));
    }
    const quick = (name, fn) => runTask(bot, name, "test", async (t) => {
      const timer = setTimeout(() => { t.cancel = true; }, 120000); // no test may run longer than 2 minutes
      try { await fn(t); } finally { clearTimeout(timer); }
    });
    if (k === "craft") await quick("craft", (t) => craftTask(bot, t, a, parseInt(b, 10) || 1));
    if (k === "smelt") await quick("craft", (t) => craftTask(bot, t, a, parseInt(b, 10) || 1, true));
    if (k === "armor") await quick("armor", (t) => X.armorTask(bot, t));
    if (k === "tunnel") await quick("tunnel", (t) => X.tunnelTask(bot, t, null, parseInt(a, 10) || 6));
    if (k === "digdown") await quick("digdown", (t) => X.digDownTask(bot, t, null, a ? parseInt(a, 10) : undefined));
    if (k === "hunt") await quick("hunt", (t) => X.huntTask(bot, t, a === "any" ? "" : a, parseInt(b, 10) || 1, false));
    if (k === "fish") await quick("fish", (t) => X.fishTask(bot, t, parseInt(a, 10) || 1));
    if (k === "farm") await quick("farm", (t) => X.farmTask(bot, t));
    if (k === "pickup") await quick("pickup", (t) => X.pickupTask(bot, t));
    if (k === "store") await quick("store", (t) => X.storeTask(bot, t, a));
    if (k === "trade") await quick("trade", (t) => X.tradeTask(bot, t, a, 1));
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
      if (Date.now() - lastCmdAt < 3000) { // right after our command: keep everything that is not a player talking
        const who = msg.match(/^<([^>\s]{3,17})>\s/) || msg.match(/^(?:\[[^\]]{1,24}\]\s*)*([A-Za-z0-9_.]{3,17})\s*(?:»|›|:|>>|>)\s/);
        if (!(who && bot.players[who[1]]) && cmdReplies.length < 8) cmdReplies.push(msg.slice(0, 200));
      }
      if (Date.now() - lastCmdAt < 4000 && /permission|izniniz yok|yetkin yok|yetkiniz yok|unknown or incomplete|unknown command|bilinmeyen komut|do not have/.test(m)) noOpAt = Date.now();
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
      guarding = null;
      queue.length = 0;
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
        bot.registry.blocksArray.forEach((b) => { if (isProtected(b.name)) mv.blocksCantBreak.add(b.id); });
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

module.exports = { craftItem, mineTask, invCounts, _test: { findPortalSite, incoming, setCurrent: (b) => { current = b; }, cmdReplies, scanBlocks, wanderFor, findInvItem, blockMatcher, queue, setCur: (q) => { curJob = q; }, getNeed: () => need, clearNeed: () => { need = null; }, canAsk, resumeNeed, needLine } };

if (require.main === module) (async () => {
  panel.start({
    log,
    bot: () => current,
    say,
    owner: () => require("./cmd").OWNERS[0],
    status: () => ({ task, guarding, queue: queue.slice(0, 8).map((q) => q.a.action + (q.a.item ? ":" + q.a.item : "") + (q.a.count > 1 ? " x" + q.a.count : "")) }),
    ask: (text) => incoming(require("./cmd").OWNERS[0], "ceyobot " + text),
    stop: (b) => stopAll(b),
    cmd: (b, text) => commandAndTell(b, text, false, false, true),
  });
  const w = Date.now();
  warmup().then(() => log("LLM warm-up done in", Math.round((Date.now() - w) / 1000), "s")).catch((e) => log("LLM warm-up failed:", e.message));
  do {
    await runSession();
    if (ONCE) break;
    const wait = 10000 + Math.random() * 10000;
    log("Rejoining in", Math.round(wait / 1000), "seconds");
    await sleep(wait);
  } while (true);
})();
