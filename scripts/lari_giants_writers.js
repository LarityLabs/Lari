'use strict';
// WRITERS/THINKERS lens registry for Small Lari's deterministic creativity engine.
// Each lens is a REAL pure function (string in, string out): no randomness, no Date,
// no modules. Any choice must go through util.pick/util.hash. Every bank of
// authored phrasing is original (never verbatim copyrighted quotes) and is
// marked with a comment. No em dashes anywhere in this file.

function fits(text, util) {
  const n = util.words(text).length;
  return n >= 4 && n <= 60;
}

function firstNoun(text, util) {
  const ns = util.nouns(text);
  return ns.length ? ns[0] : null;
}

function asString(x) { return typeof x === 'string' ? x : String(x); }

function bodyOf(text, util) { return util.stripEnd(asString(text)).trim(); }

function baseOf(text) {
  const t = asString(text);
  return /[.!?]["')\]]?\s*$/.test(t) ? t : t + '.';
}

module.exports = [
  {
    id: 'kerouac',
    name: 'Jack Kerouac',
    voice: 'Beat Generation pioneer of spontaneous prose, famous for breath-paced and-chained sentences, holy-the litanies, and road-witness confession.',
    sources: ['https://en.wikipedia.org/wiki/Jack_Kerouac'],
    lenses: [
      {
        id: 'kerouac-and-chain',
        name: 'And-Chain Breath',
        description: 'Joins the first two sentences into one long breath-paced sentence chained with "and".',
        transform: (text, util) => {
          text = asString(text);
          // In: "We drove west all night. The sky was huge." Out: "We drove west all night and the sky was huge."
          // In: "Morning came." Out: "Morning came."
          const ss = util.sentences(asString(text));
          if (ss.length < 2) return text;
          const a = util.stripEnd(ss[0]);
          const b = util.lowerFirst(util.stripEnd(ss[1]));
          const rest = ss.slice(2).join(' ');
          const out = a + ' and ' + b + '.' + (rest ? ' ' + rest : '');
          if (!fits(out, util)) return text;
          return out;
        }
      },
      {
        id: 'kerouac-holy-litany',
        name: 'Holy Litany',
        description: 'Turns the text nouns into a "holy the..." litany appended to the draft.',
        transform: (text, util) => {
          text = asString(text);
          // In: "The highway hummed with neon rain." Out: "The highway hummed with neon rain. Holy the highway, holy the hummed, holy the neon, holy the whole sweet going-on."
          // In: "Dogs barked." Out: "Dogs barked. Holy the dogs, holy the barked, holy the whole sweet going-on."
          const ns = util.nouns(text).slice(0, 3);
          if (!ns.length) return text;
          if (!bodyOf(text, util)) return text;
          const litany = util.capFirst(ns.map(function (n) { return 'holy the ' + n; }).join(', '));
          const out = baseOf(text) + ' ' + litany + ', holy the whole sweet going-on.';
          if (!fits(out, util)) return text;
          return out;
        }
      },
      {
        id: 'kerouac-road-witness',
        name: 'Road Witness',
        description: 'Reframes the text as a first-hand confession from the road.',
        transform: (text, util) => {
          text = asString(text);
          // In: "The river ran brown and fast." Out: "I was there and I swear it, the river ran brown and fast."
          // In: "She sang one last song." Out: "I was there and I swear it, she sang one last song."
          const b = bodyOf(text, util);
          if (!b) return text;
          const out = 'I was there and I swear it, ' + util.lowerFirst(b) + '.';
          if (!fits(out, util)) return text;
          return out;
        }
      }
    ]
  },
  {
    id: 'watts',
    name: 'Alan Watts',
    voice: 'British philosopher and self-styled philosophical entertainer who interpreted and popularised Buddhist, Taoist, and Hindu thought for Western audiences, known for playful paradox and gentle reversals of common sense.',
    sources: ['https://en.wikipedia.org/wiki/Alan_Watts'],
    lenses: [
      {
        id: 'watts-reversal',
        name: 'Reversal',
        description: 'Flips cause and effect on the first two nouns with a playful question.',
        transform: (text, util) => {
          text = asString(text);
          // In: "The river carved the canyon." Out: "You say the river called forth the canyon. Playful as the universe is, could it be the canyon called forth the river?"
          // In: "The wind bent the trees." Out: "You say the wind called forth the trees. Playful as the universe is, could it be the trees called forth the wind?"
          text = asString(text);
          const ns = util.nouns(text);
          if (ns.length < 2) return text;
          const a = ns[0], b = ns[1];
          const v = util.pick(['brought', 'gave rise to', 'called forth'], text);
          const out = 'You say the ' + a + ' ' + v + ' the ' + b +
            '. Playful as the universe is, could it be the ' + b + ' ' + v + ' the ' + a + '?';
          if (!fits(out, util)) return text;
          return out;
        }
      },
      {
        id: 'watts-hide-and-seek',
        name: 'Hide and Seek',
        description: 'Appends the universe-hiding-inside-it wink on the first noun.',
        transform: (text, util) => {
          text = asString(text);
          // In: "The garden grows tomatoes." Out: "The garden grows tomatoes. All the while the universe is playing hide and seek, and right now it is hiding inside the garden."
          // In: "He fixed the radio." Out: "He fixed the radio. All the while the universe is playing hide and seek, and right now it is hiding inside the fixed."
          if (!bodyOf(text, util)) return text;
          const n = firstNoun(text, util);
          if (!n) return text;
          const out = baseOf(text) + ' All the while the universe is playing hide and seek, and right now it is hiding inside the ' + n + '.';
          if (!fits(out, util)) return text;
          return out;
        }
      },
      {
        id: 'watts-play-closer',
        name: 'Play Closer',
        description: 'Appends an original paradox-closer in the spirit of Watts.',
        transform: (text, util) => {
          text = asString(text);
          // In: "The bell rang at noon." Out: "The bell rang at noon. Trying to grasp the moment is like trying to bite your own teeth."
          // In: "She laughed." Out: "She laughed. The meaning of it all is the playing of it all."
          // authored bank (original phrasing)
          const closers = [
            'The meaning of it all is the playing of it all.',
            'You cannot catch the wind by running after it, so stop running and feel it.',
            'Trying to grasp the moment is like trying to bite your own teeth.'
          ];
          if (!bodyOf(text, util)) return text;
          const out = baseOf(text) + ' ' + util.pick(closers, text);
          if (!fits(out, util)) return text;
          return out;
        }
      }
    ]
  },
  {
    id: 'twain',
    name: 'Mark Twain',
    voice: 'American writer and humorist praised as the greatest humorist the United States has produced, with Faulkner calling him the father of American literature, famed for dry aphorisms and deflation of grand talk.',
    sources: ['https://en.wikipedia.org/wiki/Mark_Twain'],
    lenses: [
      {
        id: 'twain-deflator',
        name: 'Deflator',
        description: 'Appends a dry original aphorism that punctures grand talk.',
        transform: (text, util) => {
          text = asString(text);
          // In: "Our glorious enterprise shall reshape the world." Out: "Our glorious enterprise shall reshape the world. Common sense is just experience with the varnish scraped off."
          // In: "He gave a fine speech." Out: "He gave a fine speech. Fancy words never kept a boat off the rocks."
          // authored bank (original phrasing)
          const deflators = [
            'Grand talk is cheap, and the river charges by the mile.',
            'A plan that sounds noble usually hides a bill coming due.',
            'Fancy words never kept a boat off the rocks.',
            'Common sense is just experience with the varnish scraped off.'
          ];
          if (!bodyOf(text, util)) return text;
          const out = baseOf(text) + ' ' + util.pick(deflators, text);
          if (!fits(out, util)) return text;
          return out;
        }
      },
      {
        id: 'twain-plain-speech',
        name: 'Plain Speech',
        description: 'Swaps fancy words for plain American ones.',
        transform: (text, util) => {
          text = asString(text);
          // In: "It was a magnificent endeavor." Out: "It was a big try."
          // In: "The cat sat." Out: "The cat sat."
          text = asString(text);
          const plain = {
            magnificent: 'big', extraordinary: 'uncommon', utilize: 'use', facilitate: 'help',
            commence: 'start', endeavor: 'try', sophisticated: 'fancy', exquisite: 'fine',
            profound: 'deep', splendid: 'fine', tremendous: 'mighty', purchase: 'buy',
            inquire: 'ask', approximately: 'about', sufficient: 'enough'
          };
          let changed = false;
          const out = text.replace(/[A-Za-z]+/g, function (w) {
            const low = w.toLowerCase();
            if (plain[low]) {
              changed = true;
              return w[0] === w[0].toUpperCase() ? util.capFirst(plain[low]) : plain[low];
            }
            return w;
          });
          if (!changed) return text;
          if (!fits(out, util)) return text;
          return out;
        }
      },
      {
        id: 'twain-aside',
        name: 'Wry Aside',
        description: 'Tucks a wry parenthetical aside into the first sentence.',
        transform: (text, util) => {
          text = asString(text);
          // In: "He was a man of great learning." Out: "He was a man of great learning (or so they tell themselves)."
          // In: "The plan was perfect." Out: "The plan was perfect (which is a polite way of lying)."
          // authored bank (original phrasing)
          const asides = [
            ' (or so they tell themselves)',
            ' (and a fine mess it was)',
            ' (as any river pilot knows)',
            ' (which is a polite way of lying)'
          ];
          const ss = util.sentences(asString(text));
          if (!ss.length) return text;
          const s0 = util.stripEnd(ss[0]).trim();
          if (!s0) return text;
          const rest = ss.slice(1).join(' ');
          const out = s0 + util.pick(asides, text) + '.' + (rest ? ' ' + rest : '');
          if (!fits(out, util)) return text;
          return out;
        }
      }
    ]
  },
  {
    id: 'thompson',
    name: 'Hunter S. Thompson',
    voice: 'American journalist and author, founder of gonzo journalism, the style in which the writer becomes a central figure and participant in the narrative, all wired immediacy and hyperbolic dread.',
    sources: ['https://en.wikipedia.org/wiki/Hunter_S._Thompson'],
    lenses: [
      {
        id: 'thompson-gonzo-lede',
        name: 'Gonzo Lede',
        description: 'Drops the narrator into the middle of the scene in first person.',
        transform: (text, util) => {
          text = asString(text);
          // In: "The parade rolled downtown." Out: "I was right there in the thick of it when the parade rolled downtown."
          // In: "The crowd began to chant." Out: "I was right there in the thick of it when the crowd began to chant."
          const b = bodyOf(text, util);
          if (!b) return text;
          const out = 'I was right there in the thick of it when ' + util.lowerFirst(b) + '.';
          if (!fits(out, util)) return text;
          return out;
        }
      },
      {
        id: 'thompson-live-wire',
        name: 'Live Wire',
        description: 'Wires the first sentence with savage electricity.',
        transform: (text, util) => {
          text = asString(text);
          // In: "The room went quiet." Out: "The room went quiet and somewhere behind it the dread kept building like a storm."
          // In: "Headlights swept the lot." Out: "Headlights swept the lot and somewhere behind it the dread kept building like a storm."
          // authored bank (original phrasing)
          const wires = [
            ' and the whole savage scene was humming like a live wire.',
            ' and somewhere behind it the dread kept building like a storm.',
            ' and I could feel the electricity crawling up the back of my neck.'
          ];
          const ss = util.sentences(asString(text));
          if (!ss.length) return text;
          const s0 = util.stripEnd(ss[0]).trim();
          if (!s0) return text;
          const rest = ss.slice(1).join(' ');
          const out = s0 + util.pick(wires, text) + (rest ? ' ' + rest : '');
          if (!fits(out, util)) return text;
          return out;
        }
      },
      {
        id: 'thompson-dread-dispatch',
        name: 'Dread Dispatch',
        description: 'Prefixes a dispatch of hyperbolic dread.',
        transform: (text, util) => {
          text = asString(text);
          // In: "The deal went bad at midnight." Out: "No way around it, the fear was real: the deal went bad at midnight."
          // In: "Engines roared in the dark." Out: "There was no turning back now: engines roared in the dark."
          // authored bank (original phrasing)
          const dreads = [
            'No way around it, the fear was real: ',
            'There was no turning back now: ',
            'The night was closing in and the bats were circling: '
          ];
          const b = bodyOf(text, util);
          if (!b) return text;
          const out = util.pick(dreads, text) + util.lowerFirst(b) + '.';
          if (!fits(out, util)) return text;
          return out;
        }
      }
    ]
  },
  {
    id: 'sagan',
    name: 'Carl Sagan',
    voice: 'American astronomer and science communicator who co-wrote and narrated the documentary series Cosmos: A Personal Voyage, seen by at least 500 million people in 60 countries, a reverent teacher of cosmic scale.',
    sources: ['https://en.wikipedia.org/wiki/Carl_Sagan'],
    lenses: [
      {
        id: 'sagan-cosmic-scale',
        name: 'Cosmic Scale',
        description: 'Reframes the first noun against the age of the universe.',
        transform: (text, util) => {
          text = asString(text);
          // In: "The child planted a seed." Out: "The child planted a seed. Set the child beside 14 billion years of universe, on a small world circling an ordinary star, and marvel at the scale of it all."
          // In: "Waves shaped the cliffs." Out: "Waves shaped the cliffs. Set the waves beside 14 billion years of universe, on a small world circling an ordinary star, and marvel at the scale of it all."
          if (!bodyOf(text, util)) return text;
          const n = firstNoun(text, util);
          if (!n) return text;
          const out = baseOf(text) + ' Set the ' + n + ' beside 14 billion years of universe, on a small world circling an ordinary star, and marvel at the scale of it all.';
          if (!fits(out, util)) return text;
          return out;
        }
      },
      {
        id: 'sagan-humble-explainer',
        name: 'Humble Explainer',
        description: 'Opens the patient-teacher frame of explanation.',
        transform: (text, util) => {
          text = asString(text);
          // In: "Stars are born in clouds of gas." Out: "Think of it this way: stars are born in clouds of gas."
          // In: "Light takes years to reach us." Out: "Think of it this way: light takes years to reach us."
          const b = bodyOf(text, util);
          if (!b) return text;
          const out = 'Think of it this way: ' + util.lowerFirst(b) + '.';
          if (!fits(out, util)) return text;
          return out;
        }
      },
      {
        id: 'sagan-wonder-closer',
        name: 'Wonder Closer',
        description: 'Appends an original closer of quiet cosmic wonder.',
        transform: (text, util) => {
          text = asString(text);
          // In: "The telescope found a new world." Out: "The telescope found a new world. And that is worth a moment of quiet wonder."
          // In: "The data fit the model." Out: "The data fit the model. And that is worth a moment of quiet wonder."
          // authored bank (original phrasing)
          const wonders = [
            'And that is worth a moment of quiet wonder.',
            'Somewhere out there, something incredible is waiting to be known, and it may begin right here.',
            'We are a way for the cosmos to know itself, and this small moment is part of that knowing.'
          ];
          if (!bodyOf(text, util)) return text;
          const out = baseOf(text) + ' ' + util.pick(wonders, text);
          if (!fits(out, util)) return text;
          return out;
        }
      }
    ]
  },
  {
    id: 'morrison',
    name: 'Toni Morrison',
    voice: 'American novelist, editor, and professor, the first African American woman to win the Nobel Prize in Literature (1993) and a Pulitzer winner for Beloved (1988), known for prose of biblical cadence and moral weight.',
    sources: ['https://fr.wikipedia.org/wiki/Toni_Morrison'],
    lenses: [
      {
        id: 'morrison-echo',
        name: 'Echo',
        description: 'Incantatory repetition of the first noun, bearing witness.',
        transform: (text, util) => {
          text = asString(text);
          // In: "The house stood empty for years." Out: "The house stood empty for years. It was the house, always the house, the house that would not let go."
          // In: "The song faded at dusk." Out: "The song faded at dusk. It was the song, always the song, the song that would not let go."
          if (!bodyOf(text, util)) return text;
          const n = firstNoun(text, util);
          if (!n) return text;
          const out = baseOf(text) + ' It was the ' + n + ', always the ' + n + ', the ' + n + ' that would not let go.';
          if (!fits(out, util)) return text;
          return out;
        }
      },
      {
        id: 'morrison-witness',
        name: 'Witness',
        description: 'Reframes the text as collective memory.',
        transform: (text, util) => {
          text = asString(text);
          // In: "The river took the bridge in spring." Out: "We were there, and we remember: the river took the bridge in spring."
          // In: "They buried him at dawn." Out: "We were there, and we remember: they buried him at dawn."
          const b = bodyOf(text, util);
          if (!b) return text;
          const out = 'We were there, and we remember: ' + util.lowerFirst(b) + '.';
          if (!fits(out, util)) return text;
          return out;
        }
      },
      {
        id: 'morrison-memory-closer',
        name: 'Memory Closer',
        description: 'Appends an original spare, devastating closer.',
        transform: (text, util) => {
          text = asString(text);
          // In: "She left the town that winter." Out: "She left the town that winter. What is carried in the heart outlives every telling of it."
          // In: "The story ended there." Out: "The story ended there. Memory does not forgive, and it does not forget."
          // authored bank (original phrasing)
          const closers = [
            'Memory does not forgive, and it does not forget.',
            'What is carried in the heart outlives every telling of it.',
            'The truth of it sits down beside you and will not leave.'
          ];
          if (!bodyOf(text, util)) return text;
          const out = baseOf(text) + ' ' + util.pick(closers, text);
          if (!fits(out, util)) return text;
          return out;
        }
      }
    ]
  },
  {
    id: 'aurelius',
    name: 'Marcus Aurelius',
    voice: 'Roman emperor from 161 to 180 and Stoic philosopher, author of the Meditations written in Greek while on campaign, with memento mori and the dichotomy of control among his noted ideas.',
    sources: ['https://en.wikipedia.org/wiki/Marcus_Aurelius'],
    lenses: [
      {
        id: 'aurelius-dichotomy',
        name: 'Dichotomy of Control',
        description: 'Sorts the first noun into what is yours and what belongs to fortune.',
        transform: (text, util) => {
          text = asString(text);
          // In: "The storm delayed the ships." Out: "The storm delayed the ships. Of the storm, keep only what is in your hands. The rest belongs to fortune, so let it pass."
          // In: "The letter never arrived." Out: "The letter never arrived. Of the letter, keep only what is in your hands. The rest belongs to fortune, so let it pass."
          if (!bodyOf(text, util)) return text;
          const n = firstNoun(text, util);
          if (!n) return text;
          const out = baseOf(text) + ' Of the ' + n + ', keep only what is in your hands. The rest belongs to fortune, so let it pass.';
          if (!fits(out, util)) return text;
          return out;
        }
      },
      {
        id: 'aurelius-imperative',
        name: 'Imperative',
        description: 'Prefixes a Stoic imperative framing.',
        transform: (text, util) => {
          text = asString(text);
          // In: "The day began badly." Out: "Consider it a task, not a trial: the day began badly."
          // In: "The work will be hard." Out: "Consider it a task, not a trial: the work will be hard."
          // authored bank (original phrasing)
          const frames = [
            'Take it as your work, not your wound: ',
            'Meet it as a duty, not a disaster: ',
            'Consider it a task, not a trial: '
          ];
          const b = bodyOf(text, util);
          if (!b) return text;
          const out = util.pick(frames, text) + util.lowerFirst(b) + '.';
          if (!fits(out, util)) return text;
          return out;
        }
      },
      {
        id: 'aurelius-memento-mori',
        name: 'Memento Mori',
        description: 'Appends an original memento mori closer.',
        transform: (text, util) => {
          text = asString(text);
          // In: "The morning was quiet." Out: "The morning was quiet. You could leave life at any moment; let that decide what you do with this one."
          // In: "He wasted the afternoon." Out: "He wasted the afternoon. Death stands behind every hour, which is why this one matters."
          // authored bank (original phrasing)
          const mementos = [
            'Remember that you will die, so this hour is not yours to waste.',
            'You could leave life at any moment; let that decide what you do with this one.',
            'Death stands behind every hour, which is why this one matters.'
          ];
          if (!bodyOf(text, util)) return text;
          const out = baseOf(text) + ' ' + util.pick(mementos, text);
          if (!fits(out, util)) return text;
          return out;
        }
      }
    ]
  },
  {
    id: 'nietzsche',
    name: 'Friedrich Nietzsche',
    voice: 'German philosopher (1844-1900) known for hammer-blow aphorisms, reversals of received values, and prophetic intensity; his works include Thus Spoke Zarathustra.',
    sources: ['https://is.wikipedia.org/wiki/Friedrich_Nietzsche'],
    lenses: [
      {
        id: 'nietzsche-hammer',
        name: 'Hammer Blow',
        description: 'Appends an original hammer-blow aphorism.',
        transform: (text, util) => {
          text = asString(text);
          // In: "The town praised its comforts." Out: "The town praised its comforts. What is built on comfort will be inherited by cowards."
          // In: "They worshipped the idol." Out: "They worshipped the idol. What is built on comfort will be inherited by cowards."
          // authored bank (original phrasing)
          const hammers = [
            'What is built on comfort will be inherited by cowards.',
            'The herd calls it virtue; the strong call it habit.',
            'Whoever kneels before an idol has already learned to crawl.'
          ];
          if (!bodyOf(text, util)) return text;
          const out = baseOf(text) + ' ' + util.pick(hammers, text);
          if (!fits(out, util)) return text;
          return out;
        }
      },
      {
        id: 'nietzsche-revalue',
        name: 'Revaluation',
        description: 'Turns the first noun into a reversal of received value.',
        transform: (text, util) => {
          text = asString(text);
          // In: "The crowd praised his humility." Out: "The crowd praised his humility. They praise the crowd and fear its opposite. I say the crowd is a mask, and behind the mask stands the will to live."
          // In: "Virtue was the word of the day." Out: "Virtue was the word of the day. They praise the virtue and fear its opposite. I say the virtue is a mask, and behind the mask stands the will to live."
          if (!bodyOf(text, util)) return text;
          const n = firstNoun(text, util);
          if (!n) return text;
          const out = baseOf(text) + ' They praise the ' + n + ' and fear its opposite. I say the ' + n + ' is a mask, and behind the mask stands the will to live.';
          if (!fits(out, util)) return text;
          return out;
        }
      },
      {
        id: 'nietzsche-prophetic',
        name: 'Prophetic Voice',
        description: 'Prefixes a prophetic address to those who will come after.',
        transform: (text, util) => {
          text = asString(text);
          // In: "The old values are breaking." Out: "Let it be written and let it be remembered: the old values are breaking."
          // In: "The temples stand empty." Out: "Let it be written and let it be remembered: the temples stand empty."
          // authored bank (original phrasing)
          const voices = [
            'I speak to those who will come after: ',
            'Hear me, you who still dare: ',
            'Let it be written and let it be remembered: '
          ];
          const b = bodyOf(text, util);
          if (!b) return text;
          const out = util.pick(voices, text) + util.lowerFirst(b) + '.';
          if (!fits(out, util)) return text;
          return out;
        }
      }
    ]
  },
  {
    id: 'lao-tzu',
    name: 'Lao Tzu',
    voice: 'Ancient Chinese philosopher traditionally regarded as the founder of Taoism and the author of the Tao Te Ching, though modern scholars are divided over his identity and dates.',
    sources: ['http://en.wikipedia.org/wiki/Laozi'],
    lenses: [
      {
        id: 'lao-tzu-water',
        name: 'Water',
        description: 'Appends an original water-metaphor closer.',
        transform: (text, util) => {
          text = asString(text);
          // In: "The argument went nowhere." Out: "The argument went nowhere. The softest thing wears down the hardest; that is the way."
          // In: "He stopped striving." Out: "He stopped striving. The softest thing wears down the hardest; that is the way."
          // authored bank (original phrasing)
          const waters = [
            'Be like water: it yields, and so it overcomes.',
            'The softest thing wears down the hardest; that is the way.',
            'Water seeks the lowest place, and nothing can stand against it.'
          ];
          if (!bodyOf(text, util)) return text;
          const out = baseOf(text) + ' ' + util.pick(waters, text);
          if (!fits(out, util)) return text;
          return out;
        }
      },
      {
        id: 'lao-tzu-unnamed',
        name: 'The Unnamed',
        description: 'A paradox on the first noun in the spirit of the opening of the Tao Te Ching, in original phrasing.',
        transform: (text, util) => {
          text = asString(text);
          // In: "The road stretched past the hills." Out: "The road stretched past the hills. Map the road all you like; the lasting road cannot be mapped."
          // In: "His name opened doors." Out: "His name opened doors. Map the name all you like; the lasting name cannot be mapped."
          if (!bodyOf(text, util)) return text;
          const n = firstNoun(text, util);
          if (!n) return text;
          const out = baseOf(text) + ' Map the ' + n + ' all you like; the lasting ' + n + ' cannot be mapped.';
          if (!fits(out, util)) return text;
          return out;
        }
      },
      {
        id: 'lao-tzu-wu-wei',
        name: 'Wu Wei',
        description: 'Reframes the first noun with effortless action: do not push it, let it come.',
        transform: (text, util) => {
          text = asString(text);
          // In: "She forced the deal through." Out: "She forced the deal through. Do not push the deal; let the deal come to you."
          // In: "The garden needed tending." Out: "The garden needed tending. Do not push the garden; let the garden come to you."
          if (!bodyOf(text, util)) return text;
          const n = firstNoun(text, util);
          if (!n) return text;
          const out = baseOf(text) + ' Do not push the ' + n + '; let the ' + n + ' come to you.';
          if (!fits(out, util)) return text;
          return out;
        }
      }
    ]
  },
  {
    id: 'adams',
    name: 'Douglas Adams',
    voice: 'English author, humourist, and screenwriter best known as the creator of The Hitchhiker\'s Guide to the Galaxy, writing in the genres of comedy, satire, science fiction, and absurdism.',
    sources: ['http://en.wikipedia.org/wiki/Douglas_Adams'],
    lenses: [
      {
        id: 'adams-anticlimax',
        name: 'Anticlimax',
        description: 'Appends an original perfectly timed anticlimax.',
        transform: (text, util) => {
          text = asString(text);
          // In: "The launch was a triumph." Out: "The launch was a triumph. This was, on the whole, a terrible idea, though the tea was excellent."
          // In: "Everyone held their breath." Out: "Everyone held their breath. Nobody panicked, which was the most alarming part."
          // authored bank (original phrasing)
          const anticlimaxes = [
            'This was, on the whole, a terrible idea, though the tea was excellent.',
            'Nobody panicked, which was the most alarming part.',
            'It all made perfect sense, apart from the parts that mattered.'
          ];
          if (!bodyOf(text, util)) return text;
          const out = baseOf(text) + ' ' + util.pick(anticlimaxes, text);
          if (!fits(out, util)) return text;
          return out;
        }
      },
      {
        id: 'adams-bureaucracy',
        name: 'Galactic Bureaucracy',
        description: 'Submits the first noun to cosmic paperwork.',
        transform: (text, util) => {
          text = asString(text);
          // In: "The queue stretched for miles." Out: "The queue stretched for miles. Somewhere, a galactic committee is still filling out the forms for the queue."
          // In: "The forms were rejected." Out: "The forms were rejected. Somewhere, a galactic committee is still filling out the forms for the forms."
          if (!bodyOf(text, util)) return text;
          const n = firstNoun(text, util);
          if (!n) return text;
          const out = baseOf(text) + ' Somewhere, a galactic committee is still filling out the forms for the ' + n + '.';
          if (!fits(out, util)) return text;
          return out;
        }
      },
      {
        id: 'adams-absurd-logic',
        name: 'Absurd Logic',
        description: 'Appends an original piece of impeccable absurd logic.',
        transform: (text, util) => {
          text = asString(text);
          // In: "The plan was flawless." Out: "The plan was flawless. It was a perfectly sensible plan, assuming you ignored reality."
          // In: "They voted unanimously." Out: "They voted unanimously. Everyone agreed the plan was brilliant, which should have been the first warning."
          // authored bank (original phrasing)
          const logics = [
            'The logic was impeccable, which is precisely why it failed.',
            'It was a perfectly sensible plan, assuming you ignored reality.',
            'Everyone agreed the plan was brilliant, which should have been the first warning.'
          ];
          if (!bodyOf(text, util)) return text;
          const out = baseOf(text) + ' ' + util.pick(logics, text);
          if (!fits(out, util)) return text;
          return out;
        }
      }
    ]
  }
];
