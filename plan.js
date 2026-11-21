// Crafting planner. Turns "make a wooden pickaxe" into ordered steps:
//   { kind: "gather", item, count }            -> mine raw blocks
//   { kind: "craft", item, count, times, table } -> craft (table = needs a crafting table)
//   { kind: "unsupported", item }               -> needs smelting etc., the bot cannot do it
// Pure function of minecraft-data + an inventory map, so it can be tested without a server.

// raw item -> block that has to be mined to get it
const GATHER_BLOCK = {
  cobblestone: "stone", cobbled_deepslate: "deepslate", coal: "coal_ore", diamond: "diamond_ore",
  raw_iron: "iron_ore", raw_gold: "gold_ore", raw_copper: "copper_ore", redstone: "redstone_ore",
  lapis_lazuli: "lapis_ore", emerald: "emerald_ore", flint: "gravel", sand: "sand", gravel: "gravel", dirt: "dirt",
  clay_ball: "clay", string: null, leather: null,
};
// these need a furnace (or mobs), the bot does not do that
const UNSUPPORTED = new Set(["iron_ingot", "gold_ingot", "copper_ingot", "glass", "brick", "bricks", "stone", "smooth_stone", "charcoal", "netherite_ingot", "string", "leather", "paper", "book"]);
// treat as raw even though a (reverse) recipe exists
const RAW = new Set(["cobblestone", "coal", "diamond", "redstone", "lapis_lazuli", "emerald", "flint", "sand", "gravel", "dirt", "clay_ball", "raw_iron", "raw_gold", "raw_copper"]);

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

  const recipes = mcData.recipes[item.id];
  if (RAW.has(want) || !recipes || !recipes.length) {
    let block = want in GATHER_BLOCK ? GATHER_BLOCK[want] : want; // logs etc. are mined under their own name
    if (isLog(want)) block = "_log"; // any tree will do
    if (block === null) { steps.push({ kind: "unsupported", item: want }); inv[want] = count; return steps; }
    steps.push({ kind: "gather", item: want, block, count: need });
    inv[want] = (inv[want] || 0) + need;
    return steps;
  }

  // prefer a recipe made only of things we can get (logs → planks → sticks ...)
  const info = recipeInfo(mcData, recipes[0]);
  const times = Math.max(1, Math.ceil(need / info.out));
  for (const [id, c] of Object.entries(info.counts)) {
    const ing = mcData.items[id];
    if (!ing) throw new Error("unknown ingredient " + id);
    planCraft(mcData, ing.name, c * times, inv, steps, depth + 1);
    inv[ing.name] = (inv[ing.name] || 0) - c * times; // consumed
  }
  if (info.table) {
    // need a crafting table: nearby one is fine, otherwise craft one (the executor checks nearby first)
    if (!(inv.crafting_table > 0)) planCraft(mcData, "crafting_table", 1, inv, steps, depth + 1);
  }
  steps.push({ kind: "craft", item: want, count: need, times, table: info.table });
  inv[want] = (inv[want] || 0) + times * info.out;
  return steps;
}

// "pickaxe needed" for mining a block: wooden for stone/coal, stone for iron/copper/lapis, iron for the rest
function toolTierFor(block) {
  const b = String(block || "");
  if (/(gold|diamond|redstone|emerald|obsidian|ancient)/.test(b)) return "iron";
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

module.exports = { planCraft, toolTierFor, tierRank, bestPickaxeRank, isLog, GATHER_BLOCK };
