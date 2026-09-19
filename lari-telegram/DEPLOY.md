# Lari Telegram bridge — deploy guide (Dell server)

One bot, N Laris. Each friend gets their own Lari (own brain file, own
workspace folder). Group chat is shared context; learning is owner-only.

## 1. Create the bot (2 min, on your phone)

1. Message **@BotFather** on Telegram → `/newbot` → name it (e.g. `Lari`) →
   username (e.g. `yourlari_bot`). BotFather gives you a **token**.
2. Add the bot to your Lari group chat as a member.
3. (Optional) DM the bot `/start` — you'll get your own Lari there too.

## 2. Put the files on the Dell

```bash
sudo mkdir -p /srv/lari
sudo cp -r lari-telegram /srv/lari/
sudo useradd -r -m -d /srv/lari lari 2>/dev/null || true
sudo chown -R lari:lari /srv/lari
```

Also copy the Lari runtime next to it (or point RUNTIME_PATH at it):

```bash
# wherever swarm_model_runtime.js lives and is readable by the lari user
```

## 3. Configure

Create `/srv/lari/lari-telegram/.env` (readable only by the lari user):

```bash
TELEGRAM_BOT_TOKEN=123456:ABC-your-token-here
LARI_ROOT=/srv/lari
RUNTIME_PATH=/srv/lari/runtime/swarm_model_runtime.js
BASE_MODEL_PATH=/srv/lari/runtime/swarm-model.json
BOT_USERNAME=yourlari_bot
BOT_USER_ID=123456789
GROUP_CHAT_ID=-1001234567890
```

- `BOT_USER_ID`: message **@userinfobot** to get your bot's numeric id.
- `GROUP_CHAT_ID`: add **@getmyid_bot** to the group, it prints the chat id.
- `BASE_MODEL_PATH`: the model new users start from (deep-copied, then they
  diverge). Point at your canonical `swarm-model.json` so friends start with
  your skills. Empty = blank model.

```bash
sudo chmod 600 /srv/lari/lari-telegram/.env
sudo chown lari:lari /srv/lari/lari-telegram/.env
```

## 4. Run it

```bash
sudo cp lari-telegram.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now lari-telegram
journalctl -u lari-telegram -f   # watch it come alive
```

## How it behaves

- **DMs**: anyone who messages the bot gets their own Lari. First message
  creates `users/<telegram-id>/` with `model.json` + `workspace/`.
- **Group**: every Lari hears everything (shared context), but a Lari only
  replies when its owner mentions `@yourlari_bot` (or replies to its message).
  Your Lari learns from what YOU say to it — never from other people's messages.
- **Workspaces**: each user's Lari can save things it builds under its own
  `workspace/`. Paths are jailed — no escaping into other users' folders.
- **Restarts**: models auto-save after every turn; shared context replays the
  last 50 messages on boot.

## Honest limits (v1)

- The sandbox runs code with a timeout in a temp dir — it is not a security
  boundary. This is a friends-and-fun deployment; don't expose it to enemies.
- New users start from your base model: they inherit your skills AND your
  learned knowledge snapshot. Their future learning is their own.
- Group replies are labeled (`Greg's Lari: ...`) since one bot speaks for N Laris.
