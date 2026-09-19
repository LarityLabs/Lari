#!/usr/bin/env node
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'consolidation', 'primitive-invention-20260831');
const PUBLIC = path.join(OUT, 'public-training.json');
const HIDDEN = path.join(OUT, 'hidden-holdouts.json');
const SEAL = path.join(OUT, 'sealed-index.json');
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const writeExclusive = (file, value) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx' }); };

const publicTraining = {
  schemaVersion: 1,
  kind: 'lari.primitive-invention.public-training',
  case: {
    id: 'training.identifier-boundary-normalization', language: 'javascript', testRunner: 'javascript.node', testPath: 'tests/naming.test.js', expressionTarget: 'src/fields.js',
    files: {
      'src/naming.js': "function normalizeIdentifier(value) {\n  return String(value).trim().toLowerCase();\n}\nmodule.exports = { normalizeIdentifier };\n",
      'src/fields.js': "const { normalizeIdentifier } = require('./naming');\nfunction uniqueFieldNames(values) {\n  return values;\n}\nmodule.exports = { uniqueFieldNames };\n",
      'tests/naming.test.js': "const assert = require('assert');\nconst { normalizeIdentifier } = require('../src/naming');\nconst { uniqueFieldNames } = require('../src/fields');\nassert.strictEqual(normalizeIdentifier('userProfile'), 'user_profile');\nassert.strictEqual(normalizeIdentifier('HTTPServerID'), 'http_server_id');\nassert.strictEqual(normalizeIdentifier('XMLParser'), 'xml_parser');\nassert.deepStrictEqual(uniqueFieldNames([' UserProfile ', 'userProfile', 'HTTPServerID']), ['user_profile', 'http_server_id']);\nconsole.log('identifier primitive and procedure verified');\n"
    }
  }
};

const hiddenHoldouts = {
  schemaVersion: 1,
  kind: 'lari.primitive-invention.hidden-holdouts',
  cases: [
    {
      id: 'hidden.js.api-fields', language: 'javascript', testRunner: 'javascript.node', testPath: 'proof/run.js', expressionTarget: 'schema/fields.js',
      files: {
        'schema/naming.js': "function fieldKey(value) { return String(value).trim().toLowerCase(); }\nmodule.exports = { fieldKey };\n",
        'schema/fields.js': "const { fieldKey } = require('./naming');\nfunction distinctKeys(values) { return values; }\nmodule.exports = { distinctKeys };\n",
        'proof/run.js': "const assert = require('assert'); const { fieldKey } = require('../schema/naming'); const { distinctKeys } = require('../schema/fields'); assert.strictEqual(fieldKey('apiTokenID'), 'api_token_id'); assert.strictEqual(fieldKey('JSONPayload'), 'json_payload'); assert.strictEqual(fieldKey('orderItem'), 'order_item'); assert.deepStrictEqual(distinctKeys(['ApiTokenID', 'apiTokenID', 'JSONPayload']), ['api_token_id', 'json_payload']); console.log('api fields verified');\n"
      }
    },
    {
      id: 'hidden.py.event-fields', language: 'python', testRunner: 'python.script', testPath: 'proof/check.py', expressionTarget: 'events/fields.py',
      files: {
        'events/__init__.py': '',
        'events/naming.py': "def event_key(value):\n    return str(value).strip().lower()\n",
        'events/fields.py': "from .naming import event_key\n\ndef unique_event_keys(values):\n    return values\n",
        'proof/check.py': "from events.naming import event_key\nfrom events.fields import unique_event_keys\nassert event_key('eventTypeID') == 'event_type_id'\nassert event_key('XMLMessage') == 'xml_message'\nassert event_key('retryCount') == 'retry_count'\nassert unique_event_keys(['EventTypeID', 'eventTypeID', 'XMLMessage']) == ['event_type_id', 'xml_message']\nprint('event fields verified')\n"
      }
    },
    {
      id: 'hidden.js.config-fields', language: 'javascript', testRunner: 'javascript.node', testPath: 'checks/check.js', expressionTarget: 'config/list.js',
      files: {
        'config/key.js': "function configKey(value) { return String(value).trim().toLowerCase(); }\nmodule.exports = { configKey };\n",
        'config/list.js': "const { configKey } = require('./key');\nfunction canonicalKeys(values) { return values; }\nmodule.exports = { canonicalKeys };\n",
        'checks/check.js': "const assert = require('assert'); const { configKey } = require('../config/key'); const { canonicalKeys } = require('../config/list'); assert.strictEqual(configKey('databaseURL'), 'database_url'); assert.strictEqual(configKey('TLSConfig'), 'tls_config'); assert.strictEqual(configKey('maxRetries'), 'max_retries'); assert.deepStrictEqual(canonicalKeys(['DatabaseURL', 'databaseURL', 'TLSConfig']), ['database_url', 'tls_config']); console.log('config fields verified');\n"
      }
    },
    {
      id: 'hidden.py.metric-fields', language: 'python', testRunner: 'python.script', testPath: 'checks/run.py', expressionTarget: 'metrics/listing.py',
      files: {
        'metrics/__init__.py': '',
        'metrics/naming.py': "def metric_name(value):\n    return str(value).strip().lower()\n",
        'metrics/listing.py': "from .naming import metric_name\n\ndef unique_metric_names(values):\n    return values\n",
        'checks/run.py': "from metrics.naming import metric_name\nfrom metrics.listing import unique_metric_names\nassert metric_name('requestHTTPStatus') == 'request_http_status'\nassert metric_name('CPUTime') == 'cpu_time'\nassert metric_name('errorCount') == 'error_count'\nassert unique_metric_names(['RequestHTTPStatus', 'requestHTTPStatus', 'CPUTime']) == ['request_http_status', 'cpu_time']\nprint('metric fields verified')\n"
      }
    }
  ]
};

function main() {
  if ([PUBLIC, HIDDEN, SEAL].some(fs.existsSync)) throw new Error('Primitive-invention curriculum already exists.');
  const publicBytes = Buffer.from(`${JSON.stringify(publicTraining, null, 2)}\n`);
  const hiddenBytes = Buffer.from(`${JSON.stringify(hiddenHoldouts, null, 2)}\n`);
  writeExclusive(PUBLIC, publicTraining);
  writeExclusive(HIDDEN, hiddenHoldouts);
  writeExclusive(SEAL, { schemaVersion: 1, kind: 'lari.primitive-invention.sealed-index', createdAt: new Date().toISOString(), publicTraining: { path: path.relative(ROOT, PUBLIC).replace(/\\/g, '/'), sha256: sha(publicBytes), cases: 1 }, hiddenHoldouts: { path: path.relative(ROOT, HIDDEN).replace(/\\/g, '/'), sha256: sha(hiddenBytes), cases: hiddenHoldouts.cases.length }, existingPrimitiveLanguage: { normalization: ['trim', 'lowercase'], terminals: ['list', 'stable_unique'], totalPrograms: 6 }, learnerMayRead: [path.relative(ROOT, PUBLIC).replace(/\\/g, '/')], learnerMustNotRead: [path.relative(ROOT, HIDDEN).replace(/\\/g, '/')] });
  process.stdout.write(`${JSON.stringify({ passed: true, publicHash: sha(publicBytes), hiddenHash: sha(hiddenBytes), hiddenCases: hiddenHoldouts.cases.length, existingPrograms: 6 }, null, 2)}\n`);
}

main();
