# sunucu-ai

A Minecraft chat bot with a **local AI brain** (Turkish-capable LLM) that runs entirely on **GitHub Actions**. It stays on your server, reads the chat, and decides on its own whether to answer and which small action to take (look at you, wave, come to you, follow you, mine blocks, break the block you look at, place blocks, build a tower/wall/platform/house, give you items, stop). It also fights nearby hostile mobs and eats when hungry. Put it in creative mode (`/gamemode creative ceyobot`) and it can build with any block, in survival it needs the blocks in its inventory.

No API keys, no hosting costs: the model runs on the GitHub runner with [llama.cpp](https://github.com/ggml-org/llama.cpp), and public repositories get unlimited Actions minutes.

## Setup

1. **Fork** this repo.
2. Settings → Secrets and variables → Actions → add the secret `MC_PASSWORD` (the bot's AuthMe password, used for `/register` and `/login`).
3. Optional variables: `MC_HOST` (server address), `MC_USERNAME`, `MC_VERSION` (e.g. `1.21.4`), `MODEL_REPO`, `MODEL_PATTERN`.
4. Actions tab → enable workflows → run **ai** once. It restarts itself every 5 hours (GitHub's job limit is 6 hours) and rejoins 10-20 seconds later.
5. Run **test** first if you want to check the model and the connection (about 10 minutes, results show up as annotations on the run).

## The model

Default: `bartowski/Qwen2.5-7B-Instruct-GGUF` (Q4_K_M). If it feels slow, switch to a smaller one with the variable `MODEL_REPO`, for example `bartowski/Qwen2.5-3B-Instruct-GGUF`. Any GGUF repo on Hugging Face works.

## Safety

- The AI can only **chat** and choose from a fixed list of harmless actions. It cannot run commands: anything starting with `/` is stripped before sending.
- Your password lives in repository secrets and is never sent to the model.
- Use it only on servers where you have permission to run bots.

## Credits

Free to use, no license needed. If you use or share this, a small credit linking back to [ceyo0134](https://github.com/ceyo0134) would be really appreciated. It is a request, not a requirement. Thank you! 💚

## Commands and new abilities

- **Owner commands:** the owner (`ceyo0134`, change with the `MC_OWNERS` variable, comma separated) can make the bot run any Minecraft command by writing it after the bot's name: `ceyobot /time set day`. The AI can also run commands for the owner when asked in plain words ("ceyobot gündüz yap"). Other players are refused. Dangerous commands (`op`, `deop`, `stop`, `ban`, `whitelist`, `lp`, `login` ...) are always blocked, also inside `execute ... run`.
- **Needs op:** the bot must be op on the server for commands, heal and auto-giving build materials to work. If it is not op it tells you.
- **New actions:** `heal` (instant health, saturation, regeneration), `guard` (follows and protects a player), `fight`, `goto x y z`, `craft`, `sleep`, plus a bigger house (5-7 wide, door, windows and a roof).

## The model decides (job queue)

- You talk to the bot in plain Turkish. The AI decides what to do and can return **many jobs in one answer** ("10 odun topla, kazma yap, bana ver"). They run one after another.
- New requests are added to the **end of the queue** (up to 1000 jobs). Say "hemen" / "şimdi" and the model puts a `stop` first so the new job starts immediately.
- **"dur"** is decided by the model: `stop` drops the current job and the whole queue, `skip` only drops the current job and continues with the next one.
- The status the model sees contains the current job and the next queued jobs, so it knows what is going on.
- llama.cpp now runs with a 6144 token context (the prompt got bigger) and prompt caching, so only the first message is slow.
