/**
 * index.js — entry point. Loads config, the real Lari runtime, and starts
 * the Telegram long-poll loop. Run under systemd on the Dell for always-on.
 */
'use strict';

const config = require('./config');
const { createTelegramClient } = require('./telegram');
const { createBridge } = require('./bridge');

async function main() {
  if (!config.TELEGRAM_BOT_TOKEN) {
    console.error('Set TELEGRAM_BOT_TOKEN (see DEPLOY.md). Refusing to start.');
    process.exit(1);
  }
  let runtime;
  try {
    runtime = require(config.RUNTIME_PATH);
  } catch (e) {
    console.error(`Could not load Lari runtime at ${config.RUNTIME_PATH}: ${e.message}`);
    process.exit(1);
  }
  if (typeof runtime.sendMessageToLariAsync !== 'function') {
    console.error('Runtime has no sendMessageToLariAsync. Refusing to start.');
    process.exit(1);
  }

  const telegram = createTelegramClient({ token: config.TELEGRAM_BOT_TOKEN });
  const bridge = createBridge({ config, runtime, telegram });

  console.log(`[lari-telegram] root=${config.LARI_ROOT} group=${config.GROUP_CHAT_ID || '(any)'}`);
  console.log('[lari-telegram] polling Telegram...');
  await telegram.poll((update) => bridge.handleUpdate(update), { log: console.log });
}

main().catch(e => { console.error('fatal:', e); process.exit(1); });
