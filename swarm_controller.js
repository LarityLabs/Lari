(function attachSwarmController(globalScope) {
  function textTokens(value) {
    return String(value || '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(token => token.length > 2);
  }

  function selectRelevantKnowledge(model, task) {
    if (globalScope.SwarmModelRuntime?.searchKnowledge) {
      return globalScope.SwarmModelRuntime.searchKnowledge(model, task, { minScore: 0.18 })[0] || null;
    }
    const tokens = new Set(textTokens(task));
    return (model.selfTeaching?.knowledgeBase || [])
      .map(item => {
        const haystack = `${item.topic || ''} ${item.summary || ''}`.toLowerCase();
        const matches = [...tokens].filter(token => haystack.includes(token));
        return { item, score: matches.length * (item.confidence || 0.5), matches };
      })
      .filter(entry => entry.score > 0)
      .sort((a, b) => b.score - a.score)[0] || null;
  }

  function scoreConfidence(model, task) {
    const knownPatterns = ['html', 'website', 'app', 'todo', 'notes', 'kanban', 'calculator', 'dashboard', 'landing', 'form', 'broadcastchannel'];
    const text = String(task || '').toLowerCase();
    const patternHits = knownPatterns.filter(pattern => text.includes(pattern)).length;
    const knowledge = selectRelevantKnowledge(model, task);
    const base = 0.36 + patternHits * 0.1;
    const learned = knowledge ? Math.min(0.35, knowledge.score * 0.12) : 0;
    return Math.min(0.95, base + learned);
  }

  const capabilityProfiles = [
    {
      id: 'code',
      keywords: ['code', 'bug', 'fix', 'repo', 'test', 'function', 'component', 'api', 'script', 'html', 'css', 'javascript'],
      preferredWorker: 'coder',
      preferredTool: 'workspace.filesystem'
    },
    {
      id: 'content',
      keywords: ['post', 'blog', 'article', 'newsletter', 'caption', 'script', 'copy', 'content', 'pipeline', 'publish'],
      preferredWorker: 'content_operator',
      preferredTool: 'workspace.filesystem'
    },
    {
      id: 'systems',
      keywords: ['system', 'server', 'process', 'monitor', 'ops', 'workflow', 'automation', 'pipeline', 'schedule'],
      preferredWorker: 'systems_operator',
      preferredTool: 'workspace.filesystem'
    },
    {
      id: 'browser',
      keywords: ['browser', 'website', 'click', 'navigate', 'form', 'scrape', 'login', 'page', 'openclaw'],
      preferredWorker: 'browser_operator',
      preferredTool: 'computer_use.openclaw'
    },
    {
      id: 'data',
      keywords: ['csv', 'spreadsheet', 'data', 'report', 'numbers', 'metrics', 'dashboard', 'analyze'],
      preferredWorker: 'data_operator',
      preferredTool: 'workspace.filesystem'
    },
    {
      id: 'design',
      keywords: ['design', 'brand', 'image', 'visual', 'layout', 'ui', 'presentation', 'slide'],
      preferredWorker: 'design_operator',
      preferredTool: 'workspace.filesystem'
    }
  ];

  function routeCapability(model, task) {
    const tokens = new Set(textTokens(task));
    const scored = capabilityProfiles
      .map(profile => {
        const keywordHits = profile.keywords.filter(keyword => tokens.has(keyword) || String(task || '').toLowerCase().includes(keyword));
        const registeredAgent = (model.swarmAgents || []).find(agent => agent.capability === profile.id || agent.id === `agent_${profile.preferredWorker}` || agent.id === profile.preferredWorker);
        const skill = (model.skills || []).find(item => String(item.id || '').includes(profile.id) || item.worker === profile.preferredWorker);
        const score = keywordHits.length * 0.22 + (registeredAgent ? 0.35 : 0) + (skill ? 0.2 : 0);
        return { ...profile, score, keywordHits, registeredAgent: registeredAgent || null, skill: skill || null };
      })
      .sort((a, b) => b.score - a.score);
    const best = scored[0] || capabilityProfiles[0];
    return {
      capability: best.id,
      confidence: Math.min(0.95, 0.32 + best.score),
      worker: best.registeredAgent?.id || best.preferredWorker,
      tool: best.preferredTool,
      hasRegisteredAgent: !!best.registeredAgent,
      hasSkill: !!best.skill,
      keywordHits: best.keywordHits || [],
      alternatives: scored.slice(1, 4).map(item => ({ capability: item.id, score: item.score }))
    };
  }

  function decideNext(model, context = {}) {
    const confidence = scoreConfidence(model, context.task || context.goal || '');
    const threshold = model.selfTeaching?.confidenceThreshold ?? 0.62;
    if (context.phase === 'task_start') {
      const route = routeCapability(model, context.task || context.goal || '');
      if (route.confidence >= 0.58 && !route.hasRegisteredAgent && ['content', 'systems', 'browser', 'data', 'design'].includes(route.capability)) {
        return { action: 'EXPAND', confidence: route.confidence, route, reason: `No registered ${route.capability} specialist exists yet.` };
      }
      if (confidence < threshold && route.confidence < threshold) return { action: 'TEACH', confidence, route };
      if (route.tool === 'computer_use.openclaw' && route.hasRegisteredAgent) return { action: 'TOOL', confidence: route.confidence, route };
      return { action: 'PLAN', confidence: Math.max(confidence, route.confidence), route, knowledge: selectRelevantKnowledge(model, context.task) };
    }
    if (context.phase === 'audit_complete' && context.passed === false) {
      return context.retryCount >= 1 ? { action: 'TEACH', confidence } : { action: 'RETRY', confidence };
    }
    if (context.phase === 'audit_complete' && context.passed === true) return { action: 'COMPLETE', confidence };
    if (context.phase === 'tool_observation') return { action: 'PLAN', confidence, knowledge: selectRelevantKnowledge(model, context.task) };
    return { action: 'PLAN', confidence };
  }

  function applyObservation(model, observation = {}) {
    const result = { toolLearning: null, knowledge: null };
    if (globalScope.SwarmModelRuntime && observation.type === 'tool') {
      result.toolLearning = globalScope.SwarmModelRuntime.learnFromToolObservation(model, observation.data);
      if (observation.data?.adapter === 'knowledge.local_retrieval' && observation.data?.ok && observation.data?.observation) {
        result.knowledge = globalScope.SwarmModelRuntime.ingestKnowledge(model, {
          id: observation.data.traceId,
          topic: observation.data.observation.topic,
          sourceAdapter: observation.data.adapter,
          confidence: observation.data.observation.confidence,
          summary: observation.data.observation.summary,
          procedure: observation.data.observation.procedure,
          worker: observation.data.worker || 'architect'
        });
      }
    }
    return result;
  }

  function produceRunReport(model, traces = []) {
    const events = traces.map(trace => trace.event);
    return {
      generation: model.generation,
      eventCount: traces.length,
      events,
      usedTeaching: events.includes('TEACHING_REQUEST') || events.includes('SELF_TEACHING_PROMOTED'),
      usedTool: events.includes('TOOL_ACTION_REQUEST') || events.includes('TOOL_ACTION_OBSERVATION'),
      completed: events.includes('AUDIT_COMPLETE') || events.includes('REGISTRY_LOGGED'),
      latestKnowledge: model.selfTeaching?.knowledgeBase?.[0] || null
    };
  }

  const api = { decideNext, scoreConfidence, routeCapability, selectRelevantKnowledge, applyObservation, produceRunReport };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  globalScope.SwarmController = api;
})(typeof globalThis !== 'undefined' ? globalThis : window);
