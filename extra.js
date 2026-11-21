// More things a Minecraft player can do: smelting, armor, chests, farming, fishing, hunting,
// tunnels / branch mining, trading, enchanting, riding, picking up drops.
// bot.js hands us its helpers (ctx) so everything shares the same task / cancel system.
const { goals } = require("mineflayer-pathfinder");
const { Vec3 } = require("vec3");
const { SMELT } = require("./plan");

const ARMOR_PARTS = { head: "helmet", torso: "chestplate", legs: "leggings", feet: "boots" };
const ARMOR_RANK = { leather: 1, copper: 2, golden: 2, turtle: 2, chainmail: 3, iron: 4, diamond: 5, netherite: 6 };
const TOOL_RANK = { wooden: 1, golden: 1.5, stone: 2, copper: 2.5, iron: 3, diamond: 4, netherite: 5 };
// good height to strip-mine each ore
const ORE_Y = { coal_ore: 45, iron_ore: 16, copper_ore: 48, gold_ore: -16, redstone_ore: -58, lapis_ore: 0, diamond_ore: -58 };
const CROPS = {
  wheat: { seed: "wheat_seeds", max: 7 },
  carrots: { seed: "carrot", max: 7 },
  potatoes: { seed: "potato", max: 7 },
  beetroots: { seed: "beetroot_seeds", max: 3 },
};
const FUEL_ITEMS = { coal: 8, charcoal: 8, coal_block: 80, blaze_rod: 12 }; // items smelted per unit
const KEEP_RE = /(pickaxe|_axe$|sword|shovel|hoe|helmet|chestplate|leggings|boots|shield|fishing_rod|^bow$|crossbow|bucket|^torch$|bread|cooked_|baked_|^apple$|golden_apple|^carrot$|^potato$|^arrow$|crafting_table|^furnace$)/;

function materialRank(name, suffix, table) {
  if (!name.endsWith("_" + suffix)) return 0;
  return table[name.slice(0, -(suffix.length + 1))] || 0;
}
const armorRank = (name, suffix) => materialRank(name, suffix, ARMOR_RANK);
function dirFromYaw(yaw) {
  const dx = -Math.sin(yaw), dz = -Math.cos(yaw);
  return Math.abs(dx) > Math.abs(dz) ? new Vec3(Math.sign(dx), 0, 0) : new Vec3(0, 0, Math.sign(dz) || -1);
}
function cropAge(b) {
  try {
    if (b.getProperties) { const a = b.getProperties().age; if (a !== undefined) return Number(a); }
  } catch (_) {}
  return Number(b.metadata) || 0;
}
const matches = (name, want) => !want || name === want || name.endsWith("_" + want);

module.exports = function makeExtra(ctx) {
  const { say, log, sleep, gotoNear, digBlock, placeAt, norm, isProtected } = ctx;

  // ---------- armor and weapons ----------
  function bestWeapon(bot) {
    let best = null, rank = 0;
    for (const it of bot.inventory.items()) {
      const r = Math.max(materialRank(it.name, "sword", TOOL_RANK) * 2, materialRank(it.name, "axe", TOOL_RANK) * 1.5);
      if (r > rank) { best = it; rank = r; }
    }
    return best;
  }

  async function equipBest(bot) {
    let changed = 0;
    for (const [slot, suffix] of Object.entries(ARMOR_PARTS)) {
      let cur = null;
      try { cur = bot.inventory.slots[bot.getEquipmentDestSlot(slot)]; } catch (_) {}
      let best = null, bestRank = cur ? armorRank(cur.name, suffix) : 0;
      for (const it of bot.inventory.items()) {
        const r = armorRank(it.name, suffix);
        if (r > bestRank) { best = it; bestRank = r; }
      }
      if (best) { try { await bot.equip(best, slot); changed++; } catch (_) {} }
    }
    const shield = bot.inventory.items().find((i) => i.name === "shield");
    if (shield && !bot.inventory.slots[45]) { try { await bot.equip(shield, "off-hand"); changed++; } catch (_) {} }
    return changed;
  }

  async function armorTask(bot, t) {
    const n = await equipBest(bot);
    say(bot, n ? `${n} parça giydim!` : "Giyecek daha iyi bir zırhım yok.");
  }

  // ---------- picking up drops ----------
  async function collectDrops(bot, t, radius = 8, maxItems = 20) {
    const tried = new Set();
    let n = 0;
    while (n < maxItems && !(t && t.cancel)) {
      const me = bot.entity.position;
      const it = bot.nearestEntity((e) => (e.name === "item" || e.objectType === "Item") && !tried.has(e.id) && e.position.distanceTo(me) < radius);
      if (!it) break;
      tried.add(it.id); n++;
      await gotoNear(bot, it.position, 1, 6000).catch(() => {});
      await sleep(150);
    }
    return n;
  }
  async function pickupTask(bot, t) {
    const n = await collectDrops(bot, t, 24, 40);
    say(bot, n ? `${n} eşya topladım.` : "Yerde eşya göremiyorum.");
  }

  // ---------- hunting ----------
  const PASSIVE = ["cow", "pig", "sheep", "chicken", "rabbit"];
  async function huntTask(bot, t, mob, count, quiet) {
    mob = norm(mob);
    const any = !mob || ["any", "animal", "hayvan"].includes(mob);
    if (!any && !bot.registry.entitiesByName[mob]) { say(bot, "Bu yaratığı tanımıyorum."); return 0; }
    const isTarget = (e) => e.name && (any ? PASSIVE.includes(e.name) : e.name === mob);
    let kills = 0;
    const end = Date.now() + 4 * 60000;
    while (!t.cancel && kills < count && Date.now() < end) {
      const me = bot.entity.position;
      const e = bot.nearestEntity((x) => isTarget(x) && x.position.distanceTo(me) < 48);
      if (!e) { if (!quiet) say(bot, kills ? `${kills} tane avladım, yakında başka yok.` : "Yakında bulamadım."); break; }
      t.text = `${any ? "hayvan" : mob} avlıyorum (${kills}/${count})`;
      try {
        const w = bestWeapon(bot);
        if (w) await bot.equip(w, "hand").catch(() => {});
        await gotoNear(bot, e.position, 2, 10000).catch(() => {});
        for (let k = 0; k < 40 && e.isValid && !t.cancel; k++) {
          if (bot.health <= 6 && e.type === "hostile") { say(bot, "Canım az, çekiliyorum!"); return kills; }
          if (e.position.distanceTo(bot.entity.position) > 3) await gotoNear(bot, e.position, 2, 5000).catch(() => {});
          await bot.lookAt(e.position.offset(0, (e.height || 1) * 0.8, 0));
          if (e.position.distanceTo(bot.entity.position) < 4) bot.attack(e);
          await sleep(550);
        }
        if (!e.isValid) kills++;
      } catch (err) { log("hunt error:", err.message); await sleep(500); }
      await sleep(300);
      await collectDrops(bot, t, 8, 12);
    }
    if (!quiet && !t.cancel && kills) say(bot, `${kills} tane avladım!`);
    return kills;
  }

  // ---------- digging safety / tunnels ----------
  function liquidNear(bot, pos) {
    for (const d of [[0, 0, 0], [1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]]) {
      const b = bot.blockAt(pos.offset(d[0], d[1], d[2]));
      if (b && (b.name === "lava" || b.name === "water")) return true;
    }
    return false;
  }

  async function clearBlock(bot, pos) {
    if (liquidNear(bot, pos)) return "danger";
    const b = bot.blockAt(pos);
    if (!b || b.boundingBox === "empty") return "ok";
    if (isProtected(b.name) || !b.diggable) return "blocked";
    await digBlock(bot, b);
    return "ok";
  }

  async function walkTo(bot, pos, ms = 6000) {
    const goal = new goals.GoalBlock(pos.x, pos.y, pos.z);
    let timer;
    try {
      await Promise.race([
        bot.pathfinder.goto(goal),
        new Promise((_, rej) => { timer = setTimeout(() => rej(new Error("walk timeout")), ms); }),
      ]);
    } finally { clearTimeout(timer); try { bot.pathfinder.setGoal(null); } catch (_) {} }
  }

  // dig one block forward (2 high) and step into it. Returns ok | danger | blocked | drop | stuck
  async function stepForward(bot, t, dir) {
    const next = bot.entity.position.floored().plus(dir);
    for (const p of [next, next.offset(0, 1, 0)]) {
      for (let k = 0; k < 4; k++) {
        const r = await clearBlock(bot, p);
        if (r !== "ok") return r;
        await sleep(120);
        const b = bot.blockAt(p);
        if (!b || b.boundingBox === "empty") break; // gravel may have fallen in, loop digs again
      }
    }
    let solid = false;
    for (let k = 1; k <= 3; k++) {
      const g = bot.blockAt(next.offset(0, -k, 0));
      if (!g) break;
      if (g.name === "lava" || g.name === "water") return "danger";
      if (g.boundingBox === "block") { solid = true; break; }
    }
    if (!solid) return "drop";
    try { await walkTo(bot, next, 6000); } catch (_) { return "stuck"; }
    return "ok";
  }

  async function placeTorch(bot) {
    const torch = bot.inventory.items().find((i) => i.name === "torch");
    if (!torch) return;
    try {
      const below = bot.blockAt(bot.entity.position.floored().offset(0, -1, 0));
      if (!below || below.boundingBox !== "block") return;
      await bot.equip(torch, "hand");
      await bot.placeBlock(below, new Vec3(0, 1, 0));
    } catch (_) {}
  }

  async function tunnel(bot, t, dir, len, scan) {
    let done = 0;
    for (let i = 0; i < len && !t.cancel; i++) {
      t.text = `tünel açıyorum (${done}/${len})`;
      const r = await stepForward(bot, t, dir);
      if (r !== "ok") return { done, reason: r };
      done++;
      if (done % 8 === 0) await placeTorch(bot);
      if (scan && done % 3 === 0 && scan()) return { done, reason: "found" };
    }
    return { done, reason: "end" };
  }

  // staircase down to targetY
  async function digDown(bot, t, targetY, dir, scan) {
    for (let guard = 0; guard < 200 && !t.cancel; guard++) {
      if (bot.entity.position.floored().y <= targetY) return "done";
      if (scan && guard % 3 === 2 && scan()) return "found";
      t.text = `aşağı kazıyorum (y=${Math.floor(bot.entity.position.y)} -> ${targetY})`;
      const r = await stepForward(bot, t, dir);
      if (r !== "ok") return r;
      const f = bot.entity.position.floored();
      const below = f.offset(0, -1, 0);
      let solid = false;
      for (let k = 2; k <= 4; k++) {
        const g = bot.blockAt(f.offset(0, -k, 0));
        if (g && (g.name === "lava" || g.name === "water")) return "danger";
        if (g && g.boundingBox === "block") { solid = true; break; }
      }
      if (!solid) return "drop";
      const rr = await clearBlock(bot, below);
      if (rr !== "ok") return rr;
      await sleep(500); // fall one block
    }
    return t.cancel ? "cancel" : "limit";
  }

  async function tunnelTask(bot, t, e, len) {
    const dir = dirFromYaw(e ? e.yaw : bot.entity.yaw);
    if (e) await gotoNear(bot, e.position, 2, 15000).catch(() => {});
    const r = await tunnel(bot, t, dir, Math.min(len || 10, 200), null);
    if (t.cancel) return;
    say(bot, r.reason === "end" ? `${r.done} blokluk tünel açtım!` : `${r.done} blok açtım, devam edemedim (${r.reason}).`);
  }

  async function digDownTask(bot, t, e, y) {
    const cur = Math.floor(bot.entity.position.y);
    const target = Number.isFinite(y) ? Math.max(-60, y) : cur - 12;
    const r = await digDown(bot, t, target, dirFromYaw(e ? e.yaw : bot.entity.yaw));
    if (!t.cancel) say(bot, r === "done" ? `y=${Math.floor(bot.entity.position.y)} seviyesine indim.` : `Durdum (${r}), y=${Math.floor(bot.entity.position.y)}.`);
  }

  // used by mining when no ore is near: go to the ore's best height and strip-mine until it shows up
  async function exploreFor(bot, t, match, nm) {
    const key = String(nm).replace(/^deepslate_/, "");
    const targetY = ORE_Y[key];
    if (targetY === undefined) return false;
    try { if (/nether|end/.test(String(bot.game.dimension))) return false; } catch (_) {}
    say(bot, "Yakında yok, tünel açıp arıyorum.");
    const scan = () => bot.findBlocks({ matching: match, maxDistance: 24, count: 1 }).length > 0;
    const dirs = [new Vec3(1, 0, 0), new Vec3(0, 0, 1), new Vec3(-1, 0, 0), new Vec3(0, 0, -1)];
    let di = Math.floor(Math.random() * 4);
    const start = Date.now();
    if (bot.entity.position.y > targetY + 2) {
      const r = await digDown(bot, t, targetY, dirs[di], scan);
      if (r === "found" || scan()) return true;
    }
    // arms: forward, then back through the start and beyond (the tunnel already exists, so that is cheap),
    // then sideways and back, so the search covers a cross instead of running away in one direction
    const d = dirs[di], p = new Vec3(d.z, 0, d.x), neg = (v) => new Vec3(-v.x, -v.y, -v.z);
    const legs = [[d, 28], [neg(d), 56], [p, 28], [neg(p), 56], [d, 28], [neg(d), 56], [p, 28], [neg(p), 56]];
    for (const [dir, len] of legs) {
      if (t.cancel || Date.now() - start > 6 * 60000) break;
      await tunnel(bot, t, dir, len, scan);
      if (scan()) return true;
    }
    return scan();
  }

  // ---------- smelting ----------
  function pickFuel(bot, needItems, reserve) {
    const inv = bot.inventory.items();
    for (const [name, per] of Object.entries(FUEL_ITEMS)) {
      const it = inv.find((i) => i.name === name);
      if (it) return { it, n: Math.min(it.count, Math.ceil(needItems / per)) };
    }
    for (const it of inv) {
      if (!/_(log|planks|stem)$/.test(it.name)) continue;
      const avail = it.count - (reserve && reserve.name === it.name ? reserve.n : 0);
      if (avail > 0) return { it, n: Math.min(avail, Math.ceil(needItems / 1.5)) };
    }
    return null;
  }

  async function getFurnace(bot, t) {
    const fb = bot.registry.blocksByName.furnace;
    const near = bot.findBlock({ matching: fb.id, maxDistance: 24 });
    if (near) { await gotoNear(bot, near.position, 3, 20000).catch(() => {}); return near; }
    if (!bot.inventory.items().some((i) => i.name === "furnace")) {
      if (!(await ctx.craftItem(bot, t, "furnace", 1, true))) return null;
    }
    return ctx.placeNearby(bot, t, "furnace"); // free spot nearby, or digs one out of the rock
  }

  // How many items the fuel in the inventory can smelt (logs/planks count 1.5, coal 8 ...). "reserve" = logs we want to smelt ourselves.
  function fuelUnits(bot, reserve) {
    let sum = 0;
    for (const it of bot.inventory.items()) {
      if (FUEL_ITEMS[it.name]) sum += FUEL_ITEMS[it.name] * it.count;
      else if (/_(log|planks|stem)$/.test(it.name)) sum += 1.5 * Math.max(0, it.count - (reserve && reserve.name === it.name ? reserve.n : 0));
    }
    return sum;
  }

  // Makes sure there is fuel for `n` items: first coal (mines coal ore, tunnels for it), then any wood.
  async function ensureFuel(bot, t, n, reserve) {
    let have = fuelUnits(bot, reserve);
    if (have < n) {
      t.text = "kömür arıyorum";
      say(bot, "Yakıt (kömür) lazım, arıyorum.");
      await ctx.mineTask(bot, t, "coal_ore", Math.max(1, Math.ceil((n - have) / 8)), true).catch(() => 0);
      have = fuelUnits(bot, reserve);
    }
    if (have < n && !t.cancel) {
      t.text = "yakıt için odun topluyorum";
      await ctx.mineTask(bot, t, "_log", Math.max(1, Math.ceil((n - have) / 1.5)) + 1, true).catch(() => 0);
    }
    return pickFuel(bot, n, reserve);
  }

  // st: { item: output, input, count }. Works in batches: refuels (finds coal / wood) when the furnace runs dry and keeps going.
  async function smeltStep(bot, t, st) {
    const haveInput = () => { const it = bot.inventory.items().find((i) => i.name === st.input); return it ? it.count : 0; };
    const total = Math.min(st.count, haveInput());
    if (total < 1) { say(bot, `Eritmek için ${st.input} yok.`); return false; }
    const logInput = /_log$/.test(st.input);
    const fblock = await getFurnace(bot, t);
    if (!fblock) { say(bot, "Fırın koyacak yer bulamadım."); return false; }
    let done = 0, stuck = 0;
    while (done < total && !t.cancel && stuck < 3) {
      const batch = Math.min(total - done, 64, haveInput());
      if (batch < 1) break;
      const fuel = await ensureFuel(bot, t, batch, logInput ? { name: st.input, n: batch } : null);
      if (t.cancel) return false;
      if (!fuel) { say(bot, "Fırın için yakıt bulamadım."); return false; }
      await gotoNear(bot, fblock.position, 3, 15000).catch(() => {});
      let furn;
      try { furn = await bot.openFurnace(bot.blockAt(fblock.position) || fblock); }
      catch (e) { log("openFurnace error:", e.message); stuck++; await sleep(1000); continue; }
      let got = 0;
      try {
        const inp = bot.inventory.items().find((i) => i.name === st.input);
        await furn.putFuel(fuel.it.type, null, fuel.n);
        await furn.putInput(inp.type, null, Math.min(batch, inp.count));
        const t0 = Date.now(), limit = 20000 + batch * 11000;
        while (got < batch && !t.cancel && Date.now() - t0 < limit) {
          await sleep(2000);
          if (furn.outputItem()) { const it = await furn.takeOutput(); if (it) got += it.count; }
          t.text = `${st.item} eritiyorum (${done + got}/${total})`;
          if (got < batch && furn.fuel === 0 && !furn.fuelItem() && !furn.outputItem()) break; // ran out of fuel: refuel in the next round
        }
        if (got < batch) { try { if (furn.inputItem()) await furn.takeInput(); } catch (_) {} } // take the rest back
      } catch (e) { log("smelt error:", e.message); }
      finally { try { furn.close(); } catch (_) {} }
      done += got;
      stuck = got > 0 ? 0 : stuck + 1;
    }
    if (done < total && !t.cancel) { say(bot, `${st.item} tam olmadı (${done}/${total}).`); return false; }
    return done >= total;
  }

  // ---------- farming ----------
  async function plantAt(bot, pos, seed) {
    const it = bot.inventory.items().find((i) => i.name === seed);
    if (!it) return false;
    const soil = bot.blockAt(pos.offset(0, -1, 0));
    const here = bot.blockAt(pos);
    if (!soil || soil.name !== "farmland" || (here && here.name !== "air")) return false;
    await bot.equip(it, "hand");
    await bot.placeBlock(soil, new Vec3(0, 1, 0));
    return true;
  }
  const anySeed = (bot) => Object.values(CROPS).map((c) => c.seed).find((s) => bot.inventory.items().some((i) => i.name === s));

  async function farmTask(bot, t) {
    const reg = bot.registry.blocksByName;
    const cropIds = Object.keys(CROPS).map((n) => reg[n]).filter(Boolean).map((b) => b.id);
    let harvested = 0, planted = 0, tilled = 0;
    const bad = new Set();
    const deadline = Date.now() + 5 * 60000;

    // 1. harvest ripe crops and replant
    while (!t.cancel && Date.now() < deadline) {
      const pos = bot.findBlocks({ matching: cropIds, maxDistance: 24, count: 60 })
        .filter((p) => !bad.has(p.toString()))
        .find((p) => { const b = bot.blockAt(p); return b && CROPS[b.name] && cropAge(b) >= CROPS[b.name].max; });
      if (!pos) break;
      t.text = `hasat yapıyorum (${harvested})`;
      try {
        await gotoNear(bot, pos, 3);
        const b = bot.blockAt(pos);
        if (!b || !CROPS[b.name]) { bad.add(pos.toString()); continue; }
        const seed = CROPS[b.name].seed;
        await bot.dig(b, true);
        harvested++;
        await sleep(250);
        await plantAt(bot, pos, seed).catch(() => {});
      } catch (e) { log("harvest error:", e.message); bad.add(pos.toString()); }
    }
    await collectDrops(bot, t, 12, 30);

    // 2. seeds: break grass if we have none
    if (!anySeed(bot) && reg.farmland && !t.cancel) {
      const grass = reg.short_grass ? "short_grass" : "grass";
      t.text = "tohum arıyorum";
      await ctx.mineTask(bot, t, grass, 30, true).catch(() => 0);
      await collectDrops(bot, t, 12, 30);
    }

    // 3. plant on empty farmland
    if (reg.farmland && !t.cancel) {
      const lands = bot.findBlocks({ matching: reg.farmland.id, maxDistance: 20, count: 80 })
        .filter((p) => { const a = bot.blockAt(p.offset(0, 1, 0)); return a && a.name === "air"; });
      for (const p of lands) {
        if (t.cancel) break;
        const seed = anySeed(bot);
        if (!seed) break;
        t.text = `ekiyorum (${planted})`;
        try {
          await gotoNear(bot, p, 3, 10000);
          if (await plantAt(bot, p.offset(0, 1, 0), seed)) planted++;
          await sleep(150);
        } catch (e) { log("plant error:", e.message); }
      }
    }

    // 4. till dirt next to water (needs a hoe and seeds)
    if (!t.cancel && reg.water && anySeed(bot)) {
      let hoe = bot.inventory.items().find((i) => i.name.endsWith("_hoe"));
      if (!hoe && (await ctx.craftItem(bot, t, "wooden_hoe", 1, true))) hoe = bot.inventory.items().find((i) => i.name.endsWith("_hoe"));
      if (hoe) {
        const waters = bot.findBlocks({ matching: reg.water.id, maxDistance: 20, count: 10 });
        const done = new Set();
        outer: for (const w of waters) {
          for (let dx = -4; dx <= 4; dx++) {
            for (let dz = -4; dz <= 4; dz++) {
              if (t.cancel || tilled >= 16 || !anySeed(bot)) break outer;
              const c = w.offset(dx, 0, dz);
              const key = c.toString();
              if (done.has(key)) continue;
              done.add(key);
              const b = bot.blockAt(c), up = bot.blockAt(c.offset(0, 1, 0));
              if (!b || !up || up.name !== "air" || (b.name !== "dirt" && b.name !== "grass_block")) continue;
              try {
                t.text = `toprağı sürüyorum (${tilled})`;
                await gotoNear(bot, c, 3, 8000);
                await bot.equip(hoe, "hand");
                await bot.activateBlock(bot.blockAt(c));
                await sleep(250);
                tilled++;
                if (await plantAt(bot, c.offset(0, 1, 0), anySeed(bot))) planted++;
              } catch (e) { log("till error:", e.message); }
            }
          }
        }
      }
    }
    if (!t.cancel) {
      const parts = [];
      if (harvested) parts.push(`${harvested} ekin hasat ettim`);
      if (tilled) parts.push(`${tilled} yer sürdüm`);
      if (planted) parts.push(`${planted} tane ektim`);
      say(bot, parts.length ? parts.join(", ") + "!" : "Yapacak bir şey bulamadım. Çapa, tohum ve su kenarında toprak lazım.");
    }
  }

  // ---------- fishing ----------
  async function fishTask(bot, t, count) {
    let rod = bot.inventory.items().find((i) => i.name === "fishing_rod");
    if (!rod) {
      if (!(await ctx.craftItem(bot, t, "fishing_rod", 1, false))) return;
      rod = bot.inventory.items().find((i) => i.name === "fishing_rod");
      if (!rod) return;
    }
    const water = bot.findBlock({
      matching: bot.registry.blocksByName.water.id, maxDistance: 24,
      useExtraInfo: (b) => { const up = bot.blockAt(b.position.offset(0, 1, 0)); return up && up.name === "air"; },
    });
    if (!water) { say(bot, "Yakında balık tutacak su yok."); return; }
    await gotoNear(bot, water.position, 4, 30000).catch(() => {});
    await bot.equip(rod, "hand");
    const total = () => bot.inventory.items().reduce((a, i) => a + i.count, 0);
    const before = total();
    for (let i = 0; i < count && !t.cancel; i++) {
      t.text = `balık tutuyorum (${i}/${count})`;
      await bot.lookAt(water.position.offset(0.5, 0.5, 0.5));
      let timer;
      try {
        await Promise.race([bot.fish(), new Promise((_, rej) => { timer = setTimeout(() => rej(new Error("fish timeout")), 60000); })]);
      } catch (e) { try { bot.activateItem(); } catch (_) {} }
      clearTimeout(timer);
      await sleep(500);
    }
    if (!t.cancel) say(bot, `Oltayı ${count} kez attım, ${Math.max(0, total() - before)} şey yakaladım.`);
  }

  // ---------- chests ----------
  async function openNearbyContainer(bot) {
    const ids = ["chest", "trapped_chest", "barrel"].map((n) => bot.registry.blocksByName[n]).filter(Boolean).map((b) => b.id);
    const blk = bot.findBlock({ matching: ids, maxDistance: 24 });
    if (!blk) return null;
    await gotoNear(bot, blk.position, 3, 20000).catch(() => {});
    return bot.openContainer(blk);
  }

  async function storeTask(bot, t, item) {
    const want = ["", "all", "hepsi", "her_sey", "herşey"].includes(norm(item)) ? "" : norm(item);
    const c = await openNearbyContainer(bot);
    if (!c) { say(bot, "Yakında sandık göremiyorum."); return; }
    let moved = 0;
    try {
      const list = bot.inventory.items().filter((i) => (want ? matches(i.name, want) : !KEEP_RE.test(i.name)));
      for (const it of list) {
        if (t.cancel) break;
        try { await c.deposit(it.type, null, it.count); moved += it.count; }
        catch (e) { say(bot, "Sandık dolmuş olabilir."); break; }
      }
    } finally { try { c.close(); } catch (_) {} }
    say(bot, moved ? `${moved} eşyayı sandığa koydum.` : "Koyacak bir şey bulamadım.");
  }

  async function takeTask(bot, t, item, n) {
    const want = norm(item);
    const c = await openNearbyContainer(bot);
    if (!c) { say(bot, "Yakında sandık göremiyorum."); return; }
    let got = 0;
    try {
      for (const it of c.containerItems().filter((i) => matches(i.name, want))) {
        if (got >= n || t.cancel) break;
        const k = Math.min(it.count, n - got);
        try { await c.withdraw(it.type, null, k); got += k; } catch (e) { say(bot, "Envanterim dolu olabilir."); break; }
      }
    } finally { try { c.close(); } catch (_) {} }
    say(bot, got ? `${got} tane ${item || "eşya"} aldım.` : `Sandıkta ${item || "bir şey"} yok.`);
  }

  // ---------- villagers ----------
  async function tradeTask(bot, t, item, count) {
    const vil = bot.nearestEntity((e) => e.name === "villager" && e.position.distanceTo(bot.entity.position) < 40);
    if (!vil) { say(bot, "Yakında köylü yok."); return; }
    await gotoNear(bot, vil.position, 2, 20000).catch(() => {});
    const v = await bot.openVillager(vil);
    try {
      await sleep(600);
      const trades = v.trades || [];
      if (!trades.length) { say(bot, "Bu köylünün takası yok."); return; }
      const fmt = (tr) => `${tr.inputItem1.count} ${tr.inputItem1.name}${tr.inputItem2 ? " + " + tr.inputItem2.count + " " + tr.inputItem2.name : ""} -> ${tr.outputItem.count} ${tr.outputItem.name}`;
      const want = norm(item);
      if (!want) { say(bot, "Takaslar: " + trades.slice(0, 3).map(fmt).join(" | ")); return; }
      const idx = trades.findIndex((tr) => !tr.tradeDisabled && matches(tr.outputItem.name, want));
      if (idx < 0) { say(bot, `Köylüde ${item} takası yok.`); return; }
      const tr = trades[idx];
      const have = (name) => bot.inventory.items().filter((i) => i.name === name).reduce((a, i) => a + i.count, 0);
      let times = Math.min(count || 1, Math.floor(have(tr.inputItem1.name) / tr.inputItem1.count));
      if (tr.inputItem2) times = Math.min(times, Math.floor(have(tr.inputItem2.name) / tr.inputItem2.count));
      if (tr.maximumNbTradeUses) times = Math.min(times, tr.maximumNbTradeUses - (tr.nbTradeUses || 0));
      if (times < 1) { say(bot, `Takas için ${fmt(tr)} lazım, bende yok.`); return; }
      await bot.trade(v, idx, times);
      say(bot, `${times} kere takas yaptım: ${fmt(tr)}`);
    } finally { try { v.close(); } catch (_) {} }
  }

  // ---------- enchanting ----------
  async function enchantTask(bot, t, item) {
    const tb = bot.registry.blocksByName.enchanting_table;
    const blk = tb && bot.findBlock({ matching: tb.id, maxDistance: 24 });
    if (!blk) { say(bot, "Yakında büyü masası yok."); return; }
    const want = norm(item);
    const target = bot.inventory.items().find((i) => (want ? matches(i.name, want) : /(sword|pickaxe|_axe|chestplate|helmet|leggings|boots|^bow)$/.test(i.name)));
    if (!target) { say(bot, "Büyülenecek eşya bende yok."); return; }
    const lapis = bot.inventory.items().find((i) => i.name === "lapis_lazuli");
    if (!lapis) { say(bot, "Lapis lazuli lazım."); return; }
    const lvl = bot.experience ? bot.experience.level : 0;
    if (lvl < 1) { say(bot, "XP seviyem yok."); return; }
    await gotoNear(bot, blk.position, 3, 20000).catch(() => {});
    const table = await bot.openEnchantmentTable(blk);
    try {
      await table.putLapis(lapis);
      const ready = new Promise((res) => table.once("ready", res));
      await table.putTargetItem(target);
      await Promise.race([ready, sleep(4000)]);
      let choice = -1;
      (table.enchantments || []).forEach((en, i) => { if (en && en.level > 0 && en.level <= lvl && lapis.count >= i + 1) choice = i; });
      if (choice < 0) say(bot, `Seviyem (${lvl}) ya da lapis yetmiyor.`);
      else { await table.enchant(choice); await sleep(600); say(bot, "Büyüledim!"); }
      await table.takeTargetItem().catch(() => {});
    } finally { try { table.close(); } catch (_) {} }
  }

  // ---------- riding ----------
  async function rideTask(bot, t, type) {
    const want = norm(type);
    const me = bot.entity.position;
    const e = bot.nearestEntity((x) => x.name && /(boat|raft|horse|donkey|mule|pig|strider|camel|minecart|llama)$/.test(x.name) && (!want || x.name.includes(want)) && x.position.distanceTo(me) < 24);
    if (!e) { say(bot, "Yakında binecek bir şey yok."); return; }
    await gotoNear(bot, e.position, 2, 15000).catch(() => {});
    try { await bot.mount(e); say(bot, `${e.name} üstündeyim!`); }
    catch (err) { say(bot, "Binemedim (eyer gerekebilir)."); }
  }

  return {
    bestWeapon, equipBest, armorTask, collectDrops, pickupTask, huntTask, tunnelTask, digDownTask, exploreFor,
    smeltStep, farmTask, fishTask, storeTask, takeTask, tradeTask, enchantTask, rideTask,
    // exposed for tests
    _t: { dirFromYaw, cropAge, armorRank, matches, SMELT },
  };
};
