// Talks to a local llama.cpp server (OpenAI compatible API) and returns a safe, whitelisted decision.
const BASE = process.env.LLM_URL || "http://127.0.0.1:8080";
const BOT = process.env.MC_USERNAME || "ceyobot";

const ACTIONS = ["none", "look", "jump", "wave", "come", "follow", "stop"];

const SYSTEM = `Sen ${BOT} adında, Minecraft sunucusunda yaşayan samimi, esprili bir yapay zeka botusun. Türkçe konuşursun.
Kurallar:
- Cevapların çok kısa olsun: en fazla 1-2 kısa cümle.
- Sana seslenildiğinde (adın: ${BOT}, ceyo, bot) mutlaka cevap ver.
- Sana seslenilmediyse sadece sohbet sana gerçekten uygunsa kısaca karış, yoksa "say" alanını boş bırak.
- Komut çalıştıramazsın, sadece sohbet edebilir ve şu hareketlerden birini seçebilirsin: none, look (oyuncuya bak), jump (zıpla), wave (el salla), come (oyuncunun yanına gel), follow (oyuncuyu takip et), stop (dur).
- Çıktın SADECE şu JSON olsun: {"say":"...","action":"none","target":""}
- "target" hareketin yöneleceği oyuncunun adıdır, boşsa mesajı yazan oyuncu seçilir.

Örnekler:
Mesaj: "${BOT} naber" -> {"say":"İyiyim, sen nasılsın?","action":"none","target":""}
Mesaj: "${BOT} buraya gel" -> {"say":"Geliyorum!","action":"come","target":""}
Mesaj: "${BOT} zıpla" -> {"say":"Hop!","action":"jump","target":""}
Mesaj: "ahmet: hadi madene gidelim" (sana seslenilmedi) -> {"say":"","action":"none","target":""}`;

function parse(text) {
  const m = String(text || "").match(/\{[\s\S]*\}/);
  if (m) {
    try {
      const j = JSON.parse(m[0]);
      return {
        say: typeof j.say === "string" ? j.say : "",
        action: ACTIONS.includes(j.action) ? j.action : "none",
        target: typeof j.target === "string" ? j.target : "",
      };
    } catch (_) {}
  }
  return { say: String(text || "").trim().slice(0, 200), action: "none", target: "" };
}

async function ask(history, job) {
  const lines = history.map((l) => String(l).slice(0, 200)).join("\n");
  const user =
    `Son sohbet:\n${lines}\n\n` +
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
        temperature: 0.6,
        max_tokens: 120,
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

module.exports = { ask, ACTIONS };
