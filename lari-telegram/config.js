/**
 * config.js — all knobs in one place. Env vars override for the Dell.
 *
 * Required: TELEGRAM_BOT_TOKEN (BotFather).
 * Optional: LARI_ROOT, RUNTIME_PATH, BASE_MODEL_PATH, BOT_USERNAME,
 *           BOT_USER_ID, GROUP_CHAT_ID.
 */
'use strict';

const path = require('path');

const HERE = __dirname;

// Load .env next to config.js if present (KEY=value lines, # comments).
// This keeps the bot token out of command lines and process lists.
try {
  const fs = require('fs');
  const envPath = path.join(HERE, '.env');
  if (fs.existsSync(envPath)) {
    for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
      const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  }
} catch (_) {}

module.exports = {
  // Where per-user homes live. On the Dell: /srv/lari
  LARI_ROOT: process.env.LARI_ROOT || path.join(HERE, 'data'),

  // The Lari runtime (swarm_model_runtime.js). Defaults to the workspace copy.
  RUNTIME_PATH: process.env.RUNTIME_PATH || path.join(
    process.env.HOME || '/root', 'workspace', 'lari', 'lari-runtime', 'Lari for Muse', 'swarm_model_runtime.js'
  ),

  // Model new users start from (deep-copied). Empty string = blank model.
  BASE_MODEL_PATH: process.env.BASE_MODEL_PATH || '',

  TELEGRAM_BOT_TOKEN: process.env.TELEGRAM_BOT_TOKEN || '',

  // Shown as "Greg's Lari: ..." in group replies. The bot's @username,
  // used for mention detection (without the @).
  BOT_USERNAME: process.env.BOT_USERNAME || '',
  // Telegram numeric user id of the bot itself (for reply-to detection).
  BOT_USER_ID: process.env.BOT_USER_ID || '',

  // Only operate in this group chat id. Empty = any group (not recommended).
  GROUP_CHAT_ID: process.env.GROUP_CHAT_ID || '',

  // Fallback timezone for "what time is it" when a user has none set.
  // Users can get their own via their profile.json's "timezone" field.
  DEFAULT_TIMEZONE: process.env.DEFAULT_TIMEZONE || ''
};
