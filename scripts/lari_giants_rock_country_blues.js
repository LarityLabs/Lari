'use strict';
// DRAFT: transforms only, examples to be verified by harness run.
module.exports = [
{ id: 'dylan', name: 'Bob Dylan',
  voice: 'Nobel literature laureate whose lyrics fused protest politics, surreal imagery, and biblical language, and reshaped American song.',
  sources: ['https://ja.wikipedia.org/wiki/ボブ・ディラン'],
  lenses: [
  { id: 'dylan-riddle-question', name: 'Riddling protest question',
    description: 'Appends a riddling protest question built from two nouns in the text.',
    // ex: "The city sleeps while the factories burn." -> "The city sleeps while the factories burn. Tell me, how many times must the factories fall before the city learns to rise?"
    // ex: "Rain on the window, thunder on the roof." -> "Rain on the window, thunder on the roof. Tell me, how many times must the roof fall before the window learns to rise?"
    transform: (text, util) => {
      if (!text || !text.trim()) return text;
      var nouns = util.nouns(text);
      var adj = {old:1,new:1,long:1,good:1,great:1,big:1,small:1,black:1,white:1,red:1,hot:1,cold:1,young:1,dark:1,empty:1,full:1,whole:1,real:1,loud:1,lonesome:1,back:1,own:1,last:1,first:1};
      var clean = nouns.filter(function (w) { return !adj[w]; });
      if (clean.length) nouns = clean;
      if (nouns.length < 2) return text;
      var n1 = util.pick(nouns, 'dylan-riddle-1:' + text);
      var n2 = util.pick(nouns, 'dylan-riddle-2:' + text);
      return util.endWith(text, '.') + ' Tell me, how many times must the ' + n1 + ' fall before the ' + n2 + ' learns to rise?';
    } },
  { id: 'dylan-biblical-opener', name: 'Surreal biblical opener',
    description: 'Prefixes the text with a surreal biblical clause that collides with the original sentence.',
    // ex: "The judge signed the paper at dawn." -> "When the trumpet sounded over the empty courthouse, and still the judge signed the paper at dawn."
    // ex: "The children marched through the empty square." -> "And the prophets said the river would run backward, and still the children marched through the empty square."
    transform: (text, util) => {
      if (!text || !text.trim()) return text;
      // authored bank (original phrasing)
      var bank = [
        'And the prophets said the river would run backward',
        'In the year the locusts ate the harvest',
        'When the trumpet sounded over the empty courthouse',
        'And the elders dreamed that the mountains moved'
      ];
      var opener = util.pick(bank, 'dylan-biblical:' + text);
      return opener + ', and still ' + util.lowerFirst(text.trim());
    } },
  { id: 'dylan-aphorism-closer', name: 'Gnomic aphorism closer',
    description: 'Appends an original aphorism in the gnomic, road-worn register.',
    // ex: "He left the town before the parade." -> "He left the town before the parade. The truth wears no crown and carries no map."
    // ex: "The radio played nothing but static." -> "The radio played nothing but static. The wind keeps no promises, and neither do kings."
    transform: (text, util) => {
      if (!text || !text.trim()) return text;
      // authored bank (original phrasing)
      var bank = [
        'The truth wears no crown and carries no map.',
        'Every road ends where the asking begins.',
        'The mirror never lies, but it never confesses either.',
        'A bell that rings for everyone rings for no one.',
        'The wind keeps no promises, and neither do kings.'
      ];
      return util.endWith(text, '.') + ' ' + util.pick(bank, 'dylan-closer:' + text);
    } }
  ] },
{ id: 'jim-morrison', name: 'Jim Morrison',
  voice: 'Poet and baritone frontman of The Doors, famed for a theatrical shaman persona and dark poetic improvisation on stage.',
  sources: ['https://ru.wikipedia.org/wiki/Моррисон,_Джим'],
  lenses: [
  { id: 'jim-morrison-storm-prophecy', name: 'Storm prophecy',
    description: 'Appends a dark prophetic sentence drawn from an authored bank of storm and night imagery.',
    // ex: "We drove until the headlights died." -> "We drove until the headlights died. The doors you locked are opening from the other side."
    // ex: "The carnival packed up in the rain." -> "The carnival packed up in the rain. The doors you locked are opening from the other side."
    transform: (text, util) => {
      if (!text || !text.trim()) return text;
      // authored bank (original phrasing)
      var bank = [
        'Somewhere the storm is learning your name.',
        'The doors you locked are opening from the other side.',
        'Night is coming down like a velvet hammer.',
        'The desert keeps what the city throws away.'
      ];
      return util.endWith(text, '.') + ' ' + util.pick(bank, 'morrison-prophecy:' + text);
    } },
  { id: 'jim-morrison-shaman-chant', name: 'Shaman chant',
    description: 'Appends a threefold chant of a key noun, like a ritual incantation.',
    // ex: "The fire took the old theater." -> "The fire took the old theater. And still it calls: fire, fire, fire."
    // ex: "The desert wind carried the drums." -> "The desert wind carried the drums. And still it calls: drums, drums, drums."
    transform: (text, util) => {
      if (!text || !text.trim()) return text;
      var nouns = util.nouns(text);
      var adj = {old:1,new:1,long:1,good:1,great:1,big:1,small:1,black:1,white:1,red:1,hot:1,cold:1,young:1,dark:1,empty:1,full:1,whole:1,real:1,loud:1,lonesome:1,back:1,own:1,last:1,first:1};
      var clean = nouns.filter(function (w) { return !adj[w]; });
      if (clean.length) nouns = clean;
      if (!nouns.length) return text;
      var n = util.pick(nouns, 'morrison-chant:' + text);
      return util.endWith(text, '.') + ' And still it calls: ' + n + ', ' + n + ', ' + n + '.';
    } },
  { id: 'jim-morrison-fatal-inversion', name: 'Fatal inversion',
    description: 'Reframes the text as an already-written ending, fatal and declarative.',
    // ex: "She danced alone in the empty hall." -> "The end is already written: she danced alone in the empty hall."
    // ex: "The last train left without a whistle." -> "The end is already written: the last train left without a whistle."
    transform: (text, util) => {
      if (!text || !text.trim()) return text;
      return 'The end is already written: ' + util.lowerFirst(text.trim());
    } }
  ] },
{ id: 'patti-smith', name: 'Patti Smith',
  voice: 'Poet and singer dubbed the godmother of punk, who fused Beat poetry with garage rock on her 1975 debut Horses.',
  sources: ['https://el.wikipedia.org/wiki/%CE%A0%CE%AC%CF%84%CF%84%CE%B9_%CE%A3%CE%BC%CE%B9%CE%B8'],
  lenses: [
  { id: 'patti-smith-incantation-list', name: 'Incantation list',
    description: 'Appends an incantatory I-want list built from the nouns of the text.',
    // ex: "The guitars rang out over the crowd." -> "The guitars rang out over the crowd. I want crowd, I want guitars."
    // ex: "The choir sang hymns in the old chapel." -> "The choir sang hymns in the old chapel. I want choir, I want chapel, I want hymns."
    transform: (text, util) => {
      if (!text || !text.trim()) return text;
      var nouns = util.nouns(text);
      var adj = {old:1,new:1,long:1,good:1,great:1,big:1,small:1,black:1,white:1,red:1,hot:1,cold:1,young:1,dark:1,empty:1,full:1,whole:1,real:1,loud:1,lonesome:1,back:1,own:1,last:1,first:1};
      var clean = nouns.filter(function (w) { return !adj[w]; });
      if (clean.length) nouns = clean;
      if (!nouns.length) return text;
      var ranked = nouns.slice().sort(function (a, b) { return util.hash(a + ':' + text) - util.hash(b + ':' + text); });
      var picks = ranked.slice(0, 3);
      return util.endWith(text, '.') + ' I want ' + picks.join(', I want ') + '.';
    } },
  { id: 'patti-smith-fierce-blessing', name: 'Fierce blessing',
    description: 'Appends a fierce, tender blessing from an authored bank.',
    // ex: "She sang until the windows shook." -> "She sang until the windows shook. Take the stage the world denied you and set it alight."
    // ex: "The band played past midnight." -> "The band played past midnight. Take the stage the world denied you and set it alight."
    transform: (text, util) => {
      if (!text || !text.trim()) return text;
      // authored bank (original phrasing)
      var bank = [
        'Stay wild, stay tender, stay awake.',
        'The night belongs to the ones who burn clean.',
        'Write it in fire, love it like thunder.',
        'Take the stage the world denied you and set it alight.'
      ];
      return util.endWith(text, '.') + ' ' + util.pick(bank, 'smith-blessing:' + text);
    } },
  { id: 'patti-smith-rimbaud-fire', name: 'Rimbaud fire',
    description: 'Appends a Rimbaud-channeling line of arsonous praise.',
    // ex: "He wrote the poem on a napkin." -> "He wrote the poem on a napkin. The poets of the old century are jealous of this hour."
    // ex: "The drums would not stop." -> "The drums would not stop. Even Rimbaud would have set this one on fire."
    transform: (text, util) => {
      if (!text || !text.trim()) return text;
      // authored bank (original phrasing)
      var bank = [
        'Even Rimbaud would have set this one on fire.',
        'Rimbaud is somewhere applauding with burnt hands.',
        'The poets of the old century are jealous of this hour.'
      ];
      return util.endWith(text, '.') + ' ' + util.pick(bank, 'smith-rimbaud:' + text);
    } }
  ] },
{ id: 'leonard-cohen', name: 'Leonard Cohen',
  voice: 'Canadian poet and singer of emotionally intense, complex songs about religion, loneliness, and love, in a deep low voice.',
  sources: ['https://ru.wikipedia.org/wiki/Коэн,_Леонард'],
  lenses: [
  { id: 'leonard-cohen-wound-of-light', name: 'Wound of light',
    description: 'Appends a wry prayer-like closer about brokenness and light, from an authored bank.',
    // ex: "He carried the loss for twenty years." -> "He carried the loss for twenty years. We were never perfect, which is why the light found us."
    // ex: "The letter arrived after the funeral." -> "The letter arrived after the funeral. I learned the chords; the song learned me."
    transform: (text, util) => {
      if (!text || !text.trim()) return text;
      // authored bank (original phrasing)
      var bank = [
        'The wound is where the morning enters.',
        'Even the prayer that fails is still a prayer.',
        'I learned the chords; the song learned me.',
        'We were never perfect, which is why the light found us.'
      ];
      return util.endWith(text, '.') + ' ' + util.pick(bank, 'cohen-wound:' + text);
    } },
  { id: 'leonard-cohen-wry-confession', name: 'Wry confession',
    description: 'Prefixes a sorrowful confession that frames the original as testimony.',
    // ex: "The deal fell through in the spring." -> "I am a man of sorrows, and I confess: the deal fell through in the spring."
    // ex: "Love left no forwarding address." -> "I am a man of sorrows, and I confess: love left no forwarding address."
    transform: (text, util) => {
      if (!text || !text.trim()) return text;
      return 'I am a man of sorrows, and I confess: ' + util.lowerFirst(text.trim());
    } },
  { id: 'leonard-cohen-psalm-count', name: 'Psalm count',
    description: 'Replaces the text with a short psalm: first this, then that, and at the end, silence.',
    // ex: "The choir sang, the candles burned, the night went on." -> "First the candles, then the choir, and at the end, the silence."
    // ex: "Wine, bread, and a borrowed guitar." -> "First the guitar, then the wine, and at the end, the silence."
    transform: (text, util) => {
      if (!text || !text.trim()) return text;
      var nouns = util.nouns(text);
      var adj = {old:1,new:1,long:1,good:1,great:1,big:1,small:1,black:1,white:1,red:1,hot:1,cold:1,young:1,dark:1,empty:1,full:1,whole:1,real:1,loud:1,lonesome:1,back:1,own:1,last:1,first:1};
      var clean = nouns.filter(function (w) { return !adj[w]; });
      if (clean.length) nouns = clean;
      if (nouns.length < 2) return text;
      var n1 = util.pick(nouns, 'cohen-psalm-1:' + text);
      var n2 = util.pick(nouns, 'cohen-psalm-2:' + text);
      return 'First the ' + n1 + ', then the ' + n2 + ', and at the end, the silence.';
    } }
  ] },
{ id: 'johnny-cash', name: 'Johnny Cash',
  voice: 'The Man in Black, whose deep bass-baritone sang of sorrow, moral trial, and redemption, always opening with a plain hello.',
  sources: ['https://zh.wikipedia.org/wiki/約翰尼·卡什'],
  lenses: [
  { id: 'johnny-cash-strip-adverbs', name: 'Adverb strip',
    description: 'Strips -ly adverbs that follow verbs, leaving the sentence lean and declarative.',
    // ex: "He walked slowly down the lonely road." -> "He walked down the lonely road."
    // ex: "She sang softly and the crowd listened quietly." -> "She sang and the crowd listened."
    transform: (text, util) => {
      if (!text || !text.trim()) return text;
      var verbs = {};
      util.verbs(text).forEach(function (v) { verbs[v] = true; });
      var parts = text.split(/([A-Za-z]+(?:'[A-Za-z]+)?)/);
      var prevWord = '';
      var out = [];
      for (var i = 0; i < parts.length; i++) {
        var p = parts[i];
        if (/^[A-Za-z]/.test(p)) {
          var low = p.toLowerCase();
          if (low.length > 4 && /ly$/.test(low) && verbs[prevWord]) {
            prevWord = '';
            continue;
          }
          out.push(p);
          prevWord = low;
        } else {
          out.push(p);
        }
      }
      var result = out.join('').replace(/ {2,}/g, ' ').replace(/ ([.,!?;:])/g, '$1');
      if (result === text) return text;
      return result;
    } },
  { id: 'johnny-cash-moral-verdict', name: 'Moral verdict',
    description: 'Appends a plain declarative moral verdict from an authored bank.',
    // ex: "He cheated his partners and kept the money." -> "He cheated his partners and kept the money. And that is where the line is drawn."
    // ex: "The town forgot the promise by winter." -> "The town forgot the promise by winter. And that is where the line is drawn."
    transform: (text, util) => {
      if (!text || !text.trim()) return text;
      // authored bank (original phrasing)
      var bank = [
        'And that is where the line is drawn.',
        'You reap what you sow, and the harvest is on you.',
        'A man is measured by what he carries, not what he takes.',
        'The bill always comes due, friend, always.'
      ];
      return util.endWith(text, '.') + ' ' + util.pick(bank, 'cash-verdict:' + text);
    } },
  { id: 'johnny-cash-plain-confession', name: 'Plain confession',
    description: 'Appends a plain first-person confession of shared experience.',
    // ex: "The road was hard and the nights were long." -> "The road was hard and the nights were long. I know, because I have been there myself."
    // ex: "Prison teaches a man to count the days." -> "Prison teaches a man to count the days. I know, because I have been there myself."
    transform: (text, util) => {
      if (!text || !text.trim()) return text;
      return util.endWith(text, '.') + ' I know, because I have been there myself.';
    } }
  ] },
{ id: 'willie-nelson', name: 'Willie Nelson',
  voice: 'Outlaw country icon with a relaxed nasal sound, famed for plainspoken songwriting, constant touring, and easygoing defiance.',
  sources: ['https://zh.wikipedia.org/wiki/%E5%A8%81%E5%88%A9%C2%B7%E7%B4%8D%E7%88%BE%E9%81%9C'],
  lenses: [
  { id: 'willie-nelson-well-now', name: 'Well now',
    description: 'Prefixes the text with an easygoing "Well now," setting a porch-philosopher tone.',
    // ex: "The river keeps its own time." -> "Well now, the river keeps its own time."
    // ex: "Most worries dissolve by morning." -> "Well now, most worries dissolve by morning."
    transform: (text, util) => {
      if (!text || !text.trim()) return text;
      var t = text.trim();
      if (/^well now\b/i.test(t)) return text;
      return 'Well now, ' + util.lowerFirst(t);
    } },
  { id: 'willie-nelson-road-wisdom', name: 'Road wisdom',
    description: 'Appends gentle outlaw philosophy from an authored bank.',
    // ex: "The years piled up like autumn leaves." -> "The years piled up like autumn leaves. It all works out, or it does not, and either way the song plays on."
    // ex: "He missed the bus and caught a story." -> "He missed the bus and caught a story. Time has taught me most of what I once forgot."
    transform: (text, util) => {
      if (!text || !text.trim()) return text;
      // authored bank (original phrasing)
      var bank = [
        'The road goes on, and so do I.',
        'Time has taught me most of what I once forgot.',
        'It all works out, or it does not, and either way the song plays on.',
        'I have been wrong enough to know when I am right.'
      ];
      return util.endWith(text, '.') + ' ' + util.pick(bank, 'willie-wisdom:' + text);
    } },
  { id: 'willie-nelson-wry-closer', name: 'Wry closer',
    description: 'Appends a ragged-but-right closer: true, or close enough to sing.',
    // ex: "The porch light burned all night." -> "The porch light burned all night. That is the truth, or close enough to sing."
    // ex: "Old dogs learn the same old tricks." -> "Old dogs learn the same old tricks. That is the truth, or close enough to sing."
    transform: (text, util) => {
      if (!text || !text.trim()) return text;
      return util.endWith(text, '.') + ' That is the truth, or close enough to sing.';
    } }
  ] },
{ id: 'dolly-parton', name: 'Dolly Parton',
  voice: 'Country singer and songwriter of more than 3,000 songs, famed for Jolene and 9 to 5, pairing a sweet image with sharp business grit.',
  sources: ['https://sw.wikipedia.org/wiki/Dolly_Parton'],
  lenses: [
  { id: 'dolly-parton-bless-your-heart', name: 'Bless your heart',
    description: 'Prefixes a honeyed "Bless your heart," sweet on the surface.',
    // ex: "The meeting ran three hours long." -> "Bless your heart, the meeting ran three hours long."
    // ex: "The pipes burst in January." -> "Bless your heart, the pipes burst in January."
    transform: (text, util) => {
      if (!text || !text.trim()) return text;
      var t = text.trim();
      if (/^bless your heart\b/i.test(t)) return text;
      return 'Bless your heart, ' + util.lowerFirst(t);
    } },
  { id: 'dolly-parton-steel-closer', name: 'Steel closer',
    description: 'Appends a wry aphoristic closer with steel underneath, from an authored bank.',
    // ex: "They underestimated her every single time." -> "They underestimated her every single time. Kindness is a choice, and I choose it with both hands."
    // ex: "The deal was signed before lunch." -> "The deal was signed before lunch. Sweet talk is free, but backbone is earned."
    transform: (text, util) => {
      if (!text || !text.trim()) return text;
      // authored bank (original phrasing)
      var bank = [
        'Sweet talk is free, but backbone is earned.',
        'Charm opens the door; grit keeps it open.',
        'Kindness is a choice, and I choose it with both hands.',
        'A smile can carry what a sermon cannot.'
      ];
      return util.endWith(text, '.') + ' ' + util.pick(bank, 'dolly-steel:' + text);
    } },
  { id: 'dolly-parton-smile-and-mean-it', name: 'Smile and mean it',
    description: 'Appends a smiling, steely declaration of intent.',
    // ex: "I told them exactly what I thought." -> "I told them exactly what I thought. I said it with a smile, and I meant every word."
    // ex: "She kept the books and the secrets." -> "She kept the books and the secrets. I said it with a smile, and I meant every word."
    transform: (text, util) => {
      if (!text || !text.trim()) return text;
      return util.endWith(text, '.') + ' I said it with a smile, and I meant every word.';
    } }
  ] },
{ id: 'hank-williams', name: 'Hank Williams',
  voice: 'Honky-tonk pioneer and the Hillbilly Shakespeare, whose concise songs became a backbone of country music.',
  sources: ['https://en.wikipedia.org/wiki/Hank_Williams,_Sr.'],
  lenses: [
  { id: 'hank-williams-lonesome-closer', name: 'Lonesome closer',
    description: 'Appends a lonesome, economical closer from an authored bank.',
    // ex: "She left on a Tuesday and never wrote." -> "She left on a Tuesday and never wrote. Nobody knows the trouble I keep to myself."
    // ex: "The neon buzzed above the empty bar." -> "The neon buzzed above the empty bar. Lonesome is just another word for honest."
    transform: (text, util) => {
      if (!text || !text.trim()) return text;
      // authored bank (original phrasing)
      var bank = [
        'The train is gone, and I am still at the station.',
        'Lonesome is just another word for honest.',
        'Nobody knows the trouble I keep to myself.',
        'The jukebox knows my story better than I do.'
      ];
      return util.endWith(text, '.') + ' ' + util.pick(bank, 'hank-lonesome:' + text);
    } },
  { id: 'hank-williams-three-chords', name: 'Three chords',
    description: 'Prefixes the text with "Three chords and the truth," plain and direct.',
    // ex: "My dog died and my truck broke down." -> "Three chords and the truth: my dog died and my truck broke down."
    // ex: "The rent is due and the well ran dry." -> "Three chords and the truth: the rent is due and the well ran dry."
    transform: (text, util) => {
      if (!text || !text.trim()) return text;
      var t = text.trim();
      if (/^three chords/i.test(t)) return text;
      return 'Three chords and the truth: ' + util.lowerFirst(t);
    } },
  { id: 'hank-williams-direct-question', name: 'Direct question',
    description: 'Appends a direct lonesome question aimed at a noun from the text.',
    // ex: "He lost the farm and the girl in one year." -> "He lost the farm and the girl in one year. Now tell me true: did the girl ever love you back?"
    // ex: "The winter took the crops and the hope." -> "The winter took the crops and the hope. Now tell me true: did the winter ever love you back?"
    transform: (text, util) => {
      if (!text || !text.trim()) return text;
      var nouns = util.nouns(text);
      var adj = {old:1,new:1,long:1,good:1,great:1,big:1,small:1,black:1,white:1,red:1,hot:1,cold:1,young:1,dark:1,empty:1,full:1,whole:1,real:1,loud:1,lonesome:1,back:1,own:1,last:1,first:1};
      var clean = nouns.filter(function (w) { return !adj[w]; });
      if (clean.length) nouns = clean;
      if (!nouns.length) return text;
      var n = util.pick(nouns, 'hank-question:' + text);
      return util.endWith(text, '.') + ' Now tell me true: did the ' + n + ' ever love you back?';
    } }
  ] },
{ id: 'howlin-wolf', name: "Howlin' Wolf",
  voice: 'Chicago blues giant born Chester Arthur Burnett, famed for a rough primal voice and an imposing physical presence.',
  sources: ['https://ko.wikipedia.org/wiki/하울링_울프'],
  lenses: [
  { id: 'howlin-wolf-primal-boast', name: 'Primal boast',
    description: 'Replaces the text with a primal first-person boast built around a key noun.',
    // ex: "The storm broke the windows downtown." -> "I am the downtown you warned your children about."
    // ex: "Thunder scared the horses." -> "I am the horses you warned your children about."
    transform: (text, util) => {
      if (!text || !text.trim()) return text;
      var nouns = util.nouns(text);
      var adj = {old:1,new:1,long:1,good:1,great:1,big:1,small:1,black:1,white:1,red:1,hot:1,cold:1,young:1,dark:1,empty:1,full:1,whole:1,real:1,loud:1,lonesome:1,back:1,own:1,last:1,first:1};
      var clean = nouns.filter(function (w) { return !adj[w]; });
      if (clean.length) nouns = clean;
      if (!nouns.length) return text;
      var n = util.pick(nouns, 'wolf-boast:' + text);
      return 'I am the ' + n + ' you warned your children about.';
    } },
  { id: 'howlin-wolf-growl-repeat', name: 'Growl repeat',
    description: 'Appends a guttural repeated declaration of a key noun.',
    // ex: "The fire took the old theater." -> "The fire took the old theater. Fire! I said fire, and I mean every howl of it."
    // ex: "The river flooded the low roads." -> "The river flooded the low roads. Roads! I said roads, and I mean every howl of it."
    transform: (text, util) => {
      if (!text || !text.trim()) return text;
      var nouns = util.nouns(text);
      var adj = {old:1,new:1,long:1,good:1,great:1,big:1,small:1,black:1,white:1,red:1,hot:1,cold:1,young:1,dark:1,empty:1,full:1,whole:1,real:1,loud:1,lonesome:1,back:1,own:1,last:1,first:1};
      var clean = nouns.filter(function (w) { return !adj[w]; });
      if (clean.length) nouns = clean;
      if (!nouns.length) return text;
      var n = util.pick(nouns, 'wolf-growl:' + text);
      return util.endWith(text, '.') + ' ' + util.capFirst(n) + '! I said ' + n + ', and I mean every howl of it.';
    } },
  { id: 'howlin-wolf-no-apology', name: 'No apology',
    description: 'Appends an untamed, unapologetic declaration.',
    // ex: "He broke every rule in the book." -> "He broke every rule in the book. I am not sorry, and I will not be tamed."
    // ex: "The night swallowed the headlights." -> "The night swallowed the headlights. I am not sorry, and I will not be tamed."
    transform: (text, util) => {
      if (!text || !text.trim()) return text;
      return util.endWith(text, '.') + ' I am not sorry, and I will not be tamed.';
    } }
  ] },
{ id: 'muddy-waters', name: 'Muddy Waters',
  voice: 'Postwar blues figure often called the father of modern Chicago blues, who electrified the Delta sound for Chess Records.',
  sources: ['https://th.wikipedia.org/wiki/%E0%B8%A1%E0%B8%B1%E0%B8%94%E0%B8%94%E0%B8%B5_%E0%B8%A7%E0%B8%AD%E0%B9%80%E0%B8%97%E0%B8%AD%E0%B8%AA%E0%B9%8C'],
  lenses: [
  { id: 'muddy-waters-say-it-twice', name: 'Say it twice',
    description: 'Appends a repetition-with-variation: said once, said twice, claimed as his own.',
    // ex: "The river took my house in the spring." -> "The river took my house in the spring. I said it once, and I will say it twice: the river is mine."
    // ex: "The levee broke before the dawn." -> "The levee broke before the dawn. I said it once, and I will say it twice: the levee is mine."
    transform: (text, util) => {
      if (!text || !text.trim()) return text;
      var nouns = util.nouns(text);
      var adj = {old:1,new:1,long:1,good:1,great:1,big:1,small:1,black:1,white:1,red:1,hot:1,cold:1,young:1,dark:1,empty:1,full:1,whole:1,real:1,loud:1,lonesome:1,back:1,own:1,last:1,first:1};
      var clean = nouns.filter(function (w) { return !adj[w]; });
      if (clean.length) nouns = clean;
      if (!nouns.length) return text;
      var n = util.pick(nouns, 'muddy-twice:' + text);
      return util.endWith(text, '.') + ' I said it once, and I will say it twice: the ' + n + ' is mine.';
    } },
  { id: 'muddy-waters-electric-swagger', name: 'Electric swagger',
    description: 'Appends a swaggering declaration from an authored bank.',
    // ex: "He walked into the club like he owned it." -> "He walked into the club like he owned it. They can copy the licks, but they cannot copy the walk."
    // ex: "The band tuned up in the back room." -> "The band tuned up in the back room. I walk in like I own the lightning."
    transform: (text, util) => {
      if (!text || !text.trim()) return text;
      // authored bank (original phrasing)
      var bank = [
        'I walk in like I own the lightning.',
        'My shadow does the talking when I go quiet.',
        'They can copy the licks, but they cannot copy the walk.'
      ];
      return util.endWith(text, '.') + ' ' + util.pick(bank, 'muddy-swagger:' + text);
    } },
  { id: 'muddy-waters-call-response', name: 'Call and response',
    description: 'Replaces the text with a call-and-response built around a key noun.',
    // ex: "The blues came knocking at midnight." -> "You ask about the midnight? The midnight is asking about you."
    // ex: "A stranger asked about the old song." -> "You ask about the stranger? The stranger is asking about you."
    transform: (text, util) => {
      if (!text || !text.trim()) return text;
      var nouns = util.nouns(text);
      var adj = {old:1,new:1,long:1,good:1,great:1,big:1,small:1,black:1,white:1,red:1,hot:1,cold:1,young:1,dark:1,empty:1,full:1,whole:1,real:1,loud:1,lonesome:1,back:1,own:1,last:1,first:1};
      var clean = nouns.filter(function (w) { return !adj[w]; });
      if (clean.length) nouns = clean;
      if (!nouns.length) return text;
      var n = util.pick(nouns, 'muddy-call:' + text);
      return 'You ask about the ' + n + '? The ' + n + ' is asking about you.';
    } }
  ] },
{ id: 'robert-johnson', name: 'Robert Johnson',
  voice: 'Delta blues master of the landmark 1936 and 1937 recordings, whose legend says he sold his soul at a crossroads.',
  sources: ['https://en.wikipedia.org/wiki/Robert_Johnson_(musician)'],
  lenses: [
  { id: 'robert-johnson-crossroads-deal', name: 'Crossroads deal',
    description: 'Appends crossroads dread from an authored bank of deal-with-the-devil imagery.',
    // ex: "I left town before the sun came up." -> "I left town before the sun came up. At the crossroads I made my deal, and the devil keeps the receipt."
    // ex: "The dust settled over the crossroads." -> "The dust settled over the crossroads. A hellhound is on my trail, and I can hear it gaining."
    transform: (text, util) => {
      if (!text || !text.trim()) return text;
      // authored bank (original phrasing)
      var bank = [
        'At the crossroads I made my deal, and the devil keeps the receipt.',
        'A hellhound is on my trail, and I can hear it gaining.',
        'I sold my shadow at midnight; now the dark walks beside me.',
        'The crossroads gave me the tune and took the rest.'
      ];
      return util.endWith(text, '.') + ' ' + util.pick(bank, 'johnson-deal:' + text);
    } },
  { id: 'robert-johnson-dread-question', name: 'Dread question',
    description: 'Appends a haunted question about what follows in the dark.',
    // ex: "The train is rolling down the line." -> "The train is rolling down the line. But tell me, who is that walking behind me in the dark?"
    // ex: "Footsteps followed me past the levee." -> "Footsteps followed me past the levee. But tell me, who is that walking behind me in the dark?"
    transform: (text, util) => {
      if (!text || !text.trim()) return text;
      return util.endWith(text, '.') + ' But tell me, who is that walking behind me in the dark?';
    } },
  { id: 'robert-johnson-delta-echo', name: 'Delta echo',
    description: 'Appends a haunted echo of the final three words of the text.',
    // ex: "I left town before the sun came up." -> "I left town before the sun came up. Sun came up, sun came up."
    // ex: "The train is rolling down the line." -> "The train is rolling down the line. Down the line, down the line."
    transform: (text, util) => {
      if (!text || !text.trim()) return text;
      var sents = util.sentences(text);
      var last = sents[sents.length - 1] || '';
      var words = util.words(last);
      if (words.length < 4) return text;
      var tail = words.slice(-3).join(' ');
      return util.endWith(text, '.') + ' ' + util.capFirst(tail) + ', ' + tail + '.';
    } }
  ] }
];

