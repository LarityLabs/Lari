#!/usr/bin/env node
/**
 * Lari sensei loop: pairwise taste-preference recorder (prototype v1).
 *
 * Taste is not a rulebook. It is retained pairwise judgments: Greg picks A
 * over B, Lari records it. Later phases will induce preference operators from
 * accumulated pairs (the same induction machinery as the discourse operators).
 * This module only records; the interactive A/B asking happens in chat.
 *
 * Storage: models/lari/current/sensei-preferences.jsonl (git-ignored runtime
 * state, one JSON object per line). Never touches the research store or the
 * model file.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const SENSEI_PATH = path.join(__dirname, '..', 'models', 'lari', 'current', 'sensei-preferences.jsonl');

function ensureSenseiFile() {
  fs.mkdirSync(path.dirname(SENSEI_PATH), { recursive: true });
  if (!fs.existsSync(SENSEI_PATH)) fs.writeFileSync(SENSEI_PATH, '');
  return SENSEI_PATH;
}

function recordPreference({ winnerId, loserId, context = '', note = '' }) {
  if (!winnerId || typeof winnerId !== 'string') throw new Error('recordPreference needs a winnerId string');
  if (!loserId || typeof loserId !== 'string') throw new Error('recordPreference needs a loserId string');
  if (winnerId === loserId) throw new Error('winnerId and loserId must differ');
  ensureSenseiFile();
  const record = {
    ts: new Date().toISOString(),
    winnerId, loserId,
    context: String(context || ''),
    note: String(note || '')
  };
  fs.appendFileSync(SENSEI_PATH, JSON.stringify(record) + '\n');
  return record;
}

function listPairs() {
  ensureSenseiFile();
  const lines = fs.readFileSync(SENSEI_PATH, 'utf8').split('\n').filter(l => l.trim());
  const pairs = [];
  for (const line of lines) {
    try { pairs.push(JSON.parse(line)); } catch (_) { /* skip corrupt lines, keep going */ }
  }
  return pairs;
}

function summarizePreferences() {
  const wins = {};
  for (const p of listPairs()) wins[p.winnerId] = (wins[p.winnerId] || 0) + 1;
  return { total: listPairs().length, wins };
}

module.exports = { SENSEI_PATH, ensureSenseiFile, recordPreference, listPairs, summarizePreferences };

if (require.main === module) {
  const [cmd, ...rest] = process.argv.slice(2);
  try {
    if (cmd === 'record') {
      const [winnerId, loserId, context = '', note = ''] = rest;
      console.log(JSON.stringify(recordPreference({ winnerId, loserId, context, note }), null, 2));
    } else if (cmd === 'list') {
      console.log(JSON.stringify(listPairs(), null, 2));
    } else if (cmd === 'summary') {
      console.log(JSON.stringify(summarizePreferences(), null, 2));
    } else {
      console.error('usage: node scripts/lari_sensei.js record <winnerId> <loserId> [context] [note] | list | summary');
      process.exit(1);
    }
  } catch (error) {
    console.error(`sensei failed: ${error.message}`);
    process.exit(1);
  }
}
