'use strict';

/**
 * Learning word classes from usage instead of being handed them.
 *
 * Every version of this lane so far carried the same caveat: the word classes were written by me from
 * knowledge of English, and only which *combinations* were forbidden was learned. That is a large
 * thing to be given. It also blocked the obvious fix for v2's faults -- complementizer "that", degree
 * adverb "this many", noun-reading "does" -- which all need to know a word's category in context.
 *
 * The obvious instrument for that is a part-of-speech tagger, and nltk's is installed. It is also a
 * statistical model trained by someone else, and putting it in the answer path is what VISION.md
 * section 3 rules out. So the classes are induced here instead: from the distributional hypothesis,
 * that words appearing in similar contexts belong to similar categories. Nothing pretrained, nothing
 * downloaded, and the result is a table you can read.
 *
 * The risk, stated before running
 * -------------------------------
 * Distributional clustering groups words by substitutability, and number-agreeing variants are highly
 * substitutable. "The result is ready" and "The results are ready" put `is` and `are` in near-identical
 * company. If the induced classes merge them, then class-level constraints cannot express "a plural
 * determiner is not followed by a singular verb" at all, because both verbs would be one class -- and
 * the whole class-based approach would need the number distinction supplied from outside, which is
 * where it started.
 *
 * That is a real possible outcome and it is worth more than a good number: it would say that
 * agreement is not recoverable from distribution alone at this corpus size, which is a fact about the
 * method rather than a fact about the run.
 */

/** Tokens, lowercased. Punctuation dropped; sentence boundaries preserved by the caller. */
function tokenize(text) {
  return String(text).toLowerCase().match(/[a-z']+/g) || [];
}

function countFrequencies(sentences) {
  const counts = new Map();
  for (const sentence of sentences) {
    for (const token of tokenize(sentence)) counts.set(token, (counts.get(token) || 0) + 1);
  }
  return counts;
}

function topWords(counts, limit) {
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, limit).map(entry => entry[0]);
}

/**
 * Context vectors, PPMI-weighted.
 *
 * Raw counts let frequent context words dominate every vector, so `the` on the left would swamp the
 * signal that actually distinguishes categories. Positive pointwise mutual information asks instead
 * how much more often a pairing occurs than chance would predict, which is what makes the rare but
 * discriminating contexts visible.
 *
 * Left and right neighbours occupy separate dimensions. Direction is most of the signal: determiners
 * are defined by what follows them, and merging the two halves would erase that.
 */
function buildContextVectors(sentences, targets, contextWords) {
  const targetSet = new Set(targets);
  const contextIndex = new Map(contextWords.map((word, index) => [word, index]));
  const width = contextWords.length;
  const vectors = new Map(targets.map(word => [word, new Float64Array(width * 2)]));

  const pairTotals = new Float64Array(width * 2);
  const targetTotals = new Map(targets.map(word => [word, 0]));
  let grandTotal = 0;

  for (const sentence of sentences) {
    const tokens = tokenize(sentence);
    for (let i = 0; i < tokens.length; i += 1) {
      const token = tokens[i];
      if (!targetSet.has(token)) continue;
      const vector = vectors.get(token);
      const left = i > 0 ? contextIndex.get(tokens[i - 1]) : undefined;
      const right = i + 1 < tokens.length ? contextIndex.get(tokens[i + 1]) : undefined;
      if (left !== undefined) {
        vector[left] += 1; pairTotals[left] += 1;
        targetTotals.set(token, targetTotals.get(token) + 1); grandTotal += 1;
      }
      if (right !== undefined) {
        vector[width + right] += 1; pairTotals[width + right] += 1;
        targetTotals.set(token, targetTotals.get(token) + 1); grandTotal += 1;
      }
    }
  }

  for (const [word, vector] of vectors) {
    const rowTotal = targetTotals.get(word) || 1;
    let norm = 0;
    for (let d = 0; d < vector.length; d += 1) {
      if (vector[d] === 0) continue;
      const pmi = Math.log((vector[d] * grandTotal) / (rowTotal * (pairTotals[d] || 1)));
      vector[d] = pmi > 0 ? pmi : 0;
      norm += vector[d] * vector[d];
    }
    norm = Math.sqrt(norm) || 1;
    for (let d = 0; d < vector.length; d += 1) vector[d] /= norm;
  }
  return vectors;
}

function cosine(a, b) {
  let sum = 0;
  for (let i = 0; i < a.length; i += 1) sum += a[i] * b[i];
  return sum;
}

/**
 * Spherical k-means over the unit-normalised vectors.
 *
 * Seeded deterministically from the frequency order rather than at random, so a run is reproducible
 * and a changed result means changed input rather than a changed dice roll.
 */
function clusterWords(vectors, k, iterations = 25) {
  const words = [...vectors.keys()];
  const width = vectors.get(words[0]).length;
  const centroids = [];
  const stride = Math.max(1, Math.floor(words.length / k));
  for (let i = 0; i < k; i += 1) centroids.push(Float64Array.from(vectors.get(words[i * stride % words.length])));

  let assignment = new Map();
  for (let iteration = 0; iteration < iterations; iteration += 1) {
    const next = new Map();
    for (const word of words) {
      const vector = vectors.get(word);
      let best = 0;
      let bestScore = -Infinity;
      for (let c = 0; c < k; c += 1) {
        const score = cosine(vector, centroids[c]);
        if (score > bestScore) { bestScore = score; best = c; }
      }
      next.set(word, best);
    }
    let changed = false;
    for (const word of words) if (next.get(word) !== assignment.get(word)) { changed = true; break; }
    assignment = next;
    if (!changed && iteration > 0) break;

    for (let c = 0; c < k; c += 1) centroids[c] = new Float64Array(width);
    for (const word of words) {
      const vector = vectors.get(word);
      const centroid = centroids[assignment.get(word)];
      for (let d = 0; d < width; d += 1) centroid[d] += vector[d];
    }
    for (let c = 0; c < k; c += 1) {
      let norm = 0;
      for (let d = 0; d < width; d += 1) norm += centroids[c][d] * centroids[c][d];
      norm = Math.sqrt(norm) || 1;
      for (let d = 0; d < width; d += 1) centroids[c][d] /= norm;
    }
  }
  return assignment;
}

/**
 * Induce word classes from a corpus.
 *
 * @param {string[]} sentences
 * @param {object} [options]
 * @param {number} [options.targets=400]  word types to classify, by frequency
 * @param {number} [options.contexts=200] context words forming the vector space
 * @param {number} [options.classes=14]   number of induced classes
 */
function induceWordClasses(sentences, options = {}) {
  const { targets = 400, contexts = 200, classes = 14 } = options;
  const frequencies = countFrequencies(sentences);
  const targetWords = topWords(frequencies, targets);
  const contextWords = topWords(frequencies, contexts);
  const vectors = buildContextVectors(sentences, targetWords, contextWords);
  const assignment = clusterWords(vectors, classes);

  const grouped = new Map();
  for (const [word, cluster] of assignment) {
    if (!grouped.has(cluster)) grouped.set(cluster, []);
    grouped.get(cluster).push(word);
  }
  for (const [, members] of grouped) {
    members.sort((a, b) => (frequencies.get(b) || 0) - (frequencies.get(a) || 0));
  }

  return {
    wordToClass: Object.fromEntries([...assignment].map(([word, cluster]) => [word, `C${cluster}`])),
    classes: Object.fromEntries([...grouped].map(([cluster, members]) => [`C${cluster}`, members])),
    frequencies,
    targetWords,
    contextWords
  };
}

/**
 * Did the induced classes recover the number distinction?
 *
 * The one question that decides whether class-level agreement constraints are expressible at all. If
 * `is` and `are` share a class, they are not.
 */
function numberSeparationReport(wordToClass) {
  const pairs = [['is', 'are'], ['was', 'were'], ['has', 'have'], ['does', 'do'], ['this', 'these']];
  return pairs.map(([singular, plural]) => ({
    pair: `${singular}/${plural}`,
    singularClass: wordToClass[singular] || null,
    pluralClass: wordToClass[plural] || null,
    separated: Boolean(wordToClass[singular]) && Boolean(wordToClass[plural])
      && wordToClass[singular] !== wordToClass[plural]
  }));
}

module.exports = {
  tokenize,
  countFrequencies,
  topWords,
  buildContextVectors,
  clusterWords,
  induceWordClasses,
  numberSeparationReport
};
