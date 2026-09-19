#!/usr/bin/env node
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'consolidation', 'domain-neurogenesis-stage5-20260830');
const PUBLIC = path.join(OUT, 'public-development.json');
const HIDDEN = path.join(OUT, 'hidden-holdouts.json');
const INDEX = path.join(OUT, 'sealed-index.json');
const PARENT_HASH = '595541d08c308071049ea6bca168260f68c56efdc97a15cb7c96931a8e4b431a';
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const encode = value => Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
const rel = file => path.relative(ROOT, file).replace(/\\/g, '/');

function main() {
  if ([PUBLIC, HIDDEN, INDEX].some(fs.existsSync)) throw new Error('Stage 5 is already sealed; refusing to overwrite it.');
  fs.mkdirSync(OUT, { recursive: true });
  const publicDevelopment = {
    schemaVersion: 1,
    kind: 'lari.domain-neurogenesis-stage5.public-development',
    parentHash: PARENT_HASH,
    family: 'coordinated_text_canonicalization_procedure',
    case: {
      id: 'training.javascript.labels',
      language: 'javascript',
      testPath: 'tests/catalog.test.js',
      expressionTarget: 'src/catalog.js',
      files: {
        'src/normalize.js': 'function canonicalizeLabel(label) {\n  return label;\n}\n\nmodule.exports = { canonicalizeLabel };\n',
        'src/catalog.js': 'const { canonicalizeLabel } = require("./normalize");\n\nfunction uniqueLabels(labels) {\n  return labels;\n}\n\nmodule.exports = { uniqueLabels };\n',
        'tests/catalog.test.js': 'const assert = require("assert");\nconst { canonicalizeLabel } = require("../src/normalize");\nconst { uniqueLabels } = require("../src/catalog");\nassert.strictEqual(canonicalizeLabel("  Alpha "), "alpha");\nassert.strictEqual(canonicalizeLabel("BETA"), "beta");\nassert.deepStrictEqual(uniqueLabels([" Alpha ", "alpha", "BETA", " beta "]), ["alpha", "beta"]);\nconsole.log("catalog canonicalization verified");\n'
      }
    }
  };
  const hiddenHoldouts = {
    schemaVersion: 1,
    kind: 'lari.domain-neurogenesis-stage5.hidden',
    parentHash: PARENT_HASH,
    family: publicDevelopment.family,
    cases: [
      {
        id: 'hidden.python.keys', language: 'python', testPath: 'checks/verify.py', expressionTarget: 'keys/collection.py',
        files: {
          'keys/__init__.py': '',
          'keys/normalize.py': 'def normalize_key(value):\n    return value\n',
          'keys/collection.py': 'from .normalize import normalize_key\n\ndef distinct_keys(values):\n    return values\n',
          'checks/verify.py': 'from keys.normalize import normalize_key\nfrom keys.collection import distinct_keys\nassert normalize_key("  North ") == "north"\nassert normalize_key("SOUTH") == "south"\nassert distinct_keys([" North", "north ", " SOUTH ", "south"]) == ["north", "south"]\nprint("keys verified")\n'
        }
      },
      {
        id: 'hidden.javascript.topics', language: 'javascript', testPath: 'test/topics.js', expressionTarget: 'lib/topics.js',
        files: {
          'lib/clean.js': 'function cleanTopic(topic) {\n  return topic;\n}\nmodule.exports = { cleanTopic };\n',
          'lib/topics.js': 'const { cleanTopic } = require("./clean");\nfunction topicList(values) {\n  return values;\n}\nmodule.exports = { topicList };\n',
          'test/topics.js': 'const assert = require("assert");\nconst { cleanTopic } = require("../lib/clean");\nconst { topicList } = require("../lib/topics");\nassert.strictEqual(cleanTopic("  Science "), "science");\nassert.deepStrictEqual(topicList([" Science ", "science", "ART", " art "]), ["science", "art"]);\nconsole.log("topics verified");\n'
        }
      },
      {
        id: 'hidden.python.regions', language: 'python', testPath: 'tests/test_regions.py', expressionTarget: 'regions/listing.py',
        files: {
          'regions/__init__.py': '',
          'regions/text.py': 'def canonical_region(region):\n    return region\n',
          'regions/listing.py': 'from .text import canonical_region\n\ndef region_codes(regions):\n    return regions\n',
          'tests/test_regions.py': 'from regions.text import canonical_region\nfrom regions.listing import region_codes\nassert canonical_region(" East ") == "east"\nassert region_codes([" East ", "EAST", " west", "West "]) == ["east", "west"]\nprint("regions verified")\n'
        }
      },
      {
        id: 'hidden.javascript.names', language: 'javascript', testPath: 'checks/names.js', expressionTarget: 'names/distinct.js',
        files: {
          'names/canonical.js': 'function canonicalName(name) {\n  return name;\n}\nmodule.exports = { canonicalName };\n',
          'names/distinct.js': 'const { canonicalName } = require("./canonical");\nfunction distinctNames(names) {\n  return names;\n}\nmodule.exports = { distinctNames };\n',
          'checks/names.js': 'const assert = require("assert");\nconst { canonicalName } = require("../names/canonical");\nconst { distinctNames } = require("../names/distinct");\nassert.strictEqual(canonicalName("  Ada "), "ada");\nassert.deepStrictEqual(distinctNames([" Ada ", "ADA", " Grace", "grace "]), ["ada", "grace"]);\nconsole.log("names verified");\n'
        }
      }
    ]
  };
  const publicBytes = encode(publicDevelopment), hiddenBytes = encode(hiddenHoldouts);
  fs.writeFileSync(PUBLIC, publicBytes, { flag: 'wx' });
  fs.writeFileSync(HIDDEN, hiddenBytes, { flag: 'wx' });
  const index = {
    schemaVersion: 1,
    kind: 'lari.domain-neurogenesis-stage5.seal',
    sealedAt: new Date().toISOString(),
    parentHash: PARENT_HASH,
    publicDevelopment: { path: rel(PUBLIC), sha256: sha(publicBytes), bytes: publicBytes.length },
    hiddenHoldouts: { path: rel(HIDDEN), sha256: sha(hiddenBytes), bytes: hiddenBytes.length, caseCount: hiddenHoldouts.cases.length },
    learnerMayRead: [rel(PUBLIC)],
    learnerMustNotRead: [rel(HIDDEN)],
    mutationPolicy: 'immutable'
  };
  const indexBytes = encode(index);
  fs.writeFileSync(INDEX, indexBytes, { flag: 'wx' });
  console.log(JSON.stringify({ passed: true, seal: { path: rel(INDEX), sha256: sha(indexBytes) }, publicHash: index.publicDevelopment.sha256, hiddenHash: index.hiddenHoldouts.sha256, hiddenCases: hiddenHoldouts.cases.length }, null, 2));
}

main();
