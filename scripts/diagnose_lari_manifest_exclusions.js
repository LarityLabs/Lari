// Which instances did the measurement silently exclude, and why?
//
// Replays only the seeding and baseline steps -- no search -- so it costs one suite run per instance
// instead of a whole measurement. This inspects the harness, not the result: no candidate is generated
// and no score is produced.
const fs = require('fs');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');

const manifest = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const repo = manifest.repo.path;
const command = manifest.oracle.testCommand || manifest.oracle.command;

const git = args => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' });

function runSuite() {
  const parts = command.split(/\s+/);
  const r = spawnSync(parts[0], parts.slice(1), { cwd: repo, encoding: 'utf8', timeout: 300000, windowsHide: true });
  return { passed: r.status === 0, status: r.status };
}

console.log(`repo:    ${repo}`);
console.log(`command: ${command}`);
console.log(`instances: ${manifest.instances.length}\n`);

for (const instance of manifest.instances) {
  git(['checkout', '--', '.']);
  const targetPath = path.join(repo, instance.targetFile);
  const pristine = fs.readFileSync(targetPath, 'utf8');
  const lines = pristine.split(/\r?\n/);
  const line = lines[instance.line - 1];

  let verdict;
  if (instance.seed.deletion) {
    lines[instance.line - 1] = instance.seed.replace;
    fs.writeFileSync(targetPath, lines.join('\n'));
    verdict = runSuite().passed ? 'EXCLUDED: seeded suite is green' : 'ok';
  } else if (!line || !line.includes(instance.seed.find)) {
    verdict = `EXCLUDED: seed anchor missing -- looking for ${JSON.stringify(instance.seed.find)}`;
  } else {
    lines[instance.line - 1] = line.replace(instance.seed.find, instance.seed.replace);
    fs.writeFileSync(targetPath, lines.join('\n'));
    verdict = runSuite().passed ? 'EXCLUDED: seeded suite is green; mutation ineffective on replay' : 'ok';
  }
  console.log(`${instance.operator.padEnd(4)} ${String(instance.targetFile + ':' + instance.line).padEnd(30)} ${verdict}`);
  if (verdict.startsWith('EXCLUDED')) {
    console.log(`     line now: ${String(lines[instance.line - 1]).trim().slice(0, 100)}`);
    console.log(`     seed:     ${JSON.stringify(instance.seed)}`);
  }
}
git(['checkout', '--', '.']);
console.log('\nrepo restored to pristine.');
