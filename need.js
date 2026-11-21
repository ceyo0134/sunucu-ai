// "Missing materials -> ask the owner" helpers. Pure functions, no Minecraft needed (tested in unit.js).

// Cheap basics the bot just gathers itself without bothering the owner (ASK_ALL=1 asks for these too).
const CHEAP = new Set(["oak_log", "cobblestone", "dirt", "sand", "gravel", "coal"]);

const TR = {
  diamond: "elmas", iron_ingot: "demir külçe", raw_iron: "ham demir", iron_ore: "demir cevheri", gold_ingot: "altın külçe",
  raw_gold: "ham altın", copper_ingot: "bakır külçe", raw_copper: "ham bakır", coal: "kömür", redstone: "kırmızıtaş",
  lapis_lazuli: "lapis", emerald: "zümrüt", string: "ip", leather: "deri", feather: "tüy", bone: "kemik", gunpowder: "barut",
  obsidian: "obsidyen", ender_pearl: "ender incisi", white_wool: "yün", beef: "çiğ et", cooked_beef: "biftek", porkchop: "çiğ domuz eti",
  cobblestone: "kırıktaş", oak_log: "odun", sand: "kum", glass: "cam", stick: "çubuk", blaze_rod: "alev çubuğu",
};
const TIER = { wooden: "tahta", stone: "taş", iron: "demir", golden: "altın", diamond: "elmas", netherite: "netherit", leather: "deri", chainmail: "zincir" };
const TOOL = { pickaxe: "kazma", axe: "balta", sword: "kılıç", shovel: "kürek", hoe: "çapa", helmet: "miğfer", chestplate: "zırh", leggings: "pantolon", boots: "bot" };

function trItem(name) {
  name = String(name || "");
  if (TR[name]) return TR[name];
  const m = name.match(/^([a-z]+)_(pickaxe|axe|sword|shovel|hoe|helmet|chestplate|leggings|boots)$/);
  if (m && TIER[m[1]]) return `${TIER[m[1]]} ${TOOL[m[2]]}`;
  return name.replace(/_/g, " ");
}

// Which materials would the plan have to collect (gather / hunt / unsupported)? -> { item: count }.
// A raw ore that gets smelted is asked for as the finished ingot (iron_ingot instead of raw_iron).
function missingFor(steps, askAll) {
  const miss = {};
  const smelted = {};
  for (const s of steps) if (s.kind === "smelt") smelted[s.input] = s.item;
  for (const s of steps) {
    if (s.kind === "gather" || s.kind === "hunt") {
      if (!askAll && s.kind === "gather" && CHEAP.has(s.item)) continue;
      const name = smelted[s.item] || s.item;
      miss[name] = (miss[name] || 0) + s.count;
    } else if (s.kind === "unsupported") {
      miss[s.item] = Math.max(miss[s.item] || 0, 1);
    }
  }
  return miss;
}

// Chat line (max 200 chars, Minecraft chat limit used by the bot)
function askText(miss, forItem) {
  const list = Object.entries(miss).slice(0, 5).map(([k, v]) => `${v > 1 ? v + " " : ""}${trItem(k)}`).join(", ");
  const head = forItem ? trItem(forItem).charAt(0).toLocaleUpperCase("tr") + trItem(forItem).slice(1) + " için " : "";
  return `${head}${list} lazım, bende yok. Bana verir misin? Vermezsen "kendin topla" de.`.slice(0, 200);
}

// What did the owner say while we are waiting?  "self" = gather it yourself, "gave" = I gave it, "cancel" = forget it
const SELF_RE = /kendin\s*(topla|bul|kaz|hallet|çıkar|yap|al|git)|sen\s+topla|bende\s+(de\s+|hiç\s+)?yok|veremem|vermiyorum|vermeyeceğim/i;
const CANCEL_RE = /(^|[\s,!.:])(boşver|vazgeç|vazgeçtim|iptal|gerek yok|kalsın)(?=$|[\s,!.?:])/i;
const GAVE_RE = /(^|[\s,!.:])(al|aldın|alsana|buyur|verdim|attım|bıraktım|hadi al|al bakalım|yere attım)(?=$|[\s,!.?:])/i;
function classifyReply(msg) {
  const m = String(msg || "");
  if (m.length > 80) return null;
  if (SELF_RE.test(m)) return "self";
  if (CANCEL_RE.test(m)) return "cancel";
  if (GAVE_RE.test(m)) return "gave";
  return null;
}

// Did any of the wanted items increase since we asked?
function gotSome(have, items, snapshot) {
  const sum = Object.keys(items).reduce((a, k) => a + (have[k] || 0), 0);
  return { sum, more: sum > snapshot };
}

module.exports = { CHEAP, trItem, missingFor, askText, classifyReply, gotSome };
