#!/usr/bin/env node
'use strict';
// Attribute-question chat test: fail-before was "Core idea: This is a
// chronological list of capitals of France." Pass-after must name the actual
// attribute value. Includes transfer probes (other countries, other
// attributes) and non-attribute regressions.
const runtime = require('../swarm_model_runtime');
const registry = require('./lari_model_registry.js');

const loaded = registry.loadLariModel({});
const model = loaded.model;
const modelHash = null;

async function ask(prompt) {
  const response = await runtime.sendMessageToLariAsync(model, { prompt }, {
    userScope: 'default',
    modelHash,
    autoGrow: false,
    operator: false,
    // Research-dependent probes need headroom: the in-runtime default
    // grounding timeout (6s) flakes on slow networks.
    groundingTimeoutMs: 20000,
    kernel: { useBenchmarkSystem: false, useCapabilityGraph: true, chat: { minMemoryScore: 0, minRouteScore: 0 } }
  });
  return String(response.answer || '');
}

const BOILERPLATE = /chronological list of capitals/i;

async function main() {
  const results = [];
  const check = (name, ok, detail) => {
    results.push({ name, ok, detail });
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
  };

  // --- attribute probes (live research) ---
  const attributeProbes = [
    { q: 'what is the capital of france', expect: /paris/i },
    { q: 'what is the capital of japan', expect: /tokyo/i },
    { q: 'what is the capital of brazil', expect: /bras/i },
    { q: 'what is the currency of japan', expect: /yen/i }
  ];
  for (const probe of attributeProbes) {
    const answer = await ask(probe.q);
    const namesValue = probe.expect.test(answer);
    const noBoilerplate = !BOILERPLATE.test(answer);
    check(`attribute: "${probe.q}"`, namesValue && noBoilerplate,
      namesValue ? (noBoilerplate ? answer.slice(0, 90) : 'BOILERPLATE PRESENT') : `missing value: ${answer.slice(0, 90)}`);
  }

  // --- non-attribute regressions (no research needed) ---
  const identity = await ask('who are you');
  check('identity intact', /Lari/i.test(identity) && /Greg Betti/i.test(identity), identity.slice(0, 60));

  const definition = await ask('what was the Neo-Assyrian Empire');
  check('definition intact', /assyri/i.test(definition) && !BOILERPLATE.test(definition), definition.slice(0, 80));

  const greeting = await ask('hey');
  check('greeting intact', /ask me anything/i.test(greeting), greeting.slice(0, 60));

  const learned = await ask('what have you learned');
  check('self-knowledge intact', learned.length > 20 && !/not.*enough local memory/i.test(learned), learned.slice(0, 60));

  const failed = results.filter(r => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  if (failed.length) process.exit(1);
  console.log('ATTRIBUTE CHAT TESTS PASSED');
}

main().catch(error => { console.error('TEST FAILED:', error.message); process.exit(1); });
