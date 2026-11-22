// Quick connection check: SRV lookup, server list ping, and a short join attempt. Prints what the server answers.
const dns = require("dns").promises;
const mc = require("minecraft-protocol");
const mineflayer = require("mineflayer");
const HOST = process.env.MC_HOST || "ceyo0134.aternos.me";
const USER = process.env.MC_USERNAME || "ceyobot";
const L = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
(async () => {
  try { L("SRV:", JSON.stringify(await dns.resolveSrv("_minecraft._tcp." + HOST))); } catch (e) { L("SRV:", e.code || e.message); }
  try { L("A:", JSON.stringify(await dns.resolve4(HOST))); } catch (e) { L("A:", e.code || e.message); }
  try {
    const p = await mc.ping({ host: HOST });
    L("PING ok:", JSON.stringify({ version: p.version, players: p.players && { online: p.players.online, max: p.players.max }, motd: JSON.stringify(p.description).slice(0, 200) }));
  } catch (e) { L("PING failed:", e.code || e.message); }
  const bot = mineflayer.createBot({ host: HOST, username: USER, hideErrors: true });
  bot.on("login", () => L("LOGIN ok, version", bot.version));
  bot.on("spawn", () => L("SPAWN ok"));
  bot.on("message", (m) => L("CHAT:", m.toString().slice(0, 160)));
  bot.on("kicked", (r) => L("KICKED:", typeof r === "string" ? r : JSON.stringify(r)));
  bot.on("error", (e) => L("ERROR:", e.message));
  bot.on("end", (r) => L("END:", r));
  setTimeout(() => { L("done"); process.exit(0); }, 45000);
})();
