/**
 * Nightly memory consolidation for the Lari Telegram deployment.
 *
 * For every per-user model under <root>/users/<telegram-id>/model.json:
 *   - distills episodic memories into durable beliefs (identity facts,
 *     preferences, directives, topic familiarity, self-knowledge from
 *     discourse-miner calibration),
 *   - arbitrates contradictions (higher confidence x recency wins; the loser
 *     is superseded, never deleted),
 *   - writes the model back with a backup (keeps the last 7 consolidation
 *     backups per user).
 *
 * Run:  node scripts/run_lari_consolidation.js [--root /tmp/lari-live]
 * Env:  LARI_TELEGRAM_ROOT overrides the default root.
 *
 * On the Dell this runs from a systemd timer (see lari-telegram/DEPLOY.md).
 * In the current test deployment it runs from a Muse cron job.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const api = require('../swarm_model_runtime.js');

function parseArgs() {
  const args = process.argv.slice(2);
  const out = { root: process.env.LARI_TELEGRAM_ROOT || '/tmp/lari-live' };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--root' && args[i + 1]) { out.root = args[i + 1]; i++; }
  }
  return out;
}

function listUsers(root) {
  const usersDir = path.join(root, 'users');
  let entries = [];
  try { entries = fs.readdirSync(usersDir, { withFileTypes: true }); } catch (_) { return []; }
  return entries.filter(e => e.isDirectory()).map(e => path.join(usersDir, e.name));
}

function pruneBackups(modelPath, keep = 7) {
  try {
    const dir = path.dirname(modelPath);
    const base = path.basename(modelPath);
    const baks = fs.readdirSync(dir)
      .filter(f => f.startsWith(base + '.consolidation-') && f.endsWith('.bak'))
      .sort();
    while (baks.length > keep) {
      const drop = baks.shift();
      try { fs.unlinkSync(path.join(dir, drop)); } catch (_) {}
    }
  } catch (_) {}
}

function main() {
  const { root } = parseArgs();
  const users = listUsers(root);
  const summary = { root, users: users.length, consolidated: 0, errors: [], perUser: [] };

  for (const userDir of users) {
    const modelPath = path.join(userDir, 'model.json');
    const userId = path.basename(userDir);
    if (!fs.existsSync(modelPath)) continue;
    try {
      const model = JSON.parse(fs.readFileSync(modelPath, 'utf8'));
      const scopes = Object.keys((model.userModel && model.userModel.episodicMemories) || {});
      if (!scopes.length) scopes.push('default');
      const userReport = { userId, scopes: {} };
      for (const scope of scopes) {
        userReport.scopes[scope] = api.consolidateUserMemory(model, scope, {});
      }
      // Backup, then write back atomically.
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      const bakPath = `${modelPath}.consolidation-${stamp}.bak`;
      fs.copyFileSync(modelPath, bakPath);
      pruneBackups(modelPath, 7);
      const tmpPath = `${modelPath}.tmp`;
      fs.writeFileSync(tmpPath, JSON.stringify(model));
      fs.renameSync(tmpPath, modelPath);
      summary.consolidated += 1;
      summary.perUser.push(userReport);
    } catch (error) {
      summary.errors.push({ userId, error: String((error && error.message) || error) });
    }
  }

  console.log(JSON.stringify(summary, null, 2));
  return summary.errors.length ? 1 : 0;
}

process.exit(main());
