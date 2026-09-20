# Running Lari

Three ways to talk to him, easiest first. Requirements for all of them: Node
20+, and the repo cloned.

```bash
git clone https://github.com/LarityLabs/Lari.git
cd Lari
npm install
```

## 1. Lari Workbench — chat in your browser

```bash
python3 -m http.server 8080
# open http://localhost:8080/index.html
```

The Workbench loads the brain from `models/lari/current/swarm-model.json`. It
must be served over HTTP — double-clicking `index.html` straight from disk won't
load the model. Chat, teach him things ("the thesis is the swarm is the model.
remember that"), and he recalls them. Link a workspace folder in the UI if you
want file read/write and model persistence back to disk.

## 2. Telegram bot — one Lari per friend

Each friend gets their own Lari: own brain file, own workspace. Everyone hears
the same group chat, but learning is owner-only and replies are mention-gated.
Needs a bot token from @BotFather. Full steps: `lari-telegram/DEPLOY.md`.

## 3. CLI adapter — one question in, JSON out

For scripts and pipelines:

```bash
echo '{"prompt":"what does LARI stand for","model_path":"models/lari/current/swarm-model.json"}' \
  | node scripts/lari_model_cli.js
```

Note: the CLI refuses models carrying stored benchmark-answer back-references
(a contamination guard — see [safety](safety.md)). The committed model has them
from dev history, so point the CLI at a fresh model file, or just use the
Workbench.

## The model file is the brain

`models/lari/current/swarm-model.json` is not config — it's everything Lari has
learned. The repo tracks **exactly one** current model; a newer one overwrites
it. Checkpoint backups and staging models stay gitignored.

**Backup discipline:** back the model file up before experimenting. Learning
writes to it (see [self-learning](self-learning.md#6-checkpointing-the-brain-hits-disk)),
and while checkpointing is atomic with backups, your experiments are your own.
Don't commit your personal model — the committed one is a snapshot, and your
live one stays yours.

## Environment variables

| Variable | What it does |
|---|---|
| `LARI_DISABLE_LEARN_CHECKPOINT=1` | Disables automatic checkpointing after learning turns. |
| `LARI_CHECKPOINT_BACKUPS=N` | How many timestamped backups to keep (default: 5). |
| `LARI_TELEGRAM_ROOT` | Root dir for the Telegram deployment's per-user models (used by the consolidation script). |
| `LARI_USER` / `LARI_USER_SCOPE` | User scope for the CLI adapter. |
| `LARI_AUTONOMOUS_LEARNING=0` | Disables autonomous learning practice in the CLI adapter. |
