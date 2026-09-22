#!/usr/bin/env node
/**
 * lari_web_research.js — general web research for Small Lari.
 *
 * Extends the Wikipedia-only research with the broader web:
 * - DuckDuckGo HTML search (no API key) for general topics
 * - HTTP fetch + text extraction for any page
 * - Yahoo Finance chart API (free, no key) for stock prices
 *
 * Zero external model calls. All deterministic. Timeouts and size caps
 * keep it bounded. Only http/https URLs are fetched.
 *
 * Usage:
 *   const web = require('./lari_web_research.js');
 *   const res = await web.researchWebTopic('tesla stock price', 'What is Tesla stock price?');
 *   // { topic, sentences: [...], sources: [...] }
 */
'use strict';

const http = require('http');
const https = require('https');

const FETCH_TIMEOUT_MS = 10000;
const MAX_PAGE_BYTES = 500 * 1024;
const MAX_REDIRECTS = 3;
const USER_AGENT = 'LariResearch/1.0 (local AI research; contact: local)';

/**
 * Fetch a URL, following redirects. Returns { status, text } or null.
 */
function fetchUrl(url, redirectCount = 0) {
  return new Promise((resolve) => {
    if (redirectCount > MAX_REDIRECTS) return resolve(null);
    let parsed;
    try {
      parsed = new URL(url);
    } catch (_) {
      return resolve(null);
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return resolve(null);
    const lib = parsed.protocol === 'https:' ? https : http;
    const req = lib.request({
      hostname: parsed.hostname,
      port: parsed.port || undefined,
      path: parsed.pathname + parsed.search,
      method: 'GET',
      headers: {
        'User-Agent': USER_AGENT,
        'Accept': 'text/html,application/xhtml+xml,application/json,text/plain,*/*',
        'Accept-Language': 'en-US,en;q=0.9'
      },
      timeout: FETCH_TIMEOUT_MS
    }, (res) => {
      // Follow redirects
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        const next = new URL(res.headers.location, url).toString();
        resolve(fetchUrl(next, redirectCount + 1));
        return;
      }
      if (res.statusCode !== 200) {
        res.resume();
        return resolve(null);
      }
      const chunks = [];
      let bytes = 0;
      res.on('data', (c) => {
        bytes += c.length;
        if (bytes <= MAX_PAGE_BYTES) chunks.push(c);
      });
      res.on('end', () => {
        resolve({ status: res.statusCode, text: Buffer.concat(chunks).toString('utf8') });
      });
      res.on('error', () => resolve(null));
    });
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.on('error', () => resolve(null));
    req.end();
  });
}

/**
 * Minimal HTML entity decoder for common entities.
 */
function decodeEntities(s) {
  return s
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(parseInt(n, 10)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
}

/**
 * Extract readable text from HTML. Strips scripts, styles, nav, etc.
 */
function htmlToText(html) {
  if (!html) return '';
  let t = String(html);
  // Remove script, style, noscript, template blocks
  t = t.replace(/<script[\s\S]*?<\/script>/gi, ' ');
  t = t.replace(/<style[\s\S]*?<\/style>/gi, ' ');
  t = t.replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ');
  t = t.replace(/<template[\s\S]*?<\/template>/gi, ' ');
  // Remove comments
  t = t.replace(/<!--[\s\S]*?-->/g, ' ');
  // Replace block elements with newlines
  t = t.replace(/<\/?(p|div|br|li|tr|h[1-6]|section|article)[^>]*>/gi, '\n');
  // Strip remaining tags
  t = t.replace(/<[^>]+>/g, ' ');
  t = decodeEntities(t);
  // Collapse whitespace
  t = t.split('\n').map(l => l.replace(/[ \t]+/g, ' ').trim()).filter(l => l.length > 0);
  return t.join('\n');
}

/**
 * Split text into sentences (simple, deterministic).
 */
function splitSentences(text) {
  return String(text || '')
    .split(/(?<=[.!?])\s+(?=[A-Z0-9"'])/)
    .map(s => s.trim())
    .filter(s => s.length >= 20 && s.length <= 500);
}

/**
 * Search DuckDuckGo HTML endpoint. Returns [{ title, url }] (max 8).
 */
async function duckDuckGoSearch(query) {
  const params = new URLSearchParams({ q: query, kl: 'us-en' });
  const url = 'https://html.duckduckgo.com/html/?' + params.toString();
  // DDG html endpoint prefers POST, but GET works too
  const res = await fetchUrl(url);
  if (!res || !res.text) return [];
  const html = res.text;
  const results = [];
  // Parse result links: <a rel="nofollow" class="result__a" href="...">
  const re = /<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = re.exec(html)) !== null && results.length < 8) {
    let href = m[1];
    // DDG wraps in /l/?uddg=<encoded>
    const uddg = href.match(/[?&]uddg=([^&]+)/);
    if (uddg) {
      try { href = decodeURIComponent(uddg[1]); } catch (_) {}
    }
    if (!/^https?:\/\//i.test(href)) continue;
    // Skip DDG internal and ad links
    if (/duckduckgo\.com/i.test(href)) continue;
    const title = decodeEntities(m[2].replace(/<[^>]+>/g, '').trim()).slice(0, 120);
    results.push({ title, url: href });
  }
  return results;
}

/**
 * Fetch a page and extract topic-relevant sentences.
 */
async function fetchTopicSentences(url, topicTokens, maxSentences = 12) {
  const res = await fetchUrl(url);
  if (!res || !res.text) return [];
  const text = htmlToText(res.text);
  if (text.length < 200) return [];
  const sentences = splitSentences(text);
  const scored = [];
  for (const s of sentences) {
    const lower = s.toLowerCase();
    let hits = 0;
    for (const tok of topicTokens) {
      if (lower.includes(tok)) hits++;
    }
    // Skip nav/boilerplate
    if (/^(home|menu|search|login|sign in|subscribe|follow us|copyright|all rights reserved)/i.test(s)) continue;
    if (hits > 0) scored.push({ s, hits });
  }
  scored.sort((a, b) => b.hits - a.hits);
  return scored.slice(0, maxSentences).map(x => x.s);
}

/**
 * Yahoo Finance: get current price for a symbol. Returns { symbol, price, currency } or null.
 */
async function yahooFinancePrice(symbol) {
  const sym = String(symbol || '').toUpperCase().replace(/[^A-Z.-]/g, '').slice(0, 12);
  if (!sym) return null;
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?interval=1d&range=1d`;
  const res = await fetchUrl(url);
  if (!res || !res.text) return null;
  try {
    const data = JSON.parse(res.text);
    const meta = data?.chart?.result?.[0]?.meta;
    if (!meta || typeof meta.regularMarketPrice !== 'number') return null;
    return {
      symbol: meta.symbol || sym,
      price: meta.regularMarketPrice,
      currency: meta.currency || 'USD',
      name: meta.longName || meta.shortName || sym
    };
  } catch (_) {
    return null;
  }
}

/**
 * Detect a stock/finance question. Returns symbol or null.
 * Matches: "tesla stock price", "what is AAPL trading at", "how much is bitcoin"
 */
function detectFinanceQuery(prompt) {
  const text = String(prompt || '');
  const companyTickers = { tesla: 'TSLA', apple: 'AAPL', amazon: 'AMZN', google: 'GOOGL', microsoft: 'MSFT', nvidia: 'NVDA', meta: 'META', netflix: 'NFLX', bitcoin: 'BTC-USD' };
  // Explicit ticker: $AAPL
  let m = text.match(/\$([A-Za-z]{1,5})\b/);
  if (m) return m[1].toUpperCase();
  // "TESLA stock" / "Tesla stock price" — map company names to tickers first
  m = text.match(/\b([A-Za-z]{2,8})\s+(?:stock|share|shares)\b/i);
  if (m) {
    const word = m[1].toLowerCase();
    if (companyTickers[word]) return companyTickers[word];
    const upper = m[1].toUpperCase();
    // Avoid common words; assume 2-5 char uppercase is a ticker
    if (!/^(THE|AND|FOR|WHAT|HOW|STOCK|SHARE|PRICE)$/.test(upper) && upper.length <= 5) return upper;
  }
  // Company name + stock/price/trading
  m = text.match(/(tesla|apple|amazon|google|microsoft|nvidia|meta|netflix|bitcoin)\b[^.]{0,40}\b(?:stock|price|trading|shares?)\b/i);
  if (m) return companyTickers[m[1].toLowerCase()] || null;
  return null;
}

/**
 * Main entry: research a topic on the web.
 * Returns { topic, sentences, sources } — sentences are topic-gated.
 */
async function researchWebTopic(topic, prompt) {
  const topicTokens = String(topic || '').toLowerCase().split(/[^a-z0-9]+/).filter(t => t.length >= 3);
  if (!topicTokens.length) return { topic, sentences: [], sources: [] };

  // Finance fast path
  const symbol = detectFinanceQuery(prompt || topic);
  if (symbol) {
    const quote = await yahooFinancePrice(symbol);
    if (quote) {
      const sentence = `${quote.name} (${quote.symbol}) is trading at ${quote.price} ${quote.currency}.`;
      return {
        topic,
        sentences: [sentence],
        sources: [`https://finance.yahoo.com/quote/${quote.symbol}`],
        finance: quote
      };
    }
  }

  // General web search
  const results = await duckDuckGoSearch(topic);
  const sentences = [];
  const sources = [];
  for (const r of results.slice(0, 3)) {
    const sents = await fetchTopicSentences(r.url, topicTokens, 8);
    if (sents.length > 0) {
      sentences.push(...sents);
      sources.push(r.url);
    }
    if (sentences.length >= 20) break;
  }
  return { topic, sentences: sentences.slice(0, 20), sources };
}

module.exports = {
  fetchUrl,
  htmlToText,
  splitSentences,
  duckDuckGoSearch,
  fetchTopicSentences,
  yahooFinancePrice,
  detectFinanceQuery,
  researchWebTopic
};
