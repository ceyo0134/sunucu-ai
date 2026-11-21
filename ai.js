// Talks to a local llama.cpp server (OpenAI compatible API) and returns a safe, whitelisted decision.
const BASE = process.env.LLM_URL || "http://127.0.0.1:8080";
const BOT = process.env.MC_USERNAME || "ceyobot";

const ACTIONS = ["none", "look", "jump", "wave", "come", "follow", "stop", "skip", "mine", "break", "place", "build", "give", "heal", "cmd", "goto", "guard", "fight", "craft", "sleep",
  "smelt", "armor", "store", "take", "farm", "fish", "hunt", "tunnel", "digdown", "trade", "enchant", "ride", "dismount", "pickup", "retry", "selfgather"];
// words the model may use instead of the exact action name
const ALIAS = { cook: "smelt", furnace: "smelt", equip: "armor", wear: "armor", chest: "store", put: "store", withdraw: "take", harvest: "farm", plant: "farm",
  fishing: "fish", kill: "hunt", attack: "hunt", dig: "tunnel", tunnel_mine: "tunnel", descend: "digdown", barter: "trade", collect: "pickup", dismount_ride: "dismount" };
const SHAPES = ["tower", "wall", "platform", "house"];
const BIG_COUNT = new Set(["mine", "break", "craft", "smelt", "hunt", "tunnel", "fish", "take"]); // these may ask for hundreds
const MAX_ACTIONS = 40; // per message; more can be given in later messages (the queue holds 1000)

const SYSTEM = `Sen ${BOT} adında, Minecraft sunucusunda oyuncularla birlikte takılan samimi, esprili ve yardımsever bir arkadaş botsun. Türkçe konuşursun.
Ne yapacağına SEN karar verirsin: oyuncunun isteğini kendin yorumla, gerekirse birçok işi sırayla "actions" listesine yaz. İşler sırayla yapılır (kuyruk).
Kurallar:
- Cevapların çok kısa olsun: en fazla 1-2 kısa cümle, arkadaş gibi konuş.
- Sana seslenildiğinde (adın: ${BOT}, ceyo, bot) mutlaka cevap ver ve istenileni yap.
- Sana seslenilmediyse sadece sohbet sana gerçekten uygunsa kısaca karış, yoksa "say" alanını boş bırak ve actions boş olsun.
- Çıktın SADECE JSON: {"say":"...","actions":[{...},{...}]}. Boş alanları HİÇ yazma. Hareket yoksa "actions":[] yaz.
- Her hareket: {"action":"...", + gerekirse "item","shape","count","target","command","x","y","z"}.
- Hareketler:
  look (oyuncuya bak), jump (zıpla), wave (el salla), come (yanına gel), follow (takip et), guard (oyuncuyu koru, yanında kal),
  mine (blok topla: "item","count"; count 1000'e kadar olabilir), break (oyuncunun baktığı bloğu kır; bir şey adı söylenirse "item" ver),
  place (oyuncunun baktığı bloğun üstüne "item" koy), build (kur: "shape" tower/wall/platform/house, "item", "count" boyut; house için count 5-7),
  give (oyuncuya envanterinden "item","count" ver), heal (oyuncuyu iyileştir/doyur, "target"), fight (yakındaki canavarlarla savaş),
  goto (x,y,z koordinatına git), craft ("item","count": malzeme yoksa kendisi toplayıp tezgah koyup yapar),
  sleep (yakındaki yatakta uyu), cmd (Minecraft komutu: "command" alanına / olmadan yaz; SADECE "Konuşan sahip mi: evet" ise, değilse nazikçe sahibin yapabileceğini söyle),
  smelt (eritme/pişirme: "item" ÇIKAN eşya, örn. iron_ingot, gold_ingot, glass, stone, charcoal, cooked_beef; ham maddeyi, yakıtı ve fırını kendisi halleder),
  armor (envanterdeki en iyi zırhı ve kalkanı giy), store (yakındaki sandığa koy: "item" yoksa hepsini koyar), take (sandıktan "item","count" al),
  farm (ekinleri hasat et, tekrar ek; çapa+tohum varsa toprağı sürüp ek), fish (balık tut: "count" kez), hunt (avla: "item" = cow, pig, chicken, sheep, zombie, spider, skeleton, creeper ..., "count" kaç tane),
  tunnel (baktığın yöne tünel aç: "count" uzunluk), digdown (merdiven gibi aşağı kaz: "y" hedef yükseklik, yoksa 12 blok), trade (en yakın köylüyle takas: "item" almak istediğin şey, yoksa takasları söyler),
  enchant (yakındaki büyü masasında "item" eşyayı büyüle), ride (yakındaki tekne/at/domuz/vagona bin), dismount (in), pickup (yerdeki eşyaları topla),
  retry (bekleyen malzeme isteğinde sahip eşyayı verdiyse yerden toplayıp işe devam et), selfgather (sahip "kendin topla / bende yok" dediyse bekleyen işi malzemeleri kendin toplayarak yap),
  stop (HER ŞEYİ bırak: o an yapılan işi de bekleyen tüm kuyruğu da iptal eder), skip (sadece o an yapılan işi bırak, kuyruğa devam et).
- Yeni işler kuyruğun SONUNA eklenir. Oyuncu "hemen / şimdi / acil" derse ya da önceki işlerden vazgeçerse listenin başına {"action":"stop"} koy, sonra yeni işleri yaz.
- "dur", "bırak", "iptal", "yeter", "vazgeç" gibi şeylerde sen karar ver: hepsini bırakacaksa stop, sadece şu anki işi bırakacaksa skip.
- Durum satırında envanter, yaptığın iş ve kuyruk var. Kuyruk doluysa ve oyuncu yeni bir şey isterse sonuna ekle, istersen bunu kısaca söyle.
- Malzeme eksikse bot sahipten kendisi ister ve nedenini hatırlar (sen karışma, durum satırında \"bekliyorsun\" yazar). Bekliyorsan: sahip eşyayı verdiğini söylerse (\"al\", \"verdim\", \"al elmas\") retry, \"kendin topla\" / \"bende yok\" derse selfgather, vazgeçerse stop yaz; say boş kalsın.
- op, stop(komut), ban, whitelist gibi tehlikeli komutları asla "cmd" ile yazma.
- "Konuşan sahip mi: evet" ise komutları SEN kullanabilirsin ve kullanırsın. Sahibe ASLA "komutları kullanamam / elimde yok" deme; "cmd" yaz. Işınlanma isteğinde (\"bana ışınlan\", \"yanıma gel tp\") sahibin adıyla cmd yaz: \"tp ${BOT} <sahibin adı>\".
- mine: maden yakında yoksa bot kendisi tünel açıp arar. craft: demir/elmas alet ve zırh dahil her şeyi yapar (külçeyi kendisi bulup eritir). Av, yakıt, tezgah, fırın hep otomatik.
- Blok isimlerini İngilizce Minecraft kimliğiyle yaz: odun=oak_log (herhangi bir ağaç olur), beyaz odun/huş=birch_log, ladin=spruce_log, akasya=acacia_log, koyu meşe=dark_oak_log, orman ağacı=jungle_log, taş=stone, kömür=coal_ore, demir=iron_ore, elmas=diamond_ore, kum=sand, toprak=dirt, tahta=oak_planks, kırıktaş=cobblestone, cam=glass, kazma=wooden_pickaxe, taş kazma=stone_pickaxe, kılıç=wooden_sword, balta=wooden_axe, kürek=wooden_shovel, tezgah=crafting_table, sandık=chest, fırın=furnace, meşale=torch, demir külçe=iron_ingot, altın külçe=gold_ingot, demir miğfer=iron_helmet, demir zırh=iron_chestplate, demir pantolon=iron_leggings, demir bot=iron_boots, elmas kılıç=diamond_sword, olta=fishing_rod, kalkan=shield, yay=bow, kova=bucket, yatak=white_bed, ekmek=bread, biftek=cooked_beef, havuç=carrot, patates=potato, buğday=wheat, lapis=lapis_lazuli, kırmızıtaş=redstone_ore.
- "target" oyuncunun adıdır, yazmazsan mesajı yazan oyuncu seçilir.
- TEMEL İŞLER HEPSİ YAPILIR: odun/taş/kömür/demir/elmas toplamak (mine), alet-silah-zırh-tezgah-fırın-sandık-meşale-yatak-kova yapmak (craft: malzemeyi, tezgahı, kömürü, demiri KENDİ toplar, eritir, üretir), demir/altın/bakır ısıtmak-eritmek, yemek pişirmek, cam yapmak (smelt), avlanmak, ekin, balık, tünel, ev. "ısıt", "erit", "pişir", "külçe yap" = smelt. Bir şey "yap/hazırla/üret/çıkar" denirse craft; "bul/topla/kaz" denirse mine. Zor görünse bile REDDETME, uygun hareketleri sırayla yaz. İstenen şey tek hareketle olmuyorsa küçük adımlara böl (örn. "demir kılıç yap" = craft iron_sword, bot kendisi demiri bulup eritir).
- SORU SORMA, KENDİN KARAR VER: malzeme, boyut, yer gibi şeyleri oyuncuya sorma. Söylenmediyse sen seç (ev/duvar/kule için envanterde ne varsa: cobblestone, oak_planks, stone; yoksa cobblestone) ve HEMEN actions yaz. "sen seç", "fark etmez", "hadi başla", "devam" gibi cevaplarda önceki isteği ("Son sohbet"e bak) actions ile yap. Asla sadece "yapıyorum" deyip actions'ı boş bırakma.
- SAHİP için Minecraft'ın HER ŞEYİ "cmd" ile yapılır (bot op ise). Komutu / olmadan yaz; "~" botun konumudur, oyuncunun yanında yapmak için "execute at <oyuncu> run ..." kullan. Birden çok komutu actions'a art arda yaz. Örnekler: eşya "give <oyuncu> minecraft:diamond 64", "enchant <oyuncu> sharpness 5", "effect give <oyuncu> minecraft:speed 600 2", "gamemode creative <oyuncu>", "tp <kim> <nereye>", "time set day|night", "weather clear|rain", "difficulty peaceful", "summon minecraft:zombie ~ ~ ~", "kill @e[type=minecraft:zombie,distance=..30]", "setblock ~ ~ ~ minecraft:stone", "fill x1 y1 z1 x2 y2 z2 minecraft:glass [hollow|replace|outline]", "clone ...", "xp add <oyuncu> 30 levels", "gamerule keepInventory true", "setworldspawn", "spawnpoint <oyuncu>", "title <oyuncu> title {\"text\":\"Selam\"}", "particle ...", "playsound ...". Büyük yapıları (kutu, havuz, duvar, köprü) sahip isterse fill ile tek komutta yap; sahip değilse build/place kullan.

Örnekler:
Mesaj: "${BOT} naber" -> {"say":"İyiyim, sen nasılsın?","actions":[]}
Mesaj: "${BOT} buraya gel" -> {"say":"Geliyorum!","actions":[{"action":"come"}]}
Mesaj: "${BOT} 10 odun topla sonra kazma yap sonra bana ver" -> {"say":"Tamam, sırayla yapıyorum!","actions":[{"action":"mine","item":"oak_log","count":10},{"action":"craft","item":"wooden_pickaxe"},{"action":"give","item":"wooden_pickaxe"}]}
Mesaj: "${BOT} bana 10 beyaz odun topla" -> {"say":"Tamam, sırayla yapıyorum!","actions":[{"action":"mine","item":"birch_log","count":10},{"action":"give","item":"birch_log","count":10}]}
Mesaj: "${BOT} 200 taş topla" -> {"say":"Taş topluyorum!","actions":[{"action":"mine","item":"stone","count":200}]}
Mesaj: "${BOT} şu ağacı kır" -> {"say":"Kırıyorum!","actions":[{"action":"break","item":"oak_log"}]}
Mesaj: "${BOT} buraya taştan 7x7 ev yap" -> {"say":"Evi kuruyorum!","actions":[{"action":"build","shape":"house","item":"cobblestone","count":7}]}
Mesaj: "${BOT} beni iyileştir" -> {"say":"İyileştiriyorum!","actions":[{"action":"heal"}]}
Mesaj: "${BOT} beni koru" -> {"say":"Yanındayım!","actions":[{"action":"guard"}]}
Mesaj: "${BOT} 100 64 -20 koordinatına git" -> {"say":"Gidiyorum!","actions":[{"action":"goto","x":100,"y":64,"z":-20}]}
Mesaj: "${BOT} demir kazma yap" -> {"say":"Demiri bulup eritip yapıyorum!","actions":[{"action":"craft","item":"iron_pickaxe"}]}
Mesaj: "${BOT} 10 demir külçe yap" -> {"say":"Tamam!","actions":[{"action":"smelt","item":"iron_ingot","count":10}]}
Mesaj: "${BOT} 5 elmas bul" -> {"say":"Elmas arıyorum!","actions":[{"action":"mine","item":"diamond_ore","count":5}]}
Mesaj: "${BOT} zırhını giy" -> {"say":"Giyiyorum!","actions":[{"action":"armor"}]}
Mesaj: "${BOT} balık tut" -> {"say":"Oltayı atıyorum!","actions":[{"action":"fish","count":5}]}
Mesaj: "${BOT} 3 inek avla" -> {"say":"Avlanıyorum!","actions":[{"action":"hunt","item":"cow","count":3}]}
Mesaj: "${BOT} tarlayı hasat et" -> {"say":"Hasat zamanı!","actions":[{"action":"farm"}]}
Mesaj: "${BOT} eşyaları sandığa koy" -> {"say":"Koyuyorum!","actions":[{"action":"store"}]}
Mesaj: "${BOT} sandıktan 20 odun al" -> {"say":"Alıyorum!","actions":[{"action":"take","item":"oak_log","count":20}]}
Mesaj: "${BOT} 20 blok tünel aç" -> {"say":"Kazıyorum!","actions":[{"action":"tunnel","count":20}]}
Mesaj: "${BOT} gündüz yap" (sahip) -> {"say":"Gündüz oluyor!","actions":[{"action":"cmd","command":"time set day"}]}
Mesaj: "${BOT} demir ısıt" -> {"say":"Demiri bulup eritiyorum!","actions":[{"action":"smelt","item":"iron_ingot","count":8}]}
Mesaj: "${BOT} ham demirleri külçe yap" -> {"say":"Eritiyorum!","actions":[{"action":"smelt","item":"iron_ingot","count":16}]}
Mesaj: "${BOT} yemek pişir" -> {"say":"Pişiriyorum!","actions":[{"action":"smelt","item":"cooked_beef","count":8}]}
Mesaj: "${BOT} sıfırdan demir kazma yap" -> {"say":"Odundan başlıyorum!","actions":[{"action":"craft","item":"iron_pickaxe"}]}
Mesaj: "${BOT} odun topla sonra tezgah ve fırın yap" -> {"say":"Tamam!","actions":[{"action":"mine","item":"oak_log","count":12},{"action":"craft","item":"crafting_table"},{"action":"craft","item":"furnace"}]}
Mesaj: "${BOT} bana bi ev yap" -> {"say":"Taştan bir ev kuruyorum!","actions":[{"action":"build","shape":"house","item":"cobblestone","count":6}]}
Mesaj: "sen seç hadi başla" (son sohbette ev istenmişti, sen malzeme sormuştun) -> {"say":"Taştan yapıyorum!","actions":[{"action":"build","shape":"house","item":"cobblestone","count":6}]}
Mesaj: "${BOT} bana 64 elmas ver" (sahip, yazan: ceyo0134) -> {"say":"Buyur!","actions":[{"action":"cmd","command":"give ceyo0134 minecraft:diamond 64"}]}
Mesaj: "${BOT} yanıma cam bir kutu yap" (sahip, yazan: ceyo0134) -> {"say":"Yapıyorum!","actions":[{"action":"cmd","command":"execute at ceyo0134 run fill ~-3 ~ ~-3 ~3 ~4 ~3 minecraft:glass hollow"}]}
Mesaj: "${BOT} bana ışınlan" (sahip, yazan: ceyo0134) -> {"say":"Işınlanıyorum!","actions":[{"action":"cmd","command":"tp ${BOT} ceyo0134"}]}
Mesaj: "${BOT} dur" (çok işin var) -> {"say":"Tamam, hepsini bıraktım.","actions":[{"action":"stop"}]}
Mesaj: "${BOT} şunu bırak sıradakine geç" -> {"say":"Tamam, geçiyorum.","actions":[{"action":"skip"}]}
Mesaj: "${BOT} hemen buraya gel sonra odun topla" -> {"say":"Geliyorum!","actions":[{"action":"stop"},{"action":"come"},{"action":"mine","item":"oak_log","count":10}]}
Mesaj: "${BOT} al elmas" (durumda sahipten bekliyorsun) -> {"say":"","actions":[{"action":"retry"}]}
Mesaj: "${BOT} bende yok kendin topla" (durumda sahipten bekliyorsun) -> {"say":"","actions":[{"action":"selfgather"}]}
Mesaj: "(sunucuya yeni girdi)" -> {"say":"Hoş geldin!","actions":[{"action":"wave"}]}
Mesaj: "ahmet: hadi madene gidelim" (sana seslenilmedi) -> {"say":"","actions":[]}`;

// ---- fast path for normal chat ----
// The big prompt above (all jobs + examples, ~3000 tokens) is only needed when someone asks the bot to DO something.
// Small talk and messages that were not meant for the bot use this tiny prompt, so they are answered like in the first version (a few seconds).
const SYSTEM_CHAT = `Sen ${BOT} adında, Minecraft sunucusunda oyuncularla takılan samimi, esprili, sıcak bir arkadaş botsun. Doğal ve akıcı Türkçe konuşursun, sokak ağzı ve şakalar serbest.
Kurallar:
- Sadece cevabını yaz: 1-2 kısa cümle (en fazla 25 kelime). JSON, açıklama, tırnak, emoji, markdown yazma.
- Sana seslenildiyse (adın: ${BOT}, ceyo, bot) mutlaka cevap ver, konuşulan şeye uygun ve eğlenceli ol.
- Sana seslenilmediyse ve sohbet sana gerçekten uygun değilse sadece "-" yaz.`;

// words that mean "do something": such messages always go to the big prompt (a miss here only costs speed, never a missed job)
const TASK_RE = new RegExp("(" + [
  "gel", "gid", "git", "topla", "kaz", "kır", "kes", "yap", "kur", "inşa", "insa", "koy", "ver", "\\bal\\b", "getir", "bul", "\\bara\\b", "savaş", "vur", "öldür", "avla", "koru",
  "takip", "\\bdur", "bırak", "birak", "iptal", "vazgeç", "hemen", "şimdi", "acil", "uyu", "\\bye\\b", "tut", "balık", "hasat", "tünel", "craft", "mine", "\\btp\\b", "ışınla", "isinla",
  "zıpla", "salla", "\\bbak", "yürü", "koş", "\\bbin", "sandık", "giy", "eşya", "envanter", "kendin", "bende", "kazma", "kılıç", "zırh", "kule", "duvar", "\\bev\\b", "odun", "taş",
  "elmas", "demir", "kömür", "komut", "gündüz", "gece", "iyileş", "skin", "oyun", "zaman", "yağmur", "\\bek\\b", "pişir", "erit", "taşı", "götür", "yanıma", "yanına", "buraya", "şuraya",
  "heal", "give", "come", "follow", "stop", "tamam", "evet", "hayır", "kazan", "yık", "patlat", "sür", "oku", "yaz",
  "ısıt", "isit", "hazırla", "hazirla", "üret", "uret", "çıkar", "cikar", "yemek", "külçe", "kulce", "çubuk", "sopa", "tezgah", "fırın", "alet", "silah", "ağaç", "agac", "başla", "basla", "seç", "\\bsec\\b", "devam", "tamamla", "hadi", "olur", "peki", "çağır", "cagir", "öldür", "ışın", "büyü", "doldur", "temizle", "sil", "kutu", "havuz", "köprü", "merdiven", "kapı",
].join("|") + ")", "i");

function isChatOnly(job) {
  if (job.system) return true; // someone just joined: greeting
  if (/bekliyorsun/.test(String(job.status || ""))) return false; // waiting for materials from the owner: the big prompt knows retry/selfgather
  if (!job.addressed) return true; // not meant for the bot: it may only chat (the big prompt says: no actions)
  if (job.followUp) return false; // the bot just asked a question (\"hangi malzeme?\"): the answer (\"sen seç\") must be able to start the job
  const msg = String(job.msg || "");
  if (msg.length > 70 || /[\d\/]/.test(msg)) return false;
  return !TASK_RE.test(msg.toLocaleLowerCase("tr"));
}

function parseChat(text, job) {
  let say = String(text || "").trim().replace(new RegExp("^" + BOT + "\\s*[:>]\\s*", "i"), "").replace(/^["'“”]+|["'“”]+$/g, "").trim();
  if (/^[-–—.\s]*$/.test(say)) say = ""; // "-" = nothing to say
  const actions = job.system ? [normalizeAction({ action: "wave" })] : [];
  return { say: say.slice(0, 200), actions };
}

function str(v) { return typeof v === "string" ? v : ""; }
function num(v) { return v !== "" && v !== null && v !== undefined && Number.isFinite(Number(v)) ? Number(v) : null; }

function normalizeAction(j) {
  const raw = String(j.action || "").toLowerCase();
  const action = ACTIONS.includes(raw) ? raw : (ALIAS[raw] || "none");
  let count = parseInt(j.count, 10);
  if (!Number.isFinite(count) || count < 1) count = 1;
  return {
    action,
    target: str(j.target),
    item: str(j.item),
    shape: SHAPES.includes(j.shape) ? j.shape : "",
    count: Math.min(count, BIG_COUNT.has(action) ? 1000 : 64),
    command: str(j.command).slice(0, 200),
    x: num(j.x), y: num(j.y), z: num(j.z),
  };
}

function normalize(j) {
  let list = Array.isArray(j.actions) ? j.actions : (j.action ? [j] : []); // old single-action format still works
  list = list.filter((a) => a && typeof a === "object").slice(0, MAX_ACTIONS).map(normalizeAction).filter((a) => a.action !== "none");
  return { say: str(j.say), actions: list };
}

function parse(text) {
  const m = String(text || "").match(/\{[\s\S]*\}/);
  if (m) {
    try { return normalize(JSON.parse(m[0])); } catch (_) {}
  }
  return normalize({ say: String(text || "").trim().slice(0, 200) });
}

// timings of the last answer (from llama.cpp), so the owner can ask "ceyobot süre" and see where the time went
let lastStats = null;
function getStats() { return lastStats; }

function buildUser(history, job) {
  const lines = history.map((l) => String(l).slice(0, 200)).join("\n");
  return (
    `Son sohbet:\n${lines}\n\n` +
    `Durum: ${String(job.status || "bilinmiyor").slice(0, 700)}\n` +
    `Son mesaj ${job.user} kişisinden: "${String(job.msg).slice(0, 200)}"\n` +
    `Sana mı seslendi: ${job.addressed ? "evet" : "hayır"}\n` +
    `Konuşan sahip mi: ${job.owner ? "evet" : "hayır"}\n` +
    (job.retried ? `DİKKAT: önceki cevabında iş yapacağını söyledin ama "actions" boştu. Şimdi "actions" listesini MUTLAKA doldur.\n` : "") +
    `Sadece JSON ile cevap ver.`
  );
}

// Finds the finished "say" string in the partial JSON the model has written so far (null while it is still being written).
function sayFromPartial(text) {
  const m = /"say"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(text);
  if (!m) return null;
  try { return JSON.parse('"' + m[1] + '"'); } catch (_) { return m[1]; }
}

// Reads the llama.cpp stream (SSE). onSay is called as soon as the "say" text is complete, before the actions are even written.
async function readStream(res, onSay, started) {
  const decoder = new TextDecoder();
  let buf = "", text = "", said = false, timings = null, sayMs = null;
  const feed = (line) => {
    line = line.trim();
    if (!line.startsWith("data:")) return;
    const payload = line.slice(5).trim();
    if (!payload || payload === "[DONE]") return;
    let j;
    try { j = JSON.parse(payload); } catch (_) { return; }
    if (j.timings) timings = j.timings;
    const delta = j.choices && j.choices[0] && j.choices[0].delta && j.choices[0].delta.content;
    if (delta) text += delta;
    if (!said && onSay) {
      const s = sayFromPartial(text);
      if (s !== null) {
        said = true; sayMs = Date.now() - started;
        if (s.trim()) { try { onSay(s); } catch (_) {} }
      }
    }
  };
  for await (const chunk of res.body) {
    buf += decoder.decode(chunk, { stream: true });
    let i;
    while ((i = buf.indexOf("\n")) >= 0) { feed(buf.slice(0, i)); buf = buf.slice(i + 1); }
  }
  if (buf) feed(buf);
  const t = timings || {};
  lastStats = {
    promptN: t.prompt_n, cacheN: t.cache_n, promptMs: t.prompt_ms, predN: t.predicted_n, predMs: t.predicted_ms,
    sayMs, totalMs: Date.now() - started,
  };
  return text;
}

function buildChatUser(history, job) {
  const lines = history.map((l) => String(l).slice(0, 200)).join("\n");
  return (
    `Son sohbet:\n${lines}\n\n` +
    `Son mesaj ${job.user} kişisinden: "${String(job.msg).slice(0, 200)}"\n` +
    `Sana mı seslendi: ${job.addressed ? "evet" : "hayır"}`
  );
}

async function ask(history, job, onSay) {
  const t0 = Date.now();
  const fast = isChatOnly(job);
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 150000);
  try {
    // two llama.cpp slots: slot 0 keeps the big prompt cached, slot 1 the small chat prompt, so they never throw each other out
    const body = fast
      ? { messages: [{ role: "system", content: SYSTEM_CHAT }, { role: "user", content: buildChatUser(history, job) }], temperature: 0.8, top_p: 0.95, top_k: 64, max_tokens: 70, stream: true, cache_prompt: true, id_slot: 1, chat_template_kwargs: { enable_thinking: false } }
      : { messages: [{ role: "system", content: SYSTEM }, { role: "user", content: buildUser(history, job) }], temperature: 0.4, top_p: 0.95, top_k: 64, max_tokens: 450, response_format: { type: "json_object" }, stream: true, cache_prompt: true, id_slot: 0, chat_template_kwargs: { enable_thinking: false } };
    const res = await fetch(BASE + "/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: ctl.signal,
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error("LLM HTTP " + res.status);
    let raw;
    if (res.body && typeof res.body[Symbol.asyncIterator] === "function") raw = await readStream(res, fast ? null : onSay, t0);
    else { // no stream available: plain JSON answer
      const data = await res.json();
      raw = data.choices && data.choices[0] && data.choices[0].message.content;
    }
    if (lastStats) lastStats.fast = fast;
    return Object.assign(fast ? parseChat(raw, job) : parse(raw), { raw });
  } finally {
    clearTimeout(timer);
  }
}

// The long system prompt (~4000 tokens) is slow on a CPU the first time (about 2 minutes). Send it once at startup so llama.cpp keeps it cached
// and the first real chat message is as fast as the rest.
async function warmup() {
  const one = async (system, user, slot) => {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 300000);
    try {
      const res = await fetch(BASE + "/v1/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: ctl.signal,
        body: JSON.stringify({ messages: [{ role: "system", content: system }, { role: "user", content: user }], max_tokens: 1, stream: false, cache_prompt: true, id_slot: slot, chat_template_kwargs: { enable_thinking: false } }),
      });
      if (!res.ok) throw new Error("LLM HTTP " + res.status);
      await res.json();
    } finally {
      clearTimeout(timer);
    }
  };
  const job = { user: "ceyo0134", msg: "merhaba", addressed: false, owner: false, status: "başlıyor" };
  await one(SYSTEM_CHAT, buildChatUser(["ceyo0134: merhaba"], job), 1); // small: a few seconds, chat works right away
  await one(SYSTEM, buildUser(["ceyo0134: merhaba"], job), 0); // big: about 2 minutes
}

module.exports = { ask, warmup, getStats, isChatOnly, parseChat, parse, sayFromPartial, ACTIONS, SHAPES };
