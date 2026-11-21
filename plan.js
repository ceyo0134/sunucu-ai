// Crafting planner. Turns "make a wooden pickaxe" into ordered steps:
//   { kind: "gather", item, count }            -> mine raw blocks
//   { kind: "craft", item, count, times, table } -> craft (table = needs a crafting table)
//   { kind: "unsupported", item }               -> needs smelting etc., the bot cannot do it
// Pure function of minecraft-data + an inventory map, so it can be tested without a server.

// raw item -> block that has to be mined to get it
const GATHER_BLOCK = {
  cobblestone: "stone", cobbled_deepslate: "deepslate", coal: "coal_ore", diamond: "diamond_ore",
  raw_iron: "iron_ore", iron_ore: "iron_ore", raw_gold: "gold_ore", gold_ore: "gold_ore", raw_copper: "copper_ore", copper_ore: "copper_ore",
  redstone: "redstone_ore", lapis_lazuli: "lapis_ore", emerald: "emerald_ore", flint: "gravel", sand: "sand", gravel: "gravel", dirt: "dirt",
  clay_ball: "clay", sugar_cane: "sugar_cane", obsidian: "obsidian", quartz: "nether_quartz_ore",
};
// output -> possible inputs of a furnace (first one that exists in this Minecraft version wins)
const SMELT = {
  iron_ingot: ["raw_iron", "iron_ore"], gold_ingot: ["raw_gold", "gold_ore"], copper_ingot: ["raw_copper", "copper_ore"],
  glass: ["sand"], stone: ["cobblestone"], smooth_stone: ["stone"], brick: ["clay_ball"], charcoal: ["oak_log"],
  cooked_beef: ["beef"], cooked_porkchop: ["porkchop"], cooked_chicken: ["chicken"], cooked_mutton: ["mutton"],
  cooked_rabbit: ["rabbit"], cooked_cod: ["cod"], cooked_salmon: ["salmon"], baked_potato: ["potato"], dried_kelp: ["kelp"],
};
// item -> mob that drops it (the bot hunts it)
const HUNT = {
  beef: "cow", leather: "cow", porkchop: "pig", chicken: "chicken", feather: "chicken", mutton: "sheep", white_wool: "sheep",
  rabbit: "rabbit", rabbit_hide: "rabbit", string: "spider", spider_eye: "spider", bone: "skeleton", arrow: "skeleton",
  gunpowder: "creeper", rotten_flesh: "zombie", ender_pearl: "enderman", ink_sac: "squid", slime_ball: "slime",
};
// these need things the bot cannot do (nether, bosses ...)
const UNSUPPORTED = new Set(["netherite_ingot", "netherite_scrap", "ancient_debris", "nether_star", "blaze_rod", "elytra", "totem_of_undying", "trident"]);
// treat as raw even though a (reverse) recipe exists
const RAW = new Set(["cobblestone", "coal", "diamond", "redstone", "lapis_lazuli", "emerald", "flint", "sand", "gravel", "dirt", "clay_ball", "raw_iron", "raw_gold", "raw_copper", "iron_ore", "gold_ore", "copper_ore", "sugar_cane", "obsidian"]);

function isLog(name) { return /_(log|stem)$/.test(name) && !/stripped|wood$/.test(name); }

function recipeInfo(mcData, recipe) {
  const counts = {};
  let cells = 0, rows = 0, cols = 0;
  const add = (id) => {
    if (id === null || id === undefined || id === -1) return;
    if (typeof id === "object") id = id.id !== undefined ? id.id : id[0];
    counts[id] = (counts[id] || 0) + 1;
  };
  if (recipe.inShape) {
    rows = recipe.inShape.length;
    recipe.inShape.forEach((r) => { cols = Math.max(cols, r.length); r.forEach(add); });
  } else if (recipe.ingredients) {
    recipe.ingredients.forEach(add);
    cells = recipe.ingredients.length;
  }
  const table = recipe.inShape ? rows > 2 || cols > 2 : cells > 4;
  const out = recipe.result && recipe.result.count ? recipe.result.count : (typeof recipe.result === "number" ? 1 : 1);
  return { counts, table, out };
}

function planCraft(mcData, want, count, inv, steps = [], depth = 0) {
  if (depth > 8) throw new Error("recipe too deep");
  const item = mcData.itemsByName[want];
  if (!item) throw new Error("unknown item " + want);
  const have = inv[want] || 0;
  if (have >= count) return steps;
  const need = count - have;

  if (UNSUPPORTED.has(want)) { steps.push({ kind: "unsupported", item: want }); inv[want] = count; return steps; }

  if (SMELT[want]) {
    const input = SMELT[want].find((n) => mcData.itemsByName[n]);
    if (input) {
      planCraft(mcData, input, need, inv, steps, depth + 1);
      if (!(inv.furnace > 0)) planCraft(mcData, "furnace", 1, inv, steps, depth + 1);
      steps.push({ kind: "smelt", item: want, input, count: need });
      inv[input] = (inv[input] || 0) - need;
      inv[want] = (inv[want] || 0) + need;
      return steps;
    }
  }
  if (HUNT[want]) {
    steps.push({ kind: "hunt", item: want, mob: HUNT[want], count: need });
    inv[want] = (inv[want] || 0) + need;
    return steps;
  }

  const recipes = mcData.recipes[item.id];
  if (RAW.has(want) || !recipes || !recipes.length) {
    let block = want in GATHER_BLOCK ? GATHER_BLOCK[want] : want; // logs etc. are mined under their own name
    if (isLog(want)) block = "_log"; // any tree will do
    if (block === null) { steps.push({ kind: "unsupported", item: want }); inv[want] = count; return steps; }
    steps.push({ kind: "gather", item: want, block, count: need });
    inv[want] = (inv[want] || 0) + need;
    return steps;
  }

  // try the recipes in order: skip ones that need the item itself (dyeing, recoloring) or that cannot be planned
  let lastErr = null;
  // prefer common materials: oak wood and cobblestone before pale oak, bamboo, deepslate ...
  const cost = (recipe) => {
    let c = 0;
    for (const id of Object.keys(recipeInfo(mcData, recipe).counts)) {
      const n = (mcData.items[id] || {}).name || "";
      if (n === "oak_planks" || n === "oak_log" || n === "cobblestone") continue;
      if (/(pale_oak|crimson|warped|bamboo|mangrove|cherry|cobbled_deepslate|blackstone|stripped|_wood$|_hyphae)/.test(n)) c += 2;
      else if (/_(planks|log|stem)$/.test(n)) c += 1;
    }
    return c;
  };
  const ordered = recipes.map((r, i) => ({ r, i, c: cost(r) })).sort((a, b) => a.c - b.c || a.i - b.i).map((x) => x.r);
  for (const recipe of ordered) {
    const info = recipeInfo(mcData, recipe);
    if (info.counts[item.id]) continue;
    const trySteps = steps.slice(), tryInv = Object.assign({}, inv);
    try {
      const times = Math.max(1, Math.ceil(need / info.out));
      for (const [id, c] of Object.entries(info.counts)) {
        const ing = mcData.items[id];
        if (!ing) throw new Error("unknown ingredient " + id);
        planCraft(mcData, ing.name, c * times, tryInv, trySteps, depth + 1);
        tryInv[ing.name] = (tryInv[ing.name] || 0) - c * times; // consumed
      }
      if (info.table) {
        // need a crafting table: nearby one is fine, otherwise craft one (the executor checks nearby first)
        if (!(tryInv.crafting_table > 0)) planCraft(mcData, "crafting_table", 1, tryInv, trySteps, depth + 1);
      }
      trySteps.push({ kind: "craft", item: want, count: need, times, table: info.table });
      tryInv[want] = (tryInv[want] || 0) + times * info.out;
      steps.length = 0; trySteps.forEach((x) => steps.push(x));
      Object.keys(inv).forEach((k) => delete inv[k]); Object.assign(inv, tryInv);
      return steps;
    } catch (e) { lastErr = e; }
  }
  throw lastErr || new Error("no usable recipe for " + want);
}

// "pickaxe needed" for mining a block: wooden for stone/coal, stone for iron/copper/lapis, iron for the rest
function toolTierFor(block) {
  const b = String(block || "");
  if (/(obsidian|ancient)/.test(b)) return "diamond";
  if (/(gold|diamond|redstone|emerald)/.test(b)) return "iron";
  if (/(iron|copper|lapis)/.test(b)) return "stone";
  if (/(stone|ore|cobble|deepslate|coal|andesite|diorite|granite|netherrack|sandstone|brick)/.test(b)) return "wooden";
  return null;
}
const TIERS = ["wooden", "golden", "stone", "iron", "diamond", "netherite"];
const tierRank = (t) => (t === "golden" ? 0.5 : TIERS.indexOf(t));
function bestPickaxeRank(inv) {
  let best = -1;
  for (const k of Object.keys(inv)) {
    const m = k.match(/^(\w+)_pickaxe$/);
    if (m && inv[k] > 0) best = Math.max(best, tierRank(m[1]));
  }
  return best;
}

// "raw_iron" / "cooked beef" ... -> what comes out of the furnace
function smeltOutputFor(name) {
  if (SMELT[name]) return name;
  return Object.keys(SMELT).find((o) => SMELT[o].includes(name)) || null;
}

module.exports = { planCraft, toolTierFor, tierRank, bestPickaxeRank, isLog, GATHER_BLOCK, SMELT, HUNT, smeltOutputFor };
