/**
 * bridge.js — the multi-Lari Telegram bridge.
 *
 * One bot, N Laris. Each Telegram user gets their own Lari instance
 * (own model.json, own workspace/). All instances share the skill library
 * and hear the same group chat, but learning is strictly owner-only:
 * your Lari learns from what YOU say to IT — never from other people's
 * messages.
 *
 * Routing:
 *   DM (private chat)  -> your Lari chats freely, every message is a turn.
 *   Group chat          -> your Lari hears everything (shared context) but
 *                          only replies when mentioned (@botname) or when
 *                          someone replies to one of its messages.
 *                          Learning happens on those owner-addressed turns.
 *
 * File access for a user's Lari is jailed to users/<id>/workspace/ via
 * user_manager.jailPath. The bridge exposes context.saveFile/readFile
 * closures that enforce it.
 *
 * Dependencies are injected (config, runtime, telegram) so tests can run
 * the whole thing with a mock transport and the real Lari runtime.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const userManager = require('./user_manager');

const MAX_CONTEXT_MESSAGES = 50;

function createBridge(deps) {
  const { config, runtime, telegram } = deps;
  if (!config || !runtime || !telegram) throw new Error('bridge needs { config, runtime, telegram }');

  const root = config.LARI_ROOT;
  const models = new Map(); // userId -> { home, model }
  const sharedContext = []; // ring buffer of group messages
  const contextLogPath = path.join(root, 'shared_context.jsonl');

  try { userManager.ensureDir(root); } catch (_) {}

  // Restore recent shared context across restarts (best effort).
  try {
    const lines = fs.readFileSync(contextLogPath, 'utf8').split('\n').filter(Boolean);
    for (const line of lines.slice(-MAX_CONTEXT_MESSAGES)) {
      try { sharedContext.push(JSON.parse(line)); } catch (_) {}
    }
  } catch (_) {}

  function getUserLari(tgUser) {
    const userId = String(tgUser.id);
    if (models.has(userId)) return models.get(userId);
    // Capped beta: every user gets their own Lari and that costs real
    // compute. New users past the cap get null; handlers reply accordingly.
    const cap = config.MAX_USERS || 0;
    if (cap > 0 && !userManager.listUsers(root).includes(userId)
        && userManager.listUsers(root).length >= cap) {
      return null;
    }
    const home = userManager.getOrCreateUserHome(root, tgUser);
    const model = userManager.loadUserModel(home, config.BASE_MODEL_PATH);
    const entry = { home, model };
    models.set(userId, entry);
    return entry;
  }

  function saveUserLari(userId) {
    const entry = models.get(String(userId));
    if (entry) {
      try { userManager.saveUserModel(entry.home, entry.model); } catch (_) {}
    }
  }

  const BETA_FULL_REPLY =
    `Small Lari is in capped beta right now — every user gets their own Lari and that costs real compute, ` +
    `so I'm full at the moment. Check back later.`;

  const CONSENT_PROMPT =
    `One quick thing before we talk: I'm a learning bot. Everything you teach me trains YOUR Lari ` +
    `(your own model, nobody else's), and what I learn may be folded into future base models so everyone's Lari gets smarter.\n\n` +
    `Reply AGREE and we'll get going.`;

  function hasConsented(entry) {
    return !!(entry && entry.home && entry.home.profile
      && entry.home.profile.trainingConsent && entry.home.profile.trainingConsent.agreed);
  }

  function recordConsent(entry) {
    entry.home.profile.trainingConsent = { agreed: true, ts: new Date().toISOString() };
    userManager.saveProfile(entry.home);
  }

  // Returns a reply string when the consent flow intercepts this turn, else null (proceed to chat).
  function consentGate(entry, text) {
    if (hasConsented(entry)) return null;
    const t = String(text || '').trim().toLowerCase().replace(/^[/!]/, '');
    if (t === 'agree' || t === 'i agree' || t === 'yes' || t === 'i agree.') {
      recordConsent(entry);
      return `You're in. I'm ${entry.home.profile.lariName} — ask me anything, teach me things, correct me when I'm wrong. What do you want to talk about?`;
    }
    return CONSENT_PROMPT;
  }

  function recordSharedContext(entry) {
    sharedContext.push(entry);
    if (sharedContext.length > MAX_CONTEXT_MESSAGES) sharedContext.shift();
    try { fs.appendFileSync(contextLogPath, JSON.stringify(entry) + '\n'); } catch (_) {}
  }

  function isMentioned(msg, botUsername) {
    const text = String((msg && msg.text) || '');
    if (botUsername && new RegExp(`@${escapeRegExp(botUsername)}\\b`, 'i').test(text)) return true;
    if (msg && msg.reply_to_message && msg.reply_to_message.from &&
        config.BOT_USER_ID && String(msg.reply_to_message.from.id) === String(config.BOT_USER_ID)) return true;
    return false;
  }

  function escapeRegExp(s) {
    return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  function extractReplyText(response) {
    if (!response) return '';
    if (typeof response === 'string') return response;
    // NOTE: `answer` is the generated reply. `message` is just the input
    // echoed back in the response envelope — never send that to the user.
    return String(response.answer || response.text || response.reply || '').trim();
  }

  function lariFileApi(home) {
    return {
      workspaceDir: home.workspaceDir,
      saveFile: (name, content) => {
        const target = userManager.jailPath(home.workspaceDir, name);
        if (!target) throw new Error('path escapes workspace');
        userManager.ensureDir(path.dirname(target));
        fs.writeFileSync(target, String(content || ''));
        return target;
      },
      readFile: (name) => {
        const target = userManager.jailPath(home.workspaceDir, name);
        if (!target) throw new Error('path escapes workspace');
        return fs.readFileSync(target, 'utf8');
      },
      listFiles: () => {
        try { return fs.readdirSync(home.workspaceDir); } catch (_) { return []; }
      }
    };
  }

  async function chatWithLari(entry, messageText, extraContext = {}) {
    const files = lariFileApi(entry.home);
    const context = {
      ...extraContext,
      userTimezone: entry.home.profile.timezone || config.DEFAULT_TIMEZONE || null,
      workspaceDir: entry.home.workspaceDir,
      lariFiles: files,
      telegramUserId: entry.home.userId,
      sharedContext: sharedContext.slice(-20)
    };
    const response = await runtime.sendMessageToLariAsync(entry.model, messageText, context);
    saveUserLari(entry.home.userId); // persist whatever the turn learned
    // Transport-level turn log: feeds the discourse miner's audit trail and
    // lets us inspect what the auto-induction loop is seeing per user.
    try {
      const logPath = path.join(entry.home.dir, 'turns.jsonl');
      const record = {
        ts: new Date().toISOString(),
        chatType: extraContext.chatType || null,
        userMessage: String(messageText || '').slice(0, 500),
        lariAnswer: extractReplyText(response).slice(0, 500),
        intent: response.intent || null,
        confidence: typeof response.confidence === 'number' ? response.confidence : null,
        signal: response.discourseMining ? response.discourseMining.signal : null,
        induced: response.discourseMining && response.discourseMining.induced
          ? { learned: !!response.discourseMining.induced.learned, verified: !!response.discourseMining.induced.verified }
          : null
      };
      fs.appendFileSync(logPath, JSON.stringify(record) + '\n');
    } catch (_) { /* logging never breaks chat */ }
    return extractReplyText(response);
  }

  async function handleDirectMessage(msg) {
    const entry = getUserLari(msg.from);
    if (!entry) return BETA_FULL_REPLY;
    const text = String(msg.text || '').trim();
    if (text === '/start') {
      if (hasConsented(entry)) {
        return `Hey ${msg.from.first_name || 'there'} — I'm ${entry.home.profile.lariName}, your own Lari. ` +
          `I chat, I research things, and I remember what you teach me. Ask me anything, quiz me, correct me when I'm wrong. ` +
          `(I can talk through code and show snippets, but I don't build software — I'm a talker, not a builder.)`;
      }
      return CONSENT_PROMPT;
    }
    const gated = consentGate(entry, text);
    if (gated) return gated;
    const reply = await chatWithLari(entry, text, { chatType: 'private' });
    return reply || '...';
  }

  async function handleGroupMessage(msg) {
    const entry = getUserLari(msg.from);
    const senderName = msg.from.first_name || msg.from.username || 'someone';
    recordSharedContext({
      userId: String(msg.from.id),
      name: senderName,
      text: String(msg.text || ''),
      ts: new Date().toISOString()
    });
    // Owner-only learning, mention-gated replies. Everyone hears everything;
    // your Lari only speaks (and learns) when YOU address it.
    if (!isMentioned(msg, config.BOT_USERNAME)) return null;
    if (!entry) return BETA_FULL_REPLY;
    const cleanText = String(msg.text || '')
      .replace(new RegExp(`@${escapeRegExp(config.BOT_USERNAME)}\\b`, 'gi'), '').trim();
    const gated = consentGate(entry, cleanText || msg.text);
    if (gated) return gated;
    const reply = await chatWithLari(entry, cleanText || msg.text, { chatType: 'group' });
    if (!reply) return null;
    return `${entry.home.profile.lariName}: ${reply}`;
  }

  async function handleUpdate(update) {
    const msg = update && update.message;
    if (!msg || typeof msg.text !== 'string' || !msg.from) return;
    const chatType = msg.chat && msg.chat.type;
    try {
      if (chatType === 'private') {
        const reply = await handleDirectMessage(msg);
        if (reply) await telegram.sendMessage(msg.chat.id, reply);
      } else if (chatType === 'group' || chatType === 'supergroup') {
        if (config.GROUP_CHAT_ID && String(msg.chat.id) !== String(config.GROUP_CHAT_ID)) return;
        const reply = await handleGroupMessage(msg);
        if (reply) {
          await telegram.sendMessage(msg.chat.id, reply, { reply_to_message_id: msg.message_id });
        }
      }
    } catch (e) {
      try {
        await telegram.sendMessage(msg.chat.id, `hmm, something broke on my end: ${String(e && e.message || e).slice(0, 140)}`);
      } catch (_) {}
    }
  }

  return {
    handleUpdate,
    handleDirectMessage,
    handleGroupMessage,
    getUserLari,
    saveUserLari,
    sharedContext,
    config
  };
}

module.exports = { createBridge };
