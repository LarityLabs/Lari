'use strict';
// NEW SCHOOL lens registry for Small Lari's deterministic creativity engine.
// Each lens is a REAL pure function: string in, string out. No randomness, no Date,
// no modules. All choices go through util.pick / util.hash. Every authored
// ad-lib / lingo / template bank is original phrasing in the giant's style
// (marked "// authored bank (original phrasing)"), never verbatim lyrics.

module.exports = [
  {
    id: 'playboi-carti',
    name: 'Playboi Carti',
    voice: 'Atlanta rapper known for his eccentric vocal style, his "baby voice", and mood-first minimalism; considered an influential figure in modern hip hop and a pioneer of the rage microgenre.',
    sources: ['https://en.wikipedia.org/wiki/Playboi_Carti'],
    lenses: [
      {
        id: 'playboi-carti-baby-voice-repeat',
        name: 'Baby Voice Repeat',
        description: 'Reduces the sentence to a sparse repeated two-part declaration anchored on one noun, closed with a one-word ad-lib tag.',
        transform: (text, util) => {
          // Example 1: 'The sunrise painted the empty desert gold this morning.' -> 'Morning. Morning. I got it, ok.'
          // Example 2: 'A quiet kid watched the rain from the porch.' -> 'Porch. Porch. I got it, slatt.'
          var sents = util.sentences(text);
          if (!sents.length) return text;
          var first = sents[0];
          var nouns = util.nouns(first);
          if (!nouns.length) return text;
          var n = nouns[nouns.length - 1];
          // authored bank (original phrasing)
          var tags = ['what', 'slatt', 'yeah', 'ok'];
          var tag = util.pick(tags, n + '|tag');
          var cap = util.capFirst(n);
          return cap + '. ' + cap + '. I got it, ' + tag + '.';
        }
      },
      {
        id: 'playboi-carti-vamp-tag',
        name: 'Vamp Tag',
        description: 'Keeps the sentence intact and pins a sparse ad-lib tag to the end, like a track tag before the beat drops.',
        transform: (text, util) => {
          // Example 1: 'The moon was bright tonight.' -> 'The moon was bright tonight, what, slatt.'
          // Example 2: 'We left the city before the cops woke up.' -> 'We left the city before the cops woke up, yeah, slatt.'
          var words = util.words(text);
          if (words.length < 4) return text;
          var sents = util.sentences(text);
          if (!sents.length) return text;
          var s = util.stripEnd(sents[0]);
          // authored bank (original phrasing)
          var tags = ['slatt', 'what', 'yeah, slatt', 'what, slatt'];
          return s + ', ' + util.pick(tags, s + '|vamp') + '.';
        }
      },
      {
        id: 'playboi-carti-sparse-declare',
        name: 'Sparse Declaration',
        description: 'Compresses the sentence into one minimal first-person declaration: I verb the noun, plus a tag.',
        transform: (text, util) => {
          // Example 1: 'Dancers spin under the neon glow of midnight.' -> 'I spin the dancers, yeah.'
          // Example 2: 'The kids traded rare cards in the schoolyard.' -> 'I traded the kids, what.'
          var sents = util.sentences(text);
          if (!sents.length) return text;
          var first = sents[0];
          var verbs = util.verbs(first);
          var nouns = util.nouns(first);
          if (!verbs.length || !nouns.length) return text;
          var v = util.pick(verbs, first + '|v');
          var n = nouns[0];
          // authored bank (original phrasing)
          var tags = ['what', 'slatt', 'yeah'];
          return 'I ' + v + ' the ' + n + ', ' + util.pick(tags, v + n) + '.';
        }
      }
    ]
  },
  {
    id: 'yeat',
    name: 'Yeat',
    voice: 'American rapper known for his experimental rage sound and his unique, partly self-invented vocabulary; broke through in 2021 with the mixtape 4L and debut album Up 2 Me.',
    sources: ['https://en.wikipedia.org/wiki/Yeat'],
    lenses: [
      {
        id: 'yeat-twizzy-drop',
        name: 'Twizzy Drop',
        description: 'Rewrites the sentence as a futuristic flex built around one noun and the "twizzy" address, using invented lingo sparingly.',
        transform: (text, util) => {
          // Example 1: 'The profits from the tour finally landed in the account.' -> 'I got the account on me, twizzy, it is already up.'
          // Example 2: 'She wore a heavy gold chain to the show.' -> 'I got the show on me, twizzy, it is already up.'
          var sents = util.sentences(text);
          if (!sents.length) return text;
          var first = sents[0];
          var nouns = util.nouns(first);
          if (!nouns.length) return text;
          var n = nouns[nouns.length - 1];
          // authored bank (original phrasing)
          var bank = [
            'My {n} too big, I can not even talk to the twizzy.',
            'I got the {n} on me, twizzy, it is already up.',
            'Talk to the {n} twice, I already ran it up.'
          ];
          return util.pick(bank, first + '|bank').replace('{n}', n);
        }
      },
      {
        id: 'yeat-numb-flex',
        name: 'Numb Flex',
        description: 'Reframes the sentence as a detached, numb-hedonist aside where the feeling is gone but the object keeps calling.',
        transform: (text, util) => {
          // Example 1: 'The crowd screamed his name until the lights went out.' -> 'Too numb to care, I left the lights in the sky.'
          // Example 2: 'He left his phone buzzing on the dashboard.' -> 'I do not feel a thing, the dashboard just keeps calling.'
          var sents = util.sentences(text);
          if (!sents.length) return text;
          var first = sents[0];
          var nouns = util.nouns(first);
          if (!nouns.length) return text;
          var n = nouns[nouns.length - 1];
          // authored bank (original phrasing)
          var bank = [
            'I do not feel a thing, the {n} just keeps calling.',
            'Too numb to care, I left the {n} in the sky.',
            'I can not hear the {n} anymore, it is too far up.'
          ];
          return util.pick(bank, first + '|bank').replace('{n}', n);
        }
      },
      {
        id: 'yeat-louder-talk',
        name: 'Louder Talk',
        description: 'Turns the sentence into a surreal flex where one noun is allowed to talk, but the money talks louder.',
        transform: (text, util) => {
          // Example 1: 'The critics wrote long essays about the new album.' -> 'The critics can wait, the twizzy already up.'
          // Example 2: 'Rumors spread through the group chat all night.' -> 'The night can wait, the twizzy already up.'
          var sents = util.sentences(text);
          if (!sents.length) return text;
          var first = sents[0];
          var nouns = util.nouns(first);
          if (!nouns.length) return text;
          var n = nouns[nouns.length - 1];
          // authored bank (original phrasing)
          var bank = [
            'Let the {n} talk, the bag talks louder.',
            'I hear the {n}, but the money talks louder.',
            'The {n} can wait, the twizzy already up.'
          ];
          return util.pick(bank, first + '|bank').replace('{n}', n);
        }
      }
    ]
  },
  {
    id: 'tyler-the-creator',
    name: 'Tyler, the Creator',
    voice: 'American rapper, producer, and designer, co-founder and leader of Odd Future; known for constant reinvention across horrorcore, jazz rap, and soul, with alter egos and fashion labels Golf Wang and Le Fleur.',
    sources: ['https://lt.wikipedia.org/wiki/Tyler,_the_Creator'],
    lenses: [
      {
        id: 'tyler-the-creator-left-turn',
        name: 'Left Turn Aside',
        description: 'Keeps the sentence, then veers into an absurdist parenthetical aside, the internet-brain non sequitur.',
        transform: (text, util) => {
          // Example 1: 'The meeting starts at noon in the glass building.' -> 'The meeting starts at noon in the glass building (I once brought a trombone to something like this).'
          // Example 2: 'She keeps a strict schedule every single morning.' -> 'She keeps a strict schedule every single morning (anyway, I painted the bike again).'
          var words = util.words(text);
          if (words.length < 4) return text;
          var sents = util.sentences(text);
          if (!sents.length) return text;
          var s = util.stripEnd(sents[0]);
          // authored bank (original phrasing)
          var asides = [
            '(I once brought a trombone to something like this)',
            '(anyway, I painted the bike again)',
            '(the dog saw the whole thing and said nothing)',
            '(this is also how I pick paint colors)'
          ];
          return s + ' ' + util.pick(asides, s + '|aside') + '.';
        }
      },
      {
        id: 'tyler-the-creator-self-aware',
        name: 'Self-Aware Opener',
        description: 'Prefixes the sentence with a disarming self-aware disclaimer, then lets the original thought land plainly.',
        transform: (text, util) => {
          // Example 1: 'The clouds look like teeth today.' -> 'Look, I know this is weird, but the clouds look like teeth today.'
          // Example 2: 'I think the lamp is judging me.' -> 'Look, I know this is weird, but I think the lamp is judging me.'
          var words = util.words(text);
          if (words.length < 4) return text;
          var sents = util.sentences(text);
          if (!sents.length) return text;
          var s = util.stripEnd(sents[0]);
          s = (util.words(s)[0] === 'i') ? s : util.lowerFirst(s);
          return 'Look, I know this is weird, but ' + s + '.';
        }
      },
      {
        id: 'tyler-the-creator-reinvent',
        name: 'Reinvention Bit',
        description: 'Recasts the sentence as a fresh alter-ego bit: a new name, a new era named after one of its words.',
        transform: (text, util) => {
          // Example 1: 'The rain soaked the red umbrella.' -> 'Call me Captain Do-Over: the umbrella era starts now.'
          // Example 2: 'His old truck broke down on the highway.' -> 'Call me Sir New Era: the highway era starts now.'
          var sents = util.sentences(text);
          if (!sents.length) return text;
          var first = sents[0];
          var nouns = util.nouns(first);
          if (!nouns.length) return text;
          var n = nouns[nouns.length - 1];
          // authored bank (original phrasing)
          var aliases = ['Captain Do-Over', 'Sir New Era', 'The Fresh Guy'];
          return 'Call me ' + util.pick(aliases, n + '|alias') + ': the ' + n + ' era starts now.';
        }
      }
    ]
  },
  {
    id: 'jid',
    name: 'JID',
    voice: 'Atlanta rapper signed to J. Cole\'s Dreamville Records, acclaimed by critics for his fluent rapping style and dense wordplay; best known for The Forever Story and the hit Enemy with Imagine Dragons.',
    sources: ['https://en.wikipedia.org/wiki/JID'],
    lenses: [
      {
        id: 'jid-breathless-run',
        name: 'Breathless Run',
        description: 'Stacks the sentence\'s content words into a rapid-fire comma run, then lands a confident closer.',
        transform: (text, util) => {
          // Example 1: 'The students practiced complicated math formulas after school.' -> 'Students, practiced, complicated: I run it back, I meant it.'
          // Example 2: 'Bright kids memorize endless verses in the hallway.' -> 'Bright, kids, memorize: say it back and keep up.'
          var sents = util.sentences(text);
          if (!sents.length) return text;
          var cw = util.contentWords(sents[0]);
          if (cw.length < 3) return text;
          // authored bank (original phrasing)
          var closers = ['I run it back, I meant it.', 'I said it how I meant it.', 'say it back and keep up.'];
          var stack = util.capFirst(cw[0]) + ', ' + cw[1] + ', ' + cw[2];
          return stack + ': ' + util.pick(closers, sents[0] + '|closer');
        }
      },
      {
        id: 'jid-wordplay-flip',
        name: 'Wordplay Flip',
        description: 'Flips one noun against itself in a tight wordplay couplet: no X games, just X business.',
        transform: (text, util) => {
          // Example 1: 'The deal closed after hours of tense negotiation.' -> 'No negotiation games, just negotiation business.'
          // Example 2: 'We chased the money through three different cities.' -> 'No money games, just money business.'
          var sents = util.sentences(text);
          if (!sents.length) return text;
          var nouns = util.nouns(sents[0]);
          if (!nouns.length) return text;
          var n = util.pick(nouns, sents[0] + '|flip');
          return 'No ' + n + ' games, just ' + n + ' business.';
        }
      },
      {
        id: 'jid-meant-every-word',
        name: 'Meant Every Word',
        description: 'Collapses the sentence into a rapid confident punch anchored on its verb: I verb em, I meant every word.',
        transform: (text, util) => {
          // Example 1: 'The chef carved the tender meat with a sharp knife.' -> 'I carved em, I meant every word.'
          // Example 2: 'The pitcher threw the fast ball past the rookie.' -> 'I threw em, I meant every word.'
          var sents = util.sentences(text);
          if (!sents.length) return text;
          var verbs = util.verbs(sents[0]);
          if (!verbs.length) return text;
          var v = util.pick(verbs, sents[0] + '|verb');
          return 'I ' + v + ' em, I meant every word.';
        }
      }
    ]
  }
];
