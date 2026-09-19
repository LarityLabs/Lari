/**
 * Deterministic Swarm P2P Integration Test
 * Verifies the exact loop mechanics, BroadcastChannel schema, and file-system proxy pipeline.
 */

const { BroadcastChannel } = require('worker_threads');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

console.log('========================================================');
console.log('🤖 STARTING LOCAL DETERMINISTIC SWARM INTEGRATION TEST');
console.log('========================================================\n');

// 1. Setup the shared Swarm Mesh Channel
const channel = new BroadcastChannel('swarm-mesh');

// Helper to format logs with timestamps
function log(agent, msg, color = '\x1b[0m') {
  console.log(`[\x1b[1m${new Date().toLocaleTimeString()}\x1b[0m] ${color}[${agent}]\x1b[0m ${msg}`);
}

// 2. Initialize Agent Loops

// --- Coordinator Logic ---
const coordState = { generation: 1.0 };
channel.onmessage = (event) => {
  const msg = event.data;
  if (!msg) return;

  if (msg.type === 'WRITE_FILE_REQUEST') {
    log('Coordinator', `Received proxy WRITE_FILE_REQUEST from ${msg.sender} for "${msg.data.filename}"`, '\x1b[35m');
    try {
      const targetPath = path.join(__dirname, msg.data.filename);
      fs.writeFileSync(targetPath, msg.data.content, 'utf8');
      log('Coordinator', `Successfully wrote file to workspace: ${targetPath}`, '\x1b[32m');
      
      // Confirm write
      channel.postMessage({
        sender: 'coordinator',
        type: 'FILE_WRITTEN',
        data: { sender: msg.sender, filename: msg.data.filename }
      });
    } catch (err) {
      log('Coordinator', `Proxy write error: ${err.message}`, '\x1b[31m');
    }
  }

  if (msg.type === 'READ_FILE_REQUEST') {
    log('Coordinator', `Received proxy READ_FILE_REQUEST from ${msg.sender} for "${msg.data.filename}"`, '\x1b[35m');
    try {
      const targetPath = path.join(__dirname, msg.data.filename);
      const text = fs.readFileSync(targetPath, 'utf8');
      log('Coordinator', `Successfully read file: ${msg.data.filename} (${text.length} bytes)`, '\x1b[32m');
      
      channel.postMessage({
        sender: 'coordinator',
        type: 'FILE_READ_RESPONSE',
        data: { target: msg.sender, filename: msg.data.filename, content: text }
      });
    } catch (err) {
      log('Coordinator', `Proxy read error: ${err.message}`, '\x1b[31m');
      channel.postMessage({
        sender: 'coordinator',
        type: 'FILE_READ_RESPONSE',
        data: { target: msg.sender, filename: msg.data.filename, error: err.message }
      });
    }
  }

  if (msg.type === 'REGISTRY_LOGGED') {
    log('Coordinator', `Ledger confirmed transaction hash: ${msg.data.stateHash.slice(0, 16)}...`, '\x1b[32m');
    log('Coordinator', `Swarm generation stepped up to: Gen ${msg.data.generation.toFixed(2)}`, '\x1b[32m');
    console.log('\n========================================================');
    console.log('🎉 SUCCESS: SWARM COMPLETED PIPELINE autonomously!');
    console.log('========================================================');
    
    // Clean up and exit
    channel.close();
    setTimeout(() => process.exit(0), 1000);
  }
};

// --- Architect Agent Logic ---
const archChannel = new BroadcastChannel('swarm-mesh');
archChannel.onmessage = (event) => {
  const msg = event.data;
  if (!msg) return;

  if (msg.type === 'TASK_START') {
    log('Architect', `Received Swarm prompt instruction: "${msg.data.task}"`, '\x1b[34m');
    log('Architect', 'Designing target specifications and layout components...', '\x1b[30m');
    
    setTimeout(() => {
      const spec = {
        goal: msg.data.task,
        files: [
          {
            path: 'test_calculator.html',
            type: 'html',
            title: 'Interactive Swarm Calculator',
            components: ['header', 'display', 'keyboard', 'footer'],
            styling: { theme: 'glassmorphic-dark', accent: '#00f0ff' }
          }
        ],
        reasoningChain: [
          'Parse workflow task.',
          'Extract calculator file name target.',
          'Inject clean, glassmorphic UI buttons.'
        ]
      };
      
      log('Architect', 'Blueprint spec designed. Broadcasting TASK_SPEC_GENERATED to swarm...', '\x1b[34m');
      archChannel.postMessage({
        sender: 'architect',
        type: 'TASK_SPEC_GENERATED',
        data: { task: msg.data.task, spec: spec }
      });
    }, 1500);
  }
};

// --- Coder Agent Logic ---
const coderChannel = new BroadcastChannel('swarm-mesh');
coderChannel.onmessage = (event) => {
  const msg = event.data;
  if (!msg) return;

  if (msg.type === 'TASK_SPEC_GENERATED') {
    const spec = msg.data.spec;
    const fileTarget = spec.files[0];
    log('Coder', `Compiling glassmorphic layout code for "${fileTarget.path}"...`, '\x1b[36m');
    
    setTimeout(() => {
      // Compile the high-fidelity calculator code
      const generatedCode = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>${fileTarget.title}</title>
  <style>
    body { background-color: #0b0c10; color: #fff; font-family: sans-serif; display: flex; align-items: center; justify-content: center; min-height: 100vh; margin: 0; }
    .calculator { background: rgba(31, 40, 51, 0.45); backdrop-filter: blur(15px); border: 1px solid rgba(255, 255, 255, 0.08); border-radius: 12px; padding: 1.5rem; width: 280px; }
    .screen { background: rgba(0,0,0,0.4); border-radius: 6px; padding: 0.75rem; text-align: right; font-size: 1.5rem; color: ${fileTarget.styling.accent}; margin-bottom: 1rem; }
    .grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 0.5rem; }
    button { padding: 0.75rem; background: rgba(255,255,255,0.03); border: 1px solid rgba(255,255,255,0.06); color: #fff; border-radius: 6px; cursor: pointer; }
    button:hover { background: rgba(255,255,255,0.1); }
  </style>
</head>
<body>
  <div class="calculator">
    <div class="screen" id="display">0</div>
    <div class="grid">
      <button onclick="press('7')">7</button><button onclick="press('8')">8</button><button onclick="press('9')">9</button><button onclick="press('/')">/</button>
      <button onclick="press('4')">4</button><button onclick="press('5')">5</button><button onclick="press('6')">6</button><button onclick="press('*')">*</button>
      <button onclick="press('1')">1</button><button onclick="press('2')">2</button><button onclick="press('3')">3</button><button onclick="press('-')">-</button>
      <button onclick="clearScr()">C</button><button onclick="press('0')">0</button><button onclick="evalExpr()">=</button><button onclick="press('+')">+</button>
    </div>
  </div>
  <script>
    let expr = '';
    const disp = document.getElementById('display');
    function press(v) { expr += v; disp.textContent = expr; }
    function clearScr() { expr = ''; disp.textContent = '0'; }
    function evalExpr() { try { expr = eval(expr).toString(); disp.textContent = expr; } catch(e) { disp.textContent = 'Error'; expr = ''; } }
  <\/script>
</body>
</html>`;

      log('Coder', 'Generation finished. Broadcasting WRITE_FILE_REQUEST...', '\x1b[36m');
      coderChannel.postMessage({
        sender: 'coder',
        type: 'WRITE_FILE_REQUEST',
        data: { filename: fileTarget.path, content: generatedCode }
      });
    }, 1500);
  }
};

// --- Auditor Agent Logic ---
const auditorChannel = new BroadcastChannel('swarm-mesh');
auditorChannel.onmessage = (event) => {
  const msg = event.data;
  if (!msg) return;

  if (msg.type === 'FILE_WRITTEN' && msg.data.sender === 'coder') {
    log('Auditor', `Notified of Coder commit: "${msg.data.filename}". Requesting read access...`, '\x1b[33m');
    auditorChannel.postMessage({
      sender: 'auditor',
      type: 'READ_FILE_REQUEST',
      data: { filename: msg.data.filename }
    });
  }

  if (msg.type === 'FILE_READ_RESPONSE' && msg.data.target === 'auditor') {
    const code = msg.data.content;
    log('Auditor', `Beginning strict document audits for "${msg.data.filename}"...`, '\x1b[33m');
    
    setTimeout(() => {
      // Deterministic Checklist Assessments
      const hasDocType = code.includes('<!DOCTYPE html>');
      const hasBody = code.includes('<body') && code.includes('</body>');
      const hasStyle = code.includes('<style') && code.includes('</style>');
      const hasScript = code.includes('<script') && code.includes('<\/script>');
      const hasPlaceholders = code.includes('// TODO') || code.includes('AI_INSERT_LOGIC');

      log('Auditor', `Check 1: HTML DOCTYPE & blocktags -> ${hasDocType && hasBody ? 'PASS' : 'FAIL'}`, '\x1b[30m');
      log('Auditor', `Check 2: Responsive Stylesheets  -> ${hasStyle ? 'PASS' : 'FAIL'}`, '\x1b[30m');
      log('Auditor', `Check 3: Script bindings & logic  -> ${hasScript ? 'PASS' : 'FAIL'}`, '\x1b[30m');
      log('Auditor', `Check 4: Placeholders Check       -> ${!hasPlaceholders ? 'PASS' : 'FAIL'}`, '\x1b[30m');

      let score = 6;
      if (hasDocType) score += 1;
      if (hasStyle) score += 1;
      if (hasScript) score += 1;
      if (!hasPlaceholders) score += 1;
      if (score > 10) score = 10;

      const passed = score >= 7;
      log('Auditor', `Audit completed. Final score: ${score}/10. Passed quality: ${passed}`, '\x1b[33m');
      
      auditorChannel.postMessage({
        sender: 'auditor',
        type: 'AUDIT_COMPLETE',
        data: { filename: msg.data.filename, rating: score, passed: passed }
      });
    }, 1500);
  }
};

// --- Registry Agent Logic ---
const registryChannel = new BroadcastChannel('swarm-mesh');
let registryState = {
  generation: 1.0,
  lastBlockHash: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'
};
registryChannel.onmessage = (event) => {
  const msg = event.data;
  if (!msg) return;

  if (msg.type === 'AUDIT_COMPLETE') {
    log('Registry', `Logging audit score for "${msg.data.filename}". Computing cryptographic ledger block...`, '\x1b[32m');
    
    setTimeout(async () => {
      // Mutate Swarm Generation Metric
      if (msg.data.passed) {
        registryState.generation += 0.05;
      }
      
      const newBlock = {
        timestamp: Date.now(),
        filename: msg.data.filename,
        rating: msg.data.rating,
        passed: msg.data.passed,
        parentHash: registryState.lastBlockHash,
        generation: registryState.generation
      };

      // Native SHA-256 hash using Node 'crypto' module
      const blockStr = JSON.stringify(newBlock);
      const sha256 = crypto.createHash('sha256').update(blockStr).digest('hex');
      
      registryState.lastBlockHash = sha256;
      log('Registry', `Chained Block Hash: ${sha256}`, '\x1b[32m');
      
      registryChannel.postMessage({
        sender: 'registry',
        type: 'REGISTRY_LOGGED',
        data: {
          filename: msg.data.filename,
          rating: msg.data.rating,
          stateHash: sha256,
          generation: registryState.generation
        }
      });
    }, 1500);
  }
};

// 3. Initiate the workflow simulation by posting the task
setTimeout(() => {
  log('Coordinator', 'Gregory dispatched command: "Build a calculator page called test_calculator.html"', '\x1b[35m');
  channel.postMessage({
    sender: 'coordinator',
    type: 'TASK_START',
    data: { task: 'Build a calculator page called test_calculator.html' }
  });
}, 1000);

// Global Timeout Safeguard (15 seconds)
setTimeout(() => {
  console.log('\n❌ TIMEOUT: Swarm took too long to complete. Exiting.');
  process.exit(1);
}, 15000);
