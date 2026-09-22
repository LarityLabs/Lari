#!/usr/bin/env node
'use strict';
const fs = require('fs');
/**
 * lari_construction_discovery.js — Small Lari's construction-DISCOVERY layer.
 *
 * The induction loop (lari_semantic_induction.js) learns executable semantic
 * operators from 2-4 TAUGHT examples. This module closes the open-ended gap:
 * it discovers candidate constructions from RAW DIALOGUE with no labels, no
 * teaching, and no lexicon of known markers.
 *
 * Pipeline:
 *   1. INPUT: raw dialogue turns (synthetic noisy corpus generator included;
 *      Greg will not chat for hours, so validation is synthetic).
 *   2. PATTERN MINING: structural template extraction — sentence-initial
 *      1-3 grams and interior words as candidate markers, boundary
 *      punctuation, two role spans. Cluster by (marker, order, boundary).
 *      This is structural recurrence counting, NOT n-gram language modeling:
 *      we never estimate P(word|context), only count stable templates.
 *   3. SUBSUMPTION: over-captured markers ("admittedly the", "even")
 *      collapse to the longest boundary-anchored form; determiner-tailed
 *      markers are dropped.
 *   4. PROPOSAL: support (distinct dialogues), vocabulary diversity, and
 *      two-role structure filter clusters into proposals, ranked.
 *   5. TRUTH INFERENCE (weaker supervision): later-turn outcome statements
 *      vote per-role true/false via keyword overlap + polarity. Contradictory
 *      or absent evidence -> truth UNKNOWN -> candidate stays UNQUALIFIED.
 *      Honest: never guessed.
 *   6. DEDUP: proposals matching an existing seeded family count as
 *      rediscovery (recall), not novelty.
 *   7. REGISTRATION: novel proposals with resolved truth register via
 *      sem.registerDiscoveredConstruction(), entering the EXISTING 7-gate
 *      qualification protocol. Nothing persists without passing all gates.
 *
 * Deterministic: mulberry32-seeded corpus generation, ordered iteration,
 * sorted outputs. Zero external model calls. Observation only.
 */
'use strict';

const path = require('path');
const sem = require(path.join(__dirname, 'lari_semantic_induction.js'));

// ---------------------------------------------------------------------------
// Deterministic PRNG
// ---------------------------------------------------------------------------
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffle(arr, rnd) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function pick(arr, rnd) { return arr[Math.floor(rnd() * arr.length)]; }

// ---------------------------------------------------------------------------
// Small text utilities (local copies; discovery must not depend on
// unexported induction internals)
// ---------------------------------------------------------------------------
function cleanSpan(span) {
  return String(span || '')
    .replace(/^[\s,;:"'“”‘’()\-–—]+/, '')
    .replace(/[\s,;:"'“”‘’()\-–—.!?]+$/, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function validSpan(span) {
  const s = cleanSpan(span);
  if (s.length < 3) return false;
  if (!/[a-z]/i.test(s)) return false;
  if (s.split(/\s+/).length < 2) return false;
  return true;
}

// Closed-class words: never construction markers. This is a stopword list,
// not a construction lexicon — it contains no construction's content.
const STOPWORDS = new Set([
  'i', 'you', 'he', 'she', 'it', 'we', 'they', 'me', 'him', 'her', 'us', 'them',
  'my', 'your', 'his', 'our', 'their', 'its',
  'the', 'a', 'an', 'this', 'that', 'these', 'those',
  'is', 'are', 'was', 'were', 'be', 'been', 'being', 'am',
  'do', 'does', 'did', 'doing', 'done',
  'have', 'has', 'had', 'having',
  'will', 'would', 'shall', 'should', 'can', 'could', 'may', 'might', 'must',
  'of', 'in', 'on', 'at', 'by', 'for', 'with', 'about', 'into', 'over',
  'from', 'to', 'and', 'or', 'but', 'not', 'no', 'nor',
  'as', 'that', 'which', 'who', 'whom', 'whose',
  'what', 'when', 'where', 'why', 'how',
  'there', 'here', 'then', 'very', 'just', 'also', 'too',
  "i'm", "you're", "he's", "she's", "it's", "we're", "they're",
  "i've", "you've", "we've", "they've", "don't", "doesn't", "didn't",
  "isn't", "aren't", "wasn't", "weren't", "can't", "won't", "it's",
  'oh', 'well', 'hmm', 'hey', 'hi', 'hello', 'yeah', 'yes',
]);

const DETERMINERS = new Set([
  'the', 'a', 'an', 'this', 'these', 'those',
  'my', 'your', 'his', 'her', 'its', 'our', 'their',
  'i', 'you', 'he', 'she', 'it', 'we', 'they',
]);

function contentWords(text) {
  return String(text || '').toLowerCase().split(/[^a-z']+/)
    .map(w => w.replace(/^'+|'+$/g, ''))
    .filter(w => w.length >= 4 && !STOPWORDS.has(w));
}

function markerWordsAllStop(marker) {
  const ws = String(marker).toLowerCase().split(/\s+/).filter(Boolean);
  return ws.length > 0 && ws.every(w => STOPWORDS.has(w));
}

function normWord(w) {
  return String(w || '').toLowerCase().replace(/^[^a-z']+|[^a-z']+$/g, '');
}

// ---------------------------------------------------------------------------
// Synthetic noisy dialogue corpus generator.
// Ground truth is kept OUTSIDE the dialogues: discover() only sees raw text.
// ---------------------------------------------------------------------------
const LATENTS = [
  {
    id: 'cause', known: true, order: 'front', boundary: 'comma',
    signatures: [['because', 'front', 'comma']],
    instances: [
      ['the dam cracked', 'the valley flooded', 'dam cracked', 'valley flooded'],
      ['the server overheated', 'the website went offline', 'server overheated', 'website went offline'],
      ['the chef resigned', 'the restaurant changed its menu', 'chef resigned', 'restaurant changed'],
      ['the alarm malfunctioned', 'the factory stayed open late', 'alarm malfunctioned', 'factory stayed open'],
      ['the river flooded', 'the bridge was closed', 'river flooded', 'bridge was closed'],
      ['the storm hit hard', 'the roads washed out', 'storm hit', 'roads washed'],
      ['the funding dried up', 'the laboratory closed', 'funding dried', 'laboratory closed'],
      ['the quarterback was injured', 'the team lost the game', 'quarterback injured', 'team lost'],
      ['the volcano erupted', 'nearby villages evacuated', 'volcano erupted', 'villages evacuated'],
      ['the batteries died', 'the flashlight went dark', 'batteries died', 'flashlight went dark'],
      ['the roads iced over', 'school was cancelled', 'roads iced', 'school cancelled'],
      ['the winds shifted', 'the fire spread east', 'winds shifted', 'fire spread'],
      ['the bridge collapsed', 'the town was isolated', 'bridge collapsed', 'town isolated'],
      ['the pipes burst', 'the basement flooded', 'pipes burst', 'basement flooded'],
    ],
    text: (r1, r2) => `Because ${r1}, ${r2}.`,
    outcomes: (kw1, kw2, rnd) => [
      { text: `It really happened — ${kw1}.` },
      { text: `It really happened — ${kw2}.` },
    ],
  },
  {
    id: 'contrast', known: true, order: 'front', boundary: 'comma',
    signatures: [['although', 'front', 'comma'], ['though', 'front', 'comma'], ['even though', 'front', 'comma']],
    instances: [
      ['it rained', 'the game continued', 'it rained', 'game continued'],
      ['the desert is hot', 'the nights are freezing', 'desert hot', 'nights freezing'],
      ['the soup was salty', 'the children ate it', 'soup salty', 'children ate'],
      ['the car is old', 'the engine runs smoothly', 'car old', 'engine runs'],
      ['the exam was difficult', 'she passed with ease', 'exam difficult', 'passed ease'],
      ['the movie was long', 'the audience stayed', 'movie long', 'audience stayed'],
      ['the phone is cheap', 'the camera is excellent', 'phone cheap', 'camera excellent'],
      ['the road was narrow', 'the bus navigated it', 'road narrow', 'bus navigated'],
      ['the night was cold', 'the travelers pressed on', 'night cold', 'travelers pressed'],
      ['the winter was harsh', 'the garden survived', 'winter harsh', 'garden survived'],
      ['the hotel was crowded', 'the staff remained polite', 'hotel crowded', 'staff polite'],
      ['the software was expensive', 'the company bought it', 'software expensive', 'company bought'],
      ['the mountain is tall', 'the climb was quick', 'mountain tall', 'climb quick'],
      ['the river is wide', 'the bridge spans it', 'river wide', 'bridge spans'],
    ],
    text: (r1, r2, rnd) => {
      const m = pick(['Although', 'Though', 'Even though'], rnd);
      return `${m} ${r1}, ${r2}.`;
    },
    outcomes: (kw1, kw2, rnd) => [
      { text: `It really happened — ${kw1}.` },
      { text: `It really happened — ${kw2}.` },
    ],
  },
  {
    id: 'condition', known: true, order: 'front', boundary: 'comma',
    signatures: [['if', 'front', 'comma']],
    instances: [
      ['it rains', 'we will cancel the trip', 'it rains', 'cancel trip'],
      ['the alarm rings', 'the guards will respond', 'alarm rings', 'guards respond'],
      ['the ice melts', 'the river will flood', 'ice melts', 'river flood'],
      ['the battery dies', 'the radio goes silent', 'battery dies', 'radio silent'],
      ['the wind picks up', 'the sailors reef the sails', 'wind picks', 'sailors reef'],
      ['the printer jams', 'the office calls support', 'printer jams', 'office calls'],
      ['the seeds sprout', 'the farmer transplants them', 'seeds sprout', 'farmer transplants'],
      ['the tide rises', 'the boats float free', 'tide rises', 'boats float'],
      ['the code compiles', 'the tests will run', 'code compiles', 'tests run'],
      ['the fever breaks', 'the patient can go home', 'fever breaks', 'patient home'],
      ['the train is late', 'we will miss the connection', 'train late', 'miss connection'],
      ['the dough rises', 'the bread will be fluffy', 'dough rises', 'bread fluffy'],
      ['the gate opens', 'the crowd rushes in', 'gate opens', 'crowd rushes'],
      ['the boss calls', 'the meeting starts early', 'boss calls', 'meeting starts'],
    ],
    text: (r1, r2) => `If ${r1}, ${r2}.`,
    outcomes: null, // hypothetical: no outcome evidence by design
  },
  {
    id: 'purpose', known: true, order: 'mid', boundary: 'none',
    signatures: [['so that', 'mid', 'none']],
    instances: [
      ['She saved money', 'she could travel', 'saved money', 'could travel'],
      ['He studied hard', 'he could pass the exam', 'studied hard', 'pass exam'],
      ['They left early', 'they could beat traffic', 'left early', 'beat traffic'],
      ['She whispered', 'the baby would stay asleep', 'whispered', 'baby asleep'],
      ['He wore a jacket', 'he would stay warm', 'wore jacket', 'stay warm'],
      ['They hired a guide', 'they would not get lost', 'hired guide', 'not lost'],
      ['She set an alarm', 'she would wake up on time', 'set alarm', 'wake time'],
      ['He took notes', 'he would remember the details', 'took notes', 'remember details'],
      ['They locked the doors', 'the house would stay safe', 'locked doors', 'house safe'],
      ['She packed snacks', 'the kids would not complain', 'packed snacks', 'not complain'],
      ['He called ahead', 'the table would be ready', 'called ahead', 'table ready'],
      ['They brought maps', 'they could find the trail', 'brought maps', 'find trail'],
      ['She dimmed the lights', 'the room would feel calm', 'dimmed lights', 'room calm'],
      ['He charged his phone', 'it would last the day', 'charged phone', 'last day'],
    ],
    text: (r1, r2) => `${r1} so that ${r2}.`,
    outcomes: null, // intentional: intentional modality, no outcome evidence
  },
  // ---- novel constructions (discovery must find AND infer truth) ----
  {
    id: 'seq', known: false, order: 'front', boundary: 'comma',
    signatures: [['after', 'front', 'comma'], ['before', 'front', 'comma']],
    instances: [
      ['the meeting ended', 'we went to lunch', 'meeting ended', 'went lunch', 'after'],
      ['the movie finished', 'they walked home', 'movie finished', 'walked home', 'after'],
      ['the rain stopped', 'the kids went outside', 'rain stopped', 'kids outside', 'after'],
      ['dinner was served', 'the guests sat down', 'dinner served', 'guests sat', 'after'],
      ['the alarm rang', 'she jumped up', 'alarm rang', 'jumped up', 'after'],
      ['the game ended', 'the crowd left', 'game ended', 'crowd left', 'after'],
      ['the lesson finished', 'the students packed up', 'lesson finished', 'students packed', 'after'],
      ['the guests arrived', 'we set the table', 'guests arrived', 'set table', 'before'],
      ['the sun rose', 'they started hiking', 'sun rose', 'started hiking', 'before'],
      ['the store closed', 'he bought milk', 'store closed', 'bought milk', 'before'],
      ['the show started', 'we found seats', 'show started', 'found seats', 'before'],
      ['winter came', 'they stacked firewood', 'winter came', 'stacked firewood', 'before'],
      ['the bell rang', 'the kids lined up', 'bell rang', 'kids lined', 'before'],
      ['the flight landed', 'she turned on her phone', 'flight landed', 'turned phone', 'before'],
    ],
    text: (r1, r2, rnd, inst) => {
      const m = inst[4] === 'before' ? 'Before' : 'After';
      return `${m} ${r1}, ${r2}.`;
    },
    outcomes: (kw1, kw2, rnd) => [
      { text: `It really happened — ${kw1}.` },
      { text: `It really happened — ${kw2}.` },
    ],
  },
  {
    id: 'comparison', known: false, order: 'mid', boundary: 'none',
    signatures: [['than', 'mid', 'none']],
    instances: [
      ['the new tower is taller', 'the old one', 'tower taller', 'old one'],
      ['my car is faster', 'your truck', 'car faster', 'your truck'],
      ['this road is longer', 'the highway', 'road longer', 'highway'],
      ['her hair is darker', "her sister's", 'hair darker', 'sister'],
      ['the sequel was funnier', 'the original', 'sequel funnier', 'original'],
      ['his dog is bigger', "the neighbor's cat", 'dog bigger', 'neighbor cat'],
      ['the night train is cheaper', 'the morning flight', 'train cheaper', 'morning flight'],
      ['this puzzle is harder', 'the last one', 'puzzle harder', 'last one'],
      ['the lake is deeper', 'the river', 'lake deeper', 'river'],
      ['their house is bigger', 'our apartment', 'house bigger', 'apartment'],
      ['the new phone is lighter', 'the old model', 'phone lighter', 'old model'],
      ['this coffee is stronger', 'the decaf', 'coffee stronger', 'decaf'],
      ['the mountain trail is steeper', 'the valley path', 'trail steeper', 'valley path'],
      ['her argument was clearer', 'his rambling reply', 'argument clearer', 'rambling reply'],
    ],
    text: (r1, r2) => `The ${r1} than ${r2}.`.replace(/^The the/, 'The'),
    outcomes: (kw1, kw2, rnd) => [
      { text: `That's true — ${kw1}.` },
      { text: `That's true — ${kw2}.` },
    ],
  },
  {
    id: 'prevention', known: false, order: 'mid', boundary: 'none',
    signatures: [['prevented', 'mid', 'none'], ['stopped', 'mid', 'none']],
    instances: [
      ['The heavy rain', 'the match from starting', 'heavy rain', 'match starting'],
      ['The traffic jam', 'her from arriving on time', 'traffic jam', 'arriving time'],
      ['The power outage', 'the servers from restarting', 'power outage', 'servers restarting'],
      ['His injury', 'him from playing', 'injury', 'from playing'],
      ['The snowstorm', 'the flights from departing', 'snowstorm', 'flights departing'],
      ['The broken lock', 'the door from opening', 'broken lock', 'door opening'],
      ['Her headache', 'her from concentrating', 'headache', 'concentrating'],
      ['The flood', 'the trucks from crossing', 'flood', 'trucks crossing'],
      ['The loud alarm', 'them from sleeping', 'loud alarm', 'from sleeping'],
      ['The missing key', 'us from entering', 'missing key', 'from entering'],
      ['The storm', 'the boats from leaving', 'storm', 'boats leaving'],
      ['His cold', 'him from singing', 'cold', 'from singing'],
      ['The roadblock', 'the parade from passing', 'roadblock', 'parade passing'],
      ['The glitch', 'the upload from finishing', 'glitch', 'upload finishing'],
    ],
    text: (r1, r2, rnd) => `${r1} ${pick(['prevented', 'stopped'], rnd)} ${r2}.`,
    // truth: a=true (preventer acted), b=false (prevented event did not happen)
    outcomes: (kw1, kw2, rnd) => [
      { text: `It really happened — ${kw1}.`, truthRole: 'a' },
      { text: `${cap(kw2)} never happened.`, truthRole: 'b' },
    ],
  },
  {
    id: 'admittedly', known: false, order: 'front', boundary: 'comma',
    signatures: [['admittedly', 'front', 'comma']],
    instances: [
      ['the food was cold', 'the service was excellent', 'food cold', 'service excellent'],
      ['the room was small', 'the view was stunning', 'room small', 'view stunning'],
      ['the drive was long', 'the destination was worth it', 'drive long', 'destination worth'],
      ['the price was high', 'the quality was superb', 'price high', 'quality superb'],
      ['the weather was awful', 'the trip was fun', 'weather awful', 'trip fun'],
      ['the line was endless', 'the concert was amazing', 'line endless', 'concert amazing'],
      ['the hotel was dated', 'the staff was lovely', 'hotel dated', 'staff lovely'],
      ['the work was tedious', 'the pay was great', 'work tedious', 'pay great'],
      ['the movie was slow', 'the ending was perfect', 'movie slow', 'ending perfect'],
      ['the hike was brutal', 'the summit was breathtaking', 'hike brutal', 'summit breathtaking'],
      ['the wait was annoying', 'the meal was delicious', 'wait annoying', 'meal delicious'],
      ['the flight was delayed', 'the crew was kind', 'flight delayed', 'crew kind'],
      ['the exam was hard', 'the curve was generous', 'exam hard', 'curve generous'],
      ['the apartment was tiny', 'the location was perfect', 'apartment tiny', 'location perfect'],
    ],
    text: (r1, r2) => `Admittedly ${r1}, ${r2}.`,
    outcomes: (kw1, kw2, rnd) => [
      { text: `${cap(kw1)} — that's true.` },
      { text: `${cap(kw2)} — that's true.` },
    ],
  },
];

function cap(s) { const t = String(s); return t.charAt(0).toUpperCase() + t.slice(1); }

const DECOYS = [
  {
    id: 'you_know',
    texts: [
      'You know, I think we should just leave early.', "It's, you know, getting really late.",
      'You know, that movie was actually great.', "She's, you know, hard to read sometimes.",
      'You know, we could try the other road.', "He's, you know, not great with names.",
      'You know, I forgot my keys again.', "That's, you know, just how it goes.",
    ],
  },
  {
    id: 'i_mean',
    texts: [
      "I mean, that's just my opinion.", 'I mean, we tried our best.',
      'I mean, who really knows?', "I mean, it's not a big deal.",
      'I mean, take your time.', 'I mean, fair enough.',
      'I mean, let us just see.', 'I mean, no worries.',
    ],
  },
  {
    id: 'by_the_way',
    texts: [
      'By the way, the store closes at nine.', 'By the way, did you feed the cat?',
      'By the way, mom called earlier.', 'By the way, the meeting moved to three.',
      "By the way, I found your charger.", 'By the way, it might rain tomorrow.',
      'By the way, the wifi password changed.', "By the way, we're out of milk.",
    ],
  },
  {
    id: 'well',
    texts: [
      "Well, that's really interesting.", 'Well, I never thought of that.',
      'Well, what can you do?', "Well, that's just great.",
      'Well, let me check the schedule.', 'Well, no surprise there.',
      'Well, good luck then.', "Well, that's a first.",
    ],
  },
  {
    id: 'speaking_of', twoRole: true,
    texts: [
      'Speaking of the big dinner party, did you remember to call your mother?',
      'Speaking of the new restaurant downtown, have you tried their pasta?',
      'Speaking of the long road trip, did you pack the cooler?',
      'Speaking of the boring meeting, did anyone take notes?',
      'Speaking of the loud neighbors, did you hear them last night?',
      'Speaking of the broken dishwasher, did the repair guy come?',
      'Speaking of the weekend hike, are your boots dry yet?',
      'Speaking of the final exam, did you study chapter five?',
    ],
    topicKw: ['dinner party', 'restaurant downtown', 'road trip', 'boring meeting', 'loud neighbors', 'broken dishwasher', 'weekend hike', 'final exam'],
    // contradictory outcomes: votes cancel -> UNKNOWN -> rejected
    outcomes: (kw) => [
      { text: `The ${kw} really was amazing.` },
      { text: `Actually there was no ${kw}.` },
    ],
  },
  {
    id: 'as_for', twoRole: true,
    texts: [
      'As for the budget cuts, we will discuss them tomorrow.',
      'As for the new policy, nobody understands it yet.',
      "As for the broken fence, I'll fix it Sunday.",
      'As for your question, I need more time.',
      'As for the trip refunds, they are still processing.',
      'As for the noise complaint, it was not us.',
      'As for the late delivery, they apologized twice.',
      'As for the schedule change, check your email.',
    ],
    topicKw: ['budget cuts', 'new policy', 'broken fence', 'your question', 'trip refunds', 'noise complaint', 'late delivery', 'schedule change'],
    outcomes: (kw) => [
      { text: `Those ${kw} really happened.` },
      { text: `Actually there were no ${kw}.` },
    ],
  },
];

const NOISE_TURNS = [
  'How was your weekend?', 'Pretty good, yours?', 'Did you see the game last night?',
  'I need more coffee.', 'What time is it?', 'Hmm, let me think.', 'Oh wow, really?',
  "That's interesting.", 'I dunno.', 'Maybe later.', 'Sounds good to me.',
  'Did you sleep well?', 'The weather is nice today.', 'I forgot my umbrella.',
  'Have you eaten yet?', 'Let us grab lunch sometime.', 'My phone is dying.',
  'Did you hear about the parade?', 'I should get going soon.', 'Nice talking to you.',
  'What did you have for breakfast?', 'The traffic was awful.', 'I love this song.',
  'Can you send me the address?',
];

const CORRECTION_NOISE = [
  'No wait, I meant Tuesday.', 'Sorry, I said Friday, not Thursday.',
  'Let me rephrase: the red one.',
];

function typoWord(word, rnd) {
  if (word.length < 5) return word;
  const i = 1 + Math.floor(rnd() * (word.length - 3));
  return word.slice(0, i) + word[i + 1] + word[i] + word.slice(i + 2);
}

function applyTypo(text, rnd, hitMarker) {
  // hitMarker: corrupt the leading marker word; else corrupt a random long word / drop the comma.
  const words = text.split(/\s+/);
  if (hitMarker && words.length) {
    words[0] = typoWord(words[0].replace(/[^A-Za-z]/g, '') || words[0], rnd);
    return words.join(' ');
  }
  const r = rnd();
  if (r < 0.4) return text.replace(/,/, '');
  const idx = words.map((w, i) => ({ w, i })).filter(o => o.w.replace(/[^A-Za-z]/g, '').length >= 6);
  if (!idx.length) return text;
  const o = pick(idx, rnd);
  words[o.i] = typoWord(o.w, rnd);
  return words.join(' ');
}

// ---------------------------------------------------------------------------
// Corpus assembly
// ---------------------------------------------------------------------------
function buildDialogue(id, items, rnd, groundTruth) {
  const turns = [];
  let speaker = rnd() < 0.5 ? 'greg' : 'lari';
  const flip = () => { speaker = speaker === 'greg' ? 'lari' : 'greg'; return speaker; };
  const pushTurn = (text, meta) => {
    const t = { speaker: flip(), text };
    turns.push(t);
    if (meta) groundTruth.push({ dialogueId: id, turnIdx: turns.length - 1, ...meta });
    return t;
  };

  if (rnd() < 0.5) pushTurn(pick(NOISE_TURNS, rnd));
  if (rnd() < 0.12) pushTurn(pick(CORRECTION_NOISE, rnd));

  for (const item of items) {
    if (item.kind === 'latent') {
      const L = item.latent;
      const [r1, r2, kw1, kw2] = item.inst;
      let text = L.text(r1, r2, rnd, item.inst);
      // typos: 5% hit the marker, 5% hit elsewhere. Typo'd instances usually
      // miss their cluster; the support threshold absorbs the loss.
      const tr = rnd();
      let typo = null;
      if (tr < 0.05) { text = applyTypo(text, rnd, true); typo = 'marker'; }
      else if (tr < 0.10) { text = applyTypo(text, rnd, false); typo = 'other'; }
      pushTurn(text, { kind: 'latent', latentId: L.id, r1, r2, kw1, kw2, typo });
      // outcome turns: delayed 0-2 turns later, p=0.85 per role-plan entry
      if (L.outcomes && !typo) {
        const outs = L.outcomes(kw1, kw2, rnd);
        for (const o of outs) {
          if (rnd() < 0.85) {
            const gap = Math.floor(rnd() * 3); // 0-2 noise turns before the outcome
            for (let g = 0; g < gap; g++) pushTurn(pick(NOISE_TURNS, rnd));
            pushTurn(o.text);
          }
        }
      }
    } else if (item.kind === 'decoy') {
      const D = item.decoy;
      const di = item.decoyIdx;
      pushTurn(item.text, { kind: 'decoy', decoyId: D.id });
      if (D.outcomes) {
        const outs = D.outcomes(D.topicKw[di % D.topicKw.length]);
        for (const o of outs) {
          if (rnd() < 0.9) {
            if (rnd() < 0.5) pushTurn(pick(NOISE_TURNS, rnd));
            pushTurn(o.text);
          }
        }
      }
    }
    // topic-shift noise between embeddings
    if (rnd() < 0.6) pushTurn(pick(NOISE_TURNS, rnd));
  }
  if (rnd() < 0.5) pushTurn(pick(NOISE_TURNS, rnd));
  return { id, turns };
}

function generateCorpus(seed, opts = {}) {
  const rnd = mulberry32(seed);
  const groundTruth = [];
  const items = [];
  for (const L of LATENTS) {
    L.instances.forEach((inst) => items.push({ kind: 'latent', latent: L, inst }));
  }
  DECOYS.forEach((D) => {
    D.texts.forEach((t, i) => items.push({ kind: 'decoy', decoy: D, decoyIdx: i, text: t }));
  });
  shuffle(items, rnd);
  const dialogues = [];
  let dlgId = 0;
  while (items.length) {
    const n = Math.min(items.length, 2 + Math.floor(rnd() * 3));
    dialogues.push(buildDialogue(dlgId++, items.splice(0, n), rnd, groundTruth));
  }
  const noiseDialogues = opts.noiseDialogues == null ? 8 : opts.noiseDialogues;
  for (let i = 0; i < noiseDialogues; i++) {
    const turns = [];
    let speaker = 'greg';
    const n = 4 + Math.floor(rnd() * 4);
    for (let k = 0; k < n; k++) {
      speaker = speaker === 'greg' ? 'lari' : 'greg';
      turns.push({ speaker, text: pick(NOISE_TURNS, rnd) });
    }
    dialogues.push({ id: dlgId++, turns });
  }
  const stats = {
    seed,
    dialogues: dialogues.length,
    turns: dialogues.reduce((a, d) => a + d.turns.length, 0),
    latentEmbeddings: groundTruth.filter(g => g.kind === 'latent').length,
    decoyEmbeddings: groundTruth.filter(g => g.kind === 'decoy').length,
    typoInstances: groundTruth.filter(g => g.typo).length,
  };
  return { dialogues, groundTruth, stats };
}

// Raw view: what discover() is allowed to see (no ground truth).
function rawDialogues(corpus) {
  return corpus.dialogues.map(d => ({ id: d.id, turns: d.turns.map(t => ({ speaker: t.speaker, text: t.text })) }));
}

// ---------------------------------------------------------------------------
// Structural template extraction (no lexicon, no language modeling)
// ---------------------------------------------------------------------------
function extractFrontTemplates(text) {
  const src = String(text || '').trim().replace(/[.!?]+$/, '');
  const words = src.split(/\s+/).filter(Boolean);
  const out = [];
  for (let n = 1; n <= 3 && n < words.length; n++) {
    const mw = words.slice(0, n).map(normWord);
    if (mw.some(w => !/^[a-z][a-z']*$/.test(w))) break;
    let marker = mw.join(' ');
    // "because of X" -> "because": the case particle "of" is not marker material.
    // (Targeted: only "because of" is normalized; "speaking of" keeps its "of".)
    if (n > 1 && mw[mw.length - 1] === 'of' && mw.slice(0, -1).join(' ') === 'because') {
      marker = 'because';
    }
    const rest = words.slice(n).join(' ');
    const ci = rest.search(/[,;]/);
    if (ci < 0) continue; // front templates REQUIRE an explicit boundary
    const boundary = rest[ci] === ';' ? 'semicolon' : 'comma';
    const role1 = cleanSpan(rest.slice(0, ci));
    const role2 = cleanSpan(rest.slice(ci + 1));
    if (!validSpan(role1) || !validSpan(role2)) continue;
    out.push({ marker, order: 'front', boundary, role1, role2 });
  }
  return out;
}

function extractMidTemplates(text) {
  const src = String(text || '').trim().replace(/[.!?]+$/, '');
  const words = src.split(/\s+/).filter(Boolean).map(normWord);
  const out = [];
  const pushCand = (marker, i, j) => {
    if (!marker || markerWordsAllStop(marker)) return;
    const left = cleanSpan(words.slice(0, i).join(' '));
    const right = cleanSpan(words.slice(j).join(' '));
    if (!validSpan(left) || !validSpan(right)) return;
    out.push({ marker, order: 'mid', boundary: 'none', role1: left, role2: right });
  };
  for (let i = 1; i < words.length - 1; i++) {
    const w = words[i];
    if (!/^[a-z][a-z']*$/.test(w)) continue;
    pushCand(w, i, i + 1);
    // two-word markers ("so that"): allowed when the first word is not a stopword
    if (i + 2 < words.length) {
      const w2 = words[i + 1];
      if (/^[a-z][a-z']*$/.test(w2) && !STOPWORDS.has(w)) {
        pushCand(`${w} ${w2}`, i, i + 2);
      }
    }
  }
  return out;
}

function extractTemplates(text) {
  return extractFrontTemplates(text).concat(extractMidTemplates(text));
}

// ---------------------------------------------------------------------------
// Clustering + subsumption + structural proposal
// ---------------------------------------------------------------------------
const MIN_DIALOGUES = 3;
const MIN_DIVERSITY = 6;

function clusterKey(t) { return `${t.order}|${t.boundary}|${t.marker}`; }

function mineClusters(dialogues) {
  const clusters = new Map();
  for (const d of dialogues) {
    d.turns.forEach((t, turnIdx) => {
      for (const tpl of extractTemplates(t.text)) {
        const key = clusterKey(tpl);
        if (!clusters.has(key)) {
          clusters.set(key, {
            marker: tpl.marker, order: tpl.order, boundary: tpl.boundary,
            dialogues: new Set(), instances: [],
          });
        }
        const c = clusters.get(key);
        c.dialogues.add(d.id);
        c.instances.push({ dialogueId: d.id, turnIdx, text: t.text, role1: tpl.role1, role2: tpl.role2 });
      }
    });
  }
  return [...clusters.values()];
}

function utteranceSet(c) {
  return c.instances.map(i => `${i.dialogueId}:${i.turnIdx}`).sort().join('\n');
}

// Subsumption: collapse over-captured markers to the longest valid form.
function applySubsumption(clusters) {
  // Rule 1: drop markers ending in a determiner/pronoun ("admittedly the").
  let kept = clusters.filter(c => {
    const last = c.marker.split(/\s+/).pop();
    return !DETERMINERS.has(last);
  });
  // Rule 2: drop clusters whose role1 is invalid in >30% of instances
  // (re-check; extraction already required validity, this is belt-and-braces
  // for merged/edge cases).
  kept = kept.filter(c => {
    const bad = c.instances.filter(i => !validSpan(i.role1) || !validSpan(i.role2)).length;
    return bad / c.instances.length <= 0.3;
  });
  // Rule 3: word-prefix subsumption on identical utterance sets -> keep longest.
  const byShape = new Map();
  for (const c of kept) {
    const k = `${c.order}|${c.boundary}`;
    if (!byShape.has(k)) byShape.set(k, []);
    byShape.get(k).push(c);
  }
  const drop = new Set();
  for (const group of byShape.values()) {
    const withSets = group.map(c => ({ c, set: utteranceSet(c) }));
    for (let i = 0; i < withSets.length; i++) {
      for (let j = 0; j < withSets.length; j++) {
        if (i === j) continue;
        const A = withSets[i].c, B = withSets[j].c;
        const aw = A.marker.split(/\s+/), bw = B.marker.split(/\s+/);
        const aPrefixOfB = bw.length > aw.length && aw.every((w, k) => bw[k] === w);
        if (aPrefixOfB && withSets[i].set === withSets[j].set) drop.add(A);
      }
    }
  }
  return kept.filter(c => !drop.has(c));
}

function proposeStructures(clusters) {
  // Marker legitimacy: a marker must never occur as a CONTENT word inside the
  // role spans of FRONT-template clusters. Front templates (explicit boundary)
  // are the reliable structural anchor; their role spans carry the corpus's
  // content vocabulary. "bridge"/"game"/"meeting" fill roles there, so they
  // are content, not markers. ("than"/"prevented"/"so" never fill roles.)
  // Role vocab comes from front clusters only: mid clusters' own roles would
  // let junk ("Because the" as a role span) pollute the vocabulary.
  const roleVocab = new Set();
  for (const c of clusters) {
    if (c.order !== 'front') continue;
    for (const i of c.instances) {
      for (const w of contentWords(i.role1).concat(contentWords(i.role2))) roleVocab.add(w);
    }
  }
  const proposals = [];
  for (const c of clusters) {
    if (c.marker.split(/\s+/).every(w => STOPWORDS.has(w))) continue;
    if (c.marker.split(/\s+/).some(w => roleVocab.has(w))) continue;
    if (c.dialogues.size < MIN_DIALOGUES) continue;
    const vocab = new Set();
    for (const i of c.instances) {
      for (const w of contentWords(i.role1).concat(contentWords(i.role2))) vocab.add(w);
    }
    if (vocab.size < MIN_DIVERSITY) continue;
    proposals.push({
      marker: c.marker, order: c.order, boundary: c.boundary,
      supportDialogues: c.dialogues.size,
      instances: c.instances.length,
      vocabDiversity: vocab.size,
      roleNames: ['a', 'b'],
      _instances: c.instances,
    });
  }
  // Deterministic rank: support desc, diversity desc, marker asc.
  proposals.sort((a, b) =>
    (b.supportDialogues - a.supportDialogues) ||
    (b.vocabDiversity - a.vocabDiversity) ||
    (a.marker < b.marker ? -1 : 1));
  return proposals;
}

// ---------------------------------------------------------------------------
// Truth inference from later-turn outcomes (weaker supervision).
// For each proposal instance, scan subsequent turns (<=4 ahead) for outcome
// statements overlapping role keywords; polarity from explicit markers.
// >=2 votes with zero opposing -> value; else UNKNOWN -> unqualified.
// ---------------------------------------------------------------------------
const NEG_RE = /\b(never|not|no|n't|nothing|failed|denied|false)\b/i;
const AFF_RE = /\b(really|actually|indeed|definitely|did happen|turns out|that's true)\b/i;
const UNKNOWN = 'UNKNOWN';

function inferTruth(proposal, dialogues) {
  const votes = { a: { t: 0, f: 0 }, b: { t: 0, f: 0 } };
  const byDialogue = new Map();
  for (const d of dialogues) byDialogue.set(d.id, d.turns);
  for (const inst of proposal._instances) {
    const turns = byDialogue.get(inst.dialogueId) || [];
    const kwA = new Set(contentWords(inst.role1));
    const kwB = new Set(contentWords(inst.role2));
    for (let k = inst.turnIdx + 1; k <= inst.turnIdx + 4 && k < turns.length; k++) {
      const text = turns[k].text;
      const toks = new Set(contentWords(text));
      const hitA = [...kwA].some(w => toks.has(w));
      const hitB = [...kwB].some(w => toks.has(w));
      if (!hitA && !hitB) continue;
      let pol = 0;
      if (NEG_RE.test(text)) pol = -1;
      else if (AFF_RE.test(text)) pol = 1;
      if (!pol) continue;
      if (hitA) { if (pol > 0) votes.a.t++; else votes.a.f++; }
      if (hitB) { if (pol > 0) votes.b.t++; else votes.b.f++; }
    }
  }
  const truth = {};
  for (const r of ['a', 'b']) {
    const v = votes[r];
    if (v.t >= 2 && v.f === 0) truth[r] = true;
    else if (v.f >= 2 && v.t === 0) truth[r] = false;
    else truth[r] = UNKNOWN;
  }
  const resolved = truth.a !== UNKNOWN && truth.b !== UNKNOWN;
  return {
    truth, resolved,
    modality: resolved ? 'actual' : UNKNOWN,
    votes: { a: { ...votes.a }, b: { ...votes.b } },
  };
}

// ---------------------------------------------------------------------------
// Dedup against the existing (seeded) candidate space
// ---------------------------------------------------------------------------
function dedupAgainstKnown(candidate) {
  // Score every order/boundary/marker-compatible family by how many of the
  // proposal's instances it actually parses (guards included). This picks
  // condition/if_front over counterfactual/cf_front for plain "if" instances:
  // the cf guard (had/would-have) fails them, so if_front outscores cf_front.
  const order = candidate.order === 'front' ? 'marker_first' : 'marker_mid';
  let best = null;
  for (const construction of sem.CONSTRUCTIONS) {
    if (construction.discovered) continue;
    for (const family of construction.families) {
      if (family.order !== order) continue;
      if (family.boundary !== candidate.boundary) continue;
      if (!candidate.markers.some(m => family.markers.includes(m))) continue;
      const allowed = family.markers.filter(m => candidate.markers.includes(m));
      let hits = 0;
      for (const inst of candidate._instances || []) {
        const text = inst.text || `${inst.role1}, ${inst.role2}`;
        try {
          if (sem.parseWithFamily(text, construction, { ...family, markers: allowed })) hits++;
        } catch (_) {}
      }
      if (!best || hits > best.hits) best = { relation: construction.relation, familyId: family.id, hits };
    }
  }
  return best && best.hits > 0 ? { relation: best.relation, familyId: best.familyId } : null;
}

function buildDiscoveredSpec(candidate) {
  // One candidate -> one relation (disc_<marker>). No cross-marker merging:
  // markers with identical truth tables are structurally indistinguishable
  // without semantic knowledge, so each stands alone. Honest, if less elegant.
  if (!candidate || candidate.status !== 'pending' || !candidate.truth) return null;
  const relName = 'disc_' + candidate.markers.map(m =>
    m.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '')).join('_');
  for (const r of ['a', 'b']) {
    if (typeof candidate.truth[r] !== 'boolean') return null;
  }
  return {
    relation: relName,
    roles: ['a', 'b'],
    families: [{
      id: `${relName}_fam`,
      markers: candidate.markers.slice(),
      order: candidate.order === 'front' ? 'marker_first' : 'marker_mid',
      boundary: candidate.boundary,
      roleOrder: ['a', 'b'],
      truth: { a: candidate.truth.a, b: candidate.truth.b },
      modality: 'actual',
    }],
    provenance: {
      discoveredBy: 'lari_construction_discovery',
      supportDialogues: candidate.supportDialogues,
      instances: candidate.instances,
      votes: candidate.votes || null,
    },
  };
}

// Discovered-spec registry + disk persistence. Specs live outside the model
// JSON (they extend the in-memory grammar); operator records live inside it.
// Cold start = loadDiscoveredSpecs(path) then read the model: both halves
// of a persisted discovery are restored.
const SPEC_REGISTRY = [];

function registerSpec(spec) {
  const reg = sem.registerDiscoveredConstruction(spec);
  if (reg.registered && !SPEC_REGISTRY.some(s => s.relation === spec.relation)) {
    SPEC_REGISTRY.push(spec);
  }
  return reg;
}

function listSpecRegistry() {
  return SPEC_REGISTRY.map(s => s.relation);
}

function saveDiscoveredSpecs(path) {
  fs.writeFileSync(path, JSON.stringify(SPEC_REGISTRY, null, 2));
  return { saved: SPEC_REGISTRY.length, path };
}

function loadDiscoveredSpecs(path) {
  const specs = JSON.parse(fs.readFileSync(path, 'utf8'));
  return specs.map(spec => {
    const r = registerSpec(spec);
    return { relation: spec.relation, registered: r.registered, reason: r.reason || null };
  });
}

// ---------------------------------------------------------------------------
// Full discovery pipeline.
//
// NOTE on merging: cross-marker merging (e.g. after+before -> one "sequence"
// construction) was tried and REMOVED. Markers with identical truth tables
// (because/although/admittedly/after all have {true,true}) are structurally
// indistinguishable without semantic knowledge; merging them is guessing.
// Each marker stands as its own proposal: honest, if less elegant. Two
// operators for after/before is a correct conservative result.
// ---------------------------------------------------------------------------
function discoverFromDialogues(dialogues) {
  const clusters = mineClusters(dialogues);
  const subsumed = applySubsumption(clusters);
  const proposals = proposeStructures(subsumed);
  const candidates = [];
  for (const p of proposals) {
    // Dedup FIRST: known constructions count as rediscovery even when the
    // corpus carries no outcome evidence (their truth is authored, e.g.
    // hypothetical "if" and intentional "so that").
    const dedup = dedupAgainstKnown({
      markers: [p.marker], order: p.order, boundary: p.boundary, _instances: p._instances,
    });
    if (dedup) {
      candidates.push({
        markers: [p.marker], order: p.order, boundary: p.boundary,
        supportDialogues: p.supportDialogues, instances: p.instances,
        vocabDiversity: p.vocabDiversity, roleNames: ['a', 'b'],
        truth: null, resolved: false, dedup, status: 'rediscovered',
        _instances: p._instances,
      });
      continue;
    }
    const t = inferTruth(p, dialogues);
    if (!t.resolved) {
      candidates.push({
        markers: [p.marker], order: p.order, boundary: p.boundary,
        supportDialogues: p.supportDialogues, instances: p.instances,
        vocabDiversity: p.vocabDiversity, roleNames: ['a', 'b'],
        truth: null, resolved: false, votes: t.votes, dedup: null,
        status: 'unqualified_unknown_truth', _instances: p._instances,
      });
      continue;
    }
    candidates.push({
      markers: [p.marker], order: p.order, boundary: p.boundary,
      supportDialogues: p.supportDialogues, instances: p.instances,
      vocabDiversity: p.vocabDiversity, roleNames: ['a', 'b'],
      truth: { ...t.truth }, resolved: true, votes: t.votes, dedup: null,
      status: 'pending', _instances: p._instances,
    });
  }
  // rank: rediscovered, then resolved novel, then support
  const rank = s => (s === 'rediscovered' ? 0 : s === 'pending' ? 1 : 2);
  candidates.sort((a, b) =>
    (rank(a.status) - rank(b.status)) ||
    (b.supportDialogues - a.supportDialogues) ||
    (a.markers.join('+') < b.markers.join('+') ? -1 : 1));
  return { clusters: clusters.length, proposals: proposals.length, candidates };
}

function discoverFromCorpus(corpus) {
  return { stats: corpus.stats, ...discoverFromDialogues(rawDialogues(corpus)) };
}

// ---------------------------------------------------------------------------
// Dialogue buffer: observation-only runtime integration. Chat turns accumulate
// here (bounded); discovery runs offline over the buffer. Never alters answers.
// ---------------------------------------------------------------------------
const BUFFER_SECTION = 'lari_dialogue_buffer';
const BUFFER_CAP = 200;

function observeUtterances(model, texts) {
  try {
    if (!model || typeof model !== 'object') return { buffered: 0 };
    if (!model[BUFFER_SECTION] || typeof model[BUFFER_SECTION] !== 'object') {
      model[BUFFER_SECTION] = { utterances: [], seq: 0 };
    }
    const buf = model[BUFFER_SECTION];
    if (!Array.isArray(buf.utterances)) buf.utterances = [];
    let n = 0;
    for (const t of texts || []) {
      const s = String(t || '').trim();
      if (s.length < 8) continue;
      const last = buf.utterances[buf.utterances.length - 1];
      if (last && last.text === s) continue;
      buf.seq = (buf.seq || 0) + 1;
      buf.utterances.push({ seq: buf.seq, text: s.slice(0, 500) });
      n++;
    }
    while (buf.utterances.length > BUFFER_CAP) buf.utterances.shift();
    return { buffered: n, total: buf.utterances.length };
  } catch (_) { return { buffered: 0 }; }
}

function getBufferedUtterances(model) {
  try {
    const buf = model && model[BUFFER_SECTION];
    if (!buf || !Array.isArray(buf.utterances)) return [];
    return buf.utterances.map(u => u.text);
  } catch (_) { return []; }
}

function discoverFromBuffer(model) {
  const texts = getBufferedUtterances(model);
  // The buffer is a flat stream, not segmented dialogues. Chunk into
  // pseudo-dialogues so cross-utterance support can accumulate; chunking is
  // deterministic (fixed size, in order).
  const dialogues = [];
  for (let i = 0; i < texts.length; i += 8) {
    dialogues.push({ id: dialogues.length, turns: texts.slice(i, i + 8).map(t => ({ speaker: 'user', text: t })) });
  }
  return discoverFromDialogues(dialogues);
}

module.exports = {
  mulberry32,
  LATENTS,
  DECOYS,
  NOISE_TURNS,
  STOPWORDS,
  UNKNOWN,
  MIN_DIALOGUES,
  MIN_DIVERSITY,
  generateCorpus,
  rawDialogues,
  extractTemplates,
  extractFrontTemplates,
  extractMidTemplates,
  mineClusters,
  applySubsumption,
  proposeStructures,
  inferTruth,
  dedupAgainstKnown,
  buildDiscoveredSpec,
  registerSpec,
  listSpecRegistry,
  saveDiscoveredSpecs,
  loadDiscoveredSpecs,
  discoverFromDialogues,
  discoverFromCorpus,
  observeUtterances,
  getBufferedUtterances,
  discoverFromBuffer,
  BUFFER_SECTION,
};
