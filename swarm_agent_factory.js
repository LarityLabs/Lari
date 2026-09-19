(function attachSwarmAgentFactory(globalScope) {
  function escapeHtml(value) {
    return String(value || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function createWorkerHtml(agent = {}) {
    const id = agent.id || 'agent_specialist';
    const role = agent.role || 'specialized worker';
    const capability = agent.capability || 'specialized_capability';
    const requestType = agent.messageTypes?.[0] || `${String(capability).toUpperCase()}_REQUEST`;
    const resultType = agent.messageTypes?.[1] || `${String(capability).toUpperCase()}_RESULT`;
    if (capability === 'content_pipeline') {
      return createContentPipelineWorkerHtml({ id, role, capability, requestType, resultType });
    }
    if (capability === 'systems_operator') {
      return createSystemsOperatorWorkerHtml({ id, role, capability, requestType, resultType });
    }
    if (capability === 'data_operator') {
      return createDataOperatorWorkerHtml({ id, role, capability, requestType, resultType });
    }
    if (capability === 'design_operator') {
      return createDesignOperatorWorkerHtml({ id, role, capability, requestType, resultType });
    }
    if (capability === 'browser_operator') {
      return createBrowserOperatorWorkerHtml({ id, role, capability, requestType, resultType });
    }
    const compiledSkill = agent.compiledSkill || null;
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapeHtml(role)} Agent</title>
</head>
<body>
  <script id="agent-state" type="application/json">
${JSON.stringify({ id, role, capability, requestType, resultType, compiledSkill, createdAt: new Date().toISOString() }, null, 2)}
  </script>
  <script>
    const state = JSON.parse(document.getElementById('agent-state').textContent);
    const channel = new BroadcastChannel('swarm-mesh');
    channel.postMessage({ sender: state.id, timestamp: Date.now(), type: 'HANDSHAKE_INIT', data: { role: state.role, capability: state.capability } });

    function runCompiledSkill(input = {}) {
      const skill = state.compiledSkill || {};
      const task = input.task || input.query || input.prompt || '';
      const concepts = skill.triggerConcepts || [];
      const matchedConcepts = concepts.filter(concept => String(task).toLowerCase().includes(String(concept).toLowerCase()));
      const lines = [
        '# ' + (skill.topic || state.role),
        '',
        skill.answerTemplate || 'Compiled skill executed.',
        '',
        '## Procedure',
        ...(skill.procedure || []).map((step, index) => (index + 1) + '. ' + step),
        '',
        'Matched concepts: ' + (matchedConcepts.join(', ') || 'none')
      ];
      return {
        ok: true,
        capability: state.capability,
        skillId: skill.id || null,
        topic: skill.topic || state.role,
        confidence: skill.confidence || 0,
        matchedConcepts,
        answer: skill.answerTemplate || 'Compiled skill executed.',
        procedure: skill.procedure || [],
        report: lines.join('\\n') + '\\n'
      };
    }

    channel.onmessage = event => {
      const msg = event.data;
      if (!msg || msg.sender === state.id) return;
      if (msg.type === 'HANDSHAKE_INIT') {
        channel.postMessage({ sender: state.id, timestamp: Date.now(), type: 'HANDSHAKE_ACK', data: { capability: state.capability } });
      }
      if (msg.type === state.requestType) {
        const compiledResult = state.compiledSkill ? runCompiledSkill(msg.data || {}) : null;
        channel.postMessage({
          sender: state.id,
          timestamp: Date.now(),
          type: state.resultType,
          data: compiledResult || {
            capability: state.capability,
            input: msg.data || {},
            result: 'specialist worker acknowledged request',
            ok: true
          }
        });
      }
    };
  <\/script>
</body>
</html>`;
  }

  function createDataOperatorWorkerHtml(agent = {}) {
    const state = {
      id: agent.id,
      role: agent.role,
      capability: agent.capability,
      requestType: agent.requestType,
      resultType: agent.resultType,
      createdAt: new Date().toISOString()
    };
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapeHtml(agent.role)} Agent</title>
</head>
<body>
  <script id="agent-state" type="application/json">
${JSON.stringify(state, null, 2)}
  </script>
  <script>
    const state = JSON.parse(document.getElementById('agent-state').textContent);
    const channel = new BroadcastChannel('swarm-mesh');
    channel.postMessage({ sender: state.id, timestamp: Date.now(), type: 'HANDSHAKE_INIT', data: { role: state.role, capability: state.capability } });

    function rowsFromInput(input = {}) {
      if (Array.isArray(input.rows)) return input.rows;
      if (typeof input.csv !== 'string') return [];
      const lines = input.csv.trim().split(/\\r?\\n/).filter(Boolean);
      const headers = lines.shift().split(',').map(value => value.trim());
      return lines.map(line => {
        const values = line.split(',').map(value => value.trim());
        return Object.fromEntries(headers.map((header, index) => [header, values[index] || '']));
      });
    }

    function summarize(rows) {
      const columns = {};
      rows.forEach(row => {
        Object.entries(row).forEach(([key, value]) => {
          const numeric = Number(value);
          if (!Number.isFinite(numeric)) return;
          if (!columns[key]) columns[key] = [];
          columns[key].push(numeric);
        });
      });
      return Object.fromEntries(Object.entries(columns).map(([key, values]) => {
        const sum = values.reduce((total, value) => total + value, 0);
        return [key, {
          count: values.length,
          sum,
          min: Math.min(...values),
          max: Math.max(...values),
          average: Number((sum / values.length).toFixed(2))
        }];
      }));
    }

    function reportFor(input = {}) {
      const rows = rowsFromInput(input);
      const metrics = summarize(rows);
      const title = input.title || input.task || 'local metrics report';
      const lines = ['# Data Operator Report', '', 'Title: ' + title, 'Rows: ' + rows.length, ''];
      Object.entries(metrics).forEach(([key, stat]) => {
        lines.push('- ' + key + ': count=' + stat.count + ', avg=' + stat.average + ', min=' + stat.min + ', max=' + stat.max + ', sum=' + stat.sum);
      });
      if (Object.keys(metrics).length === 0) lines.push('- No numeric columns found.');
      return { title, rows, metrics, markdown: lines.join('\\n') + '\\n' };
    }

    channel.onmessage = event => {
      const msg = event.data;
      if (!msg || msg.sender === state.id) return;
      if (msg.type === 'HANDSHAKE_INIT') {
        channel.postMessage({ sender: state.id, timestamp: Date.now(), type: 'HANDSHAKE_ACK', data: { capability: state.capability } });
      }
      if (msg.type === state.requestType) {
        const report = reportFor(msg.data || {});
        channel.postMessage({ sender: state.id, timestamp: Date.now(), type: 'WRITE_FILE_REQUEST', data: { filename: 'data-operator-report.md', content: report.markdown } });
        channel.postMessage({ sender: state.id, timestamp: Date.now(), type: state.resultType, data: { ok: true, capability: state.capability, rowCount: report.rows.length, metrics: report.metrics, report: report.markdown } });
      }
    };
  <\/script>
</body>
</html>`;
  }

  function createDesignOperatorWorkerHtml(agent = {}) {
    const state = {
      id: agent.id,
      role: agent.role,
      capability: agent.capability,
      requestType: agent.requestType,
      resultType: agent.resultType,
      createdAt: new Date().toISOString()
    };
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapeHtml(agent.role)} Agent</title>
</head>
<body>
  <script id="agent-state" type="application/json">
${JSON.stringify(state, null, 2)}
  </script>
  <script>
    const state = JSON.parse(document.getElementById('agent-state').textContent);
    const channel = new BroadcastChannel('swarm-mesh');
    channel.postMessage({ sender: state.id, timestamp: Date.now(), type: 'HANDSHAKE_INIT', data: { role: state.role, capability: state.capability } });

    function buildSpec(input = {}) {
      const subject = input.subject || input.task || 'local operator dashboard';
      const mood = input.mood || 'rubberhose minimalist dark';
      const sections = input.sections || ['status strip', 'operator canvas', 'audit rail'];
      const palette = input.palette || ['ink black', 'warm white', 'signal green', 'coral accent'];
      const spec = {
        subject,
        mood,
        palette,
        layout: sections.map((section, index) => ({ order: index + 1, section, density: index === 1 ? 'primary' : 'compact' })),
        controls: ['segmented mode switch', 'icon buttons', 'compact audit timeline'],
        constraints: ['dark canvas', 'minimal chrome', '8px radius maximum', 'no cyberpunk glow']
      };
      const markdown = [
        '# Design Operator Spec',
        '',
        'Subject: ' + subject,
        'Mood: ' + mood,
        'Palette: ' + palette.join(', '),
        '',
        '## Layout',
        ...spec.layout.map(item => item.order + '. ' + item.section + ' - ' + item.density),
        '',
        '## Constraints',
        ...spec.constraints.map(item => '- ' + item)
      ].join('\\n') + '\\n';
      return { spec, markdown };
    }

    channel.onmessage = event => {
      const msg = event.data;
      if (!msg || msg.sender === state.id) return;
      if (msg.type === 'HANDSHAKE_INIT') {
        channel.postMessage({ sender: state.id, timestamp: Date.now(), type: 'HANDSHAKE_ACK', data: { capability: state.capability } });
      }
      if (msg.type === state.requestType) {
        const output = buildSpec(msg.data || {});
        channel.postMessage({ sender: state.id, timestamp: Date.now(), type: 'WRITE_FILE_REQUEST', data: { filename: 'design-operator-spec.md', content: output.markdown } });
        channel.postMessage({ sender: state.id, timestamp: Date.now(), type: state.resultType, data: { ok: true, capability: state.capability, spec: output.spec, report: output.markdown } });
      }
    };
  <\/script>
</body>
</html>`;
  }

  function createBrowserOperatorWorkerHtml(agent = {}) {
    const state = {
      id: agent.id,
      role: agent.role,
      capability: agent.capability,
      requestType: agent.requestType,
      resultType: agent.resultType,
      createdAt: new Date().toISOString()
    };
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapeHtml(agent.role)} Agent</title>
</head>
<body>
  <script id="agent-state" type="application/json">
${JSON.stringify(state, null, 2)}
  </script>
  <script>
    const state = JSON.parse(document.getElementById('agent-state').textContent);
    const channel = new BroadcastChannel('swarm-mesh');
    channel.postMessage({ sender: state.id, timestamp: Date.now(), type: 'HANDSHAKE_INIT', data: { role: state.role, capability: state.capability } });

    function allowedLocalUrl(url) {
      try {
        const parsed = new URL(url, location.href);
        return ['localhost', '127.0.0.1', location.hostname].includes(parsed.hostname);
      } catch {
        return false;
      }
    }

    function makePlan(input = {}) {
      const url = input.url || location.origin + '/index.html';
      if (!allowedLocalUrl(url)) {
        return { ok: false, refused: true, reason: 'Refused non-local browser target: ' + url, url };
      }
      const actions = input.actions || ['inspect_title', 'inspect_forms'];
      const audit = ['allowlist checked', 'planned actions: ' + actions.join(', '), 'requires host Playwright/computer-use executor for DOM execution'];
      return { ok: true, refused: false, url, actions, audit, plan: 'Open local URL, inspect page structure, perform approved actions, write audit.' };
    }

    channel.onmessage = event => {
      const msg = event.data;
      if (!msg || msg.sender === state.id) return;
      if (msg.type === 'HANDSHAKE_INIT') {
        channel.postMessage({ sender: state.id, timestamp: Date.now(), type: 'HANDSHAKE_ACK', data: { capability: state.capability } });
      }
      if (msg.type === state.requestType) {
        const result = makePlan(msg.data || {});
        const markdown = ['# Browser Operator Plan', '', 'URL: ' + result.url, 'Refused: ' + (result.refused ? 'yes' : 'no'), 'Actions: ' + (result.actions || []).join(', '), '', ...(result.audit || []).map(item => '- ' + item)].join('\\n') + '\\n';
        channel.postMessage({ sender: state.id, timestamp: Date.now(), type: 'WRITE_FILE_REQUEST', data: { filename: 'browser-operator-plan.md', content: markdown } });
        channel.postMessage({ sender: state.id, timestamp: Date.now(), type: state.resultType, data: { capability: state.capability, ...result, report: markdown } });
      }
    };
  <\/script>
</body>
</html>`;
  }

  function createSystemsOperatorWorkerHtml(agent = {}) {
    const state = {
      id: agent.id,
      role: agent.role,
      capability: agent.capability,
      requestType: agent.requestType,
      resultType: agent.resultType,
      createdAt: new Date().toISOString()
    };
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapeHtml(agent.role)} Agent</title>
</head>
<body>
  <script id="agent-state" type="application/json">
${JSON.stringify(state, null, 2)}
  </script>
  <script>
    const state = JSON.parse(document.getElementById('agent-state').textContent);
    const channel = new BroadcastChannel('swarm-mesh');
    const safeActions = new Set(['read_status', 'write_report', 'restart_mock_service']);
    channel.postMessage({ sender: state.id, timestamp: Date.now(), type: 'HANDSHAKE_INIT', data: { role: state.role, capability: state.capability } });

    function inspectManifest(manifest = {}) {
      const services = manifest.services || [];
      const failed = services.filter(service => service.status === 'failed' || service.status === 'stalled');
      return { serviceCount: services.length, failed };
    }

    function requestedUnsafeAction(input = {}) {
      return (input.requestedActions || []).find(action => !safeActions.has(action)) || null;
    }

    channel.onmessage = event => {
      const msg = event.data;
      if (!msg || msg.sender === state.id) return;
      if (msg.type === 'HANDSHAKE_INIT') {
        channel.postMessage({ sender: state.id, timestamp: Date.now(), type: 'HANDSHAKE_ACK', data: { capability: state.capability } });
      }
      if (msg.type === state.requestType) {
        const input = msg.data || {};
        const unsafe = requestedUnsafeAction(input);
        if (unsafe) {
          channel.postMessage({
            sender: state.id,
            timestamp: Date.now(),
            type: state.resultType,
            data: {
              ok: false,
              refused: true,
              reason: 'Refused unsafe or unapproved action: ' + unsafe,
              mode: input.mode || 'dry_run',
              auditTrail: ['checked requested actions', 'refused ' + unsafe]
            }
          });
          return;
        }

        const inspection = inspectManifest(input.manifest || {});
        const target = inspection.failed[0] || null;
        const proposedAction = target ? 'restart_mock_service' : 'write_report';
        const approved = (input.approvedActions || []).includes(proposedAction);
        const execute = input.mode === 'execute' && approved && !!target;
        const updatedManifest = JSON.parse(JSON.stringify(input.manifest || { services: [] }));
        if (execute) {
          const service = (updatedManifest.services || []).find(item => item.id === target.id);
          if (service) service.status = 'running';
        }

        const report = [
          '# Systems Operator Report',
          '',
          'Mode: ' + (input.mode || 'dry_run'),
          'Failed services: ' + inspection.failed.length,
          'Proposed action: ' + proposedAction,
          'Executed: ' + (execute ? 'yes' : 'no'),
          target ? 'Target: ' + target.id : 'Target: none'
        ].join('\\n');

        channel.postMessage({
          sender: state.id,
          timestamp: Date.now(),
          type: 'WRITE_FILE_REQUEST',
          data: { filename: 'systems-operator-report.md', content: report }
        });
        channel.postMessage({
          sender: state.id,
          timestamp: Date.now(),
          type: state.resultType,
          data: {
            ok: true,
            refused: false,
            mode: input.mode || 'dry_run',
            inspection,
            proposedAction,
            approved,
            executed: execute,
            targetService: target,
            manifest: updatedManifest,
            auditTrail: ['read manifest', 'identified failed services', execute ? 'executed approved restart' : 'reported proposed action']
          }
        });
      }
    };
  <\/script>
</body>
</html>`;
  }

  function createContentPipelineWorkerHtml(agent = {}) {
    const state = {
      id: agent.id,
      role: agent.role,
      capability: agent.capability,
      requestType: agent.requestType,
      resultType: agent.resultType,
      createdAt: new Date().toISOString()
    };
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapeHtml(agent.role)} Agent</title>
</head>
<body>
  <script id="agent-state" type="application/json">
${JSON.stringify(state, null, 2)}
  </script>
  <script>
    const state = JSON.parse(document.getElementById('agent-state').textContent);
    const channel = new BroadcastChannel('swarm-mesh');
    channel.postMessage({ sender: state.id, timestamp: Date.now(), type: 'HANDSHAKE_INIT', data: { role: state.role, capability: state.capability } });

    function slugify(value) {
      return String(value || 'content')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '') || 'content';
    }

    function buildContentPack(input = {}) {
      const topic = input.topic || input.task || 'OpenSwarm personal automation';
      const audience = input.audience || 'builders and operators';
      const tone = input.tone || 'clear, direct, useful';
      const userPreferences = input.userPreferences || [];
      const preferredTone = userPreferences.find(item => item.key === 'tone')?.value || tone;
      const signature = userPreferences.find(item => item.key === 'signature')?.value || '';
      const signatureBlock = signature ? '\\n' + signature + '\\n' : '';
      const channels = input.channels || ['x', 'linkedin', 'blog'];
      const slug = slugify(topic);
      const plan = [
        { channel: channels[0] || 'x', angle: 'announce the operator swarm idea', format: 'short post' },
        { channel: channels[1] || 'linkedin', angle: 'explain the practical workflow value', format: 'professional post' },
        { channel: channels[2] || 'blog', angle: 'show the local-first architecture', format: 'outline' }
      ];
      const files = [
        {
          filename: \`content-\${slug}-plan.md\`,
          content: \`# Content Pipeline Plan: \${topic}\\n\\nAudience: \${audience}\\nTone: \${preferredTone}\\nPersonalized: \${userPreferences.length > 0 ? 'yes' : 'no'}\\n\\n\${plan.map((item, index) => \`\${index + 1}. \${item.channel}: \${item.angle} (\${item.format})\`).join('\\n')}\\n\`
        },
        {
          filename: \`content-\${slug}-posts.md\`,
          content: \`# Draft Posts: \${topic}\\n\\nTone: \${preferredTone}\\nPersonalized: \${userPreferences.length > 0 ? 'yes' : 'no'}\\n\\n## Short Post\\n\${topic} is about turning repeatable work into a local swarm that can plan, act, audit, and learn.\\n\\n## Professional Post\\nFor \${audience}, \${topic} means cheaper execution, inspectable memory, and reusable operator workflows without paying a frontier model for every step.\\n\\n## Blog Outline\\n- The problem: expensive repeated agent work\\n- The idea: local HTML workers as an operator swarm\\n- The proof: route, act, audit, repair, learn\\n- The next step: connect real tools and pipelines\\n\${signatureBlock}\`
        }
      ];
      return { topic, audience, tone: preferredTone, personalized: userPreferences.length > 0, appliedPreferences: userPreferences, plan, files, ok: true };
    }

    channel.onmessage = event => {
      const msg = event.data;
      if (!msg || msg.sender === state.id) return;
      if (msg.type === 'HANDSHAKE_INIT') {
        channel.postMessage({ sender: state.id, timestamp: Date.now(), type: 'HANDSHAKE_ACK', data: { capability: state.capability } });
      }
      if (msg.type === state.requestType) {
        const pack = buildContentPack(msg.data || {});
        pack.files.forEach(file => {
          channel.postMessage({
            sender: state.id,
            timestamp: Date.now(),
            type: 'WRITE_FILE_REQUEST',
            data: { filename: file.filename, content: file.content }
          });
        });
        channel.postMessage({
          sender: state.id,
          timestamp: Date.now(),
          type: state.resultType,
          data: pack
        });
      }
    };
  <\/script>
</body>
</html>`;
  }

  const api = { createWorkerHtml };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  globalScope.SwarmAgentFactory = api;
})(typeof globalThis !== 'undefined' ? globalThis : window);
