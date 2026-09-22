#!/usr/bin/env node
/**
 * Lari research: deterministic retrieval + distillation. Zero external model calls.
 *
 * When the composer hits a knowledge shortfall, Lari researches the topic
 * instead of shortfalling: fetch URLs named in the prompt (Wikipedia pages via
 * the MediaWiki API), otherwise search Wikipedia for the topic and pull the
 * article extracts. Sentences are distilled with topic gating, deduplicated,
 * and returned with their sources so the composer can answer from real content
 * and the model can persist what it learned.
 *
 * Usable as a module (require) and as a CLI:
 *   node scripts/lari_research.js "Write a 300+ word summary of https://en.wikipedia.org/wiki/Raymond_III,_Count_of_Tripoli"
 */
'use strict';

const UA = 'LariResearch/1.0 (local deterministic research; contact: local)';
const FETCH_TIMEOUT_MS = 20000;
const MAX_FETCH_BYTES = 2_000_000;

const STOPWORDS = new Set(String(
  'a,an,the,of,and,or,to,in,on,for,with,about,as,at,by,from,is,are,was,were,be,been,' +
  'it,its,this,that,these,those,what,which,who,whom,whose,how,when,where,why,do,does,' +
  'did,can,could,should,would,will,shall,may,might,must,you,your,he,she,they,them,his,' +
  'her,their,our,we,i,me,my,us,not,no,yes,if,then,than,so,such,very,more,most,less,' +
  'least,into,out,over,under,between,through,during,before,after,above,below,up,down,' +
  'write,give,make,please,explain,describe,discuss,short,long,brief,following,use,using'
).split(','));

function topicTokens(text) {
  const tokens = new Set();
  for (const tok of String(text || '').toLowerCase().match(/[a-z][a-z-]{2,}/g) || []) {
    if (!STOPWORDS.has(tok) && !tokens.has(tok)) tokens.add(tok);
  }
  return tokens;
}

function extractUrls(text) {
  const urls = [];
  for (const m of String(text || '').matchAll(/https?:\/\/[^\s"'<>)\]]+/g)) {
    let url = m[0].replace(/[.,;:!?]+$/, '');
    if (!urls.includes(url)) urls.push(url);
  }
  return urls.slice(0, 3);
}

function wikipediaTitleFromUrl(url) {
  const m = String(url || '').match(/wikipedia\.org\/wiki\/([^#?]+)/i);
  if (!m) return '';
  try {
    return decodeURIComponent(m[1]).replace(/_/g, ' ').trim();
  } catch (_) {
    return m[1].replace(/_/g, ' ').trim();
  }
}

async function fetchWithTimeout(url, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs || FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      headers: { 'User-Agent': UA, Accept: options.accept || '*/*' },
      signal: controller.signal,
      redirect: 'follow'
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length > MAX_FETCH_BYTES) throw new Error('response too large');
    return buffer.toString('utf8');
  } finally {
    clearTimeout(timer);
  }
}

function decodeEntities(text) {
  return String(text || '')
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, code) => String.fromCharCode(parseInt(code, 16)))
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ');
}

function htmlToText(html) {
  let text = String(html || '');
  text = text.replace(/<script[\s\S]*?<\/script>/gi, ' ');
  text = text.replace(/<style[\s\S]*?<\/style>/gi, ' ');
  text = text.replace(/<!--[\s\S]*?-->/g, ' ');
  text = text.replace(/<[^>]+>/g, ' ');
  text = decodeEntities(text);
  return text.replace(/[ \t\f\v\u00a0]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
}

async function wikipediaSearch(topic) {
  const url = `https://en.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(topic)}&format=json&srlimit=5`;
  const raw = await fetchWithTimeout(url, { accept: 'application/json' });
  const data = JSON.parse(raw);
  return (data && data.query && data.query.search || []).map(item => item.title).filter(Boolean);
}

async function wikipediaExtracts(title) {
  const url = `https://en.wikipedia.org/w/api.php?action=query&prop=extracts&explaintext=1&exsectionformat=plain&titles=${encodeURIComponent(title)}&format=json`;
  const raw = await fetchWithTimeout(url, { accept: 'application/json' });
  const data = JSON.parse(raw);
  const pages = (data && data.query && data.query.pages) || {};
  for (const key of Object.keys(pages)) {
    const extract = pages[key] && pages[key].extract;
    if (extract) return { title: pages[key].title || title, text: extract };
  }
  return null;
}

async function wikipediaSummary(title) {
  const url = `https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(title)}`;
  const raw = await fetchWithTimeout(url, { accept: 'application/json' });
  const data = JSON.parse(raw);
  if (data && data.extract) return { title: data.title || title, text: data.extract };
  return null;
}

function splitSentences(text) {
  return String(text || '').match(/[^.!?]+[.!?]+["']?/g) || [];
}

function distillSentences(text, tokens, max = 40) {
  const out = [];
  const seen = new Set();
  const debris = /^(edit|references|see also|external links|further reading|notes|citations)\b/i;
  for (let sentence of splitSentences(text)) {
    sentence = sentence.replace(/\s+/g, ' ').trim();
    if (sentence.length < 25 || sentence.length > 500) continue;
    if (!/[.!?]["']?$/.test(sentence)) continue;
    if (debris.test(sentence)) continue;
    if (/\b(click here|cookie|subscribe|sign up|all rights reserved)\b/i.test(sentence)) continue;
    const lower = sentence.toLowerCase();
    let shared = 0;
    if (tokens.size) {
      for (const tok of tokens) {
        if (new RegExp(`\\b${tok.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(lower)) shared += 1;
      }
      if (!shared) continue;
    }
    const key = lower;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(sentence);
    if (out.length >= max) break;
  }
  return out;
}

/**
 * Infer a research topic from a prompt. Priority: Wikipedia URL title in the
 * prompt, quoted phrases, "about/on X" clauses, then content-word fallback.
 */
function inferResearchTopic(prompt) {
  const text = String(prompt || '');
  for (const url of extractUrls(text)) {
    const title = wikipediaTitleFromUrl(url);
    if (title) return { topic: title, urls: [url] };
  }
  const quoted = [];
  for (const m of text.matchAll(/[""''"]([^""''"]{4,80})[""''"]/g)) {
    const phrase = m[1].trim();
    if (!/^(write|please|answer|respond)/i.test(phrase)) quoted.push(phrase);
  }
  if (quoted.length) {
    quoted.sort((a, b) => b.length - a.length);
    return { topic: quoted[0], urls: extractUrls(text) };
  }
  const aboutMatch = text.match(/\babout\s+([^.,;!?]{4,80}?)(?:,|\.|;|!|\?|\bwith\b|\bwithout\b|$)/i)
    || text.match(/\bessay\s+on\s+([^.,;!?]{4,80}?)(?:,|\.|;|!|\?|$)/i)
    || text.match(/\barticle\s+(?:about|on)\s+([^.,;!?]{4,80}?)(?:,|\.|;|!|\?|$)/i)
    || text.match(/\b(?:summary|overview|description|profile)\s+(?:of|on)\s+([^.,;!?]{4,80}?)(?:,|\.|;|!|\?|$)/i);
  if (aboutMatch) {
    const cleaned = aboutMatch[1].trim().replace(/^(?:the|a|an)\s+/i, '');
    if (cleaned) return { topic: cleaned, urls: [] };
  }
  // Question frames ("Who wrote Hamlet?", "How tall is Mount Everest?")
  // would otherwise pollute the topic ("tall mount everest" once fetched
  // the 1996 disaster article instead of the mountain). Strip the frame so
  // the topic is the subject being asked about.
  const questionStripped = text
    .replace(/^(?:who|what|where|when|why|which)\s+(?:is|are|was|were|do|does|did|wrote|painted|discovered|invented)\s+/i, '')
    .replace(/^how\s+(?:many|much|old|far|tall|long|deep|big|wide)\s+(?:is|are|was|were)\s+/i, '')
    .replace(/^what\s+language\s+do\s+they\s+speak\s+in\s+/i, '')
    .replace(/\s+born\??$/i, '');
  const stripped = questionStripped !== text ? questionStripped : text;
  const contentWords = [...topicTokens(stripped)].slice(0, 6);
  // Numeric subjects ("Who wrote 1984?"): topicTokens only captures
  // alphabetic tokens, so a stripped question left with just a number
  // would infer an empty topic.
  if (!contentWords.length && questionStripped !== text) {
    const numeric = stripped.match(/\b\d[\d,.]*\b/g) || [];
    if (numeric.length) {
      const numTopic = numeric.slice(0, 3).join(' ');
      // "Who wrote 1984?" is about the novel, not the year 1984.
      if (/who\s+wrote/i.test(text)) return { topic: numTopic + ' novel', urls: [] };
      return { topic: numTopic, urls: [] };
    }
  }
  if (contentWords.length >= 1) return { topic: contentWords.join(' '), urls: [] };
  return { topic: '', urls: [] };
}

async function researchTopic(topic, urls = []) {
  const sentences = [];
  const sources = [];
  const push = (list, source) => {
    for (const sentence of list) {
      if (!sentences.includes(sentence)) sentences.push(sentence);
    }
    if (source && !sources.includes(source)) sources.push(source);
  };

  // 1. URLs named in the prompt first: the prompt may literally ask to summarize one.
  for (const url of urls.slice(0, 2)) {
    try {
      const wikiTitle = wikipediaTitleFromUrl(url);
      if (wikiTitle) {
        const extracts = await wikipediaExtracts(wikiTitle);
        if (extracts && extracts.text) {
          push(distillSentences(extracts.text, topicTokens(topic), 40), url);
          continue;
        }
        const summary = await wikipediaSummary(wikiTitle);
        if (summary && summary.text) push(distillSentences(summary.text, topicTokens(topic), 12), url);
      } else {
        const html = await fetchWithTimeout(url, { accept: 'text/html' });
        push(distillSentences(htmlToText(html), topicTokens(topic), 30), url);
      }
    } catch (error) {
      push([], null);
    }
    if (sentences.length >= 12) break;
  }

  // 2. Wikipedia search for the topic.
  if (sentences.length < 8 && topic) {
    try {
      const titles = await wikipediaSearch(topic);
      for (const title of titles.slice(0, 2)) {
        try {
          const extracts = await wikipediaExtracts(title);
          if (extracts && extracts.text) {
            push(distillSentences(extracts.text, topicTokens(topic), 40),
              `https://en.wikipedia.org/wiki/${encodeURIComponent(title.replace(/ /g, '_'))}`);
          }
        } catch (_) { /* next title */ }
        if (sentences.length >= 20) break;
      }
    } catch (_) { /* search failed; keep what we have */ }
  }

  return { topic, sentences: sentences.slice(0, 40), sources };
}

async function researchPrompt(prompt) {
  const inferred = inferResearchTopic(prompt);
  if (!inferred.topic && !inferred.urls.length) return { topic: '', sentences: [], sources: [] };
  return researchTopic(inferred.topic, inferred.urls);
}

module.exports = {
  topicTokens,
  extractUrls,
  wikipediaTitleFromUrl,
  inferResearchTopic,
  distillSentences,
  researchTopic,
  researchPrompt
};

if (require.main === module) {
  (async () => {
    const prompt = process.argv.slice(2).join(' ');
    if (!prompt) {
      console.error('usage: node scripts/lari_research.js "<prompt>"');
      process.exit(1);
    }
    const result = await researchPrompt(prompt);
    console.log(JSON.stringify(result, null, 2));
  })().catch(error => {
    console.error(`research failed: ${error.message}`);
    process.exit(1);
  });
}
