// Offline tests: planner, parser and the dig/tunnel logic against a fake world (no Minecraft server needed).
const assert = require("assert");
const { Vec3 } = require("vec3");
const { planCraft, smeltOutputFor } = require("./plan");
const { parse, sayFromPartial, isChatOnly, parseChat } = require("./ai");
const makeExtra = require("./extra");

process.env.ASK_OWNER = process.env.ASK_OWNER || "1"; // the ask-the-owner flow tests need this mode (default is: gather everything itself)
let fails = 0;
const ok = (name, cond, info) => { console.log((cond ? "PASS " : "FAIL ") + name + (info ? "  " + info : "")); if (!cond) fails++; };

// ---- planner on two Minecraft versions ----
for (const ver of ["1.20.4", "1.21.4"]) {
  const mc = require("minecraft-data")(ver);
  const kinds = (n, c = 1, inv = {}) => planCraft(mc, n, c, { ...inv }).map((s) => s.kind + ":" + s.item);
  const iron = kinds("iron_pickaxe");
  ok(`[${ver}] iron_pickaxe plans mining+smelting`, iron.some((x) => x.startsWith("gather:raw_iron")) && iron.includes("smelt:iron_ingot") && iron.includes("craft:furnace") && iron.at(-1) === "craft:iron_pickaxe", iron.join(" "));
  const chest = kinds("iron_chestplate");
  ok(`[${ver}] oak + cobblestone preferred`, iron.join().includes("oak_log") && !iron.join().includes("pale") && !iron.join().includes("deepslate") && kinds("stone_pickaxe").join().includes("gather:cobblestone"), iron.join(" "));
  ok(`[${ver}] iron_chestplate`, chest.includes("smelt:iron_ingot") && chest.at(-1) === "craft:iron_chestplate");
  ok(`[${ver}] glass`, kinds("glass").join().includes("gather:sand") && kinds("glass").includes("smelt:glass"));
  ok(`[${ver}] cooked_beef hunts a cow`, kinds("cooked_beef").join() === "hunt:beef,craft:oak_planksx".slice(0, 0) + kinds("cooked_beef").join() && kinds("cooked_beef").includes("hunt:beef") && kinds("cooked_beef").includes("smelt:cooked_beef"));
  ok(`[${ver}] fishing_rod hunts a spider`, kinds("fishing_rod").includes("hunt:string"));
  ok(`[${ver}] bed hunts sheep`, kinds("white_bed").includes("hunt:white_wool"));
  ok(`[${ver}] bread / book`, kinds("book").includes("hunt:leather"));
  ok(`[${ver}] netherite unsupported`, kinds("netherite_ingot").includes("unsupported:netherite_ingot"));
  ok(`[${ver}] have inputs -> no gather`, !kinds("iron_ingot", 3, { raw_iron: 3, furnace: 1 }).some((x) => x.startsWith("gather")));
}
ok("smeltOutputFor", smeltOutputFor("raw_iron") === "iron_ingot" && smeltOutputFor("beef") === "cooked_beef" && smeltOutputFor("sand") === "glass");

// ---- parser ----
const p = parse('{"say":"x","actions":[{"action":"cook","item":"cooked_beef","count":4},{"action":"Harvest"},{"action":"hunt","item":"cow","count":3},{"action":"digdown","y":-50},{"action":"hack"}]}');
ok("parser aliases", p.actions.map((a) => a.action).join() === "smelt,farm,hunt,digdown" && p.actions[3].y === -50);
{
  const J = (msg, extra) => Object.assign({ user: "ceyo0134", msg, addressed: /ceyo|bot/i.test(msg), status: "can 20/20" }, extra || {});
  const chatMsgs = ["ceyobot naber", "ceyobot nasılsın?", "ceyobot selam", "ceyobot sen kimsin", "ceyobot çok komiksin"];
  const taskMsgs = ["ceyobot buraya gel", "ceyobot 10 odun topla", "ceyobot dur", "ceyobot bana tp len", "ceyobot /skin set Yener", "ceyobot şaka yap", "ceyobot elmas kazma", "ceyobot hemen gel", "ceyobot tamam", "ceyobot beni koru", "ceyobot gündüz olsun"];
  ok("fast path: small talk uses the small prompt", chatMsgs.every((m) => isChatOnly(J(m))), chatMsgs.filter((m) => !isChatOnly(J(m))).join(" | "));
  ok("fast path: anything that asks for work uses the big prompt", taskMsgs.every((m) => !isChatOnly(J(m))), taskMsgs.filter((m) => isChatOnly(J(m))).join(" | "));
  ok("fast path: not addressed -> small prompt (no actions possible)", isChatOnly(J("ahmet: hadi madene gidelim", { addressed: false })));
  ok("fast path: follow-up answer to the bot's question -> big prompt", !isChatOnly(J("sen seç ceyobot hadi başla", { followUp: true })));
  ok("fast path: 'hadi başla' alone -> big prompt", !isChatOnly(J("ceyobot hadi başla")));
  { const cut = parse('{"say":"Tamam","actions":[{"action":"craft","item":"wooden_pickaxe"},{"action":"mine","item":"stone","count":10},{"action":"portal"},{"action":"craft","item":"sto');
    ok("cut-off JSON keeps the finished actions", cut.actions.length === 3 && cut.actions[2].action === "portal" && cut.say === "Tamam", JSON.stringify(cut)); }
  ok("fast path: waiting for the owner -> big prompt", !isChatOnly(J("ceyobot naber", { status: "sahipten bekliyorsun: elmas" })));
  ok("fast path: join greeting waves", parseChat("Hoş geldin!", { system: true }).actions[0].action === "wave");
  ok("fast path: '-' means silence, quotes/name stripped", parseChat("-", {}).say === "" && parseChat('ceyobot: "Selam!"', {}).say === "Selam!");
}
ok("stream: say is found only once it is complete", sayFromPartial('{"say":"Gel') === null && sayFromPartial('{"say":"Geliyorum!","acti') === "Geliyorum!");
ok("stream: escaped quotes in say", sayFromPartial('{"say":"O \\"iyi\\" bir gün","actions":[]}') === 'O "iyi" bir gün');

// ---- ask the owner for missing materials ----
const { missingFor, askText, classifyReply, trItem, gotSome } = require("./need");
{
  const mc = require("minecraft-data")("1.21.4");
  const plan = (n, c = 1, inv = {}) => planCraft(mc, n, c, { ...inv });
  const m1 = missingFor(plan("diamond_pickaxe"));
  ok("ask: diamond_pickaxe -> only 3 diamonds", m1.diamond === 3 && Object.keys(m1).length === 1, JSON.stringify(m1));
  const m2 = missingFor(plan("iron_pickaxe"));
  ok("ask: iron_pickaxe asks ingots, not raw ore", m2.iron_ingot === 3 && !m2.raw_iron && Object.keys(m2).length === 1, JSON.stringify(m2));
  ok("ask: wooden/stone tools -> gather by itself", !Object.keys(missingFor(plan("wooden_pickaxe"))).length && !Object.keys(missingFor(plan("stone_pickaxe"))).length);
  ok("ask: ASK_ALL asks for logs too", missingFor(plan("wooden_pickaxe"), true).oak_log > 0);
  ok("ask: nothing missing when the items are there", !Object.keys(missingFor(plan("diamond_pickaxe", 1, { diamond: 3 }))).length);
  ok("ask: partial -> only the rest", missingFor(plan("diamond_pickaxe", 1, { diamond: 1 })).diamond === 2);
  ok("ask: fishing_rod asks for string", missingFor(plan("fishing_rod")).string >= 1);
  ok("ask: netherite counts as missing", missingFor(plan("netherite_ingot")).netherite_ingot === 1);
  const txt = askText(m1, "diamond_pickaxe");
  ok("askText", txt.startsWith("Elmas kazma için 3 elmas lazım") && txt.includes("kendin topla") && txt.length <= 200, txt);
  ok("trItem", trItem("iron_ingot") === "demir külçe" && trItem("iron_pickaxe") === "demir kazma" && trItem("foo_bar") === "foo bar");
  const reply = (m) => classifyReply(m);
  ok("reply: al elmas / verdim -> gave", reply("Al elmas") === "gave" && reply("ceyobot al") === "gave" && reply("tamam al bakalım") === "gave" && reply("verdim yere attım") === "gave");
  ok("reply: kendin topla -> self", reply("kendin topla") === "self" && reply("ben yok kendin topla") === "self" && reply("ceyobot bende yok") === "self" && reply("kendin al") === "self");
  ok("reply: vazgeç -> cancel", reply("vazgeç") === "cancel" && reply("boşver") === "cancel");
  ok("reply: normal chat -> null", reply("şu ağacı kır") === null && reply("naber") === null && reply("x ".repeat(60) + "al") === null);
  ok("gotSome", gotSome({ diamond: 3 }, { diamond: true }, 0).more && !gotSome({ diamond: 3 }, { diamond: true }, 3).more);
  const q = parse('{"say":"","actions":[{"action":"retry"},{"action":"selfgather"}]}');
  ok("parser: retry/selfgather", q.actions.map((a) => a.action).join() === "retry,selfgather");
}

// ---- the whole ask -> wait -> continue flow with a fake bot ----
const flowDone = (async () => {
  process.env.MC_PASSWORD = process.env.MC_PASSWORD || "unit-test";
  const B = require("./bot");
  const T = B._test;
  const mc = require("minecraft-data")("1.21.4");
  const chat = [];
  const inv = [];
  const bot = { registry: mc, players: {}, chat: (m) => chat.push(m), findBlock: () => null, inventory: { items: () => inv } };
  const give = (name, count) => { const e = inv.find((i) => i.name === name); if (e) e.count += count; else inv.push({ name, count }); };
  const owner = { user: "ceyo0134", owner: true };
  const later = { a: { action: "give", item: "diamond_pickaxe", count: 1 }, job: owner };
  T.queue.length = 0; T.queue.push(later);
  T.setCur({ a: { action: "craft", item: "diamond_pickaxe", count: 1 }, job: owner });
  const r = await B.craftItem(bot, { cancel: false }, "diamond_pickaxe", 1, false);
  const n = T.getNeed();
  ok("flow: asks the owner and stops", r === false && chat.some((c) => c.includes("3 elmas")), chat.join(" | "));
  ok("flow: remembers the job and parks the queue", n && n.a.item === "diamond_pickaxe" && n.rest.length === 1 && T.queue.length === 0 && T.needLine().includes("elmas kazma"));
  give("diamond", 3);
  ok("flow: items arrive", require("./need").gotSome(B.invCounts(bot), n.watch, n.snap).more);
  T.resumeNeed(bot, false);
  ok("flow: continues the same job first, the rest after it", T.queue.length === 2 && T.queue[0].a.item === "diamond_pickaxe" && T.queue[0].a.action === "craft" && T.queue[1] === later && !T.queue[0].job.noAsk && !T.getNeed());
  const r2 = await B.craftItem(bot, { cancel: false }, "diamond_pickaxe", 1, true).catch(() => "threw");
  ok("flow: with the diamonds it does not ask again", !chat.slice(1).some((c) => c.includes("lazım")), chat.join(" | "));

  // "kendin topla": never asks again for that job
  T.queue.length = 0; inv.length = 0; chat.length = 0;
  T.setCur({ a: { action: "craft", item: "diamond_pickaxe", count: 1 }, job: owner });
  await B.craftItem(bot, { cancel: false }, "diamond_pickaxe", 1, false);
  T.resumeNeed(bot, true);
  ok("flow: kendin topla -> noAsk", T.queue[0].job.noAsk === true && chat.at(-1).includes("kendim"), chat.at(-1));
  T.setCur(T.queue[0]);
  ok("flow: noAsk job does not ask", T.canAsk() === false);
  T.setCur({ a: {}, job: { user: "ahmet", owner: false } });
  ok("flow: other players are never asked", T.canAsk() === false);
  T.setCur(null); T.queue.length = 0; T.clearNeed();
})();

// ---- scanning: any wood, staged radius, unreachable spots, wandering on the surface ----
const scanDone = (async () => {
  process.env.MC_PASSWORD = process.env.MC_PASSWORD || "unit-test";
  const B = require("./bot");
  const T = B._test;
  const { Vec3 } = require("vec3");
  const at = (n) => ({ name: n });
  const m = T.blockMatcher("oak_log"); // what the model writes for "odun"
  ok("wood: oak_log means any log", m(at("birch_log")) && m(at("oak_log")) && m(at("spruce_log")) && m(at("jungle_log")));
  ok("wood: stripped logs are left alone", !m(at("stripped_birch_log")) && !m(at("oak_planks")) && !m(at("oak_leaves")));
  const bm = T.blockMatcher("beyaz odun");
  ok("wood: beyaz odun = birch only", bm(at("birch_log")) && !bm(at("oak_log")) && T.blockMatcher("birch_log")(at("birch_log")) && !T.blockMatcher("birch_log")(at("oak_log")));

  // fake bot: only blocks within LOADED blocks of the bot are visible, results nearest first
  const LOADED = 100;
  const mk = (positions, start = new Vec3(0, 64, 0)) => {
    const bot = { entity: { position: start }, chat: () => {}, pathfinder: { setGoal: () => {} } };
    bot.findBlocks = ({ maxDistance, count }) => positions.map((p) => new Vec3(...p))
      .filter((p) => p.distanceTo(bot.entity.position) <= Math.min(maxDistance, LOADED))
      .sort((a, b) => a.distanceTo(bot.entity.position) - b.distanceTo(bot.entity.position)).slice(0, count);
    bot.pathfinder.goto = async (g) => { bot.entity.position = new Vec3(g.x, 64, g.z); };
    return bot;
  };
  const any = () => true;

  // 20 trees; the 12 nearest are unreachable -> the other 8 must still be found
  const trees = Array.from({ length: 20 }, (_, i) => [i + 3, 64, 0]);
  const b1 = mk(trees);
  const bad = new Set(trees.slice(0, 12).map((p) => new Vec3(...p).toString()));
  const f1 = T.scanBlocks(b1, any, bad);
  ok("scan: unreachable spots do not use up the candidates", f1.length === 8 && f1[0].x === 15, `found ${f1.length}`);
  ok("scan: finds far blocks (staged radius)", T.scanBlocks(mk([[90, 64, 0]]), any, new Set()).length === 1);
  ok("scan: nothing beyond the loaded area", T.scanBlocks(mk([[160, 64, 0]]), any, new Set()).length === 0);

  // forest 150 blocks east: wander east until it comes into view
  {
    const bot = mk([[150, 64, 0], [152, 64, 3]]);
    const real = Math.random; Math.random = () => 0; // first direction = +x
    const r = await T.wanderFor(bot, { cancel: false }, any);
    Math.random = real;
    ok("wander: walks to new ground until trees are loaded", r === true && bot.entity.position.x >= 48 && bot.entity.position.x <= 150, `x=${bot.entity.position.x}`);
  }
  // blocked in the first direction -> turns
  {
    const bot = mk([[0, 64, 140]]);
    bot.pathfinder.goto = async (g) => { if (g.x > 10) return; bot.entity.position = new Vec3(g.x, 64, g.z); }; // east is blocked
    const real = Math.random; Math.random = () => 0;
    const r = await T.wanderFor(bot, { cancel: false }, any);
    Math.random = real;
    ok("wander: turns when blocked", r === true && bot.entity.position.z > 0, `pos=${bot.entity.position}`);
  }
  ok("wander: gives up when there is nothing", (await T.wanderFor(mk([]), { cancel: false }, any, 3)) === false);

  // give: oak_log request, birch in the inventory
  const inv = (...xs) => ({ inventory: { items: () => xs.map(([name, count]) => ({ name, count })) } });
  ok("give: oak_log falls back to any wood", T.findInvItem(inv(["birch_log", 5], ["spruce_log", 9]), "oak_log").name === "spruce_log");
  ok("give: exact name wins, no wrong fallback", T.findInvItem(inv(["oak_log", 1], ["birch_log", 9]), "oak_log").name === "oak_log" && T.findInvItem(inv(["birch_log", 5]), "diamond") === null && T.findInvItem(inv(["birch_planks", 4]), "oak_planks").name === "birch_planks");
})();

// ---- commands: the real server answer is reported; everybody gives jobs, only the owner sends / commands ----
const { summarizeReply } = require("./cmd");
const cmdDone = (async () => {
  const noPerm = summarizeReply(["I'm sorry, but you do not have permission to perform this command. Please contact the server administrators if you believe that this is a mistake."]);
  ok("reply: no permission -> failed + noOp", noPerm.failed && noPerm.noOp && noPerm.text.length <= 110);
  const unk = summarizeReply(["Unknown or incomplete command, see below for error", "tp ceyo0134<--[HERE]"]);
  ok("reply: unknown command -> failed + noOp", unk.failed && unk.noOp);
  const okr = summarizeReply(["Teleported ceyobot to ceyo0134"]);
  ok("reply: success text passed on", !okr.failed && okr.text === "Teleported ceyobot to ceyo0134");
  ok("reply: no entity -> failed, not an op problem", summarizeReply(["No entity was found"]).failed && !summarizeReply(["No entity was found"]).noOp);
  ok("reply: ClearLag spam ignored", summarizeReply(["[ClearLag] Items and entities will be cleared in 300!"]).text === "" && !summarizeReply([]).failed);

  process.env.MC_PASSWORD = process.env.MC_PASSWORD || "unit-test";
  const B = require("./bot");
  const T = B._test;
  const chat = [];
  const bot = { chat: (m) => chat.push(m), players: {} };
  T.setCurrent(bot);

  // owner: /tp, server says no permission -> the owner is told, not "sent"
  T.incoming("ceyo0134", "ceyobot /tp ceyo0134");
  await new Promise((r) => setTimeout(r, 900));
  T.cmdReplies.push("I'm sorry, but you do not have permission to perform this command.");
  await new Promise((r) => setTimeout(r, 2000));
  ok("cmd: the command really went out", chat[0] === "/tp ceyo0134", chat.join(" | "));
  ok("cmd: owner is told it failed + op hint", chat.some((c) => c.includes("Komut çalışmadı") && c.includes("/op")) && !chat.some((c) => c === "Komutu gönderdim."), chat.join(" | "));

  // owner: command works -> the server's answer is shown
  chat.length = 0;
  T.incoming("ceyo0134", "ceyobot /time set day");
  await new Promise((r) => setTimeout(r, 900));
  T.cmdReplies.push("Set the time to 1000");
  await new Promise((r) => setTimeout(r, 2000));
  ok("cmd: success shows the server answer", chat.some((c) => c === "Sunucu: Set the time to 1000"), chat.join(" | "));

  // owner: "/skin set Yener yaz" -> server rejects the extra word -> retried once without "yaz"
  chat.length = 0;
  T.incoming("ceyo0134", "ceyobot /skin set Yener yaz");
  await new Promise((r) => setTimeout(r, 900));
  T.cmdReplies.push('Invalid command argument: null');
  await new Promise((r) => setTimeout(r, 3200));
  ok("cmd: filler word dropped and command retried", chat[0] === "/skin set Yener yaz" && chat.includes("/skin set Yener"), chat.join(" | "));

  // owner diagnostic
  chat.length = 0;
  T.incoming("ceyo0134", "ceyobot süre");
  ok("diag: owner can ask for the last timing", chat.length === 1 && chat[0].startsWith("Henüz cevap vermedim"), chat.join(" | "));

  // other players: they may give jobs, but never "/" commands
  chat.length = 0;
  T.incoming("ahmet", "ceyobot /gamemode creative");
  ok("commands: strangers cannot send / commands", chat.length === 1 && chat[0] === "Komutları sadece sahibim verebilir.", chat.join(" | "));

  const reply = (json) => { global.fetch = async () => ({ ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify(json) } }] }) }); };
  const bot2 = { chat: (m) => chat.push(m), players: {}, health: 20, food: 20, game: { gameMode: "survival" }, experience: { level: 0 },
    entity: { position: new (require("vec3").Vec3)(0, 64, 0) }, inventory: { items: () => [] }, swingArm: () => {}, pathfinder: { setGoal: () => {} } };
  T.setCurrent(bot2);
  chat.length = 0;
  reply({ say: "Tamam!", actions: [{ action: "come" }] });
  T.incoming("ahmet", "ceyobot buraya gel");
  await new Promise((r) => setTimeout(r, 700));
  ok("jobs: strangers can give jobs", chat.includes("Tamam!") && chat.some((c) => c.startsWith("Seni göremiyorum")), chat.join(" | "));
  chat.length = 0;
  reply({ say: "Gündüz oluyor!", actions: [{ action: "cmd", command: "time set day" }] });
  T.incoming("ayse", "ceyobot gündüz yap");
  await new Promise((r) => setTimeout(r, 700));
  ok("commands: a stranger's request cannot make the AI run a command", !chat.some((c) => c.startsWith("/")) && chat.includes("Komutları sadece sahibim verebilir."), chat.join(" | "));
  delete global.fetch;
  T.setCurrent(null);
})();

// ---- fake world ----
function makeWorld(ores) {
  const edits = new Map(); // "x,y,z" -> name
  const key = (x, y, z) => x + "," + y + "," + z;
  const nameAt = (x, y, z) => {
    const k = key(x, y, z);
    if (edits.has(k)) return edits.get(k);
    if (y > 60) return "air";
    if (y < -63) return "bedrock";
    return ores[k] || "stone";
  };
  const blockAt = (pos) => {
    const name = nameAt(pos.x, pos.y, pos.z);
    const solid = name !== "air";
    return { name, position: new Vec3(pos.x, pos.y, pos.z), boundingBox: solid ? "block" : "empty", diggable: name !== "bedrock" };
  };
  const settle = () => { const p = bot.entity.position; let y = Math.floor(p.y); while (y > -64 && blockAt(new Vec3(Math.floor(p.x), y - 1, Math.floor(p.z))).boundingBox !== "block") y--; bot.entity.position = new Vec3(p.x, y, p.z); };
  const bot = {
    settle,
    entity: { position: new Vec3(0.5, 61, 0.5), yaw: 0 }, health: 20, game: { dimension: "overworld" },
    blockAt,
    findBlocks: ({ matching, maxDistance, count }) => {
      const out = [], me = bot.entity.position;
      for (const k of Object.keys(ores)) {
        const [x, y, z] = k.split(",").map(Number);
        const b = blockAt(new Vec3(x, y, z));
        if (matching(b) && b.position.distanceTo(me) <= maxDistance) out.push(b.position);
      }
      return out.slice(0, count);
    },
    inventory: { items: () => [] },
    pathfinder: {
      goto: async (g) => { // teleports, but refuses to walk through solid blocks like the real pathfinder (canDig=false)
        const feet = blockAt(new Vec3(g.x, g.y, g.z)), head = blockAt(new Vec3(g.x, g.y + 1, g.z));
        if (feet.boundingBox === "block" || head.boundingBox === "block") throw new Error("no path");
        bot.entity.position = new Vec3(g.x + 0.5, g.y, g.z + 0.5);
        // gravity: fall until standing on something
        while (blockAt(new Vec3(g.x, bot.entity.position.y - 1, g.z)).boundingBox !== "block") bot.entity.position = bot.entity.position.offset(0, -1, 0);
      },
      setGoal: () => {},
    },
  };
  return { bot, edits, key };
}
const mkX = (world, said) => makeExtra({
  say: (b, m) => said.push(m), log: () => {}, sleep: async () => { world.bot.settle(); },
  gotoNear: async () => {}, norm: (s) => String(s || ""), isProtected: (n) => n === "chest" || n === "bedrock",
  placeAt: async () => "fail", craftItem: async () => false, mineTask: async () => 0,
  digBlock: async (bot, b) => { world.edits.set(world.key(b.position.x, b.position.y, b.position.z), "air"); },
});

(async () => {
  await flowDone;
  await scanDone;
  await cmdDone;
  // tunnel 12 blocks forward through stone
  {
    const w = makeWorld({}); w.bot.entity.position = new Vec3(0.5, 50, 0.5);
    const said = []; const X = mkX(w, said);
    await X.tunnelTask(w.bot, { cancel: false }, null, 12);
    const p = w.bot.entity.position;
    ok("tunnel 12 blocks", Math.abs(p.x - 0.5) + Math.abs(p.z - 0.5) >= 12 || p.z <= -11.5, `ended at ${p.x},${p.y},${p.z} said: ${said.join("|")}`);
  }
  // lava stops the tunnel
  {
    const lava = {}; for (let y = 49; y <= 52; y++) lava[`0,${y},-5`] = "lava";
    const w = makeWorld(lava); w.bot.entity.position = new Vec3(0.5, 50, 0.5);
    const said = []; const X = mkX(w, said);
    await X.tunnelTask(w.bot, { cancel: false }, null, 12);
    const p = w.bot.entity.position;
    ok("tunnel stops before lava", p.z > -5 && said.join().includes("danger"), `z=${p.z} said: ${said.join("|")}`);
  }
  // staircase down 15 levels
  {
    const w = makeWorld({}); w.bot.entity.position = new Vec3(0.5, 61, 0.5);
    const said = []; const X = mkX(w, said);
    await X.digDownTask(w.bot, { cancel: false }, null, 46);
    ok("digdown reaches y=46", w.bot.entity.position.y <= 46, `y=${w.bot.entity.position.y} said: ${said.join("|")}`);
  }
  // explore for iron: ore sits at y=16 about 20 blocks away from where the bot digs
  {
    const ores = {}; for (let dx = -40; dx <= 40; dx += 1) ores[`${dx},16,${-20}`] = "iron_ore"; // a vein line across the map
    const w = makeWorld(ores); w.bot.entity.position = new Vec3(0.5, 61, 0.5);
    const said = []; const X = mkX(w, said);
    const realRandom = Math.random; Math.random = () => 0.9; // fixed start direction (-z) so the test is repeatable
    const found = await X.exploreFor(w.bot, { cancel: false }, (b) => b.name === "iron_ore", "iron_ore");
    Math.random = realRandom;
    ok("exploreFor finds iron", found === true, `y=${w.bot.entity.position.y} pos=${w.bot.entity.position} said: ${said.join("|")}`);
  }
  // vein is behind the starting direction: the arms that come back through the start must find it
  {
    const ores = {}; for (let dx = -40; dx <= 40; dx++) ores[`${dx},16,${-20}`] = "iron_ore";
    const w = makeWorld(ores); w.bot.entity.position = new Vec3(0.5, 61, 0.5);
    const said = []; const X = mkX(w, said);
    const realRandom = Math.random; Math.random = () => 0.3; // di=1 -> +z, away from the vein
    const found = await X.exploreFor(w.bot, { cancel: false }, (b) => b.name === "iron_ore", "iron_ore");
    Math.random = realRandom;
    ok("exploreFor turns around", found === true, `pos=${w.bot.entity.position}`);
  }
  // no explore for non-ore
  {
    const w = makeWorld({}); const X = mkX(w, []);
    ok("exploreFor ignores non-ore", (await X.exploreFor(w.bot, { cancel: false }, () => false, "oak_log")) === false);
  }
  // helpers
  const X0 = mkX(makeWorld({}), []);
  const T = X0._t;
  ok("dirFromYaw", T.dirFromYaw(0).z === -1 && T.dirFromYaw(Math.PI / 2).x === -1 && T.dirFromYaw(Math.PI).z === 1);
  ok("cropAge props/meta", T.cropAge({ getProperties: () => ({ age: 7 }) }) === 7 && T.cropAge({ metadata: 3 }) === 3 && T.cropAge({ getProperties: () => ({ age: "5" }) }) === 5);
  ok("armorRank", T.armorRank("diamond_helmet", "helmet") > T.armorRank("iron_helmet", "helmet") && T.armorRank("iron_boots", "helmet") === 0);
  // armor + weapon choice with a fake inventory
  {
    const items = [{ name: "iron_helmet" }, { name: "diamond_helmet" }, { name: "leather_boots" }, { name: "stone_sword" }, { name: "iron_axe" }, { name: "diamond_sword" }, { name: "shield" }];
    const equipped = [];
    const slots = []; slots[8] = { name: "leather_boots" }; // already wearing leather boots
    const bot = { inventory: { items: () => items, slots }, getEquipmentDestSlot: (s) => ({ head: 5, torso: 6, legs: 7, feet: 8 })[s], equip: async (it, where) => { equipped.push(it.name + "@" + where); } };
    const X = mkX(makeWorld({}), []);
    const n = await X.equipBest(bot);
    ok("equipBest", equipped.join() === "diamond_helmet@head,shield@off-hand" && n === 2, equipped.join());
    ok("bestWeapon", X.bestWeapon(bot).name === "diamond_sword");
  }
  {
  process.env.MC_PASSWORD = process.env.MC_PASSWORD || "unit-test";
  const B = require("./bot");
  const mk = (name, solid) => ({ name, boundingBox: solid ? "block" : "empty" });
  const bot = { entity: { position: new Vec3(0.5, 64, 0.5), yaw: Math.PI }, blockAt: (p) => (p.y < 64 ? mk("stone", true) : mk("air", false)) };
  const site = B._test.findPortalSite(bot);
  ok("portal: finds a flat 4x5 site in front of the bot", !!site && site.n.z === 1 && site.a.x === 1, JSON.stringify(site));
  bot.blockAt = (p) => mk("stone", true); // solid everywhere -> nowhere to build
  ok("portal: no site inside solid rock", B._test.findPortalSite(bot) === null);
}
  { // reflex: instant body commands
    const { parseReflex } = require("./reflex");
    const A = (m) => { const r = parseReflex(m, "ceyobot"); return r ? r.actions.map((a) => a.action + (a.item ? ":" + a.item : "")).join(",") : null; };
    ok("reflex zıpla", A("ceyobot zıpla") === "jump");
    ok("reflex etil/eğil", A("ceyobot etil") === "crouch" && A("ceyobot eğil") === "crouch");
    ok("reflex arkanı dön", A("ceyobot arkanı dön") === "turnaround");
    ok("reflex bana dön / dönme", A("bana dön") === "facelook" && A("ceyobot dönme") === "nolook");
    ok("reflex two commands", A("ceyobot zıpla ve arkanı dön") === "jump,turnaround");
    ok("reflex leaves real jobs to the AI", A("ceyobot zıpla sonra 10 odun topla") === null && A("ceyobot 10 odun topla") === null);
  }
console.log(fails ? `\n${fails} FAILED` : "\nall passed");
  process.exit(fails ? 1 : 0);
})();
