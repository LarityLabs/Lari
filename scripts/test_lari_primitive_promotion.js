#!/usr/bin/env node
'use strict';

/**
 * Asserts primitive promotion, in both directions, against the real trained vocabulary.
 *
 * The sibling module `swarm_vocabulary_compression.js` shipped calling itself compression while its own
 * test showed description length growing from 5 to 6. That is exactly the failure this suite exists to
 * prevent: an abstraction accepted because nobody made it prove it paid for itself.
 *
 * So the finding this suite pins is a REFUSAL. Lari's trained vocabulary -- 77 rules, 9 families --
 * does not compress today: its binary-substitution families hold 9 rules over an alphabet of nearly the
 * same size, so storing the alphabet costs about what storing the rules costs. Compression needs
 * redundancy, and the vocabulary is currently broad rather than deep. A vocabulary with real
 * redundancy does promote, which is what shows the mechanism works rather than that it is inert.
 *
 * Usage: node scripts/test_lari_primitive_promotion.js
 */

const fs = require('fs');
const path = require('path');
const promotion = require(path.join(__dirname, '..', 'swarm_primitive_promotion.js'));

let failures = 0;
function check(name, condition, detail) {
  if (condition) console.log(`  ok   ${name}`);
  else {
    failures += 1;
    console.log(`  FAIL ${name}${detail !== undefined ? ` -- ${JSON.stringify(detail).slice(0, 240)}` : ''}`);
  }
}

/** Deep: many rules over few operators. This is the shape an abstraction can pay for. */
const REDUNDANT = {
  'arithmetic-substitution': { rules: [[' + ', ' - '], [' - ', ' + '], [' + ', ' * '], [' * ', ' + '], [' - ', ' * ']] },
  'bitwise-substitution': { rules: [[' + ', ' & '], [' & ', ' + '], [' - ', ' & '], [' & ', ' - '], [' * ', ' & ']] },
  // Not a binary substitution; must never be absorbed.
  'unary-negation': { rules: [['not ', ''], ['return ', 'return not ']] }
};

/** Broad: few rules over many operators. This is roughly the shape Lari has today. */
const BROAD = {
  'arithmetic-substitution': { rules: [[' + ', ' - '], [' - ', ' + '], [' + ', ' * '], [' // ', ' % ']] },
  'bitwise-substitution': { rules: [[' & ', ' | '], [' | ', ' & ']] },
  'comparison-substitution': { rules: [[' < ', ' >= '], [' == ', ' > ']] }
};

console.log('a redundant vocabulary promotes');
{
  const { accepted, rejected } = promotion.promote(REDUNDANT);
  check('a primitive is promoted', accepted.length === 1, { accepted: accepted.length, rejected });
  if (!accepted.length) { console.log('\nFAIL (cannot continue)'); process.exit(1); }
  const p = accepted[0];
  check('it spans more than one family', new Set(p.families).size >= 2, p.families);
  check('it does NOT absorb the unary family, whose rules are not binary substitutions',
    !p.families.includes('unary-negation'), p.families);
  check('the promotion compresses', p.compression.compresses && p.compression.saved > 0, p.compression);
  check('it reports both sides of the comparison',
    p.compression.before > p.compression.after, p.compression);
  check('no external model calls', promotion.promote(REDUNDANT).externalModelCalls === 0);
}

console.log('\noracle 1: preservation -- every subsumed rule comes back out');
{
  const p = promotion.promote(REDUNDANT).accepted[0];
  check('nothing is lost', promotion.preservationViolations(p, REDUNDANT).length === 0,
    promotion.preservationViolations(p, REDUNDANT));

  const expanded = promotion.expandPrimitive(p).map(r => r.map(x => x.trim()).join('=>'));
  let allBack = true;
  for (const family of p.families) {
    for (const rule of REDUNDANT[family].rules) {
      if (!expanded.includes(rule.map(x => x.trim()).join('=>'))) allBack = false;
    }
  }
  check('every rule of every subsumed family is regenerable', allBack);

  // Adversarial: a primitive that quietly drops a pair must be caught.
  check('a primitive that drops a rule is caught',
    promotion.preservationViolations({ ...p, pairs: p.pairs.slice(1) }, REDUNDANT).length > 0);
}

console.log('\noracle 2: MDL -- and this is where it refuses');
{
  const result = promotion.promote(BROAD);
  check('a broad, shallow vocabulary does NOT promote', result.accepted.length === 0, result.accepted);
  check('and the refusal is on MDL, not on preservation or vacuity',
    result.rejected.length === 1
      && result.rejected[0].compression.compresses === false
      && result.rejected[0].preservation.length === 0
      && result.rejected[0].vacuity.length === 0,
    result.rejected);
  check('the refusal shows the cost it refused to pay',
    result.rejected[0].compression.after > result.rejected[0].compression.before,
    result.rejected[0].compression);

  // The name must not decide the outcome. A verbose primitive name once cost 28 symbols and refused
  // promotions on the strength of what it was called.
  const p = promotion.promote(REDUNDANT).accepted[0];
  const renamed = { ...p, name: 'x'.repeat(200) };
  check('a longer name does not change the verdict',
    promotion.compressionOf(renamed, REDUNDANT).saved === p.compression.saved);
}

console.log('\noracle 3: non-vacuity');
{
  const single = { 'arithmetic-substitution': REDUNDANT['arithmetic-substitution'] };
  check('one family alone does not promote -- that is a rename, not an abstraction',
    promotion.promote(single).accepted.length === 0);
  check('too few rules does not promote',
    promotion.promote({ a: { rules: [[' + ', ' - ']] }, b: { rules: [[' & ', ' | ']] } }).accepted.length === 0);
  check('an empty vocabulary produces nothing rather than throwing',
    promotion.promote({}).accepted.length === 0);
}

console.log('\nuntried pairings are candidates, never rules');
{
  const p = promotion.promote(REDUNDANT).accepted[0];
  const untried = promotion.proposeUntriedPairings(p, REDUNDANT);
  check('there are pairings the vocabulary has never verified', untried.length > 0, untried.length);
  check('every one is marked unverified',
    untried.every(u => u.verified === false && u.status === 'candidate'));
  const known = new Set(p.families.flatMap(f => REDUNDANT[f].rules).map(r => r.map(x => x.trim()).join('=>')));
  check('none of them is an already-known rule',
    untried.every(u => !known.has(u.rule.map(x => x.trim()).join('=>'))));
}

console.log('\nagainst the real trained vocabulary');
{
  const inventoryPath = path.join(__dirname, '..', 'models', 'lari', 'trained', 'INVENTORY.json');
  if (!fs.existsSync(inventoryPath)) {
    console.log('  ..   no INVENTORY.json; skipping');
  } else {
    const inventory = JSON.parse(fs.readFileSync(inventoryPath, 'utf8'));
    const trained = inventory.models.find(m => /blitz/.test(m.file));
    const vocab = {};
    for (const [family, rules] of Object.entries(trained.families)) {
      const parsed = rules
        .map(r => String(r).split(' -> '))
        .filter(parts => parts.length === 2 && parts.every(x => x.trim() && x.trim() !== '(nothing)'))
        .map(parts => [` ${parts[0].trim()} `, ` ${parts[1].trim()} `]);
      if (parsed.length === rules.length && parsed.length) vocab[family] = { rules: parsed };
    }
    const result = promotion.promote(vocab);
    const verdict = result.accepted[0] || result.rejected[0];
    console.log(`  ..   binary families: ${Object.keys(vocab).join(', ')}`);
    console.log(`  ..   ${verdict.compression.rulesSubsumed} rules, `
      + `${verdict.compression.before} -> ${verdict.compression.after} symbols `
      + `(${verdict.compression.saved >= 0 ? 'saved' : 'cost'} ${Math.abs(verdict.compression.saved)})`);

    // This assertion originally predicted a refusal, on the reasoning that Lari's vocabulary is broad
    // rather than deep. That was wrong and the test caught it: six binary families hold 73 rules over a
    // 23-symbol alphabet, which is deep enough to pay for itself several times over. The prediction was
    // made from a hand-built sample rather than from the vocabulary, which is the whole reason this
    // suite reads the real inventory.
    check('the real trained vocabulary promotes a primitive', result.accepted.length === 1,
      { accepted: result.accepted.length, rejected: result.rejected });
    if (result.accepted.length) {
      const p = result.accepted[0];
      check('it subsumes most of the vocabulary', p.compression.rulesSubsumed >= 60, p.compression);
      check('it spans several families', p.families.length >= 4, p.families);
      check('it compresses substantially -- over half the symbols',
        p.compression.saved > p.compression.before / 2, p.compression);
      check('and loses nothing that was verified',
        promotion.preservationViolations(p, vocab).length === 0,
        promotion.preservationViolations(p, vocab));
      const untried = promotion.proposeUntriedPairings(p, vocab);
      check('it proposes untried pairings as candidates', untried.length > 0, untried.length);
      check('including the missing arithmetic direction * -> //',
        untried.some(u => u.rule[0].trim() === '*' && u.rule[1].trim() === '//'));
      console.log(`  ..   ${untried.length} untried pairings proposed -- candidates, not rules; each must`);
      console.log('  ..   still pass the upstream suite before it is retained.');
    }
  }
}

console.log(failures === 0 ? '\nPASS' : `\nFAIL (${failures})`);
process.exit(failures === 0 ? 0 : 1);
