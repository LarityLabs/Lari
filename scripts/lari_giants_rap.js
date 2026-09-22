'use strict';
// RAP lens registry for Small Lari's deterministic creativity engine.
// Each lens is a REAL pure function: string in, string out. No randomness, no Date,
// no modules. All choices go through util.pick / util.hash. Every authored
// template / rhyme / ad-lib bank is original phrasing in the giant's style
// (marked "// authored bank (original phrasing)"), never verbatim lyrics.
// Rap lenses stay readable prose: density, rhyme, and rhythm, never sound salad.

// Shared plain-JS guards (not part of the lens contract, just plumbing).
function safeInput(text) {
  return typeof text === 'string' && text.trim().length > 0;
}
// Accept the lens output only if it is grammatical-length prose (4-60 words,
// no em dashes); otherwise return the input unchanged so the lens never fails.
function finish(text, out) {
  if (!safeInput(text) || typeof out !== 'string') return text;
  if (out.indexOf('\u2014') !== -1) return text;
  var n = out.trim().split(/\s+/).filter(Boolean).length;
  if (n < 4 || n > 60) return text;
  return out;
}
// Noun-quality filter (plain JS): util.nouns is heuristic, so drop obvious
// non-nouns that would make simile/refrain templates read wrong.
var NON_NOUNS = {
  him: 1, her: 1, them: 1, us: 1, me: 1, mine: 1, yours: 1, ours: 1, theirs: 1,
  itself: 1, himself: 1, herself: 1, themselves: 1, myself: 1, yourself: 1,
  past: 1, across: 1, before: 1, after: 1, over: 1, under: 1, between: 1,
  through: 1, during: 1, while: 1, again: 1, still: 1, just: 1, very: 1,
  also: 1, then: 1, now: 1, here: 1, there: 1, where: 1, when: 1, what: 1,
  which: 1, who: 1, whom: 1, whose: 1, how: 1, why: 1, every: 1, each: 1,
  all: 1, any: 1, some: 1, more: 1, most: 1, own: 1, same: 1, other: 1,
  another: 1, such: 1, many: 1, much: 1, few: 1, only: 1, final: 1, cold: 1,
  blue: 1, old: 1, quiet: 1, endless: 1, last: 1, first: 1, new: 1, high: 1,
  low: 1, big: 1, small: 1, long: 1, short: 1, deep: 1, dark: 1, bright: 1,
  heavy: 1, soft: 1, loud: 1, fast: 1, slow: 1, young: 1, late: 1, early: 1,
  hard: 1, wild: 1, sweet: 1, warm: 1, cool: 1, hot: 1, dry: 1, wet: 1,
  clean: 1, full: 1, empty: 1, true: 1, real: 1, sure: 1, saw: 1, held: 1
};
var ING_KEEP = { morning: 1, evening: 1, king: 1, ring: 1, thing: 1, spring: 1, string: 1, wing: 1 };
function cleanNouns(util, text) {
  var verbs = {};
  util.verbs(text).forEach(function (v) { verbs[v] = 1; });
  return util.nouns(text).filter(function (n) {
    if (NON_NOUNS[n]) return false;
    if (verbs[n]) return false;
    if (n.length > 5 && n.slice(-3) === 'ing' && !ING_KEEP[n]) return false;
    return true;
  });
}
// Find content-word pairs sharing a 3-letter suffix (internal rhyme candidates).
function rhymePairs(util, text) {
  var words = util.contentWords(text).filter(function (w) { return w.length >= 4; });
  var pairs = [];
  for (var i = 0; i < words.length; i += 1) {
    for (var j = i + 1; j < words.length; j += 1) {
      var a = words[i], b = words[j];
      if (a !== b && a.slice(-3) === b.slice(-3)) pairs.push([a, b]);
    }
  }
  return pairs;
}

module.exports = [
  {
    id: 'black-thought',
    name: 'Black Thought',
    voice: 'Lead MC of The Roots, praised by critics for continuous multisyllabic rhyme schemes, complex lyricism, double entendres, and politically aware precision.',
    sources: ['https://en.wikipedia.org/wiki/Black_Thought'],
    lenses: [
      {
        id: 'black-thought-internal-rhyme-chain',
        name: 'Internal Rhyme Chain',
        description: 'Finds two rhyming content words and welds them into a relentless multisyllabic tail on the last sentence.',
        transform: (text, util) => {
          // Example 1: 'The machine never stops; the mission never drops.' -> 'The machine never stops; the mission never drops, stops to drops, relentless and precise to the last syllable.'
          // Example 2: 'The room went quiet at the final bell.' -> 'The room went quiet at the final bell.'
          if (!safeInput(text)) return text;
          var sents = util.sentences(text);
          if (!sents.length) return text;
          if (/relentless and precise to the last syllable/i.test(text)) return text;
          var pairs = rhymePairs(util, text);
          if (!pairs.length) return text;
          var p = util.pick(pairs, text + '|chain');
          var head = sents.slice(0, -1);
          var last = util.stripEnd(sents[sents.length - 1]);
          var out = head.concat([last + ', ' + p[0] + ' to ' + p[1] + ', relentless and precise to the last syllable.']).join(' ');
          return finish(text, out);
        }
      },
      {
        id: 'black-thought-breathless-opener',
        name: 'Breathless Opener',
        description: 'Opens the text with a compressed, breathless multisyllabic lead-in, packing every syllable tight.',
        transform: (text, util) => {
          // Example 1: 'The night was cold.' -> 'With syllables stacked like steel, the night was cold.'
          // Example 2: 'Dawn broke over the quiet harbor.' -> 'With syllables stacked like steel, dawn broke over the quiet harbor.'
          if (!safeInput(text)) return text;
          if (/^(with syllables stacked like steel|no wasted breath|compressed to the bone|every syllable earning its keep),/i.test(text.trim())) return text;
          // authored bank (original phrasing)
          var openers = [
            'With syllables stacked like steel, ',
            'No wasted breath, no wasted line, ',
            'Compressed to the bone and built to last, ',
            'Every syllable earning its keep, '
          ];
          var opener = util.pick(openers, text + '|opener');
          var out = opener + util.lowerFirst(text.trim());
          return finish(text, out);
        }
      }
    ]
  },
  {
    id: 'andre-3000',
    name: 'Andre 3000',
    voice: 'One half of Outkast, widely regarded as one of the greatest rappers, known for playful rap-singing, fearless reinvention, and left-field leaps like the flute-led New Blue Sun.',
    sources: ['https://en.wikipedia.org/wiki/Andr%C3%A9_3000'],
    lenses: [
      {
        id: 'andre-3000-cosmic-simile',
        name: 'Cosmic Simile',
        description: 'Hangs a playful left-field cosmic comparison off one noun, like the universe showed up uninvited.',
        transform: (text, util) => {
          // Example 1: 'The sky is blue.' -> 'The sky is blue, and somewhere an alien philosopher just nodded in approval.'
          // Example 2: 'Time ticks on the old clock.' -> 'Time ticks on the old clock, like the whole universe was humming along in tune.'
          if (!safeInput(text)) return text;
          if (/humming along in tune|alien philosopher|waiting its whole life|if it could dance/i.test(text)) return text;
          var sents = util.sentences(text);
          if (!sents.length) return text;
          var nouns = cleanNouns(util, text);
          if (!nouns.length) return text;
          var n = util.pick(nouns, text + '|noun');
          // authored bank (original phrasing)
          var bank = [
            ', like the whole universe was humming along in tune.',
            ', as if {n} had been waiting its whole life for this exact moment.',
            ', which is exactly what {n} would do if it could dance.',
            ', and somewhere an alien philosopher just nodded in approval.'
          ];
          var tail = util.pick(bank, n + '|simile').replace('{n}', n);
          var head = sents.slice(0, -1);
          var last = util.stripEnd(sents[sents.length - 1]);
          var out = head.concat([last + tail]).join(' ');
          return finish(text, out);
        }
      },
      {
        id: 'andre-3000-what-if-flip',
        name: 'What-If Flip',
        description: 'Flips a statement into a mischievous what-if question, reinventing the sentence mid-thought.',
        transform: (text, util) => {
          // Example 1: 'The sky is blue.' -> 'But what if the sky is blue and the stars were in on the joke all along?'
          // Example 2: 'The party starts at midnight.' -> 'But what if the party starts at midnight and the stars were in on the joke all along?'
          if (!safeInput(text)) return text;
          var sents = util.sentences(text);
          if (!sents.length) return text;
          var first = sents[0];
          if (/^\s*(but\s+)?what\s+if\b/i.test(first)) return text;
          var stripped = util.stripEnd(first);
          // authored bank (original phrasing)
          var bank = [
            'just to keep the universe guessing?',
            'for no reason the textbooks can explain?',
            'and the stars were in on the joke all along?'
          ];
          var out = 'But what if ' + util.lowerFirst(stripped) + ' ' + util.pick(bank, stripped + '|flip');
          var rest = sents.slice(1);
          if (rest.length) out += ' ' + rest.join(' ');
          return finish(text, out);
        }
      },
      {
        id: 'andre-3000-joyful-interjection',
        name: 'Joyful Interjection',
        description: 'Leads the text with a burst of playful joy, an interjection that sets a mischievous tone.',
        transform: (text, util) => {
          // Example 1: 'The parade marched down Peachtree Street.' -> 'Alright! The parade marched down Peachtree Street.'
          // Example 2: 'She laughed and kept walking.' -> 'Alright! She laughed and kept walking.'
          if (!safeInput(text)) return text;
          if (/^(hey|alright|okay now|listen)!\s/i.test(text.trim())) return text;
          // authored bank (original phrasing)
          var bank = ['Hey!', 'Alright!', 'Okay now!', 'Listen!'];
          var out = util.pick(bank, text + '|interject') + ' ' + text.trim();
          return finish(text, out);
        }
      }
    ]
  },
  {
    id: 'nas',
    name: 'Nas',
    voice: 'Queensbridge storyteller behind the landmark debut Illmatic, regarded as one of the greatest rappers for his vivid street poetry and reflective wisdom.',
    sources: ['https://en.wikipedia.org/wiki/Nas'],
    lenses: [
      {
        id: 'nas-scene-painter',
        name: 'Scene Painter',
        description: 'Paints one noun with concrete cinematic street detail, like a camera settling on a single corner.',
        transform: (text, util) => {
          // Example 1: 'The kids played in the park.' -> 'The kids played in the park, glowing like kids under the last streetlight on the block.'
          // Example 2: 'A train rattled past the window.' -> 'A train rattled past the window, and the window holds every story the block forgot.'
          if (!safeInput(text)) return text;
          if (/last streetlight on the block|every story the block forgot|a past and a promise in it/i.test(text)) return text;
          var sents = util.sentences(text);
          if (!sents.length) return text;
          var nouns = cleanNouns(util, text);
          if (!nouns.length) return text;
          var n = util.pick(nouns, text + '|scene');
          // authored bank (original phrasing)
          var bank = [
            ', glowing like {n} under the last streetlight on the block.',
            ', and the {n} holds every story the block forgot.',
            ', every corner knows {n}: a past and a promise in it.'
          ];
          var tail = util.pick(bank, n + '|paint').replace('{n}', n);
          var head = sents.slice(0, -1);
          var last = util.stripEnd(sents[sents.length - 1]);
          var out = head.concat([last + tail]).join(' ');
          return finish(text, out);
        }
      },
      {
        id: 'nas-reflective-uplift',
        name: 'Reflective Uplift',
        description: 'Lands a reflective, uplifting closing line that turns the scene into a lesson.',
        transform: (text, util) => {
          // Example 1: 'Times were hard on that block.' -> 'Times were hard on that block. Still, we rise: the story was never the ending, only the lesson.'
          // Example 2: 'The summer heat made tempers short.' -> 'The summer heat made tempers short. From the pavement, something beautiful keeps pushing through the cracks.'
          if (!safeInput(text)) return text;
          if (/still, we rise|pushing through the cracks|the struggle taught us how to shine/i.test(text)) return text;
          // authored bank (original phrasing)
          var bank = [
            'Still, we rise: the story was never the ending, only the lesson.',
            'From the pavement, something beautiful keeps pushing through the cracks.',
            'Look how far the block has come; the struggle taught us how to shine.'
          ];
          var out = text.trim() + ' ' + util.pick(bank, text + '|uplift');
          return finish(text, out);
        }
      },
      {
        id: 'nas-first-person-witness',
        name: 'First-Person Witness',
        description: 'Reframes the first sentence as lived testimony: the narrator was there when it happened.',
        transform: (text, util) => {
          // Example 1: 'The kids played in the park.' -> 'I was there when the kids played in the park.'
          // Example 2: 'The block went quiet after midnight.' -> 'I was there when the block went quiet after midnight.'
          if (!safeInput(text)) return text;
          var sents = util.sentences(text);
          if (!sents.length) return text;
          var first = sents[0];
          if (/^\s*i[\s']/i.test(first)) return text;
          var term = (first.match(/[.!?]$/) || ['.'])[0];
          var stripped = util.stripEnd(first);
          var out = 'I was there when ' + util.lowerFirst(stripped) + term;
          var rest = sents.slice(1);
          if (rest.length) out += ' ' + rest.join(' ');
          return finish(text, out);
        }
      }
    ]
  },
  {
    id: 'mf-doom',
    name: 'MF DOOM',
    voice: 'Masked underground lyricist behind the landmark Madvillainy, famed for intricate wordplay, a metal mask, and a supervillain stage persona.',
    sources: ['https://en.wikipedia.org/wiki/MF_Doom'],
    lenses: [
      {
        id: 'mf-doom-rhyme-labyrinth',
        name: 'Rhyme Labyrinth',
        description: 'Twists two rhyming content words into a villainous labyrinth clause on the last sentence.',
        transform: (text, util) => {
          // Example 1: 'The plot is thick; the villain is quick.' -> 'The plot is thick; the villain is quick, thick flips to quick in the villain's hidden labyrinth.'
          // Example 2: 'The sun rose over the quiet town.' -> 'The sun rose over the quiet town.'
          if (!safeInput(text)) return text;
          var sents = util.sentences(text);
          if (!sents.length) return text;
          if (/in the villain's hidden labyrinth/i.test(text)) return text;
          var pairs = rhymePairs(util, text);
          if (!pairs.length) return text;
          var p = util.pick(pairs, text + '|labyrinth');
          var head = sents.slice(0, -1);
          var last = util.stripEnd(sents[sents.length - 1]);
          var out = head.concat([last + ', ' + p[0] + ' flips to ' + p[1] + " in the villain's hidden labyrinth."]).join(' ');
          return finish(text, out);
        }
      },
      {
        id: 'mf-doom-masked-sign-off',
        name: 'Masked Sign-Off',
        description: 'Stamps the sentence with the masked persona, a villainous signature at the close.',
        transform: (text, util) => {
          // Example 1: 'The plan unfolds at midnight.' -> 'The plan unfolds at midnight, as plotted by the iron-faced architect of rhyme.'
          // Example 2: 'Nobody saw it coming.' -> 'Nobody saw it coming, signed: the masked villain of the underground.'
          if (!safeInput(text)) return text;
          if (/masked villain|iron-faced|villain vanishes/i.test(text)) return text;
          var sents = util.sentences(text);
          if (!sents.length) return text;
          // authored bank (original phrasing)
          var bank = [
            ', signed: the masked villain of the underground.',
            ', as plotted by the iron-faced architect of rhyme.',
            ', and the villain vanishes before the echo fades.'
          ];
          var head = sents.slice(0, -1);
          var last = util.stripEnd(sents[sents.length - 1]);
          var out = head.concat([last + util.pick(bank, text + '|signoff')]).join(' ');
          return finish(text, out);
        }
      },
      {
        id: 'mf-doom-obscure-reference',
        name: 'Obscure Reference',
        description: 'Drops an obscure comic-book-flavored footnote onto the sentence, dusty and half-remembered.',
        transform: (text, util) => {
          // Example 1: 'He kept the ledger in a locked drawer.' -> 'He kept the ledger in a locked drawer, straight out of a B-side only the mask remembers.'
          // Example 2: 'The city held its breath.' -> 'The city held its breath, straight out of a B-side only the mask remembers.'
          if (!safeInput(text)) return text;
          if (/dusty comic|B-side only the mask|well-worn paperback/i.test(text)) return text;
          var sents = util.sentences(text);
          if (!sents.length) return text;
          // authored bank (original phrasing)
          var bank = [
            ', like a footnote from a dusty comic the heroes never finished reading.',
            ', straight out of a B-side only the mask remembers.',
            ", annotated in the margins of a villain's well-worn paperback."
          ];
          var head = sents.slice(0, -1);
          var last = util.stripEnd(sents[sents.length - 1]);
          var out = head.concat([last + util.pick(bank, text + '|obscure')]).join(' ');
          return finish(text, out);
        }
      }
    ]
  },
  {
    id: 'tech-n9ne',
    name: 'Tech N9ne',
    voice: 'Kansas City chopper pioneer named after the TEC-9 for his rapid-fire style, co-founder of Strange Music, known for the complete technique of rhyme.',
    sources: ['https://en.wikipedia.org/wiki/Tech_N9ne'],
    lenses: [
      {
        id: 'tech-n9ne-stutter-hit',
        name: 'Stutter Hit',
        description: 'Fires a percussive chopper stutter on the first content word, like a snare hit before the flow.',
        transform: (text, util) => {
          // Example 1: 'The lightning struck the tower.' -> 'The l-li-lightning struck the tower.'
          // Example 2: 'Thunder rolls across the plains.' -> 'T-th-thunder rolls across the plains.'
          if (!safeInput(text)) return text;
          var words = util.contentWords(text).filter(function (w) { return w.length >= 3; });
          if (!words.length) return text;
          var w = words[0];
          var already = new RegExp(w[0] + '-' + w.slice(0, 2) + '-' + w, 'i');
          if (already.test(text)) return text;
          var re = new RegExp('\\b' + w + '\\b', 'i');
          var m = text.match(re);
          if (!m) return text;
          var raw = w[0] + '-' + w.slice(0, 2) + '-' + w;
          var rep = raw;
          if (/^[A-Z]+$/.test(m[0])) rep = raw.toUpperCase();
          else if (/^[A-Z]/.test(m[0])) rep = util.capFirst(raw);
          var out = text.slice(0, m.index) + rep + text.slice(m.index + m[0].length);
          return finish(text, out);
        }
      },
      {
        id: 'tech-n9ne-echo-burst',
        name: 'Echo Burst',
        description: 'Ends the sentence with a rapid-fire echo burst on the last content word, machine-gun repetition.',
        transform: (text, util) => {
          // Example 1: 'The beat drops.' -> 'The beat drops, drops, drops!'
          // Example 2: 'We came to run the night.' -> 'We came to run the night, night, night!'
          if (!safeInput(text)) return text;
          var words = util.contentWords(text).filter(function (w) { return w.length >= 3; });
          if (!words.length) return text;
          var w = words[words.length - 1];
          var doneRe = new RegExp(',\\s*' + w + ',\\s*' + w + '!\\s*$', 'i');
          if (doneRe.test(text)) return text;
          var sents = util.sentences(text);
          if (!sents.length) return text;
          var head = sents.slice(0, -1);
          var last = util.stripEnd(sents[sents.length - 1]);
          var out = head.concat([last + ', ' + w + ', ' + w + '!']).join(' ');
          return finish(text, out);
        }
      },
      {
        id: 'tech-n9ne-rapid-multis',
        name: 'Rapid Multis',
        description: 'Opens with a rapid-fire multisyllabic comparison built from two rhyming words in the text.',
        transform: (text, util) => {
          // Example 1: 'The lightning flashes; the beat crashes.' -> 'Fast as flashes, faster than crashes, the lightning flashes; the beat crashes.'
          // Example 2: 'The dog slept under the porch.' -> 'The dog slept under the porch.'
          if (!safeInput(text)) return text;
          var sents = util.sentences(text);
          if (!sents.length) return text;
          if (/^fast as .*faster than/i.test(sents[0].trim())) return text;
          var pairs = rhymePairs(util, text);
          if (!pairs.length) return text;
          var p = util.pick(pairs, text + '|rapid');
          var out = 'Fast as ' + p[0] + ', faster than ' + p[1] + ', ' + util.lowerFirst(sents[0].trim());
          var rest = sents.slice(1);
          if (rest.length) out += ' ' + rest.join(' ');
          return finish(text, out);
        }
      }
    ]
  },
  {
    id: 'bone-thugs',
    name: 'Bone Thugs-N-Harmony',
    voice: 'Cleveland five-man crew known for pioneering chopper rap and rap-singing, blending rapid-fire flow with melodic harmonies across 16 million records sold.',
    sources: ['http://en.wikipedia.org/wiki/Bone_Thugs-n-Harmony'],
    lenses: [
      {
        id: 'bone-thugs-melodic-refrain',
        name: 'Melodic Refrain',
        description: 'Echoes one noun in a sing-song refrain, repetition carrying the emotion.',
        transform: (text, util) => {
          // Example 1: 'We miss our home.' -> 'We miss our home, home keeps calling, home keeps calling.'
          // Example 2: 'The road stretched out before us.' -> 'The road stretched out before us, singing road, singing road, till the morning comes.'
          if (!safeInput(text)) return text;
          if (/keeps calling|till the morning comes|in the harmony/i.test(text)) return text;
          var sents = util.sentences(text);
          if (!sents.length) return text;
          var nouns = cleanNouns(util, text);
          if (!nouns.length) return text;
          var n = util.pick(nouns, text + '|refrain');
          // authored bank (original phrasing)
          var bank = [
            ', {n} keeps calling, {n} keeps calling.',
            ', singing {n}, singing {n}, till the morning comes.',
            ', {n} in the melody, {n} in the harmony.'
          ];
          var tail = util.pick(bank, n + '|melody').replace(/\{n\}/g, n);
          var head = sents.slice(0, -1);
          var last = util.stripEnd(sents[sents.length - 1]);
          var out = head.concat([last + tail]).join(' ');
          return finish(text, out);
        }
      },
      {
        id: 'bone-thugs-sing-through-it',
        name: 'Sing Through It',
        description: 'Lifts the sentence with a melodic, harmonizing uplift, voices rising together.',
        transform: (text, util) => {
          // Example 1: 'The night felt endless.' -> 'The night felt endless, every voice together, lifting higher than before.'
          // Example 2: 'Grief sat heavy on the porch.' -> 'Grief sat heavy on the porch, harmonies rising where the tears used to fall.'
          if (!safeInput(text)) return text;
          if (/keep on singing through the storm|harmonies rising|every voice together/i.test(text)) return text;
          var sents = util.sentences(text);
          if (!sents.length) return text;
          // authored bank (original phrasing)
          var bank = [
            ', and we keep on singing through the storm.',
            ', harmonies rising where the tears used to fall.',
            ', every voice together, lifting higher than before.'
          ];
          var head = sents.slice(0, -1);
          var last = util.stripEnd(sents[sents.length - 1]);
          var out = head.concat([last + util.pick(bank, text + '|sing')]).join(' ');
          return finish(text, out);
        }
      },
      {
        id: 'bone-thugs-harmonic-merge',
        name: 'Harmonic Merge',
        description: 'Braids the first two sentences into one flowing melodic line, voices overlapping.',
        transform: (text, util) => {
          // Example 1: 'We lost our friend. We miss him daily.' -> 'We lost our friend, and we miss him daily.'
          // Example 2: 'The choir rose. The room went still.' -> 'The choir rose, and the room went still.'
          if (!safeInput(text)) return text;
          var sents = util.sentences(text);
          if (sents.length < 2) return text;
          var out = util.stripEnd(sents[0]) + ', and ' + util.lowerFirst(util.stripEnd(sents[1])) + '.';
          var rest = sents.slice(2);
          if (rest.length) out += ' ' + rest.join(' ');
          return finish(text, out);
        }
      }
    ]
  }
];
