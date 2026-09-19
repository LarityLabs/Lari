'use strict';

// A read-only projection over Lari's existing candidate-learning state. It is
// deliberately not another store: model intelligence remains in canonical
// typed records and candidates remain owned by the existing learning queue.
function projectLearningLifecycle(response = {}, queued = null) {
  const learning = response.autonomousLearning || response.autonomous_learning || {};
  const practice = response.autonomousPractice || response.autonomous_practice || {};
  const source = queued && typeof queued === 'object' ? { ...learning, ...queued } : learning;
  const quarantined = source.status === 'quarantined' || source.risk === 'high';
  const scheduled = source.queued === true || practice.queued === true;
  const promoted = source.promoted === true;
  const verified = source.verified === true || source.passed === true;
  const researching = source.status === 'researching' || source.researching === true;
  const practicing = practice.status === 'practicing';
  const stage = quarantined ? 'quarantined'
    : promoted ? 'promoted'
      : verified ? 'verified'
        : practicing ? 'practicing'
          : researching ? 'researching'
            : scheduled ? 'queued'
          : 'observed';
  return {
    schemaVersion: 1,
    stage,
    observed: true,
    queued: scheduled,
    researching,
    practicing: practice.queued === true || practicing,
    verified,
    candidateCreated: Boolean(source.candidateHash || source.candidatePath || source.candidate),
    promoted,
    quarantined,
    rollbackAvailable: promoted && Boolean(source.rollbackHash || source.rollbackPath),
    origin: source.origin || null,
    risk: source.risk || null,
    jobId: source.jobId || source.id || queued?.jobId || null,
    candidateHash: source.candidateHash || source.candidate?.sha256 || null
  };
}

module.exports = { projectLearningLifecycle };
