/**
 * telegram.js — thin Telegram Bot API wrapper.
 *
 * Real transport: HTTPS long-polling (getUpdates) + sendMessage.
 * Mock transport: pass { transport } in options for tests — an object with
 *   async getUpdates(offset, timeoutMs) -> { ok, result: [updates] }
 *   async sendMessage(chatId, text, extra) -> { ok, result }
 *
 * Long messages are chunked at 4096 chars (Telegram's limit).
 */
'use strict';

const https = require('https');

function realTransport(token) {
  function api(method, params = {}) {
    return new Promise((resolve, reject) => {
      const body = JSON.stringify(params);
      const req = https.request({
        hostname: 'api.telegram.org',
        path: `/bot${token}/${method}`,
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
      }, (res) => {
        let data = '';
        res.on('data', c => { data += c; });
        res.on('end', () => {
          try { resolve(JSON.parse(data)); }
          catch (e) { reject(new Error(`bad telegram response: ${data.slice(0, 120)}`)); }
        });
      });
      req.on('error', reject);
      req.setTimeout(70000, () => req.destroy(new Error('telegram request timed out')));
      req.end(body);
    });
  }
  return {
    getUpdates: (offset, timeoutMs) => api('getUpdates', {
      offset, timeout: Math.min(60, Math.floor((timeoutMs || 30000) / 1000)),
      allowed_updates: ['message']
    }),
    sendMessage: (chatId, text, extra) => api('sendMessage', {
      chat_id: chatId, text, ...(extra || {})
    })
  };
}

function chunkText(text, maxLen = 4000) {
  const t = String(text || '');
  if (t.length <= maxLen) return [t];
  const chunks = [];
  let rest = t;
  while (rest.length > maxLen) {
    let cut = rest.lastIndexOf('\n', maxLen);
    if (cut < maxLen / 2) cut = maxLen;
    chunks.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^\n+/, '');
  }
  if (rest) chunks.push(rest);
  return chunks;
}

function createTelegramClient(options = {}) {
  if (!options.token && !options.transport) {
    throw new Error('telegram: need a bot token (or a mock transport)');
  }
  const transport = options.transport || realTransport(options.token);

  async function sendMessage(chatId, text, extra = {}) {
    const results = [];
    for (const chunk of chunkText(text)) {
      results.push(await transport.sendMessage(chatId, chunk, extra));
    }
    return results;
  }

  /**
   * Long-poll loop. Calls onUpdate(update) for each incoming update.
   * Never throws out — logs and backs off, so the bot stays alive.
   */
  async function poll(onUpdate, pollOptions = {}) {
    let offset = pollOptions.offset || 0;
    const log = pollOptions.log || (() => {});
    let backoffMs = 1000;
    for (;;) {
      let batch;
      try {
        batch = await transport.getUpdates(offset, 30000);
        backoffMs = 1000;
      } catch (e) {
        log(`poll error: ${e.message}; retrying in ${backoffMs}ms`);
        await new Promise(r => setTimeout(r, backoffMs));
        backoffMs = Math.min(60000, backoffMs * 2);
        continue;
      }
      if (!batch || batch.ok === false) {
        log(`poll bad response; retrying in ${backoffMs}ms`);
        await new Promise(r => setTimeout(r, backoffMs));
        backoffMs = Math.min(60000, backoffMs * 2);
        continue;
      }
      for (const update of batch.result || []) {
        offset = Math.max(offset, (update.update_id || 0) + 1);
        try { await onUpdate(update); }
        catch (e) { log(`update handler error: ${e && e.message}`); }
      }
    }
  }

  return { sendMessage, poll, chunkText };
}

module.exports = { createTelegramClient, chunkText };
