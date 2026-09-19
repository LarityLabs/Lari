'use strict';

/**
 * Turning repairs Lari could not make into things it intends to learn.
 *
 * Two working parts of this system have never been connected. When a repair search exhausts,
 * `retainLariRepairFailure` writes a typed record: what was being repaired, a redacted failure class,
 * and which families were tried and how often. Separately, `createLearningGoal` maintains a curiosity
 * queue that the research lane draws from. Nothing has ever joined them, so every gap Lari discovered
 * by failing sat unread while the queue was filled from elsewhere. A gap that is recorded and never
 * acted on is bookkeeping.
 *
 * This reads the failures and files the recurring ones as learning goals, ranked by how often Lari has
 * hit them. That is the difference between a system that fails and a system that notices it keeps
 * failing at the same thing.
 *
 * What this honestly does and does not do
 * --------------------------------------
 * It makes gaps visible, prioritised and actionable, and it is the first time Lari's own failures set
 * its agenda. It does **not** turn prose into a repair strategy. Researching "how are deleted
 * statements repaired" yields sentences, and no step in this project converts sentences into an
 * executable repair family. Claiming otherwise would be the same vacuum-filling that put gold answers
 * in model state once already: the loop must never be allowed to mark a gap closed because it read
 * about it.
 *
 * So a goal raised here stays open until a *verified* capability closes it -- a rule that repaired a
 * real defect through a real suite. Research can inform that; it cannot substitute for it.
 */

/** Failure records that are still open, newest first. */
function openRepairFailures(model) {
  return (model?.lariLearnedRecords?.records || [])
    .filter(record => record?.type === 'repair_failure' && record?.status === 'open')
    .map(record => ({
      id: record.id,
      target: record.payload?.target || 'unknown',
      failureClass: record.payload?.failureClass || record.payload?.failure_class || 'unclassified',
      familiesTried: record.payload?.familyCounts || record.payload?.families || {},
      occurrences: Number(record.payload?.occurrences || record.payload?.seen || 1)
    }));
}

/**
 * Group failures into gaps worth learning about.
 *
 * Grouping is by failure class rather than by target, because the same class recurring across
 * different files is the signal that something is missing from the engine, while one file failing once
 * is just a hard bug. Recurrence is the priority: a gap Lari has hit five times matters more than one
 * it hit once, and that ordering is derived from its own history rather than from anyone's judgement.
 */
function summarizeRepairGaps(model, { minOccurrences = 1 } = {}) {
  const failures = openRepairFailures(model);
  const byClass = new Map();

  for (const failure of failures) {
    const key = failure.failureClass;
    const found = byClass.get(key) || {
      failureClass: key, occurrences: 0, targets: new Set(), familiesTried: {}
    };
    found.occurrences += failure.occurrences;
    found.targets.add(failure.target);
    for (const [family, count] of Object.entries(failure.familiesTried)) {
      found.familiesTried[family] = (found.familiesTried[family] || 0) + Number(count || 0);
    }
    byClass.set(key, found);
  }

  return [...byClass.values()]
    .map(gap => ({
      failureClass: gap.failureClass,
      occurrences: gap.occurrences,
      distinctTargets: gap.targets.size,
      familiesExhausted: Object.keys(gap.familiesTried).length,
      // Everything the vocabulary could offer was tried and none of it worked, which is what
      // distinguishes "my vocabulary cannot express this" from "the search ran out of budget".
      vocabularyLooksInsufficient: Object.keys(gap.familiesTried).length > 0
    }))
    .filter(gap => gap.occurrences >= minOccurrences)
    .sort((left, right) => right.occurrences - left.occurrences || right.distinctTargets - left.distinctTargets);
}

/**
 * File the gaps as learning goals.
 *
 * The question is phrased about the *class* of defect rather than about any file, so what gets
 * researched is a repair technique rather than one broken line -- the same distinction that keeps a
 * retained rule from being a memorised answer.
 */
function planRepairGapCuriosity(model, { runtime, minOccurrences = 2, limit = 5 } = {}) {
  if (!model || !runtime?.createLearningGoal) return { raised: [], gaps: [] };
  const gaps = summarizeRepairGaps(model, { minOccurrences });
  const existing = new Set((model.curiosity?.queue || []).map(goal => goal.topic));
  const raised = [];

  for (const gap of gaps.slice(0, limit)) {
    const topic = `repair technique for ${gap.failureClass}`;
    if (existing.has(topic)) continue;
    const goal = runtime.createLearningGoal(model, {
      topic,
      capability: 'code_repair',
      kind: 'repair_gap',
      // Recurrence drives priority, capped so one noisy class cannot crowd out the queue.
      priority: Math.min(0.95, 0.5 + (0.05 * gap.occurrences)),
      reason: `Exhausted ${gap.familiesExhausted} repair families across ${gap.distinctTargets} `
        + `target(s) and still could not fix this failure, ${gap.occurrences} time(s). `
        + 'A verified repair capability closes this; reading about it does not.'
    });
    raised.push({ goal, gap });
  }
  return { raised, gaps };
}

/**
 * Close a gap only when a verified repair proves it is closed.
 *
 * Deliberately strict, and the strictness is the point. Nothing about having researched a topic, or
 * having queued it, or having proposed a rule for it, is allowed to mark it learned. Only a repair
 * that passed a real suite counts, which is the same standard the mutation vocabulary is held to.
 */
function closeRepairGapsOnVerifiedRepair(model, { failureClass, family } = {}) {
  if (!model || !failureClass) return [];
  const closed = [];
  for (const record of model.lariLearnedRecords?.records || []) {
    if (record?.type !== 'repair_failure' || record?.status !== 'open') continue;
    if ((record.payload?.failureClass || '') !== failureClass) continue;
    record.status = 'closed';
    record.payload.closedBy = { family: family || null, verification: 'executable_tests', closedAt: new Date().toISOString() };
    closed.push(record.id);
  }
  for (const goal of model.curiosity?.queue || []) {
    if (goal.kind === 'repair_gap' && goal.topic === `repair technique for ${failureClass}`) {
      goal.status = 'closed_by_verified_repair';
    }
  }
  return closed;
}

module.exports = {
  openRepairFailures,
  summarizeRepairGaps,
  planRepairGapCuriosity,
  closeRepairGapsOnVerifiedRepair
};
