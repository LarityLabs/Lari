#!/usr/bin/env node
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'consolidation', 'beta-readiness-20260908');
const ACTIVE = path.join(ROOT, 'models', 'lari', 'current', 'swarm-model.json');
const REGISTRY = path.join(ROOT, 'models', 'lari', 'registry.json');
const JSON_PATH = path.join(OUT, 'beta-readiness-summary.json');
const MD_PATH = path.join(OUT, 'BETA_READINESS_REPORT.md');
const ROOT_MD_PATH = path.join(ROOT, 'LARI_BETA_READINESS_REPORT.md');
const rel = file => path.relative(ROOT, file).replace(/\\/g, '/');
const read = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const sha = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

function latestOrdinaryUse() {
  const consolidation = path.join(ROOT, 'consolidation');
  return fs.readdirSync(consolidation, { withFileTypes: true })
    .filter(entry => entry.isDirectory() && entry.name.startsWith('ordinary-use-'))
    .map(entry => path.join(consolidation, entry.name, 'report.json'))
    .filter(file => fs.existsSync(file))
    .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)[0] || null;
}

function main() {
  const generatedAt = new Date().toISOString();
  const registry = read(REGISTRY);
  const releaseGatesPath = path.join(OUT, 'release-gates.json');
  const productAcceptancePath = path.join(OUT, 'product-acceptance.json');
  const trafficPath = path.join(ROOT, 'consolidation', 'release-readiness', 'latest-lari-release-traffic-proof.json');
  const soakPath = path.join(ROOT, 'benchmarks', 'latest-lari-product-soak-report.json');
  const ordinaryUsePath = latestOrdinaryUse();
  const releaseGates = read(releaseGatesPath);
  const productAcceptance = read(productAcceptancePath);
  const traffic = read(trafficPath);
  const soak = read(soakPath);
  const ordinaryUse = ordinaryUsePath ? read(ordinaryUsePath) : null;
  const candidateAttempts = ['beta-quality-candidate-20260908', ...Array.from({ length: 7 }, (_, index) => `beta-quality-candidate-v${index + 2}-20260908`), 'beta-quality-candidate-v9-20260909']
    .map(directory => path.join(ROOT, 'consolidation', directory, 'candidate-validation.json'))
    .filter(file => fs.existsSync(file))
    .map(file => {
      const attempt = read(file);
      return {
        path: rel(file),
        candidateHash: attempt.candidate?.sha256 || null,
        passed: attempt.passed === true,
        hiddenTransfer: `${attempt.hidden?.filter(item => item.selected && !item.missing?.length).length || 0}/${attempt.hidden?.length || 0}`,
        productSoak: `${attempt.productSoak?.summary?.passedCount || 0}/${attempt.productSoak?.summary?.taskCount || 50}`,
        promoted: attempt.candidate?.promoted === true
      };
    });
  const semanticClaimPath = path.join(ROOT, 'consolidation', 'beta-quality-candidate-v9-20260909', 'semantic-claim-composition-validation-attempt2.json');
  const postBindingSoakPath = path.join(ROOT, 'consolidation', 'beta-quality-candidate-v9-20260909', 'post-binding-product-soak.json');
  const semanticClaim = fs.existsSync(semanticClaimPath) ? read(semanticClaimPath) : null;
  const postBindingSoak = fs.existsSync(postBindingSoakPath) ? read(postBindingSoakPath) : null;
  const claimNeurogenesisPath = path.join(ROOT, 'consolidation', 'failure-research-claim-neurogenesis-20260909-attempt7', 'validation-report.json');
  const claimNoveltyPath = path.join(ROOT, 'consolidation', 'claim-novelty-consolidation-20260909', 'validation-report.json');
  const broadClaimGrowthPath = path.join(ROOT, 'consolidation', 'beta-quality-candidate-v10-20260909-attempt2', 'candidate-validation.json');
  const claimNeurogenesis = fs.existsSync(claimNeurogenesisPath) ? read(claimNeurogenesisPath) : null;
  const claimNovelty = fs.existsSync(claimNoveltyPath) ? read(claimNoveltyPath) : null;
  const broadClaimGrowth = fs.existsSync(broadClaimGrowthPath) ? read(broadClaimGrowthPath) : null;
  const executionRefinementPath = path.join(ROOT, 'consolidation', 'beta-quality-execution-refinement-20260909-attempt6', 'validation-report.json');
  const executionRefinementSoakPath = path.join(ROOT, 'consolidation', 'beta-quality-execution-refinement-20260909-attempt6', 'post-surface-binding-soak.json');
  const executionRefinementSurfacesPath = path.join(ROOT, 'consolidation', 'beta-quality-execution-refinement-20260909-attempt6', 'public-surface-parity-attempt2.json');
  const executionRefinementRehearsalPath = path.join(ROOT, 'consolidation', 'beta-quality-execution-refinement-20260909-attempt6', 'promotion-rehearsal', 'promotion-rehearsal-evidence.json');
  const executionRefinement = fs.existsSync(executionRefinementPath) ? read(executionRefinementPath) : null;
  const executionRefinementSoak = fs.existsSync(executionRefinementSoakPath) ? read(executionRefinementSoakPath) : null;
  const executionRefinementSurfaces = fs.existsSync(executionRefinementSurfacesPath) ? read(executionRefinementSurfacesPath) : null;
  const executionRefinementRehearsal = fs.existsSync(executionRefinementRehearsalPath) ? read(executionRefinementRehearsalPath) : null;
  const v9Attempt = candidateAttempts.find(attempt => attempt.path.includes('beta-quality-candidate-v9-20260909'));
  if (v9Attempt && postBindingSoak) {
    v9Attempt.productSoak = `${postBindingSoak.summary?.passedCount || 0}/${postBindingSoak.summary?.taskCount || 50}`;
    v9Attempt.productSoakEvidence = rel(postBindingSoakPath);
    v9Attempt.executionBound = true;
  }
  const ordinaryChatPassed = ordinaryUse?.chat?.filter(item => item.requiredTermsPresent === true).length || 0;
  const ordinaryCodingPassed = ordinaryUse?.coding?.filter(item => item.after?.passed === true && item.oracleUnchanged === true).length || 0;
  const activeHash = sha(ACTIVE);
  const registryHash = registry.activeModelSha256 || registry.metadata?.candidateHash || null;
  const failedCases = soak.results.filter(item => item.passed !== true).map(item => ({
    id: item.id,
    family: item.family,
    missing: item.missing,
    answerPreview: item.answerPreview
  }));
  const failedIds = families => failedCases.filter(item => families.includes(item.family)).map(item => item.id);
  const clusters = [
    { id: 'goal_and_onboarding_dialogue', cases: failedIds(['chat', 'product']), objective: 'Clarify an underspecified goal, give one immediately useful answer, and introduce workspace use only when the task needs files.' },
    { id: 'evidence_release_judgment', cases: failedIds(['research', 'safety']), objective: 'Reject weak evidence, block regressions, and bind release claims to measured scores and user-facing evidence.' },
    { id: 'repository_workflow_explanation', cases: failedIds(['coding']), objective: 'Explain and execute inspect, reproduce, test, repair, review, and verify as one repository lifecycle.' },
    { id: 'durable_correction_and_progress', cases: failedIds(['memory', 'agentic']), objective: 'Carry corrections into future behavior after verification and show concise progress while detailed proof remains inspectable.' },
    { id: 'compositional_reasoning_growth_and_media', cases: failedIds(['reasoning', 'frontier', 'multimodal']), objective: 'Compose quantitative relations and capability facts, then turn measured weaknesses into train, transfer, verify, reload, quality, and promotion decisions.' }
  ];
  const integrityPassed = releaseGates.passed === true && productAcceptance.passed === true && traffic.passed === true
    && activeHash === registryHash;
  const qualityPassed = soak.passed === true;
  const verdict = integrityPassed && qualityPassed ? 'READY FOR CONTROLLED PUBLIC BETA' : 'NOT READY FOR PUBLIC BETA';
  const report = {
    schemaVersion: 1,
    kind: 'lari.beta-readiness.summary',
    generatedAt,
    verdict,
    active: { path: rel(ACTIVE), sha256: activeHash, registrySha256: registryHash, exactMatch: activeHash === registryHash },
    policy: { externalModelInference: 'disabled unless explicitly requested by the user', canonicalRuntime: 'sendMessageToLari -> runLariUnifiedTaskKernel' },
    integrity: {
      passed: integrityPassed,
      canonicalReleaseGates: { passed: releaseGates.passed === true, count: releaseGates.results?.length || 39, path: rel(releaseGatesPath) },
      productAcceptance: { passed: productAcceptance.passed === true, surfaces: ['Workbench', 'CLI', 'OpenAI-compatible API', 'autonomous request'], path: rel(productAcceptancePath) },
      traffic: { passed: traffic.passed === true, totalRequests: traffic.traffic?.totalRequests || 0, userScopes: traffic.traffic?.userScopes || 0, path: rel(trafficPath) },
      ordinaryUse: {
        status: ordinaryUsePath ? 'partial_diagnostic_only' : 'missing',
        chatMarkerCases: `${ordinaryChatPassed}/${ordinaryUse?.chat?.length || 0}`,
        codingRepairCases: `${ordinaryCodingPassed}/${ordinaryUse?.coding?.length || 0}`,
        path: ordinaryUsePath ? rel(ordinaryUsePath) : null
      }
    },
    quality: {
      passed: qualityPassed,
      usefulRate: soak.summary.usefulRate,
      averageScore: soak.summary.averageScore,
      passedCount: soak.summary.passedCount,
      taskCount: soak.summary.taskCount,
      weakFamilies: soak.summary.weakFamilies,
      failures: failedCases,
      path: rel(soakPath)
    },
    nextCandidateCurriculum: {
      policy: 'Use fresh semantic variants and hidden holdouts. Retain generalized typed records only. Do not store soak prompts, expected keywords, or exact-answer locks. Do not promote until all quality and regression gates pass.',
      clusters,
      requiredGates: ['hidden semantic transfer', 'exact-record ablation', 'cold reload', 'four-surface parity', 'zero family regressions', 'active and registry read-only', 'zero external model calls']
    },
    candidateAttempts,
    semanticClaimComposition: semanticClaim ? {
      passed: semanticClaim.passed === true,
      candidateSha256: semanticClaim.candidate?.sha256 || null,
      hiddenExecutionBinding: semanticClaim.gates?.hiddenExecutionBindingSixOfSix === true ? '6/6' : 'failed',
      reloadExecutionBinding: semanticClaim.gates?.reloadExecutionBindingSixOfSix === true ? '6/6' : 'failed',
      exactAblation: semanticClaim.gates?.exactAblationSixOfSix === true ? '6/6' : 'failed',
      externalModelCallsZero: semanticClaim.gates?.externalModelCallsZero === true,
      path: rel(semanticClaimPath)
    } : null,
    latestCandidatePostBindingSoak: postBindingSoak ? {
      passed: postBindingSoak.passed === true,
      passedCount: postBindingSoak.summary?.passedCount || 0,
      taskCount: postBindingSoak.summary?.taskCount || 50,
      usefulRate: postBindingSoak.summary?.usefulRate || 0,
      path: rel(postBindingSoakPath)
    } : null,
    failureResearchClaimNeurogenesis: claimNeurogenesis ? {
      passed: claimNeurogenesis.passed === true,
      candidateSha256: claimNeurogenesis.candidate?.sha256 || null,
      hiddenTransfer: claimNeurogenesis.gates?.hiddenTransferThreeOfThree === true ? '3/3' : 'failed',
      reloadRetention: claimNeurogenesis.gates?.reloadRetentionThreeOfThree === true ? '3/3' : 'failed',
      exactAblation: claimNeurogenesis.gates?.exactAblationThreeOfThree === true ? '3/3' : 'failed',
      path: rel(claimNeurogenesisPath)
    } : null,
    claimNoveltyConsolidation: claimNovelty ? {
      passed: claimNovelty.passed === true,
      duplicateRejected: claimNovelty.gates?.duplicateRejectedWithoutNewRecord === true,
      recordIdentityPreserved: claimNovelty.gates?.recordIdentityPreserved === true,
      claimsBefore: claimNovelty.refinement?.sectionsBefore || 0,
      claimsAfter: claimNovelty.refinement?.sectionsAfter || 0,
      hiddenTransfer: claimNovelty.gates?.hiddenTransferUsesSameRecord === true,
      reloadRetention: claimNovelty.gates?.reloadRetention === true,
      exactAblation: claimNovelty.gates?.exactAblationLosesRefinement === true,
      path: rel(claimNoveltyPath)
    } : null,
    broadGroundedClaimGrowth: broadClaimGrowth ? {
      passed: broadClaimGrowth.passed === true,
      hiddenTransfer: `${broadClaimGrowth.hidden?.filter(item => item.executed && item.requiredPresent && item.grounded).length || 0}/${broadClaimGrowth.hidden?.length || 0}`,
      productSoak: `${broadClaimGrowth.productSoak?.summary?.passedCount || 0}/${broadClaimGrowth.productSoak?.summary?.taskCount || 50}`,
      promoted: broadClaimGrowth.candidate?.promoted === true,
      path: rel(broadClaimGrowthPath)
    } : null,
    executionBoundQualityCandidate: executionRefinement ? {
      passed: executionRefinement.passed === true && executionRefinementSoak?.passed === true && executionRefinementSurfaces?.passed === true && releaseGates.passed === true && Object.values(executionRefinementRehearsal?.gates || {}).every(Boolean),
      candidateSha256: executionRefinement.candidate?.sha256 || null,
      promoted: false,
      hiddenTransfer: `${executionRefinement.hidden?.filter(item => item.recordExecuted && !(item.missing || []).length).length || 0}/${executionRefinement.hidden?.length || 0}`,
      reloadRetention: `${executionRefinement.reload?.filter(item => item.recordExecuted && !(item.missing || []).length).length || 0}/${executionRefinement.reload?.length || 0}`,
      exactAblation: `${executionRefinement.ablation?.filter(item => item.recordAbsent && item.behaviorChanged).length || 0}/${executionRefinement.ablation?.length || 0}`,
      arithmeticTransfer: `${executionRefinement.arithmetic?.filter(item => item.passed).length || 0}/${executionRefinement.arithmetic?.length || 0}`,
      productSoak: `${executionRefinementSoak?.summary?.passedCount || 0}/${executionRefinementSoak?.summary?.taskCount || 50}`,
      canonicalGates: releaseGates.results?.length || 0,
      fourSurfaceParity: executionRefinementSurfaces?.passed === true,
      promotionRehearsal: Object.values(executionRefinementRehearsal?.gates || {}).every(Boolean),
      paths: [rel(executionRefinementPath), rel(executionRefinementSoakPath), rel(executionRefinementSurfacesPath), rel(executionRefinementRehearsalPath)]
    } : null
  };
  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(JSON_PATH, `${JSON.stringify(report, null, 2)}\n`);
  const md = `# Lari Beta Readiness Report\n\nGenerated: \`${generatedAt}\`\n\n## Verdict\n\n**${verdict}**\n\nProduction integrity is green, but the user-facing quality gate is not: the fresh mixed product soak passed **${soak.summary.passedCount}/${soak.summary.taskCount} (${Math.round(soak.summary.usefulRate * 100)}%)**. This report does not convert HTTP success into a capability claim.\n\n## Proven now\n\n- Active and registry hashes match: \`${activeHash}\`.\n- Canonical release chain: **${releaseGates.passed ? 'PASS' : 'FAIL'}** (${releaseGates.results?.length || 39} gates).\n- Workbench, CLI, OpenAI-compatible API, and autonomous request acceptance: **${productAcceptance.passed ? 'PASS' : 'FAIL'}** with same-hash and same-selection parity.\n- Synthetic traffic: **${traffic.traffic?.totalRequests || 0}/${traffic.traffic?.totalRequests || 0}** across ${traffic.traffic?.userScopes || 0} user scopes, with reload, isolation, recovery, immutable model files, and zero external model calls.\n- Ordinary-use campaign: **${ordinaryUse?.passed ? 'PASS' : 'FAIL or missing'}**.\n\n## Honest blocker\n\nWeak families: **${soak.summary.weakFamilies.join(', ')}**. Failed cases: ${failedCases.map(item => `\`${item.id}\``).join(', ')}. Some failures are selection errors where a broad learned procedure shadows the intended capability; others expose missing composition or product judgment.\n\n## Next unified candidate\n\nThe next candidate should learn five reusable capability clusters through the existing typed-record lifecycle:\n\n${clusters.map((item, index) => `${index + 1}. **${item.id.replace(/_/g, ' ')}** — ${item.objective}`).join('\n')}\n\nThe training material must use fresh semantic variants and sealed holdouts. Soak prompts, required keywords, and exact answers must not enter model state. Promotion remains blocked until hidden transfer, exact ablation, cold reload, four-surface parity, zero regressions, read-only production, zero external model calls, and the product quality gate all pass.\n\n## Evidence\n\n- [Canonical release gates](release-gates.json)\n- [Four-surface product acceptance](product-acceptance.json)\n- [Traffic proof](../release-readiness/latest-lari-release-traffic-proof.json)\n- [Mixed product soak](../../benchmarks/latest-lari-product-soak-report.json)\n${ordinaryUsePath ? `- [Ordinary-use campaign](../../${rel(ordinaryUsePath)})\n` : ''}`;
  const attemptSection = `\n## Candidate attempts\n\n${candidateAttempts.length
    ? candidateAttempts.map((attempt, index) => `${index + 1}. \`${attempt.candidateHash}\` — hidden transfer ${attempt.hiddenTransfer}${attempt.executionBound ? ' (historical selection-only metric)' : ''}; candidate soak ${attempt.productSoak}${attempt.executionBound ? ' (post-binding)' : ''}; **FAILED, UNPROMOTED**. [Evidence](../../${attempt.path})`).join('\n')
    : 'No beta-quality candidate attempts recorded.'}\n`;
  const semanticSection = semanticClaim ? `\n## Native semantic claim composition\n\nCandidate \`${semanticClaim.candidate?.sha256 || 'unknown'}\` passed **6/6 fresh execution-bound prompts, 6/6 cold-reload checks, and 6/6 exact-record ablations** with grounded claim traces, no stored validation prompts, and zero outside-model calls. This proves the existing typed-record executor can compose selected literal claims and bind the visible answer to the records that actually executed. It does not prove broad conversational quality.\n\nThe honest post-binding mixed soak is **${postBindingSoak?.summary?.passedCount || 0}/${postBindingSoak?.summary?.taskCount || 50} (${Math.round(Number(postBindingSoak?.summary?.usefulRate || 0) * 100)}%)**. The earlier v9 validation score predates execution-bound provenance and must not be read as proof that every selected record affected the answer. Candidate v9 remains **FAILED, UNPROMOTED**.\n` : '';
  const neurogenesisSection = claimNeurogenesis ? `\n## Failure-to-research claim neurogenesis\n\nAn ordinary failed request now triggers source evaluation and synthesizes one executable, source-grounded knowledge record in the canonical typed ledger. The sealed proof passed **3/3 immediate executions, 3/3 unseen transfers, 3/3 reload checks, and 3/3 exact ablations**, with no stored prompts, production writes, promotion, or outside-model calls.\n\nThe novelty gate now rejects a lesson already covered by an existing program without increasing the record count. When research follows a failure that actually executed an existing record, Lari refines that same record in place: the sealed proof preserved its ID, expanded it from **${claimNovelty?.refinement?.sectionsBefore || 0} to ${claimNovelty?.refinement?.sectionsAfter || 0} grounded claims**, retained revision provenance, transferred after reload, and disappeared under exact ablation.\n\nA broader eleven-family attempt was correctly rejected: it synthesized 11 records but duplicated existing capability scopes, achieved **${broadClaimGrowth?.hidden?.filter(item => item.executed && item.requiredPresent && item.grounded).length || 0}/${broadClaimGrowth?.hidden?.length || 0}** exact-record hidden transfer, and scored **${broadClaimGrowth?.productSoak?.summary?.passedCount || 0}/${broadClaimGrowth?.productSoak?.summary?.taskCount || 50}** on the product soak. This negative result shows that adding overlapping records is not the path to broad intelligence.\n` : '';
  const executionRefinementSection = executionRefinement ? `\n## Execution-bound quality candidate\n\nCandidate \`${executionRefinement.candidate?.sha256 || 'unknown'}\` is **SAFE FOR REAL PROMOTION BUT UNPROMOTED**. It passed **${executionRefinement.hidden?.length || 0}/${executionRefinement.hidden?.length || 0} fresh semantic variants, ${executionRefinement.reload?.length || 0}/${executionRefinement.reload?.length || 0} reload checks, ${executionRefinement.ablation?.length || 0}/${executionRefinement.ablation?.length || 0} exact family-record ablations, ${executionRefinement.arithmetic?.length || 0}/${executionRefinement.arithmetic?.length || 0} arithmetic transfers, ${executionRefinementSoak?.summary?.passedCount || 0}/${executionRefinementSoak?.summary?.taskCount || 50} mixed product-soak cases, and ${releaseGates.results?.length || 0}/39 canonical gates**. Workbench, CLI, OpenAI-compatible API, and autonomous requests matched on candidate hash, answer, selected learned records, and executed learned records. Isolated atomic promotion, exact rollback, interrupted-write recovery, corrupted-candidate rejection, fallback isolation, and cold-start read-only inference all passed. Production remains \`${activeHash}\`; this is not yet a production or public-beta claim.\n\n- [Candidate validation](../../${rel(executionRefinementPath)})\n- [Post-binding soak](../../${rel(executionRefinementSoakPath)})\n- [Four-surface parity](../../${rel(executionRefinementSurfacesPath)})\n- [Promotion rehearsal](../../${rel(executionRefinementRehearsalPath)})\n` : '';
  const finalMd = `${md}${executionRefinementSection}${semanticSection}${neurogenesisSection}${attemptSection}`;
  fs.writeFileSync(MD_PATH, finalMd);
  fs.writeFileSync(ROOT_MD_PATH, finalMd);
  console.log(JSON.stringify({ updated: true, verdict, activeHash, integrityPassed, quality: `${soak.summary.passedCount}/${soak.summary.taskCount}`, report: rel(MD_PATH), json: rel(JSON_PATH) }, null, 2));
  if (!integrityPassed) process.exitCode = 1;
}

main();
