/**
 * Tests for the native time capability (isLariTimePrompt + answered_time).
 *
 * Run: node scripts/test_lari_time.js
 */
'use strict';

const api = require('../swarm_model_runtime.js');

let passed = 0;
let failed = 0;
const failures = [];
function check(name, cond, detail) {
  if (cond) { passed++; console.log(`  PASS ${name}`); }
  else { failed++; failures.push(name); console.log(`  FAIL ${name}${detail ? ' — ' + detail : ''}`); }
}

function freshModel() {
  const m = {};
  m.__lariSourcePath = null; // no checkpoint writes in tests
  return m;
}

(async () => {
  console.log('== time capability ==');
  const t1 = await api.sendMessageToLariAsync(freshModel(), 'what time is it', {});
  check('bare time -> answered_time', t1.action === 'answered_time', t1.action);
  check('bare time answer has a clock reading', /It's \d{1,2}:\d{2} [AP]M/.test(t1.answer || ''), t1.answer);

  const t2 = await api.sendMessageToLariAsync(freshModel(), 'what time is it in Ohio', {});
  check('Ohio -> answered_time', t2.action === 'answered_time', t2.action);
  check('Ohio answer names Ohio + Eastern', /Ohio/i.test(t2.answer || '') && /E[DS]T/i.test(t2.answer || ''), t2.answer);

  const t3 = await api.sendMessageToLariAsync(freshModel(), 'what time is it in Tokyo?', {});
  check('Tokyo -> answered_time', t3.action === 'answered_time', t3.action);
  check('Tokyo answer names Tokyo', /Tokyo/i.test(t3.answer || ''), t3.answer);

  const t4 = await api.sendMessageToLariAsync(freshModel(), 'what time is it in Narnia', {});
  check('unknown place -> answered_time (honest)', t4.action === 'answered_time', t4.action);
  check('unknown place admits it', /don't have timezone data for "Narnia"/i.test(t4.answer || ''), t4.answer);

  const t5 = await api.sendMessageToLariAsync(freshModel(), 'what time is it', { userTimezone: 'America/Chicago' });
  check('userTimezone honored', /C[DS]T/i.test(t5.answer || ''), t5.answer);

  console.log('== no regressions ==');
  const t6 = await api.sendMessageToLariAsync(freshModel(), 'tell me about Ohio', {});
  check('Ohio facts not hijacked by time branch', t6.action !== 'answered_time', t6.action);
  const t7 = await api.sendMessageToLariAsync(freshModel(), 'what is 2+2', {});
  check('arithmetic still works', t7.action === 'answered_arithmetic' && /4/.test(t7.answer || ''), `${t7.action}: ${t7.answer}`);
  const t8 = await api.sendMessageToLariAsync(freshModel(), 'what time is the meeting', {});
  check('"what time is the meeting" not treated as clock query', t8.action !== 'answered_time', t8.action);

  console.log(`\n${passed} passed, ${failed} failed.`);
  if (failures.length) { console.log('Failures:', failures.join(', ')); process.exit(1); }
})().catch(e => { console.error('test error:', e); process.exit(1); });
