// Instant body commands in Turkish ("zıpla", "eğil", "arkanı dön", "bana dön", "dönme", "ileri git" ...).
// A small model is slow and sometimes ignores these, so they are matched here and run straight away.
// Messages that also contain a real job ("zıpla sonra 10 odun topla") return null and go to the AI.

const norm = (s) => String(s || "").replace(/[İI]/g, "i").toLowerCase()
  .replace(/ı/g, "i").replace(/ç/g, "c").replace(/ş/g, "s").replace(/ğ/g, "g").replace(/ö/g, "o").replace(/ü/g, "u")
  .replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();

// [regex, build(match, text) -> action, say, ownerOnly]. Order matters: negatives ("dönme", "zıplama") come first.
const RULES = [
  [/\bziplamaya (devam|basla)\w*|\bsurekli zipla\w*|\bziplayip dur\w*|\bziplayarak dur\w*/, () => ({ action: "jumpkeep", item: "on" }), "Zıplıyorum!"],
  [/\bziplama\w*( birak\w*| kes\w*| dur\w*)?/, () => ({ action: "jumpkeep", item: "off" }), "Tamam, zıplamıyorum."],
  [/\b(zipla\w*|atla\w*|hop)\b/, (m, t) => ({ action: "jump", count: num(t, 1, 20) }), ""],
  [/\b(egilme|comelme|kalk\w*|ayaga kalk\w*|dogrul\w*|ayaga dur\w*)\b/, () => ({ action: "uncrouch" }), "Kalktım."],
  [/\b(egil\w*|etil\w*|comel\w*|sneak|shift|otur\w*|cokel\w*)\b/, () => ({ action: "crouch" }), "Eğildim."],
  [/\b(donme\w*|bana bakma\w*|bakma\w*|donmeyi (birak|kes)\w*|bakmayi (birak|kes)\w*)\b/, () => ({ action: "nolook" }), "Tamam, dönmüyorum."],
  [/\b(arkan\w* (don|cevir)\w*|arkaya don\w*|geri don\w*|arka don\w*|sirtini don\w*)\b/, () => ({ action: "turnaround" }), "Arkamı döndüm."],
  [/\b(etrafinda don\w*|donup dur\w*|fir fir\w*|surekli don\w*|kendi etrafinda\w*|spin)\b/, () => ({ action: "spin", item: "on" }), "Dönüyorum!"],
  [/\bsaga (don|cevril|bak)\w*/, () => ({ action: "turn", item: "right" }), ""],
  [/\bsola (don|cevril|bak)\w*/, () => ({ action: "turn", item: "left" }), ""],
  [/\b(yukari\w*|gokyuzune|tavana) bak\w*/, () => ({ action: "lookdir", item: "up" }), ""],
  [/\b(asagi\w*|yere|ayaklarina) bak\w*/, () => ({ action: "lookdir", item: "down" }), ""],
  [/\b(one|ileri|karsiya|duz) bak\w*/, () => ({ action: "lookdir", item: "forward" }), ""],
  [/\b(kuzey|guney|dogu|bati)\w* (yone |tarafina |yonune )?(bak|don)\w*/, (m) => ({ action: "lookdir", item: ({ kuzey: "north", guney: "south", dogu: "east", bati: "west" })[m[1]] }), ""],
  [/\b(bana (dogru )?(don|bak|cevril|yonel|donsene|baksana)\w*|yuzunu (bana|don)\w*|bak bana|bu tarafa don\w*)\b/, () => ({ action: "facelook" }), "Buradayım!"],
  [/\b(ileri|one) (git|yuru|gel)\w*|\bilerle\b/, (m, t) => ({ action: "walk", item: "forward", count: num(t, 2, 10) }), ""],
  [/\b(geri|arkaya) (git|yuru|cekil)\w*|\bgeri cekil\w*/, (m, t) => ({ action: "walk", item: "back", count: num(t, 2, 10) }), ""],
  [/\bsaga (git|yuru|kay)\w*/, (m, t) => ({ action: "walk", item: "right", count: num(t, 2, 10) }), ""],
  [/\bsola (git|yuru|kay)\w*/, (m, t) => ({ action: "walk", item: "left", count: num(t, 2, 10) }), ""],
  [/\b(kos|kosarak|sprint)\b/, (m, t) => ({ action: "walk", item: "sprint", count: num(t, 4, 15) }), ""],
  [/\b(dans\w*|oynasana|sallan\w*)\b/, () => ({ action: "dance" }), "Hadi oynayalım!"],
  [/\b(el sall\w*|selam ver\w*)\b/, () => ({ action: "wave" }), "Selam!"],
  [/\b(envanter\w* (bosalt|dok|at)\w*|hepsini yere at\w*|her seyi yere at\w*)\b/, () => ({ action: "dropall" }), "Hepsini attım.", true],
  [/\b(elindeki\w* (at|birak)\w*|yere at\w*|esyani at\w*|elindekini at\w*)\b/, () => ({ action: "drop" }), "Attım.", true],
  [/\b(yemek ye|bir seyler ye|karnini doyur\w*|ye)\b/, () => ({ action: "eat" }), ""],
  [/\b(neredesin|nerdesin|konumun|koordinat\w*)\b/, () => ({ action: "report", item: "pos" }), ""],
  [/\b(canin kac|kac canin|can durumun|ne kadar cann?in var|saglik\w*)\b/, () => ({ action: "report", item: "health" }), ""],
  [/\b(envanter\w*( ne var)?|cantanda ne var|ne var cantanda|neler var|elinde ne var)\b/, () => ({ action: "report", item: "inv" }), ""],
  [/\bdon(sana|sene)?\b/, () => ({ action: "facelook" }), "Buradayım!"], // plain "dön" = turn towards me
];

const FILLER = new Set(("ceyobot ceyo bot bunu lutfen hadi abi kardes ya be sen bir kere kez defa de da hemen simdi sonra ve tamam ok sana bana beni biraz cok " +
  "yapar misin mi musun lan la dostum reis kanka tekrar yine bi sadece hadisene ozaman o zaman once ondan daha artik saniye sn bak mal dur gel git et yap ol").split(" "));

function num(t, def, max) {
  const m = /(\d+)\s*(?:kere|kez|defa|sn|saniye)?/.exec(t);
  return m ? Math.max(1, Math.min(parseInt(m[1], 10), max)) : def;
}

// returns { actions, say, ownerOnly } or null (not a pure body command)
function parseReflex(msg, botName) {
  let t = " " + norm(msg) + " ";
  if (botName) t = t.replace(new RegExp("\\b" + norm(botName) + "\\b", "g"), " ");
  const full = t;
  const actions = [];
  const says = [];
  let ownerOnly = false;
  for (const [re, build, say, owner] of RULES) {
    const m = re.exec(t);
    if (!m) continue;
    actions.push({ pos: m.index, a: build(m, full) });
    if (say) says.push(say);
    if (owner) ownerOnly = true;
    t = t.slice(0, m.index) + " " + t.slice(m.index + m[0].length);
  }
  if (!actions.length) return null;
  const rest = t.replace(/\d+/g, " ").split(/\s+/).filter((w) => w && !FILLER.has(w));
  if (rest.length) return null; // there is more in the message: let the AI read it
  actions.sort((x, y) => x.pos - y.pos);
  return { actions: actions.map((x) => x.a), say: says[0] || "", ownerOnly };
}

module.exports = { parseReflex, norm };
