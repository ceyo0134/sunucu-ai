const { ask } = require("./ai");

const mk = (user, msg, addressed = true) => ({
  hist: [`${user}: ${msg}`],
  job: { user, msg, addressed, status: "can 20/20, açlık 20/20, oyun modu survival, envanter: oak_log x5, cobblestone x20, yakındaki oyuncular: ceyo0134 (3m), şu an yaptığın iş: yok" },
});

const tests = [
  mk("ceyo0134", "ceyobot merhaba, nasılsın?"),
  mk("ahmet", "hadi madene gidelim", false),
  mk("ceyo0134", "ceyobot buraya gel"),
  mk("ceyo0134", "ceyobot 8 odun topla"),
  mk("ceyo0134", "ceyobot şuraya taştan 4 katlı kule yap"),
  mk("ceyo0134", "ceyobot bana 5 odun ver"),
  mk("ceyo0134", "ceyobot baktığım bloğu kır"),
  mk("ceyo0134", "ceyobot 10 odun topla sonra kazma yap"),
  mk("ceyo0134", "ceyobot dur"),
  mk("ceyo0134", "ceyobot demir kazma yap"),
  mk("ceyo0134", "ceyobot 10 demir külçe yap"),
  mk("ceyo0134", "ceyobot zırhını giy"),
  mk("ceyo0134", "ceyobot balık tut"),
  mk("ceyo0134", "ceyobot 3 inek avla"),
  mk("ceyo0134", "ceyobot ekinleri hasat et"),
  mk("ceyo0134", "ceyobot eşyaları sandığa koy"),
  mk("ceyo0134", "ceyobot 20 blok tünel aç"),
  mk("ceyo0134", "ceyobot 5 elmas bul"),
];

(async () => {
  for (const t of tests) {
    const s = Date.now();
    try {
      const r = await ask(t.hist, t.job);
      const acts = r.actions.map((a) => [a.action, a.item, a.shape, a.count > 1 ? a.count : "", a.command].filter(Boolean).join(":"));
      console.log(`[${t.job.msg}] -> ${JSON.stringify({ say: r.say, actions: acts })} (${Date.now() - s}ms)`);
    } catch (e) {
      console.log(`[${t.job.msg}] ERROR ${e.message}`);
    }
  }
})();
