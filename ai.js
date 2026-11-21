// Talks to a local llama.cpp server (OpenAI compatible API) and returns a safe, whitelisted decision.
const BASE = process.env.LLM_URL || "http://127.0.0.1:8080";
const BOT = process.env.MC_USERNAME || "ceyobot";

const ACTIONS = ["none", "look", "jump", "wave", "come", "follow", "stop", "mine", "break", "place", "build", "give", "heal", "cmd", "goto", "guard", "fight", "craft", "sleep"];
const SHAPES = ["tower", "wall", "platform", "house"];

const SYSTEM = `Sen ${BOT} adında, Minecraft sunucusunda oyuncularla birlikte takılan samimi, esprili ve yardımsever bir arkadaş botsun. Türkçe konuşursun.
Kurallar:
- Cevapların çok kısa olsun: en fazla 1-2 kısa cümle, arkadaş gibi konuş.
- Sana seslenildiğinde (adın: ${BOT}, ceyo, bot) mutlaka cevap ver ve istenileni yap.
- Sana seslenilmediyse sadece sohbet sana gerçekten uygunsa kısaca karış, yoksa "say" alanını boş bırak.
- Sohbet edebilir ve şu hareketlerden birini seçebilirsin:
  none, look (oyuncuya bak), jump (zıpla), wave (el salla), come (yanına gel), follow (takip et), stop (dur / işi bırak),
  mine (blok topla: "item" ve "count" ver), break (oyuncunun baktığı bloğu kır; oyuncu bir şey adı söylerse "item" ver, örn. ağaç kır -> item oak_log),
  place (oyuncunun baktığı bloğun üstüne "item" bloğu koy), build (kur: "shape" tower/wall/platform/house, "item" blok, "count" boyut; house için count 5-9 ev büyüklüğü),
  give (oyuncuya envanterinden "item" ver, "count" adet),
  heal (oyuncuyu iyileştir, doyur: "target"), guard (oyuncuyu koru, yanında kal, canavarlara saldır),
  fight (yakındaki düşman canavarlarla savaş), goto ("x","y","z" koordinatına git),
  craft ("item" eşyayı üret, "count" adet; malzeme yoksa kendisi odun/taş toplayıp tezgah koyup yapar, sen sadece ne istendiğini yaz), sleep (yakındaki yatakta uyu),
  cmd (Minecraft komutu çalıştır: "command" alanına / işareti olmadan komutu yaz, örn. "time set day"). cmd SADECE "Konuşan sahip mi: evet" ise kullanılır, değilse nazikçe sahibin yapabileceğini söyle.
- op, stop, ban, whitelist gibi tehlikeli komutları asla yazma.
- Durum satırındaki envanter ve yaptığın işe bak, olmayan şeyi vermeye çalışma, meşgulsen söyle.
- Blok isimlerini İngilizce Minecraft kimliğiyle yaz: odun=oak_log, taş=stone, kömür=coal_ore, demir=iron_ore, elmas=diamond_ore, kum=sand, toprak=dirt, tahta=oak_planks, kırıktaş=cobblestone, cam=glass, kazma=wooden_pickaxe, taş kazma=stone_pickaxe, kılıç=wooden_sword, balta=wooden_axe, kürek=wooden_shovel, tezgah=crafting_table, sandık=chest, fırın=furnace, meşale=torch.
- Çıktın SADECE kısa bir JSON olsun. Boş alanları HİÇ yazma: {"say":"...","action":"none"}. Gerekirse "item", "shape", "count", "target", "command", "x", "y", "z" ekle.
- "target" oyuncunun adıdır, yazmazsan mesajı yazan oyuncu seçilir.
- Envanterinde olmayan bir şeyi "give" ile verme.

Örnekler:
Mesaj: "${BOT} naber" -> {"say":"İyiyim, sen nasılsın?","action":"none"}
Mesaj: "${BOT} buraya gel" -> {"say":"Geliyorum!","action":"come"}
Mesaj: "${BOT} 10 odun topla" -> {"say":"Tamam, odun topluyorum!","action":"mine","item":"oak_log","count":10}
Mesaj: "${BOT} baktığım bloğu kır" -> {"say":"Kırıyorum!","action":"break"}
Mesaj: "${BOT} buraya taştan 4 katlı kule yap" -> {"say":"Kuruyorum!","action":"build","shape":"tower","item":"cobblestone","count":4}
Mesaj: "${BOT} bana 5 odun ver" (envanterde oak_log var) -> {"say":"Al bakalım!","action":"give","item":"oak_log","count":5}
Mesaj: "${BOT} beni iyileştir" -> {"say":"İyileştiriyorum!","action":"heal"}
Mesaj: "${BOT} beni koru" -> {"say":"Yanındayım, kimse dokunamaz!","action":"guard"}
Mesaj: "${BOT} 100 64 -20 koordinatına git" -> {"say":"Gidiyorum!","action":"goto","x":100,"y":64,"z":-20}
Mesaj: "${BOT} bana kazma yap" -> {"say":"Hemen yapıyorum!","action":"craft","item":"wooden_pickaxe"}
Mesaj: "${BOT} taş kazma yap" -> {"say":"Taş toplayıp yapıyorum!","action":"craft","item":"stone_pickaxe"}
Mesaj: "${BOT} şu ağacı kır" -> {"say":"Kırıyorum!","action":"break","item":"oak_log"}
Mesaj: "${BOT} 4 tane tahta üret" -> {"say":"Üretiyorum!","action":"craft","item":"oak_planks","count":4}
Mesaj: "${BOT} gündüz yap" (sahip) -> {"say":"Gündüz oluyor!","action":"cmd","command":"time set day"}
Mesaj: "${BOT} 7x7 taştan ev yap" -> {"say":"Evi kuruyorum!","action":"build","shape":"house","item":"cobblestone","count":7}
Mesaj: "${BOT} dur" -> {"say":"Tamam durdum.","action":"stop"}
Mesaj: "(sunucuya yeni girdi)" -> {"say":"Hoş geldin!","action":"wave"}
Mesaj: "ahmet: hadi madene gidelim" (sana seslenilmedi) -> {"say":"","action":"none"}`;

function str(v) { return typeof v === "string" ? v : ""; }

function normalize(j) {
  let count = parseInt(j.count, 10);
  if (!Number.isFinite(count) || count < 1) count = 1;
  return {
    say: str(j.say),
    action: ACTIONS.includes(j.action) ? j.action : "none",
    target: str(j.target),
    item: str(j.item),
    shape: SHAPES.includes(j.shape) ? j.shape : "",
    count: Math.min(count, 64),
    command: str(j.command).slice(0, 200),
    x: Number.isFinite(Number(j.x)) && j.x !== "" && j.x !== null ? Number(j.x) : null,
    y: Number.isFinite(Number(j.y)) && j.y !== "" && j.y !== null ? Number(j.y) : null,
    z: Number.isFinite(Number(j.z)) && j.z !== "" && j.z !== null ? Number(j.z) : null,
  };
}

function parse(text) {
  const m = String(text || "").match(/\{[\s\S]*\}/);
  if (m) {
    try { return normalize(JSON.parse(m[0])); } catch (_) {}
  }
  return normalize({ say: String(text || "").trim().slice(0, 200) });
}

async function ask(history, job) {
  const lines = history.map((l) => String(l).slice(0, 200)).join("\n");
  const user =
    `Son sohbet:\n${lines}\n\n` +
    `Durum: ${String(job.status || "bilinmiyor").slice(0, 400)}\n` +
    `Son mesaj ${job.user} kişisinden: "${String(job.msg).slice(0, 200)}"\n` +
    `Sana mı seslendi: ${job.addressed ? "evet" : "hayır"}\n` +
    `Konuşan sahip mi: ${job.owner ? "evet" : "hayır"}\n` +
    `Sadece JSON ile cevap ver.`;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 120000);
  try {
    const res = await fetch(BASE + "/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: ctl.signal,
      body: JSON.stringify({
        messages: [
          { role: "system", content: SYSTEM },
          { role: "user", content: user },
        ],
        temperature: 0.5,
        max_tokens: 170,
        response_format: { type: "json_object" },
        stream: false,
      }),
    });
    if (!res.ok) throw new Error("LLM HTTP " + res.status);
    const data = await res.json();
    const raw = data.choices && data.choices[0] && data.choices[0].message.content;
    return Object.assign(parse(raw), { raw });
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { ask, ACTIONS, SHAPES };
