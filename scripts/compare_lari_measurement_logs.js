// Compare two measurement logs: same instances? which differ? and on what family?
const fs = require('fs');

// Windows PowerShell's Tee-Object writes UTF-16LE with a BOM; the pwsh tool writes UTF-8. The runner
// produced one of each, so read the BOM rather than assuming.
function readText(file) {
  const buf = fs.readFileSync(file);
  // toString('utf16le') keeps the BOM as a leading U+FEFF, which made the FIRST record fail to match
  // `^\{` and silently dropped one instance -- reporting the comparison invalid when it was not.
  if (buf[0] === 0xFF && buf[1] === 0xFE) return buf.toString('utf16le').replace(/^﻿/, '');
  if (buf[0] === 0xEF && buf[1] === 0xBB && buf[2] === 0xBF) return buf.toString('utf8').slice(1);
  return buf.toString('utf8');
}

function parse(file) {
  const txt = readText(file);
  const objs = [...txt.matchAll(/^\{[\s\S]*?^\}/gm)]
    .map(m => { try { return JSON.parse(m[0]); } catch (e) { return null; } })
    .filter(Boolean);
  return {
    instances: objs.filter(o => o.instance),
    summary: objs.find(o => o.benchmark === 'lari-mechanical-testset') || null
  };
}

const [aFile, bFile, aName, bName] = process.argv.slice(2);
const a = parse(aFile);
const b = parse(bFile);

const ids = x => x.instances.map(i => i.instance);
const sameSet = JSON.stringify(ids(a).slice().sort()) === JSON.stringify(ids(b).slice().sort());

console.log(`${aName}: ${a.instances.length} instances   ${bName}: ${b.instances.length} instances`);
console.log(`SAME INSTANCE SET: ${sameSet ? 'yes -- comparison is valid' : 'NO -- comparison is INVALID'}`);
if (!sameSet) {
  console.log('  only in ' + aName + ': ' + ids(a).filter(i => !ids(b).includes(i)).join(', '));
  console.log('  only in ' + bName + ': ' + ids(b).filter(i => !ids(a).includes(i)).join(', '));
}

console.log('\nper instance:');
const byId = new Map(b.instances.map(i => [i.instance, i]));
for (const left of a.instances) {
  const right = byId.get(left.instance);
  const mark = right && left.repaired !== right.repaired ? '  <== DIFFERS' : '';
  console.log(`  ${String(left.operator).padEnd(4)} ${left.instance.replace('humanize-', '').padEnd(34)}`
    + ` ${aName}=${String(left.repaired).padEnd(5)} ${bName}=${String(right ? right.repaired : 'n/a').padEnd(5)}`
    + ` ${right && right.repaired ? (right.family || '') + ' ' + (right.description || '') : ''}${mark}`);
}

for (const [name, r] of [[aName, a], [bName, b]]) {
  const s = r.summary || {};
  console.log(`\n${name}: score=${s.score} repairScore=${s.repairScore} inRange=${s.inRangeScore}`
    + ` outOfRangeRepaired=${s.outOfRangeRepaired} suspect=${s.suspectEquivalentRepairs}`
    + ` vocab=${s.vocabularySource} rules=${s.vocabularyRules} priorsLoaded=${s.priorsLoaded}`
    + ` upstreamExact=${s.repairsMatchingUpstreamExactly}`);
}
