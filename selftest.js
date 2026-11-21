const { ask } = require("./ai");

const tests = [
  { hist: ["ceyo0134: ceyobot merhaba, nasılsın?"], job: { user: "ceyo0134", msg: "ceyobot merhaba, nasılsın?", addressed: true } },
  { hist: ["ahmet: hadi madene gidelim"], job: { user: "ahmet", msg: "hadi madene gidelim", addressed: false } },
  { hist: ["ceyo0134: ceyobot buraya gel"], job: { user: "ceyo0134", msg: "ceyobot buraya gel", addressed: true } },
];

(async () => {
  for (const t of tests) {
    const s = Date.now();
    try {
      const r = await ask(t.hist, t.job);
      console.log(`[${t.job.msg}] -> ${JSON.stringify({ say: r.say, action: r.action })} (${Date.now() - s}ms)`);
    } catch (e) {
      console.log(`[${t.job.msg}] ERROR ${e.message}`);
    }
  }
})();
