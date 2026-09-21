/**
 * Tests for the multi-Lari Telegram bridge.
 * Real Lari runtime, mock Telegram transport, temp LARI_ROOT.
 *
 * Run: node test/test_bridge.js
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const userManager = require('../user_manager');
const { createTelegramClient } = require('../telegram');
const { createBridge } = require('../bridge');

let passed = 0;
let failed = 0;
const failures = [];
function check(name, cond, detail) {
  if (cond) { passed++; console.log(`  PASS ${name}`); }
  else { failed++; failures.push(name); console.log(`  FAIL ${name}${detail ? ' — ' + detail : ''}`); }
}

function mockTransport() {
  const sent = [];
  return {
    sent,
    async getUpdates() { return { ok: true, result: [] }; },
    async sendMessage(chatId, text, extra) {
      sent.push({ chatId, text, extra });
      return { ok: true, result: {} };
    }
  };
}

function dm(userId, name, text, msgId = 1) {
  return { message: { message_id: msgId, from: { id: userId, first_name: name }, chat: { id: userId, type: 'private' }, text } };
}
function group(userId, name, text, msgId = 1, replyTo = null) {
  const m = { message_id: msgId, from: { id: userId, first_name: name }, chat: { id: -100, type: 'supergroup' }, text };
  if (replyTo) m.reply_to_message = replyTo;
  return { message: m };
}

(async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lari-tg-'));
  const runtime = require(process.env.RUNTIME_PATH ||
    path.join(process.env.HOME || '/root', 'workspace', 'lari', 'lari-runtime', 'Lari for Muse', 'swarm_model_runtime.js'));
  const transport = mockTransport();
  const telegram = createTelegramClient({ transport });
  const config = {
    LARI_ROOT: root,
    BASE_MODEL_PATH: '',
    BOT_USERNAME: 'testlari_bot',
    BOT_USER_ID: '999',
    GROUP_CHAT_ID: '-100'
  };
  const bridge = createBridge({ config, runtime, telegram });

  console.log('== DMs: each user gets their own Lari ==');
  await bridge.handleUpdate(dm(111, 'Greg', '/start'));
  check('/start asks for training consent first', transport.sent.length === 1 && /AGREE/.test(transport.sent[0].text),
    transport.sent[0] && transport.sent[0].text.slice(0, 80));
  const gregHome = path.join(root, 'users', '111');
  check('user home created', fs.existsSync(path.join(gregHome, 'model.json')) && fs.existsSync(path.join(gregHome, 'workspace')));

  transport.sent.length = 0;
  await bridge.handleUpdate(dm(111, 'Greg', 'so what can you do'));
  check('chat before consent is blocked by consent prompt', transport.sent.length === 1 && /AGREE/.test(transport.sent[0].text));

  transport.sent.length = 0;
  await bridge.handleUpdate(dm(111, 'Greg', 'agree'));
  check('agree records consent and welcomes', transport.sent.length === 1 && /You're in/.test(transport.sent[0].text),
    transport.sent[0] && transport.sent[0].text.slice(0, 80));
  const gregProfile = JSON.parse(fs.readFileSync(path.join(gregHome, 'profile.json'), 'utf8'));
  check('consent persisted in profile', !!(gregProfile.trainingConsent && gregProfile.trainingConsent.agreed));

  transport.sent.length = 0;
  await bridge.handleUpdate(dm(111, 'Greg', 'so what can you do'));
  const dmReply = transport.sent.length === 1 ? transport.sent[0].text : '';
  check('DM gets a reply', transport.sent.length === 1 && dmReply.length > 0);
  check('reply goes to the DM chat', String(transport.sent[0].chatId) === '111');
  check('reply is a real answer, not an echo of the input',
    dmReply !== 'so what can you do' && !/^Greg's Lari:\s*$/.test(dmReply), dmReply.slice(0, 80));

  transport.sent.length = 0;
  await bridge.handleUpdate(dm(222, 'Mike', 'yo'));
  check('second user gets consent prompt too', transport.sent.length === 1 && /AGREE/.test(transport.sent[0].text));
  await bridge.handleUpdate(dm(222, 'Mike', 'agree'));
  check('second user gets separate home', fs.existsSync(path.join(root, 'users', '222', 'model.json')));
  const m1 = fs.readFileSync(path.join(gregHome, 'model.json'), 'utf8');
  const m2 = fs.readFileSync(path.join(root, 'users', '222', 'model.json'), 'utf8');
  check('models are separate files', m1 !== undefined && m2 !== undefined &&
    path.resolve(path.join(gregHome, 'model.json')) !== path.resolve(path.join(root, 'users', '222', 'model.json')));

  console.log('== group: shared context, mention-gated replies ==');
  transport.sent.length = 0;
  await bridge.handleUpdate(group(111, 'Greg', 'anyone up for fortnite later'));
  check('no reply without mention', transport.sent.length === 0);
  check('message still heard (shared context)', bridge.sharedContext.length === 1 &&
    bridge.sharedContext[0].text === 'anyone up for fortnite later');

  await bridge.handleUpdate(group(222, 'Mike', 'yeah im down'));
  check('second message in context', bridge.sharedContext.length === 2);

  await bridge.handleUpdate(group(111, 'Greg', '@testlari_bot what did mike just say'));
  check('mention triggers reply', transport.sent.length === 1, `sent=${transport.sent.length}`);
  check('group reply is labeled with owner Lari name', /Greg's Lari:/.test(transport.sent[0].text),
    transport.sent[0].text.slice(0, 60));
  check('reply threads the message', transport.sent[0].extra && transport.sent[0].extra.reply_to_message_id === 1);

  console.log('== owner-only learning separation ==');
  const before = fs.statSync(path.join(gregHome, 'model.json')).mtimeMs;
  await new Promise(r => setTimeout(r, 20));
  await bridge.handleUpdate(group(222, 'Mike', '@testlari_bot remember that my favorite color is blue'));
  const mikeModel = JSON.parse(fs.readFileSync(path.join(root, 'users', '222', 'model.json'), 'utf8'));
  const gregModelAfter = fs.statSync(path.join(gregHome, 'model.json')).mtimeMs;
  check("mike's turn touched only mike's model", gregModelAfter === before,
    `greg model mtime changed: ${before} -> ${gregModelAfter}`);
  check("mike's model persists", !!mikeModel);

  console.log('== jailing ==');
  const ws = path.join(gregHome, 'workspace');
  check('normal path allowed', userManager.jailPath(ws, 'builds/scanner.go') === path.join(ws, 'builds/scanner.go'));
  check('.. escape refused', userManager.jailPath(ws, '../../etc/passwd') === null);
  check('absolute escape refused', userManager.jailPath(ws, '/etc/passwd') === null);

  console.log('== other groups ignored ==');
  transport.sent.length = 0;
  await bridge.handleUpdate({ message: { message_id: 9, from: { id: 111, first_name: 'Greg' }, chat: { id: -999, type: 'group' }, text: '@testlari_bot hi' } });
  check('foreign group ignored', transport.sent.length === 0);

  console.log('== capped beta ==');
  const capRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'lari-tg-cap-'));
  const capTransport = mockTransport();
  const capTelegram = createTelegramClient({ transport: capTransport });
  const capConfig = {
    LARI_ROOT: capRoot,
    BASE_MODEL_PATH: '',
    BOT_USERNAME: 'testlari_bot',
    BOT_USER_ID: '999',
    GROUP_CHAT_ID: '-100',
    MAX_USERS: 2
  };
  const capBridge = createBridge({ config: capConfig, runtime, telegram: capTelegram });
  await capBridge.handleUpdate(dm(301, 'Ann', '/start'));
  await capBridge.handleUpdate(dm(301, 'Ann', 'agree'));
  await capBridge.handleUpdate(dm(302, 'Ben', '/start'));
  await capBridge.handleUpdate(dm(302, 'Ben', 'agree'));
  capTransport.sent.length = 0;
  await capBridge.handleUpdate(dm(303, 'Cal', '/start'));
  check('third user past cap gets beta-full reply',
    capTransport.sent.length === 1 && /capped beta/.test(capTransport.sent[0].text),
    capTransport.sent[0] && capTransport.sent[0].text.slice(0, 60));
  check('capped user gets no home dir', !fs.existsSync(path.join(capRoot, 'users', '303')));
  capTransport.sent.length = 0;
  await capBridge.handleUpdate(dm(301, 'Ann', '/start'));
  check('existing user still served past cap',
    capTransport.sent.length === 1 && /your own Lari/.test(capTransport.sent[0].text));

  console.log(`\n${passed} passed, ${failed} failed.`);
  if (failures.length) { console.log('Failures:', failures.join(', ')); process.exit(1); }
})().catch(e => { console.error('test error:', e); process.exit(1); });
