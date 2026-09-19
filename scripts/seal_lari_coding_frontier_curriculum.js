#!/usr/bin/env node
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'consolidation', 'coding-frontier-curriculum-v2-20260828');
const PAYLOAD = path.join(OUT, 'sealed-holdouts.json');
const MANIFEST = path.join(OUT, 'seal-manifest.json');
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
const stable = value => `${JSON.stringify(value, null, 2)}\n`;

function main() {
  if (fs.existsSync(PAYLOAD) || fs.existsSync(MANIFEST)) throw new Error('Coding-frontier holdouts are already sealed.');
  const cases = {
    schemaVersion: 1,
    holdouts: [
      {
        id: 'issue-localization-python',
        lane: 'issue_localization',
        language: 'python',
        testRunner: 'python.script',
        testPath: 'checks/verify_public_api.py',
        request: 'Repair the failing package behavior. Localize the implementation defect from the immutable runner evidence; no target file is supplied. Preserve empty callback results, convert string results, and preserve native objects.',
        files: {
          'package/__init__.py': 'from .api import adapt\n',
          'package/api.py': 'from .adapter import adapt\n\n__all__ = ["adapt"]\n',
          'package/source.py': 'def fetch(callback, item):\n    return callback(item)\n',
          'package/adapter.py': 'from .source import fetch\n\ndef adapt(callback, item):\n    values = fetch(callback, item)\n    if isinstance(values[0], str):\n        return [{"label": value} for value in values]\n    return values\n',
          'checks/verify_public_api.py': 'import os, sys\nsys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))\nfrom package import adapt\nassert adapt(lambda item: [], "x") == []\nassert adapt(lambda item: ["red"], "x") == [{"label": "red"}]\nnative = [{"label": "blue"}]\nassert adapt(lambda item: native, "x") is native\nprint("localized package behavior verified")\n'
        }
      },
      {
        id: 'isolated-test-creation-python',
        lane: 'isolated_test_creation',
        language: 'python',
        testRunner: 'python.script',
        testPath: 'tests/native_suite.py',
        expressionTarget: 'library/slug.py',
        request: 'The native suite is blocked by a missing legacy harness dependency. Create a minimal isolated reproduction from the stated public examples, repair slugify, and verify those examples without changing the blocked native test.',
        publicExamples: [
          { args: ['  Hello, World!  '], comparator: 'equal', expected: 'hello-world' },
          { args: ['Already_clean'], comparator: 'equal', expected: 'already-clean' }
        ],
        publicSymbol: { modulePath: 'library/slug.py', symbolPath: ['slugify'] },
        files: {
          'library/__init__.py': '',
          'library/slug.py': 'def slugify(value):\n    return str(value).strip()\n',
          'tests/native_suite.py': 'import missing_legacy_harness\nfrom library.slug import slugify\nassert slugify("  Hello, World!  ") == "hello-world"\n'
        }
      },
      {
        id: 'coordinated-multifile-python',
        lane: 'coordinated_multi_file_repair',
        language: 'python',
        testRunner: 'python.script',
        testPath: 'checks/verify_total.py',
        expressionTarget: 'service/summary.py',
        request: 'Repair this failing multi-file package by coordinating the predicate helper and its consumer. Preserve public signatures and prove the immutable declared runner passes.',
        files: {
          'service/__init__.py': '',
          'service/rules.py': 'def is_enabled(entry):\n    return False\n',
          'service/summary.py': 'from .rules import is_enabled\n\ndef enabled_total(entries):\n    return 0\n',
          'checks/verify_total.py': 'import os, sys\nsys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))\nfrom service.rules import is_enabled\nfrom service.summary import enabled_total\nfirst = {"enabled": True, "amount": 4}\noff = {"enabled": False, "amount": 30}\nsecond = {"enabled": True, "amount": 7}\nassert is_enabled(first) is True\nassert is_enabled(off) is False\nassert enabled_total([first, off, second]) == 11\nprint("coordinated package behavior verified")\n'
        }
      },
      {
        id: 'behavior-preserving-refactor-python',
        lane: 'behavior_preserving_refactor',
        language: 'python',
        testRunner: 'python.script',
        testPath: 'checks/verify_refactor.py',
        expressionTarget: 'catalog/keys.py',
        request: 'Refactor duplicated key normalization into one private helper without changing public behavior. The structural oracle requires both public functions to delegate to the helper and the behavior oracle must remain green.',
        files: {
          'catalog/__init__.py': '',
          'catalog/keys.py': 'import re\n\ndef lookup_key(value):\n    text = str(value).strip().lower()\n    return re.sub(r"[^a-z0-9]+", "-", text).strip("-")\n\ndef storage_key(value):\n    text = str(value).strip().lower()\n    return re.sub(r"[^a-z0-9]+", "-", text).strip("-")\n',
          'checks/verify_refactor.py': 'import ast, os, pathlib, sys\nsys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))\nfrom catalog.keys import lookup_key, storage_key\nassert lookup_key("  Red Apple  ") == "red-apple"\nassert storage_key("A/B Test") == "a-b-test"\nsource = pathlib.Path("catalog/keys.py").read_text()\ntree = ast.parse(source)\nfunctions = {node.name: node for node in tree.body if isinstance(node, ast.FunctionDef)}\nassert "_normalize_key" in functions\nfor name in ("lookup_key", "storage_key"):\n    calls = [node for node in ast.walk(functions[name]) if isinstance(node, ast.Call) and isinstance(node.func, ast.Name)]\n    assert any(call.func.id == "_normalize_key" for call in calls)\nprint("behavior-preserving refactor verified")\n'
        }
      },
      {
        id: 'long-horizon-two-step-python',
        lane: 'long_horizon_repair',
        language: 'python',
        testRunner: 'python.script',
        testPath: 'checks/verify_operations.py',
        expressionTarget: 'operations/math_ops.py',
        request: 'Complete this bounded long-horizon repair. Re-observe after every accepted change, make monotonic progress, roll back non-improvements, finish both independent defects, and stop only when the immutable suite is green.',
        files: {
          'operations/__init__.py': '',
          'operations/math_ops.py': 'def add_values(left, right):\n    pass\n\ndef multiply_values(left, right):\n    pass\n',
          'checks/verify_operations.py': 'import os, sys\nsys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))\nfrom operations.math_ops import add_values, multiply_values\nfailures = 0\nfor actual, expected in ((add_values(2, 3), 5), (add_values(10, 1), 11), (multiply_values(2, 3), 6), (multiply_values(4, 5), 20)):\n    failures += actual != expected\nprint(f"{failures} failed" if failures else "4 passed")\nraise SystemExit(1 if failures else 0)\n'
        }
      }
    ]
  };
  fs.mkdirSync(OUT, { recursive: true });
  const payloadBytes = Buffer.from(stable(cases));
  fs.writeFileSync(PAYLOAD, payloadBytes, { flag: 'wx' });
  const manifest = {
    schemaVersion: 1,
    kind: 'lari.coding-frontier.sealed-holdout-manifest',
    sealedAt: new Date().toISOString(),
    payload: { path: path.relative(ROOT, PAYLOAD).replace(/\\/g, '/'), sha256: sha(payloadBytes), bytes: payloadBytes.length },
    lanes: cases.holdouts.map(item => item.lane),
    holdoutVisibleToLearner: false,
    mutationPolicy: 'immutable'
  };
  fs.writeFileSync(MANIFEST, stable(manifest), { flag: 'wx' });
  fs.chmodSync(PAYLOAD, 0o444);
  fs.chmodSync(MANIFEST, 0o444);
  process.stdout.write(`${JSON.stringify(manifest, null, 2)}\n`);
}

main();
