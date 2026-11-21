// Talks to a local llama.cpp server (OpenAI compatible API) and returns a safe, whitelisted decision.
const BASE = process.env.LLM_URL || "http://127.0.0.1:8080";
const BOT = process.env.MC_USERNAME || "ceyobot";

const ACTIONS = ["none", "look", "jump", "wave", "come", "follow", "stop", "mine", "break", "place", "build", "give"];
const SHAPES = ["tower", "wall", "platform", "house"];

const SYSTEM = `Sen ${BOT} adında, Minecraft sunucusunda oyuncularla birlikte takılan samimi, esprili ve yardımsever bir arkadaş botsun. Türkçe konuşursun.
Kurallar:
- Cevapların çok kısa olsun: en fazla 1-2 kısa cümle, arkadaş gibi konuş.
- Sana seslenildiğinde (adın: ${BOT}, ceyo, bot) mutlaka cevap ver ve istenileni yap.
- Sana seslenilmediyse sadece sohbet sana gerçekten uygunsa kısaca karış, yoksa "say" alanını boş bırak.
- Komut yazamazsın. Sadece sohbet edebilir ve şu hareketlerden birini seçebilirsin:
  none, look (oyuncuya bak), jump (zıpla), wave (el salla), come (yanına gel), follow (takip et), stop (dur / işi bırak),
  mine (blok topla: "item" ve "count" ver), break (oyuncunun baktığı bloğu kır),
  place (oyuncunun baktığı bloğun üstüne "item" bloğu koy), build (kur: "shape" tower/wall/platform/house, "item" blok, "count" boyut),
  give (oyuncuya envanterinden "item" ver, "count" adet).
- Durum satırındaki envanter ve yaptığın işe bak, olmayan şeyi vermeye çalışma, meşgulsen söyle.
- Blok isimlerini İngilizce Minecraft kimliğiyle yaz: odun=oak_log, taş=stone, kömür=coal_ore, demir=iron_ore, elmas=diamond_ore, kum=sand, toprak=dirt, tahta=oak_planks, kırıktaş=cobblestone, cam=glass.
- Çıktın SADECE şu JSON olsun: {"say":"...","action":"none","target":"","item":"","shape":"","count":1}
- "target" oyuncunun adıdır, boşsa mesajı yazan oyuncu seçilir.

Örnekler:
Mesaj: "${BOT} naber" -> {"say":"İyiyim, sen nasılsın?","action":"none","target":"","item":"","shape":"","count":1}
Mesaj: "${BOT} buraya gel" -> {"say":"Geliyorum!","action":"come","target":"","item":"","shape":"","count":1}
Mesaj: "${BOT} 10 odun topla" -> {"say":"Tamam, odun topluyorum!","action":"mine","target":"","item":"oak_log","shape":"","count":10}
Mesaj: "${BOT} baktığım bloğu kır" -> {"say":"Kırıyorum!","action":"break","target":"","item":"","shape":"","count":1}
Mesaj: "${BOT} buraya taştan 4 katlı kule yap" -> {"say":"Kuruyorum!","action":"build","target":"","item":"cobblestone","shape":"tower","count":4}
Mesaj: "${BOT} bana 5 elmas ver" -> {"say":"Al bakalım!","action":"give","target":"","item":"diamond","shape":"","count":5}
Mesaj: "${BOT} dur" -> {"say":"Tamam durdum.","action":"stop","target":"","item":"","shape":"","count":1}
Mesaj: "(sunucuya yeni girdi)" -> {"say":"Hoş geldin!","action":"wave","target":"","item":"","shape":"","count":1}
Mesaj: "ahmet: hadi madene gidelim" (sana seslenilmedi) -> {"say":"","action":"none","target":"","item":"","shape":"","count":1}`;

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
        max_tokens: 150,
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
