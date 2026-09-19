'use strict';

/**
 * Inducing grammatical constraints from edited text, the same way repair rules are induced from a
 * test suite.
 *
 * The repair lane works because a dumb proposer is paired with a strong oracle: mutation families
 * throw thousands of mostly-wrong candidates, and a suite nobody here wrote decides. Neither half is
 * intelligent; the combination acquires capability. This file is that structure pointed at English.
 *
 * What is given and what is learned
 * ---------------------------------
 * Given: which words belong to which closed class. That is vocabulary, not grammar -- the same status
 * as DEFAULT_OPERATORS in swarm_grammar_synthesis.js, which is read off Python's own `ast` rather than
 * invented. Knowing that "these" is plural is a fact about a word; knowing that "these is" is
 * ungrammatical is a rule about the language.
 *
 * Learned: which combinations edited English forbids. The proposer enumerates every ordered pair of
 * classes and has no idea which are legal. The corpus decides. A constraint that survives is a rule
 * this project's source never contained.
 *
 * The oracle has to be two-sided
 * ------------------------------
 * "This pattern does not appear in the corpus" is passed perfectly by any constraint that matches
 * nothing at all. A rule that never fires is the language version of a benchmark that cannot fail,
 * and this repository has been bitten by that shape more than once.
 *
 * So a constraint must also demonstrate it can catch something. Number mutation seeds agreement
 * defects into clean sentences -- swapping is/are, this/these, has/have -- and a constraint earns
 * retention only if it fires on the damaged text. Seed a defect, require the checker to catch it:
 * the same method the repair lane already uses, which is why it is trustworthy here.
 *
 * What this is not
 * ----------------
 * A generator. Every constraint here is a filter: it can reject a sentence, never produce one. That
 * is the honest scope, and it is still worth having, because a strong filter is exactly what makes a
 * weak proposer viable -- which is the whole lesson of the repair lane.
 *
 * Adjacency is a real limit too. "These results, however, is wrong" passes every constraint below,
 * because the classes are not next to each other. Genuine agreement is structural. This reaches the
 * positional shadow of it.
 */

/**
 * Open-class number, supplied by Computational English rather than guessed.
 *
 * The comment below this one held for three versions of this lane: closed classes only, because
 * detecting a plural noun would need a heuristic and a heuristic is a rule smuggled in as data. The
 * cost was that every version listed the same sentence as out of reach --
 *
 *     These books is heavy.
 *
 * -- where `books` and `is` are adjacent and nothing here could know `books` is plural. Lari's own
 * attempt to learn word classes distributionally (swarm_word_class_induction.js) recovered real
 * syntactic categories and *not* number: `is`/`are` and `this`/`these` cluster together, because
 * clustering groups words by substitutability and substitutability is exactly what number does not
 * affect. That was measured.
 *
 * CE supplies form-level Number from treebank annotation. `books` is Plur, `book` is Sing, and each
 * comes with an observation count and a part-of-speech distribution. That is evidence of the same kind
 * the repair lane already trusts -- human annotation of real text, not authored here -- and it is data
 * rather than a model, so VISION.md section 3 is untouched. No external model is called.
 *
 * A form enters a noun class only when CE's per-form Number is decisive AND the lemma reads as a noun
 * more often than not. The second condition matters: `books` is also a verb form, and admitting it as a
 * noun in every context would put verb readings into a noun class.
 */
let ceModule = null;
function computationalEnglish() {
  if (ceModule === null) {
    try { ceModule = require('computational-english'); } catch (_) { ceModule = false; }
  }
  return ceModule || null;
}

/**
 * Off. Turning this on adds CE-backed NOUN_SG and NOUN_PL classes to the lexicon, which was measured on
 * 2026-07-30 and made the lane worse -- see the note on WORD_CLASSES and
 * holdouts/grammar-induction-v4/result.json. It stays as a flag rather than deleted code because the
 * noun classification is correct and the scope is what is wrong; the day this lane can state rules over
 * structure instead of adjacency, this becomes useful unchanged.
 *
 * Anything switching it on must seal a prediction first and must not reuse english-corpus-v4.txt, which
 * is burned.
 */
const OPEN_CLASS_NOUNS_ENABLED = false;

const NOUN_NUMBER_CACHE = new Map();

/**
 * 'singular' | 'plural' | null for a surface form, from CE.
 *
 * null means CE cannot classify it, which costs coverage and never correctness -- an unclassifiable
 * form simply does not join a class. CE's own ISSUES.md records that its noun coverage is partial.
 */
function nounNumberOf(form) {
  if (NOUN_NUMBER_CACHE.has(form)) return NOUN_NUMBER_CACHE.get(form);
  let verdict = null;
  const ce = computationalEnglish();
  if (ce) {
    const entry = ce.word(form);
    const counts = entry && entry.formFeatures && entry.formFeatures.Number;
    const pos = entry && entry.pos;
    const nounDominant = pos && (pos.NOUN || 0) + (pos.PROPN || 0) > 0.5;
    if (counts && nounDominant) {
      const sing = counts.Sing || 0;
      const plur = counts.Plur || 0;
      // Decisive, not merely leaning. "Decisive" is 95% of at least three observations rather than a
      // literal zero on the other side, because a single noisy annotation should not disqualify a
      // common noun -- under the zero reading `book` was excluded on one stray Plur tag.
      //
      // Calibrated before the run, not after: the two readings classify 1247 and 1275 of the corpus's
      // 4000 commonest forms and agree on every case the experiment turns on (books, children, men all
      // plural under both). The choice is worth 28 forms and changes nothing about the outcome.
      const total = sing + plur;
      if (total >= 3) {
        if (sing / total >= 0.95) verdict = 'singular';
        else if (plur / total >= 0.95) verdict = 'plural';
      }
    }
  }
  NOUN_NUMBER_CACHE.set(form, verdict);
  return verdict;
}

/**
 * Closed word classes: lexical facts, not rules.
 *
 * Closed classes only for the *function* words. Open-class nouns are resolved per form through CE
 * above, so the limitation this comment used to describe now applies only to words CE cannot classify.
 */
const WORD_CLASSES = {
  DET_SG: ['a', 'an', 'this', 'each', 'every', 'another'],
  DET_PL: ['these', 'those', 'many', 'several', 'both'],
  BE_SG: ['is', 'was'],
  BE_PL: ['are', 'were'],
  HAVE_SG: ['has'],
  HAVE_PL: ['have'],
  DO_SG: ['does'],
  DO_PL: ['do']
  // NOUN_SG and NOUN_PL were added here on 2026-07-30, resolved per form through Computational English,
  // and reverted the same day. See holdouts/grammar-induction-v4/result.json.
  //
  // CE supplied correct noun number -- 1275 of the corpus's 4000 commonest forms, every case the
  // experiment turned on classified right. The lane still got worse: 8 constraints against v3's 2, and
  // three false positives where v3 had none. It rejected "these computer systems", "many state laws"
  // and "several phone calls", all via DET_PL -> NOUN_SG, because a singular noun modifying a plural
  // head sits exactly where a violation would.
  //
  // And the constraint the whole experiment existed to reach, NOUN_PL -> BE_SG, was rejected as
  // attested: 1975 occurrences in clean text, of which "the price of books is high", "ten years was a
  // long time" and "a million dollars is a lot" are all correct English, because the adjacent plural
  // noun is not the subject.
  //
  // The limit was never noun number. It is adjacency, and CE's own scale-v1 result had already
  // established that adjacency-scoped agreement is unsound for English. Adding expressive power to a
  // lane whose scope is unsound makes it worse: more classes mean more candidate constraints, and an
  // oracle that cannot see structure cannot reject the false ones. v3 reached 0 false positives partly
  // because it lacked the power to state a false rule.
  //
  // nounNumberOf() above is left in place and unused. The machinery is correct and becomes useful the
  // day this lane has structure to state rules over -- which means a parser, which Lari does not have.
};

/**
 * Number-swap pairs used to seed agreement defects. The mutation operator for English.
 *
 * `that <-> those` was here in v1 and was removed after it produced the run's only false constraint.
 * English "that" is overwhelmingly a complementizer or relativizer ("note that these methods...")
 * rather than a demonstrative, and swapping it there is not a number-agreement defect at all -- it is
 * a category error. Those errors manufactured 73 firings of DET_PL->DET_PL, which the induction then
 * retained as a rule, making "both these tests pass" a violation.
 *
 * Telling the two senses apart needs part-of-speech information this lane does not have, so the pair
 * is dropped rather than guarded by a heuristic. Removing coverage is honest; guessing is not. A
 * tagger would earn it back.
 *
 * The remaining pairs are unambiguous: `this` is always a determiner or demonstrative pronoun, and
 * the verb forms are always verb forms.
 */
const NUMBER_SWAPS = [
  ['is', 'are'], ['was', 'were'], ['has', 'have'], ['does', 'do'],
  ['this', 'these']
];

/** Reverse index from word to class, built once. */
function buildLexicon(classes = WORD_CLASSES) {
  const lexicon = new Map();
  for (const [className, words] of Object.entries(classes)) {
    for (const word of words) lexicon.set(word, className);
  }
  // A Map that answers for closed-class words directly and consults CE for anything else. Closed-class
  // membership wins, so a determiner is never reclassified as a noun by a lexicon lookup.
  return {
    get(form) {
      if (lexicon.has(form)) return lexicon.get(form);
      if (!OPEN_CLASS_NOUNS_ENABLED) return undefined;
      const number = nounNumberOf(form);
      return number === 'plural' ? 'NOUN_PL' : number === 'singular' ? 'NOUN_SG' : undefined;
    },
    has(form) { return this.get(form) !== undefined; }
  };
}

/** Lowercased word tokens. Punctuation is dropped; it is not what these constraints are about. */
function tokenize(text) {
  return String(text).toLowerCase().match(/[a-z']+/g) || [];
}

/**
 * Every ordered pair of classes, as a candidate constraint.
 *
 * The proposer knows nothing about English. It emits all N^2 pairs and lets the oracle sort them.
 */
function proposeAdjacencyConstraints(classes = WORD_CLASSES) {
  const names = Object.keys(classes);
  const proposals = [];
  for (const left of names) {
    for (const right of names) {
      proposals.push({
        id: `${left}->${right}`,
        left,
        right,
        statement: `a word of class ${left} is not immediately followed by a word of class ${right}`,
        examples: classes[left].slice(0, 2).flatMap(a => classes[right].slice(0, 2).map(b => `${a} ${b}`))
      });
    }
  }
  return proposals;
}

/** Count adjacent (left-class, right-class) pairs in a token stream. */
function countAdjacencies(tokens, lexicon) {
  const counts = new Map();
  for (let i = 0; i + 1 < tokens.length; i += 1) {
    const left = lexicon.get(tokens[i]);
    if (!left) continue;
    const right = lexicon.get(tokens[i + 1]);
    if (!right) continue;
    const key = `${left}->${right}`;
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  return counts;
}

/**
 * Seed agreement defects into a sentence by swapping one number-marked word.
 *
 * Returns null when the sentence contains nothing to swap, so callers can tell "no defect available"
 * apart from "defect made no difference" -- the same distinction the repair oracle draws between a
 * verifier that errors and one that rejects.
 */
function mutateNumberAgreement(sentence, swaps = NUMBER_SWAPS) {
  const tokens = String(sentence).split(/(\s+)/);
  const sites = [];
  for (let i = 0; i < tokens.length; i += 1) {
    const bare = tokens[i].toLowerCase();
    for (const [singular, plural] of swaps) {
      if (bare === singular) sites.push([i, plural]);
      else if (bare === plural) sites.push([i, singular]);
    }
  }
  if (sites.length === 0) return null;
  const mutants = [];
  for (const [index, replacement] of sites) {
    const copy = [...tokens];
    copy[index] = replacement;
    mutants.push(copy.join(''));
  }
  return mutants;
}

/**
 * Decide which proposed constraints edited English supports.
 *
 * @param {string[]} sentences        corpus, one sentence per entry
 * @param {object}   [options]
 * @param {number}   [options.maxCleanPerMillion=2]  precision bar
 * @param {number}   [options.minMutantFirings=20]   sensitivity bar, guards vacuity
 */
function induceConstraints(sentences, options = {}) {
  const {
    classes = WORD_CLASSES,
    maxCleanPerMillion = 2,
    minMutantFirings = 20,
    swaps = NUMBER_SWAPS,
    // v1 semantics are kept reachable so its recorded score stays reproducible.
    useRatioOracle = false,
    minDiscriminationRatio = 20,
    // Sentences whose mutants supply the negative evidence, when these differ from the corpus that
    // supplies the clean counts. Textbook examples carry marked focus tokens, so mutating them is
    // targeted rather than blind; the verification corpus stays independent of the textbook.
    mutationSource = null,
    // Throw out mutations that produced an attested word bigram: they did not damage the sentence.
    validateMutants = false
  } = options;

  const lexicon = buildLexicon(classes);
  const proposals = proposeAdjacencyConstraints(classes);

  const cleanTokens = [];
  for (const sentence of sentences) cleanTokens.push(tokenize(sentence));
  const totalTokens = cleanTokens.reduce((sum, tokens) => sum + tokens.length, 0);

  const cleanCounts = new Map();
  for (const tokens of cleanTokens) {
    for (const [key, count] of countAdjacencies(tokens, lexicon)) {
      cleanCounts.set(key, (cleanCounts.get(key) || 0) + count);
    }
  }

  // Mutant side. Every mutant of every sentence, counted the same way. A constraint that fires here
  // and not on clean text is detecting the seeded defect.
  // Which word bigrams edited English actually attests. Used to throw out mutations that did not
  // damage anything.
  //
  // v2's worst false constraint came from assuming every number swap seeds a defect. Mutating "is a"
  // -- 4703 occurrences, the most frequent pattern in that corpus -- produced "are a" 4585 times, and
  // "are a" is perfectly good English ("They are a team"). The negative evidence was not negative.
  // A mutation that lands on an attested bigram did not create an error and must not be counted as
  // one.
  const attestedBigrams = new Set();
  if (validateMutants) {
    for (const tokens of cleanTokens) {
      for (let i = 0; i + 1 < tokens.length; i += 1) attestedBigrams.add(`${tokens[i]} ${tokens[i + 1]}`);
    }
  }

  const mutantCounts = new Map();
  let mutantsBuilt = 0;
  let sentencesWithNoSite = 0;
  let discardedAsUndamaged = 0;
  for (const sentence of (mutationSource || sentences)) {
    const mutants = mutateNumberAgreement(sentence, swaps);
    if (mutants === null) { sentencesWithNoSite += 1; continue; }
    for (const mutant of mutants) {
      mutantsBuilt += 1;
      const tokens = tokenize(mutant);
      for (let i = 0; i + 1 < tokens.length; i += 1) {
        const left = lexicon.get(tokens[i]);
        if (!left) continue;
        const right = lexicon.get(tokens[i + 1]);
        if (!right) continue;
        if (validateMutants && attestedBigrams.has(`${tokens[i]} ${tokens[i + 1]}`)) {
          discardedAsUndamaged += 1;
          continue;
        }
        const key = `${left}->${right}`;
        mutantCounts.set(key, (mutantCounts.get(key) || 0) + 1);
      }
    }
  }

  const evaluated = proposals.map(proposal => {
    const clean = cleanCounts.get(proposal.id) || 0;
    const mutant = mutantCounts.get(proposal.id) || 0;
    const cleanPerMillion = totalTokens ? (clean / totalTokens) * 1e6 : 0;
    // Firings attributable to the seeded defect rather than to text the mutation left alone.
    const attributable = Math.max(0, mutant - clean);
    // Discrimination, not rarity.
    //
    // v1 gated on an absolute clean rate and it measured the wrong thing. "these is" occurred 5 times
    // in 330k tokens of edited English and fired 682 times on seeded defects -- a 136:1 separation,
    // the cleanest signal in the run -- and was rejected for exceeding an arbitrary 2-per-million
    // bar. Rarity and ungrammaticality are different properties; a real constraint is one that fires
    // on damaged text far more than on sound text, whatever its absolute frequency.
    //
    // Genuinely attested pairs invert the ratio rather than merely exceeding a threshold: mutating
    // "this is" destroys instances instead of creating them, so DET_SG->BE_SG scored 535 clean
    // against 187 mutant. That is a sign change, not a close call.
    const ratio = attributable / Math.max(clean, 1);
    const retained = useRatioOracle
      ? ratio >= minDiscriminationRatio && attributable >= minMutantFirings
      : cleanPerMillion <= maxCleanPerMillion && attributable >= minMutantFirings;
    return {
      ...proposal,
      cleanOccurrences: clean,
      cleanPerMillion: Number(cleanPerMillion.toFixed(3)),
      mutantOccurrences: mutant,
      attributableFirings: attributable,
      retained,
      rejectedBecause: retained ? null
        : cleanPerMillion > maxCleanPerMillion ? 'attested in edited English'
        : 'vacuous -- never fires even on seeded defects'
    };
  });

  return {
    corpus: { sentences: sentences.length, tokens: totalTokens, mutantsBuilt, sentencesWithNoSite, discardedAsUndamaged },
    thresholds: { maxCleanPerMillion, minMutantFirings },
    proposed: proposals.length,
    retained: evaluated.filter(item => item.retained),
    rejected: evaluated.filter(item => !item.retained),
    all: evaluated
  };
}

/**
 * Apply retained constraints to a sentence. The filter half of a generator.
 *
 * Returns the violations found, so a caller can reject a candidate phrasing or explain why.
 */
function checkSentence(sentence, constraints, classes = WORD_CLASSES) {
  const lexicon = buildLexicon(classes);
  const tokens = tokenize(sentence);
  const active = new Set(constraints.filter(item => item.retained !== false).map(item => item.id));
  const violations = [];
  for (let i = 0; i + 1 < tokens.length; i += 1) {
    const left = lexicon.get(tokens[i]);
    const right = lexicon.get(tokens[i + 1]);
    if (!left || !right) continue;
    const id = `${left}->${right}`;
    if (active.has(id)) violations.push({ constraint: id, at: i, text: `${tokens[i]} ${tokens[i + 1]}` });
  }
  return violations;
}

module.exports = {
  WORD_CLASSES,
  NUMBER_SWAPS,
  buildLexicon,
  tokenize,
  proposeAdjacencyConstraints,
  countAdjacencies,
  mutateNumberAgreement,
  induceConstraints,
  checkSentence
};
