(function attachSwarmExternalTools(globalScope) {
  const DEFAULT_REGION = {
    name: 'Columbus',
    admin1: 'Ohio',
    country: 'United States',
    latitude: 39.9612,
    longitude: -82.9988
  };

  function parseWeatherLocation(task = '') {
    const text = String(task || '').trim();
    const inMatch = text.match(/\b(?:in|near|for)\s+([a-zA-Z .'-]+?)(?:\?|$| today| tomorrow| right now| now)/i);
    const location = (inMatch?.[1] || '').trim().replace(/\s+/g, ' ');
    if (!location || /^ohio$/i.test(location)) return { query: 'Columbus, Ohio', assumed: true, reason: 'Ohio was provided without a city, so Columbus is used as the state reference point.' };
    return { query: location, assumed: false, reason: '' };
  }

  function weatherCodeSummary(code) {
    const table = {
      0: 'clear',
      1: 'mainly clear',
      2: 'partly cloudy',
      3: 'overcast',
      45: 'foggy',
      48: 'foggy',
      51: 'light drizzle',
      53: 'drizzle',
      55: 'heavy drizzle',
      61: 'light rain',
      63: 'rain',
      65: 'heavy rain',
      71: 'light snow',
      73: 'snow',
      75: 'heavy snow',
      80: 'light showers',
      81: 'showers',
      82: 'heavy showers',
      95: 'thunderstorms'
    };
    return table[code] || `weather code ${code}`;
  }

  function extractLearningTopic(task = '') {
    const text = String(task || '').trim();
    // A parsed factual frame yields the clean research subject directly.
    // This is the primary fix for whole-question topics ("who was Albert
    // Einstein" -> "Albert Einstein").
    try {
      const frame = parseFactualFrame(text);
      if (frame && frame.frame !== 'unknown' && frame.subject) {
        return String(frame.subject).slice(0, 120);
      }
    } catch (_) { /* fall through to the legacy patterns */ }
    const patterns = [
      /\b(?:research(?:\s+and\s+learn)?|study|look\s+up|find\s+out|teach\s+yourself)\s+(?:about\s+|the\s+topic\s+of\s+)?(.+?)(?:\?|$)/i,
      /\b(?:what is|what are|who is|who are|define|explain|teach me about|tell me about|learn about)\s+(.+?)(?:\?|$)/i,
      /\b(?:how does|how do)\s+(.+?)(?:\?|$)/i
    ];
    for (const pattern of patterns) {
      const match = text.match(pattern);
      if (match?.[1]) return cleanLearningTopic(match[1]);
    }
    return cleanLearningTopic(text);
  }

  function cleanLearningTopic(value = '') {
    const cleaned = String(value || '')
      .replace(/,\s*(?:especially|including|with\s+(?:a\s+)?focus\s+on)\b[\s\S]*$/i, ' ')
      // Audience, tone, and presentation constraints belong to realization,
      // not to the encyclopedia/search subject. Keeping them in the query made
      // ordinary prompts such as "explain recursion to a twelve-year-old using
      // an analogy" search for a nonexistent page with that entire title.
      .replace(/\s+(?:in a way(?: that)?|for|to)\s+(?:someone|a person|a curious|a beginner|a novice|a child|a kid|a twelve[- ]year[- ]old|an?\s+\d+[- ]year[- ]old)\b[\s\S]*$/i, ' ')
      .replace(/\s+(?:using|with)\s+(?:one|two|three|an?|the)\s+(?:analogy|example|metaphor|story|diagram|comparison)\b[\s\S]*$/i, ' ')
      .replace(/\s+(?:and\s+)?(?:learn|remember|retain)(?:\s+(?:it|this|that|the\s+(?:core\s+)?ideas?|what\s+matters|the\s+basics))?[\s\S]*$/i, ' ')
      .replace(/\s+(?:and\s+)?(?:explain|summarize|teach)(?:\s+me)?[\s\S]*$/i, ' ')
      .replace(/\b(today|right now|please|for me|in detail)\b/gi, ' ')
      .replace(/\s+works?\s*$/i, ' ')
      .replace(/[?.!]+$/g, '')
      .replace(/\s+/g, ' ')
      .trim();
    // Convert a natural causal question into the concept being researched.
    // Sending the entire sentence to an encyclopedia title endpoint can land on
    // an unrelated fuzzy match (for example, Lean manufacturing for queues).
    const causalSubject = /^(?:explain\s+)?why\s+(?:a|an|the)\s+(.+?)\s+(?:helps?|works?|matters?|is useful|can)\b/i.exec(cleaned)?.[1];
    const mechanismSubject = /^(?:explain\s+)?how\s+(?:a|an|the)?\s*(.+?)\s+works?\b/i.exec(cleaned)?.[1];
    return String(causalSubject || mechanismSubject || cleaned).trim().slice(0, 120);
  }

  function normalizeSkillId(value = '') {
    return String(value || 'unknown')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '') || 'unknown';
  }

  // Parse a factual question into its frame: what KIND of thing is being asked
  // (a person, a date, a quantity, an office holder, an attribute value, a
  // definition) and the clean SUBJECT the answer is about. Research must be
  // aimed at the subject ("Albert Einstein"), never at the whole interrogative
  // sentence ("who was Albert Einstein") -- sending the sentence to an
  // encyclopedia title endpoint lands on fuzzy near-misses (Hans Albert
  // Einstein, a WWII aircraft list) that then get retained as if they were
  // answers. Returns { frame, subject, attribute, office, quantityOf, role,
  // interrogative }; frame is 'unknown' when nothing matches.
  // Event nominals: "when did the Berlin Wall fall" is answered crisply by
  // the event's own article ("Fall of the Berlin Wall": "The Berlin Wall fell
  // on 9 November 1989..."), while the subject article narrates the event
  // across sentences without ever dating it in one. Null when the verb has no
  // conventional nominal -- the subject article is then the only target.
  function eventNominalTopic(eventVerb = '', subject = '') {
    const nominals = {
      fall: 'Fall of', end: 'End of', sink: 'Sinking of', die: 'Death of',
      collapse: 'Collapse of'
    };
    const nominal = nominals[String(eventVerb || '').toLowerCase()];
    const clean = String(subject || '').trim();
    return nominal && clean ? `${nominal} ${clean}` : null;
  }
  function parseFactualFrame(query = '') {
    const text = String(query || '').trim();
    const stripPunct = value => String(value || '').replace(/[?.!]+$/g, '').replace(/\s+/g, ' ').trim();
    const cleanSubject = value => stripPunct(value).replace(/^(?:the|a|an)\s+/i, '');
    const unknown = () => ({ frame: 'unknown', subject: null, attribute: null, office: null, quantityOf: null, role: null, interrogative: null, eventVerb: null, eventNominal: null, officeNominal: null });
    // Split "World War II end" / "the Titanic sink" into subject + event verb.
    const splitEventSubject = value => {
      const stripped = stripPunct(value);
      const verb = stripped.match(/\s+(end|ended|begin|began|begun|start|started|happen|happened|occur|occurred|sink|sank|sunk|die|died|fall|fell|collapse|collapsed)$/i);
      const rawSubject = verb ? stripped.slice(0, verb.index).trim() : stripped;
      return {
        subject: rawSubject.replace(/^(?:the|a|an)\s+/i, ''),
        rawSubject,
        eventVerb: verb ? verb[1].toLowerCase() : null
      };
    };
    let match;
    // Office holder first: "who is the president of France" is not a generic
    // person question. "is" = current holder, "was" (or a year) = historical.
    match = text.match(/^\s*who\s+(is|was)\s+the\s+(president|prime minister|chancellor|king|queen|pope|mayor|governor)\s+of\s+(.+?)(?:\s+in\s+(\d{4}))?\s*[?.!]*$/i);
    if (match) {
      const office = match[2].toLowerCase();
      const officeSubject = cleanSubject(match[3]);
      // The office's own article ("President of France") names the holder
      // crisply in its lead; the subject article usually does not.
      const officeNominal = office && officeSubject
        ? `${office.charAt(0).toUpperCase() + office.slice(1)} of ${officeSubject}` : null;
      return {
        frame: 'office_holder', office, subject: officeSubject,
        role: match[1].toLowerCase() === 'is' && !match[4] ? 'current' : 'historical',
        year: match[4] || null, interrogative: 'who', attribute: null, quantityOf: null, eventVerb: null,
        officeNominal
      };
    }
    // Attribute: "what is the capital of X".
    match = text.match(/^\s*(?:what|which)\s+(?:is|are|was|were)\s+the\s+(capital|currency|population|area|language|national language)\s+of\s+(.+?)\s*[?.!]*$/i);
    if (match) {
      return {
        frame: 'attribute', attribute: match[1].toLowerCase(), subject: cleanSubject(match[2]),
        role: 'value', interrogative: 'what', office: null, quantityOf: null, eventVerb: null
      };
    }
    // Quantity.
    match = text.match(/^\s*how\s+many\s+(.+?)\s+does\s+(?:a|an|the)\s+(.+?)\s+have\s*[?.!]*$/i);
    if (match) {
      return {
        frame: 'quantity', quantityOf: stripPunct(match[1]), subject: cleanSubject(match[2]),
        role: 'count', interrogative: 'how many', attribute: null, office: null, eventVerb: null
      };
    }
    match = text.match(/^\s*how\s+many\s+(.+?)\s+do\s+(.+?)\s+have\s*[?.!]*$/i);
    if (match) {
      return {
        frame: 'quantity', quantityOf: stripPunct(match[1]), subject: cleanSubject(match[2]),
        role: 'count', interrogative: 'how many', attribute: null, office: null, eventVerb: null
      };
    }
    match = text.match(/^\s*how\s+many\s+(.+?)\s+are\s+in\s+(.+?)\s*[?.!]*$/i);
    if (match) {
      return {
        frame: 'quantity', quantityOf: stripPunct(match[1]), subject: cleanSubject(match[2]),
        role: 'count', interrogative: 'how many', attribute: null, office: null, eventVerb: null
      };
    }
    match = text.match(/^\s*how\s+many\s+(.+?)\s+are\s+there\s*[?.!]*$/i);
    if (match) {
      return {
        frame: 'quantity', quantityOf: stripPunct(match[1]), subject: stripPunct(match[1]),
        role: 'count', interrogative: 'how many', attribute: null, office: null, eventVerb: null
      };
    }
    // Event date / year.
    match = text.match(/^\s*in\s+what\s+year\s+did\s+(.+?)\s*[?.!]*$/i);
    if (match) {
      const split = splitEventSubject(match[1]);
      return {
        frame: 'event_date', subject: split.subject, eventVerb: split.eventVerb,
        role: 'year', interrogative: 'what year', attribute: null, office: null, quantityOf: null,
        eventNominal: eventNominalTopic(split.eventVerb, split.rawSubject)
      };
    }
    match = text.match(/^\s*when\s+did\s+(.+?)\s*[?.!]*$/i);
    if (match) {
      const split = splitEventSubject(match[1]);
      return {
        frame: 'event_date', subject: split.subject, eventVerb: split.eventVerb,
        role: 'date', interrogative: 'when', attribute: null, office: null, quantityOf: null,
        eventNominal: eventNominalTopic(split.eventVerb, split.rawSubject)
      };
    }
    match = text.match(/^\s*when\s+was\s+(.+?)\s+(built|founded|born|established|created|released|published)\s*[?.!]*$/i);
    if (match) {
      return {
        frame: 'event_date', subject: cleanSubject(match[1]), eventVerb: match[2].toLowerCase(),
        role: 'date', interrogative: 'when', attribute: null, office: null, quantityOf: null,
        eventNominal: eventNominalTopic(match[2], stripPunct(match[1]))
      };
    }
    // Person: "who was X". Note "who was" -- the old topic extractor only knew
    // "who is"/"who are" and sent the whole question to the encyclopedia.
    match = text.match(/^\s*who\s+(?:was|is|were|are)\s+(.+?)\s*[?.!]*$/i);
    if (match) {
      return {
        frame: 'person', subject: cleanSubject(match[1]),
        role: 'identity', interrogative: 'who', attribute: null, office: null, quantityOf: null, eventVerb: null
      };
    }
    // Definition: "what is X".
    match = text.match(/^\s*(?:what|which)\s+(?:was|were|is|are)\s+(.+?)\s*[?.!]*$/i);
    if (match) {
      return {
        frame: 'definition', subject: cleanSubject(match[1]),
        role: 'definition', interrogative: 'what', attribute: null, office: null, quantityOf: null, eventVerb: null
      };
    }
    return unknown();
  }

  async function resolveKnowledge(task, options = {}) {
    const fetchImpl = options.fetch || fetch;
    const topic = extractLearningTopic(task);
    if (!topic || topic.length < 2) throw new Error('No learnable topic found.');

    // Wikimedia's older REST summary route now returns 404 on some deployments.
    // Use the stable MediaWiki Action API for the same source-backed extract.
    const extractScope = options.fullExtract === true ? '' : '&exintro=1';
    const summaryUrl = `https://en.wikipedia.org/w/api.php?action=query&prop=extracts${extractScope}&explaintext=1&redirects=1&format=json&formatversion=2&origin=*&titles=${encodeURIComponent(topic)}`;
    const res = await fetchWithTimeout(summaryUrl, {
      fetchImpl,
      timeoutMs: options.timeoutMs || 7000,
      headers: { Accept: 'application/json', 'User-Agent': 'Lari-Knowledge-Engine/1.0 (local research learning)' }
    });
    if (!res.ok) throw new Error(`Knowledge lookup failed with ${res.status}`);
    const payload = await res.json();
    const data = payload?.query?.pages?.[0] || null;
    if (!data || data.missing === true || !data.extract) throw new Error(`No summary found for ${topic}.`);

    const canonicalTopic = data.title || topic;
    const summary = data.extract.replace(/\s+/g, ' ').trim();
    const procedure = distillProcedure(summary, canonicalTopic);
    return {
      ok: true,
      tool: 'knowledge.wikipedia_summary',
      topic: canonicalTopic,
      requestedTopic: topic,
      confidence: 0.78,
      summary,
      procedure,
      sourceUrl: `https://en.wikipedia.org/wiki/${encodeURIComponent(String(canonicalTopic).replace(/ /g, '_'))}`,
      skillId: `learned.${normalizeSkillId(canonicalTopic)}`,
      observedAt: new Date().toISOString()
    };
  }

  function stripResearchMarkup(value = '') {
    return String(value || '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&(?:nbsp|amp|lt|gt|quot|#39);/gi, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function researchTokenOverlap(topic = '', value = '') {
    const stop = new Set(['about', 'research', 'study', 'learn', 'core', 'ideas', 'what', 'this', 'that']);
    const tokens = [...new Set(String(topic).toLowerCase().split(/[^a-z0-9]+/).filter(token => token.length > 2 && !stop.has(token)))];
    const haystack = String(value || '').toLowerCase();
    return tokens.filter(token => haystack.includes(token)).length;
  }

  function technicalResearchRequest(task = '') {
    const text = String(task || '').toLowerCase();
    if (/\bpython\b/.test(text)
      && /\b(?:different\s+case|case[-\s]?(?:sensitive|distinct|identity)|preserv(?:e|ing)\s+(?:original\s+)?case|lower(?:case|casing)?|casefold|normaliz(?:e|ation))\b/.test(text)
      && /\b(?:key|identifier|name|term|label|object|lookup|register|index|duplicate|glossary)\b/.test(text)) {
      return { language: 'python', concept: 'string case normalization', topic: 'Python string case normalization' };
    }
    if (!/\bpython\b/.test(text) || !/\b(?:operator|expression|syntax|arithmetic|power|exponent|division|modulo)\b/.test(text)) return null;
    const concept = /\b(?:power|exponent(?:iation)?)\b/.test(text) ? 'power'
      : /\b(?:floor division|integer division)\b/.test(text) ? 'floor division'
      : /\b(?:modulo|remainder)\b/.test(text) ? 'modulo'
      : 'arithmetic operator';
    return { language: 'python', concept, topic: `Python ${concept} operator` };
  }

  function technicalSnippet(html = '', concept = '') {
    const plain = stripResearchMarkup(String(html)
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/&#42;/g, '*')
      .replace(/&ast;/g, '*'));
    const terms = concept === 'string case normalization' ? ['str. lower ( )', 'str. casefold ( )', 'converted to lowercase', 'caseless matching']
      : concept === 'power' ? ['power operator', '**', 'exponentiation']
      : concept === 'floor division' ? ['floor division', '//']
      : concept === 'modulo' ? ['modulo', 'remainder', '%']
      : ['operator'];
    const lower = plain.toLowerCase();
    const positions = terms.map(term => lower.indexOf(term.toLowerCase())).filter(index => index >= 0);
    if (!positions.length) return '';
    const operatorMarker = concept === 'string case normalization' ? 'lower'
      : concept === 'power' ? '**' : concept === 'floor division' ? '//' : concept === 'modulo' ? '%' : '';
    const semanticTerms = concept === 'string case normalization' ? ['lower', 'casefold', 'case', 'normalization']
      : concept === 'power' ? ['power', 'exponent', 'pow'] : concept.split(/\s+/);
    const operatorIndexes = [];
    if (operatorMarker) {
      let cursor = 0;
      while ((cursor = lower.indexOf(operatorMarker, cursor)) >= 0) { operatorIndexes.push(cursor); cursor += operatorMarker.length; }
    }
    const operatorIndex = operatorIndexes.find(position => {
      const nearby = lower.slice(Math.max(0, position - 500), position + 500);
      return semanticTerms.some(term => nearby.includes(term));
    }) ?? operatorIndexes[0] ?? -1;
    const documentedStringMethodIndex = concept === 'string case normalization'
      ? [...lower.matchAll(/str\.\s*(?:lower|casefold)\s*\(\s*\)/g)]
        .map(match => {
          const position = Number(match.index || 0);
          const nearby = lower.slice(Math.max(0, position - 160), position + 2200);
          const score = (/(?:return|returns)\s+a\s+copy\s+of\s+the\s+string/.test(nearby) ? 16 : 0)
            + (/cased\s+characters?.{0,200}converted\s+to\s+lowercase|converted\s+to\s+lowercase|casefolded|caseless\s+matching/.test(nearby) ? 12 : 0)
            + (/str\.\s*(?:lower|casefold)\s*\(\s*\)/.test(nearby) ? 1 : 0);
          return { position, score };
        })
        .sort((left, right) => right.score - left.score || left.position - right.position)[0]?.position
      : null;
    // For string normalization the exact documented method matters.  A broad word such as
    // "lower" also appears in unrelated operator-precedence prose on this page, so anchoring to
    // it would turn an authoritative page into irrelevant evidence.
    const index = concept === 'string case normalization'
      ? documentedStringMethodIndex ?? Math.min(...positions)
      : operatorIndex >= 0 ? operatorIndex : Math.min(...positions);
    // Begin at the relevant sentence: leading context otherwise becomes the
    // retained summary, teaching unrelated neighboring documentation instead.
    const sentenceStart = plain.lastIndexOf('. ', index);
    const start = sentenceStart >= 0 ? sentenceStart + 2 : Math.max(0, index - 150);
    const end = Math.min(plain.length, index + 1500);
    return plain.slice(start, end).trim();
  }

  async function resolveTechnicalEvidence(task, options = {}) {
    const request = technicalResearchRequest(task);
    if (!request) return null;
    const fetchImpl = options.fetch || fetch;
    const references = request.concept === 'string case normalization'
      ? [{ title: 'Python standard library: string case methods', url: 'https://docs.python.org/3/library/stdtypes.html#string-methods', sourceType: 'official_library_reference' }]
      : [
        { title: 'Python language reference: expressions', url: 'https://docs.python.org/3/reference/expressions.html', sourceType: 'official_language_reference' },
        { title: 'Python standard library: operator', url: 'https://docs.python.org/3/library/operator.html', sourceType: 'official_library_reference' }
      ];
    const sources = [];
    for (const reference of references) {
      try {
        const response = await fetchWithTimeout(reference.url, { fetchImpl, timeoutMs: options.timeoutMs || 9000, headers: { Accept: 'text/html', 'User-Agent': 'Lari-Knowledge-Engine/1.0 (local technical research)' } });
        if (!response.ok) continue;
        const text = technicalSnippet(await response.text(), request.concept);
        if (text) sources.push({ ...reference, text, trust: 0.96, updatedAt: null });
      } catch (_) {}
    }
    if (!sources.length) throw new Error(`No authoritative technical evidence found for ${request.topic}.`);
    return { ok: true, tool: 'knowledge.official_technical_evidence', topic: request.topic, requestedTopic: extractLearningTopic(task), confidence: sources.length > 1 ? 0.94 : 0.86, summary: sources[0].text, answer: `Retrieved authoritative documentation for ${request.topic}.`, sources, observedAt: new Date().toISOString() };
  }

  async function resolveResearchEvidence(task, options = {}) {
    const fetchImpl = options.fetch || fetch;
    const topic = extractLearningTopic(task);
    if (!topic || topic.length < 2) throw new Error('No research topic found.');
    // Disambiguate operational queue questions before an encyclopedia lookup.
    // A queue alongside requests/workers/processors denotes the computational
    // FIFO structure, not the generic Wikipedia disambiguation page.
    const lookupTopic = /\bqueue\b/i.test(topic)
      && /\b(?:request|worker|process|processor|job|task|service)\b/i.test(String(task || ''))
      ? 'Queue (abstract data type)'
      : topic;
    const technical = await resolveTechnicalEvidence(task, { ...options, fetch: fetchImpl });
    if (technical) return technical;
    const sources = [];
    let canonicalTopic = lookupTopic;
    // Event-date and office-holder questions: the event/office's own article
    // ("Fall of the Berlin Wall", "President of France") states the date or
    // holder crisply in its lead; the subject article usually does not. Fetch
    // the nominal first so its sentences rank, then keep the subject article
    // as supporting context. Failure falls back silently.
    try {
      const frame = parseFactualFrame(task);
      const nominalTopic = (frame && (frame.eventNominal || frame.officeNominal)) || null;
      if (nominalTopic && nominalTopic !== lookupTopic) {
        const nominalKnowledge = await resolveKnowledge(nominalTopic, { ...options, fetch: fetchImpl });
        if (nominalKnowledge && nominalKnowledge.summary) {
          sources.push({
            title: nominalKnowledge.topic,
            url: nominalKnowledge.sourceUrl,
            sourceType: 'encyclopedia_reference',
            text: nominalKnowledge.summary,
            trust: nominalKnowledge.confidence || 0.78,
            updatedAt: nominalKnowledge.observedAt || null
          });
          canonicalTopic = nominalKnowledge.topic || nominalTopic;
        }
      }
    } catch (_) { /* subject article remains the evidence */ }

    try {
      const knowledge = await resolveKnowledge(lookupTopic, { ...options, fetch: fetchImpl });
      canonicalTopic = knowledge.topic || lookupTopic;
      sources.push({
        title: knowledge.topic,
        url: knowledge.sourceUrl,
        sourceType: 'encyclopedia_reference',
        text: knowledge.summary,
        trust: knowledge.confidence || 0.78,
        updatedAt: knowledge.observedAt || null
      });
    } catch (_) {
      const searchUrl = `https://en.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(lookupTopic)}&srlimit=1&format=json&origin=*`;
      const searchResponse = await fetchWithTimeout(searchUrl, {
        fetchImpl,
        timeoutMs: options.timeoutMs || 7000,
        headers: { Accept: 'application/json', 'User-Agent': 'Lari-Knowledge-Engine/1.0 (local research learning)' }
      });
      if (!searchResponse.ok) throw _;
      const search = await searchResponse.json();
      const title = search?.query?.search?.[0]?.title;
      if (!title) throw _;
      const knowledge = await resolveKnowledge(title, { ...options, fetch: fetchImpl });
      const requestedTokenCount = researchTokenOverlap(lookupTopic, lookupTopic);
      const relevantTokenCount = researchTokenOverlap(lookupTopic, `${knowledge.topic || ''} ${knowledge.summary || ''}`);
      if (relevantTokenCount < Math.min(2, requestedTokenCount)) {
        throw new Error(`Knowledge search result was not specific enough for ${lookupTopic}.`);
      }
      canonicalTopic = knowledge.topic || title;
      sources.push({
        title: knowledge.topic,
        url: knowledge.sourceUrl,
        sourceType: 'encyclopedia_reference',
        text: knowledge.summary,
        trust: knowledge.confidence || 0.78,
        updatedAt: knowledge.observedAt || null
      });
    }

    try {
      const crossrefUrl = `https://api.crossref.org/works?query.title=${encodeURIComponent(canonicalTopic)}&rows=3&select=DOI,title,publisher,published,URL,abstract,type`;
      const crossrefResponse = await fetchWithTimeout(crossrefUrl, {
        fetchImpl,
        timeoutMs: options.timeoutMs || 7000,
        headers: { Accept: 'application/json', 'User-Agent': 'Lari-Knowledge-Engine/1.0 (local research learning)' }
      });
      if (crossrefResponse.ok) {
        const payload = await crossrefResponse.json();
        const works = (payload?.message?.items || [])
          .map(work => {
            const title = Array.isArray(work.title) ? work.title[0] : work.title;
            const abstract = stripResearchMarkup(work.abstract || '');
            const year = work.published?.['date-parts']?.[0]?.[0] || null;
            const text = [
              title ? `Scholarly work: ${title}.` : '',
              work.publisher ? `Publisher: ${work.publisher}.` : '',
              year ? `Published: ${year}.` : '',
              abstract ? `Abstract: ${abstract.slice(0, 1400)}` : ''
            ].filter(Boolean).join(' ');
            return { work, title, text, overlap: researchTokenOverlap(canonicalTopic, `${title || ''} ${abstract}`) };
          })
          .filter(item => item.title && item.overlap > 0)
          .sort((left, right) => right.overlap - left.overlap)
          .slice(0, 2);
        works.forEach(({ work, title, text }) => sources.push({
          title,
          url: work.DOI ? `https://doi.org/${work.DOI}` : work.URL,
          sourceType: 'scholarly_metadata',
          text,
          trust: work.DOI ? 0.84 : 0.72,
          updatedAt: null
        }));
      }
    } catch (_) {
      // The encyclopedia source remains usable when no scholarly metadata is available.
    }

    const primary = sources[0];
    if (!primary?.text || !primary?.url) throw new Error(`No usable research evidence found for ${topic}.`);
    const sourceLines = sources.map(source => `- ${source.title}: ${source.url}`).join('\n');
    return {
      ok: true,
      tool: 'knowledge.public_research_evidence',
      topic: canonicalTopic,
      requestedTopic: topic,
      confidence: sources.length > 1 ? 0.84 : 0.76,
      summary: primary.text,
      answer: `Here is what I learned about ${canonicalTopic}: ${primary.text}\n\nSources:\n${sourceLines}`,
      sources: sources.slice(0, options.maxSources || 3),
      observedAt: new Date().toISOString()
    };
  }

  function distillProcedure(summary, topic) {
    const sentences = summary
      .split(/(?<=[.!?])\s+/)
      .map(sentence => sentence.trim())
      .filter(Boolean)
      .slice(0, 4);
    if (sentences.length >= 2) return sentences;
    return [
      `Identify the core concept: ${topic}.`,
      summary.slice(0, 220),
      'Reuse this memory when a later prompt overlaps with the same concept.'
    ].filter(Boolean);
  }

  async function geocodeLocation(query, fetchImpl = fetch) {
    if (/^columbus,\s*ohio$/i.test(query)) return DEFAULT_REGION;
    const url = `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(query)}&count=1&language=en&format=json`;
    const res = await fetchWithTimeout(url, { fetchImpl, timeoutMs: 5000 });
    if (!res.ok) throw new Error(`Geocoding failed with ${res.status}`);
    const data = await res.json();
    const place = data.results?.[0];
    if (!place) throw new Error(`No location found for ${query}`);
    return place;
  }

  async function resolveWeather(task, options = {}) {
    const fetchImpl = options.fetch || fetch;
    const parsed = parseWeatherLocation(task);
    const place = await geocodeLocation(parsed.query, fetchImpl);
    const forecastUrl = [
      'https://api.open-meteo.com/v1/forecast',
      `?latitude=${encodeURIComponent(place.latitude)}`,
      `&longitude=${encodeURIComponent(place.longitude)}`,
      '&current=temperature_2m,relative_humidity_2m,apparent_temperature,precipitation,weather_code,wind_speed_10m',
      '&daily=temperature_2m_max,temperature_2m_min,precipitation_probability_max',
      '&temperature_unit=fahrenheit',
      '&wind_speed_unit=mph',
      '&precipitation_unit=inch',
      '&timezone=auto',
      '&forecast_days=1'
    ].join('');
    let res = null;
    try {
      res = await fetchWithRetry(forecastUrl, fetchImpl);
    } catch (err) {
      return resolveNwsWeather(place, parsed, fetchImpl);
    }
    if (!res.ok) return resolveNwsWeather(place, parsed, fetchImpl);
    const data = await res.json();
    const current = data.current || {};
    const daily = data.daily || {};
    const locationName = [place.name, place.admin1, place.country].filter(Boolean).join(', ');
    return {
      ok: true,
      tool: 'weather.open_meteo',
      query: parsed.query,
      assumed: parsed.assumed,
      assumption: parsed.reason,
      location: locationName,
      latitude: place.latitude,
      longitude: place.longitude,
      observedAt: current.time,
      summary: weatherCodeSummary(current.weather_code),
      temperatureF: current.temperature_2m,
      feelsLikeF: current.apparent_temperature,
      humidityPercent: current.relative_humidity_2m,
      windMph: current.wind_speed_10m,
      precipitationIn: current.precipitation,
      highF: daily.temperature_2m_max?.[0],
      lowF: daily.temperature_2m_min?.[0],
      precipitationProbabilityPercent: daily.precipitation_probability_max?.[0]
    };
  }

  async function resolveNwsWeather(place, parsed, fetchImpl = fetch) {
    const headers = { Accept: 'application/geo+json' };
    try {
      const pointsUrl = `https://api.weather.gov/points/${place.latitude},${place.longitude}`;
      const pointsRes = await fetchWithTimeout(pointsUrl, { fetchImpl, headers, timeoutMs: 5000 });
      if (!pointsRes.ok) throw new Error(`Weather lookup failed with ${pointsRes.status}`);
      const points = await pointsRes.json();
      const hourlyUrl = points.properties?.forecastHourly;
      const dailyUrl = points.properties?.forecast;
      if (!hourlyUrl || !dailyUrl) throw new Error('Weather lookup did not return forecast URLs.');
      const [hourlyRes, dailyRes] = await Promise.all([
        fetchWithTimeout(hourlyUrl, { fetchImpl, headers, timeoutMs: 5000 }),
        fetchWithTimeout(dailyUrl, { fetchImpl, headers, timeoutMs: 5000 })
      ]);
      if (!hourlyRes.ok || !dailyRes.ok) throw new Error('Weather forecast request failed.');
      const hourly = await hourlyRes.json();
      const daily = await dailyRes.json();
      const current = hourly.properties?.periods?.[0] || {};
      const today = daily.properties?.periods?.[0] || {};
      const tonight = daily.properties?.periods?.[1] || {};
      const locationName = [place.name, place.admin1, place.country].filter(Boolean).join(', ');
      return {
        ok: true,
        tool: 'weather.weather_gov',
        query: parsed.query,
        assumed: parsed.assumed,
        assumption: parsed.reason,
        location: locationName,
        latitude: place.latitude,
        longitude: place.longitude,
        observedAt: current.startTime,
        summary: current.shortForecast || today.shortForecast || 'forecast available',
        temperatureF: current.temperature,
        feelsLikeF: current.temperature,
        humidityPercent: current.relativeHumidity?.value,
        windMph: Number.parseInt(current.windSpeed, 10),
        precipitationIn: null,
        highF: today.isDaytime ? today.temperature : current.temperature,
        lowF: tonight.temperature,
        precipitationProbabilityPercent: current.probabilityOfPrecipitation?.value ?? today.probabilityOfPrecipitation?.value
      };
    } catch (err) {
      return resolveWttrWeather(place, parsed, fetchImpl);
    }
  }

  async function fetchWithRetry(url, fetchImpl, attempts = 2) {
    let lastResponse = null;
    let lastError = null;
    for (let i = 0; i < attempts; i++) {
      try {
        const res = await fetchWithTimeout(url, { fetchImpl, timeoutMs: 5000 });
        if (res.ok) return res;
        lastResponse = res;
      } catch (err) {
        lastError = err;
      }
      await new Promise(resolve => setTimeout(resolve, 350));
    }
    if (!lastResponse && lastError) throw lastError;
    return lastResponse;
  }

  async function fetchWithTimeout(url, options = {}) {
    const fetchImpl = options.fetchImpl || fetch;
    const timeoutMs = options.timeoutMs || 6000;
    const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
    try {
      return await fetchImpl(url, {
        headers: options.headers,
        signal: controller?.signal
      });
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  async function resolveWttrWeather(place, parsed, fetchImpl = fetch) {
    const locationQuery = [place.name, place.admin1].filter(Boolean).join(',');
    const url = `https://wttr.in/${encodeURIComponent(locationQuery)}?format=j1`;
    const res = await fetchWithTimeout(url, { fetchImpl, timeoutMs: 8000 });
    if (!res.ok) throw new Error(`Weather lookup failed with ${res.status}`);
    const data = await res.json();
    const current = data.current_condition?.[0] || {};
    const today = data.weather?.[0] || {};
    const hourly = today.hourly?.[0] || {};
    const locationName = [place.name, place.admin1, place.country].filter(Boolean).join(', ');
    return {
      ok: true,
      tool: 'weather.wttr',
      query: parsed.query,
      assumed: parsed.assumed,
      assumption: parsed.reason,
      location: locationName,
      latitude: place.latitude,
      longitude: place.longitude,
      observedAt: current.localObsDateTime,
      summary: current.weatherDesc?.[0]?.value || hourly.weatherDesc?.[0]?.value || 'forecast available',
      temperatureF: Number(current.temp_F),
      feelsLikeF: Number(current.FeelsLikeF),
      humidityPercent: Number(current.humidity),
      windMph: Number(current.windspeedMiles),
      precipitationIn: Number(current.precipInches),
      highF: Number(today.maxtempF),
      lowF: Number(today.mintempF),
      precipitationProbabilityPercent: Number(hourly.chanceofrain || hourly.chanceofsnow || 0)
    };
  }

  function formatWeatherAnswer(weather) {
    const assumption = weather.assumed ? `I used ${weather.location} because only the state was given. ` : '';
    return `${assumption}Current weather for ${weather.location}: <strong>${Math.round(weather.temperatureF)}°F</strong>, ${weather.summary}, feels like <strong>${Math.round(weather.feelsLikeF)}°F</strong>. Today: high <strong>${Math.round(weather.highF)}°F</strong>, low <strong>${Math.round(weather.lowF)}°F</strong>, wind around <strong>${Math.round(weather.windMph)} mph</strong>, precipitation chance <strong>${weather.precipitationProbabilityPercent ?? 0}%</strong>.`;
  }

  function formatKnowledgeAnswer(knowledge) {
    const source = knowledge.sourceUrl ? ` <a href="${knowledge.sourceUrl}" target="_blank" rel="noreferrer">source</a>` : '';
    return `I learned <strong>${knowledge.topic}</strong> and stored it as <code>${knowledge.skillId}</code>. ${knowledge.summary}${source}`;
  }

  const api = { parseWeatherLocation, resolveWeather, formatWeatherAnswer, weatherCodeSummary, extractLearningTopic, parseFactualFrame, resolveKnowledge, resolveResearchEvidence, resolveTechnicalEvidence, technicalResearchRequest, formatKnowledgeAnswer };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  globalScope.SwarmExternalTools = api;
})(typeof globalThis !== 'undefined' ? globalThis : window);
