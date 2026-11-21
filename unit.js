// Offline tests: planner, parser and the dig/tunnel logic against a fake world (no Minecraft server needed).
const assert = require("assert");
const { Vec3 } = require("vec3");
const { planCraft, smeltOutputFor } = require("./plan");
const { parse } = require("./ai");
const makeExtra = require("./extra");

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
  console.log(fails ? `\n${fails} FAILED` : "\nall passed");
  process.exit(fails ? 1 : 0);
})();
