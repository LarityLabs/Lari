'use strict';

/**
 * Writing code from the language's own grammar, rather than rearranging code that already exists.
 *
 * Everything this engine could do until now was a rearrangement. Substitutions swap an operator that
 * is present; statement restoration copies a line from somewhere else in the project. Both need the
 * answer to already exist in some form, which is why deleted statements top out around two thirds --
 * the rest are lines that appear nowhere.
 *
 * The way past that is not a bigger corpus, it is the grammar. Python describes itself: `ast` lists 29
 * statement kinds, 29 expression kinds, 33 operators, and the fields each one requires -- `BinOp` is
 * (left, op, right), `Compare` is (left, ops, comparators). Nothing about that has to be taught by
 * hand, and nothing about it is specific to a repository. Given the names in scope at a hole, the
 * grammar says exactly which expressions are constructible, and every one of them parses by
 * construction rather than by luck.
 *
 * It also answers "what have I never tried". Lari uses about five of the 33 operators. The grammar
 * knows about the other 28, so an unfamiliar construct is something it can deliberately attempt rather
 * than something it waits to encounter.
 *
 * The limit, stated first because it decides where this is useful
 * --------------------------------------------------------------
 * Combinatorics. Expressions of depth two over a handful of names are hundreds of candidates and
 * perfectly affordable. Depth four is millions and is not. So this fills *small holes* -- an
 * expression, a condition, one assignment's right-hand side -- which is precisely the gap copying
 * cannot reach. It does not write programs, and no amount of budget makes it write programs.
 *
 * As always, generation only proposes. The tests decide.
 */

/**
 * Operators worth composing with, grouped by what they produce.
 *
 * Read from Python rather than invented here: the caller passes what `ast` reported, so a construct
 * this file has never heard of still participates.
 */
const DEFAULT_OPERATORS = {
  arithmetic: ['+', '-', '*', '//', '%'],
  comparison: ['==', '!=', '<', '<=', '>', '>='],
  boolean: ['and', 'or'],
  bitwise: ['&', '|', '^', '<<', '>>'],
  unary: ['not ', '-']
};

/** Names visible at a point in the file: parameters, assignments, loop variables. */
function namesInScope(source, lineIndex) {
  const lines = String(source).split(/\r?\n/);
  const names = new Set();
  for (let i = 0; i < Math.min(lineIndex, lines.length); i += 1) {
    const line = lines[i];
    const assigned = line.match(/^\s*([A-Za-z_]\w*)\s*=[^=]/);
    if (assigned) names.add(assigned[1]);
    const loop = line.match(/^\s*for\s+([A-Za-z_]\w*)\s+in\b/);
    if (loop) names.add(loop[1]);
    const params = line.match(/^\s*def\s+\w+\s*\(([^)]*)\)/);
    if (params) {
      for (const part of params[1].split(',')) {
        const name = part.trim().split(/[:=]/)[0].trim();
        if (/^[A-Za-z_]\w*$/.test(name) && name !== 'self') names.add(name);
      }
    }
  }
  return [...names];
}

/**
 * Build expressions from the grammar, smallest first.
 *
 * Depth 1 is a bare name or literal. Depth 2 applies one operator or call to depth-1 terms, and so on.
 * Ordering by size is not a heuristic about what is likely -- it is the observation that a smaller
 * expression is cheaper to test and, when several fit, usually the one that was meant.
 */
function synthesizeExpressions({
  names = [],
  constants = ['0', '1', ''],
  operators = DEFAULT_OPERATORS,
  depth = 2,
  limit = 400,
  calls = ['len']
} = {}) {
  const terms = [...names, ...constants].filter(Boolean);
  const produced = new Set(terms);
  let frontier = [...terms];

  for (let level = 1; level < depth && produced.size < limit; level += 1) {
    const next = [];
    for (const left of frontier) {
      for (const right of terms) {
        for (const group of ['arithmetic', 'comparison', 'boolean', 'bitwise']) {
          for (const operator of operators[group] || []) {
            if (produced.size >= limit) break;
            const expression = `${left} ${operator} ${right}`;
            if (produced.has(expression)) continue;
            produced.add(expression);
            next.push(expression);
          }
        }
      }
      for (const call of calls) {
        const expression = `${call}(${left})`;
        if (!produced.has(expression) && produced.size < limit) {
          produced.add(expression);
          next.push(expression);
        }
      }
      for (const operator of operators.unary || []) {
        const expression = `${operator}${left}`;
        if (!produced.has(expression) && produced.size < limit) {
          produced.add(expression);
          next.push(expression);
        }
      }
    }
    frontier = next;
  }

  return [...produced];
}

/**
 * Candidate statements for a hole, built rather than copied.
 *
 * A deleted statement is overwhelmingly an assignment -- 20 of 20 in this repository's sealed sets --
 * and when the failure names an unbound name, the left-hand side is known. That collapses the problem
 * from "write a statement" to "write one expression", which is the size the grammar can actually
 * search.
 */
function synthesizeStatements({ source, lineIndex, targetName = null, failureText = '', ...options }) {
  const names = namesInScope(source, lineIndex);
  const unbound = targetName ? [targetName] : [
    ...new Set([...String(failureText).matchAll(/(?:name|variable) '([A-Za-z_]\w*)' is not defined/g)].map(m => m[1]))
  ];
  const expressions = synthesizeExpressions({ names, ...options });

  const statements = [];
  for (const name of unbound.length ? unbound : names.slice(0, 3)) {
    for (const expression of expressions) {
      if (expression === name) continue;                 // x = x teaches nothing
      statements.push({ text: `${name} = ${expression}`, target: name, expression });
    }
  }
  return statements;
}

/** Constructs the grammar offers that a vocabulary has never used -- the deliberate unknown. */
function unexploredOperators(vocabulary, operators = DEFAULT_OPERATORS) {
  const used = new Set();
  for (const entry of Object.values(vocabulary || {})) {
    for (const rule of entry?.rules || []) {
      used.add(String(rule[0]).trim());
      used.add(String(rule[1]).trim());
    }
  }
  const all = Object.values(operators).flat().map(op => op.trim());
  return [...new Set(all)].filter(operator => operator && !used.has(operator));
}

module.exports = {
  DEFAULT_OPERATORS,
  namesInScope,
  synthesizeExpressions,
  synthesizeStatements,
  unexploredOperators
};
