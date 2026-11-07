import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { writeDiagnostic } from './redact.mjs';

/**
 * The eval rule's parser, run as a child process by rules-eval.mjs. It reads `{ units: [{ kind, text }], maxLines }` from
 * stdin (a kind is js, jsx, ts, tsx or html, a whole HTML file), parses each unit with the TypeScript compiler (parsing only;
 * nothing is run), and writes `{ results: [{ lines, cause? }] }` to stdout: for each unit the distinct 1-based lines of dynamic
 * evaluation (at most `maxLines`) and, when the unit cannot be judged, one cause. No text, name or path leaves this process; a failure leaves a fixed text on stderr.
 * The rules are syntactic and closed: no value is tracked, so a form they do not name is no finding.
 */

const SCRIPT_KINDS = { js: ts.ScriptKind.JS, jsx: ts.ScriptKind.JSX, ts: ts.ScriptKind.TS, tsx: ts.ScriptKind.TSX };
/** The kind of a unit that is a whole HTML file, from which the child itself takes the code. */
const HTML_KIND = 'html';
/** The names refused wherever they are written: the global functions whose use evaluates code. */
const DYNAMIC_NAMES = new Set(['eval', 'Function']);
/** The global functions that evaluate their first argument when it is a string. */
const TIMER_NAMES = new Set(['setTimeout', 'setInterval']);
const GLOBAL_OBJECTS = new Set(['globalThis', 'window', 'self', 'global']);

/** `expression` without parentheses, non-null marks and type assertions, and, for a comma expression, only its last operand. */
function unwrap(expression) {
  let current = expression;
  while (ts.isParenthesizedExpression(current) || ts.isNonNullExpression(current) || ts.isAsExpression(current) || ts.isTypeAssertionExpression(current) || ts.isSatisfiesExpression(current)
    || (ts.isBinaryExpression(current) && current.operatorToken.kind === ts.SyntaxKind.CommaToken)) {
    current = ts.isBinaryExpression(current) ? current.right : current.expression;
  }
  return current;
}

/** The text of a key written as a string, number or plain template literal, else undefined (a BigInt or any other expression). */
function keyText(expression) {
  const key = unwrap(expression);
  return ts.isStringLiteralLike(key) || ts.isNumericLiteral(key) ? key.text : undefined;
}

/** A name this identifier declares or labels, or a property it names, is no use of the global of that name. */
function isUse(identifier) {
  const { parent } = identifier;
  const isName = parent.name === identifier && !ts.isShorthandPropertyAssignment(parent);
  const isLabel = (ts.isLabeledStatement(parent) || ts.isBreakOrContinueStatement(parent)) && parent.label === identifier;
  return !isName && !isLabel && parent.propertyName !== identifier;
}

/** The statement kinds the emitter drops whole when they carry their own `declare` modifier; any other `declare` node is still emitted. */
const DROPPED_DECLARATIONS = new Set([ts.SyntaxKind.VariableStatement, ts.SyntaxKind.FunctionDeclaration, ts.SyntaxKind.ClassDeclaration, ts.SyntaxKind.EnumDeclaration, ts.SyntaxKind.ModuleDeclaration]);
const isDroppedDeclaration = (node) => DROPPED_DECLARATIONS.has(node.kind) && (ts.getModifiers(node) ?? []).some(({ kind }) => kind === ts.SyntaxKind.DeclareKeyword);
// Types, interfaces, `implements` clauses and `declare` variable, function, class, enum and namespace statements are erased: nothing in them runs. A class `extends` clause does,
// and so do a `declare` export assignment, import alias or class field, which the emitter keeps. Every walk of the tree, `visit` and `usesOf` alike, stops at an erased node.
const isErased = (node) => (ts.isTypeNode(node) && !ts.isExpressionWithTypeArguments(node)) || ts.isInterfaceDeclaration(node)
  || (ts.isHeritageClause(node) && node.token === ts.SyntaxKind.ImplementsKeyword) || isDroppedDeclaration(node);

/** A test, kept per node, of whether a node holds anywhere in it, outside erased nodes, a node for which `matches` is true. */
function holding(matches) {
  const held = new WeakMap();
  const holds = (node) => {
    if (!held.has(node)) held.set(node, !isErased(node) && (matches(node) || ts.forEachChild(node, (child) => holds(child) || undefined) === true));
    return held.get(node);
  };
  return holds;
}
const isUseOf = (names) => (node) => ts.isIdentifier(node) && names.has(node.text) && isUse(node);
const holdsGlobalObject = holding(isUseOf(GLOBAL_OBJECTS));

/** Whether `node` is setTimeout or setInterval itself: a use of the name, or such a literal-key member of an expression naming a global object. */
function isTimerItself(node) {
  if (ts.isIdentifier(node)) return isUseOf(TIMER_NAMES)(node);
  const key = ts.isPropertyAccessExpression(node) ? node.name.text : ts.isElementAccessExpression(node) ? keyText(node.argumentExpression) : undefined;
  return TIMER_NAMES.has(key) && holdsGlobalObject(node.expression);
}
const holdsTimer = holding(isTimerItself);

/** Whether `node` names eval or Function: as any identifier, as a literal property, member, binding or specifier name, or as a literal element-access key or computed name. */
function namesDynamic(node) {
  if (ts.isIdentifier(node)) return DYNAMIC_NAMES.has(node.text);
  if (ts.isStringLiteralLike(node)) return DYNAMIC_NAMES.has(node.text) && (node.parent.name === node || node.parent.propertyName === node);
  const key = ts.isElementAccessExpression(node) ? node.argumentExpression : ts.isComputedPropertyName(node) ? node.expression : undefined;
  return key !== undefined && DYNAMIC_NAMES.has(keyText(key));
}

const isOpenKey = (name) => name !== undefined && (ts.isBigIntLiteral(name) || (ts.isComputedPropertyName(name) && keyText(name.expression) === undefined));
/** Whether a destructuring pattern, or one nested in it, takes a non-literal or BigInt key, a rest element or a spread. */
function hasOpenKey(target) {
  const node = ts.isBinaryExpression(target) && target.operatorToken.kind === ts.SyntaxKind.EqualsToken ? target.left : target;
  if (ts.isBindingElement(node)) return node.dotDotDotToken !== undefined || isOpenKey(node.propertyName) || hasOpenKey(node.name);
  if (ts.isPropertyAssignment(node)) return isOpenKey(node.name) || hasOpenKey(node.initializer);
  if (ts.isSpreadElement(node) || ts.isSpreadAssignment(node)) return true;
  const isList = ts.isObjectBindingPattern(node) || ts.isArrayBindingPattern(node) || ts.isArrayLiteralExpression(node);
  return (isList ? node.elements : ts.isObjectLiteralExpression(node) ? node.properties : []).some(hasOpenKey);
}

/** The pattern and its value at a destructuring: a declared or parameter pattern and its initializer (or `for…of` operand), the left and right of `=`, or a `for…of` target and operand. */
function destructuringAt(node) {
  if ((ts.isVariableDeclaration(node) || ts.isParameter(node)) && ts.isBindingPattern(node.name)) {
    const loop = node.parent.parent;
    return { pattern: node.name, value: node.initializer ?? (ts.isForOfStatement(loop) && loop.initializer === node.parent ? loop.expression : undefined) };
  }
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken) return { pattern: node.left, value: node.right };
  return ts.isForOfStatement(node) && !ts.isVariableDeclarationList(node.initializer) ? { pattern: node.initializer, value: node.expression } : undefined;
}

/** Whether `node` reads a key that cannot be judged from an expression naming a global object: a non-literal element-access key, or an open destructuring key (see `hasOpenKey`). */
function readsOpenKey(node) {
  if (ts.isElementAccessExpression(node)) return keyText(node.argumentExpression) === undefined && holdsGlobalObject(node.expression);
  const site = destructuringAt(node);
  return site !== undefined && hasOpenKey(site.pattern) && (holdsGlobalObject(site.pattern) || (site.value !== undefined && holdsGlobalObject(site.value)));
}

/** The first timer arguments that cannot be a string: a function, a name or a property access. */
const CODE_FREE_ARGUMENTS = [ts.isArrowFunction, ts.isFunctionExpression, ts.isIdentifier, ts.isPropertyAccessExpression];
/** The arguments that pass in a call whose callee only holds a timer (`.call`, `.apply`, `.bind`, a wrapper): the receiver, `this`, `null`, `undefined`, a global object, a number or a function. */
const isReceiverOrFunction = (argument) => {
  const node = unwrap(argument);
  return ts.isArrowFunction(node) || ts.isFunctionExpression(node) || ts.isNumericLiteral(node) || node.kind === ts.SyntaxKind.ThisKeyword || node.kind === ts.SyntaxKind.NullKeyword
    || (ts.isIdentifier(node) && (node.text === 'undefined' || GLOBAL_OBJECTS.has(node.text)));
};
/**
 * Whether `node` calls a timer with an argument that may be a string: a tagged template on an expression holding a timer; a call of the timer itself with a first argument that is
 * present and none of CODE_FREE_ARGUMENTS; or a call of an expression that only holds a timer, where the place of the code is unknown, with any argument but those of isReceiverOrFunction.
 */
function isStringTimerCall(node) {
  if (ts.isTaggedTemplateExpression(node)) return holdsTimer(node.tag);
  if (!ts.isCallExpression(node)) return false;
  const callee = unwrap(node.expression);
  if (isTimerItself(callee)) return node.arguments.length > 0 && !CODE_FREE_ARGUMENTS.some((isCodeFree) => isCodeFree(unwrap(node.arguments[0])));
  return holdsTimer(callee) && !node.arguments.every(isReceiverOrFunction);
}

/** Judges one unit, whose first line is line `firstLine` of its file: { lines, cause? }. */
function judge({ kind, text, firstLine = 1 }, maxLines) {
  const source = ts.createSourceFile(`unit.${kind}`, text, ts.ScriptTarget.Latest, true, SCRIPT_KINDS[kind]);
  if (source.parseDiagnostics.length > 0) return { lines: [], cause: 'eval-parse-error' };
  const lines = new Set();
  let openKey = false;
  const visit = (node) => {
    if (isErased(node)) return;
    if ((namesDynamic(node) || isStringTimerCall(node)) && lines.size < maxLines) lines.add(source.getLineAndCharacterOfPosition(node.getStart(source)).line + firstLine);
    openKey ||= readsOpenKey(node);
    ts.forEachChild(node, visit);
  };
  visit(source);
  return { lines: [...lines].sort((first, second) => first - second), ...(openKey ? { cause: 'eval-computed-member' } : {}) };
}

/*
 * The only HTML forms read, all matched with linear patterns: a trigger finds each `<script` or `on…=`, and a sticky pattern at that
 * spot must then match its exact form, else the whole file is unreadable. Entities are never decoded.
 */
const SCRIPT_TRIGGER = /<script/gi;
const SCRIPT_EXACT = /<script(?: type="(?:module|text\/javascript)"(?: src="[^"<>&]*")?| src="[^"<>&]*"(?: type="(?:module|text\/javascript)")?)?>([^<]*)<\/script>/yd;
const HANDLER_TRIGGER = /(?<![A-Za-z0-9])on[A-Za-z0-9]*\s*=/gi;
const HANDLER_EXACT = / on[a-z]+="([^"&]*)"/yd;
/* The reader does not track tags, so code that holds an `on…=` not written as a property (`this.onerror=null` is one) may be a tag's attribute it cannot see. */
const ATTRIBUTE_LIKE = /(?<![A-Za-z0-9.])on[A-Za-z0-9]*\s*=/i;
/* Inside `<svg>` the browser decodes character references in a script body, so a body read as text there may run other code. */
const FOREIGN_CONTENT = /<svg/i;

/** Matches the sticky `pattern` at `index` of `text`; null when there is no such position or no match there. */
function matchAt(pattern, text, index) {
  if (index < 0) return null;
  pattern.lastIndex = index;
  return pattern.exec(text);
}

/** The 1-based line of `position` in a text whose lines start at `lineStarts`. */
function lineOf(lineStarts, position) {
  let low = 0;
  let high = lineStarts.length - 1;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (lineStarts[middle] <= position) low = middle;
    else high = middle - 1;
  }
  return low + 1;
}

/** `text` with each of the ascending, disjoint ranges [start, end) blanked, so positions and the text around them stay as they were. */
function blanked(text, ranges) {
  let result = '';
  let copied = 0;
  for (const [start, end] of ranges) {
    result += `${text.slice(copied, start)}${' '.repeat(end - start)}`;
    copied = end;
  }
  return result + text.slice(copied);
}

/**
 * The code in an HTML file as JS units { kind, text, firstLine }: each non-blank script body, then each event-handler value as the
 * body of a function. Returns undefined when the file holds an `<svg`, when a `<script` or an `on…=` is not in an exact form, or when the two readings meet: an
 * accepted script body or handler value that holds an attribute-like `on…=`, or a handler value that overlaps a script body (either
 * could be a quoted attribute value in the browser's reading, hiding real code). An accepted script body is blanked before the
 * handler trigger runs, and the trigger resumes after each accepted handler value (code, so `this.onerror=null` in it is no attribute).
 */
function htmlUnitsOf(text) {
  if (FOREIGN_CONTENT.test(text)) return undefined;
  const lineStarts = ts.computeLineStarts(text);
  const units = [];
  const bodies = [];
  for (const { index } of text.matchAll(SCRIPT_TRIGGER)) {
    const script = matchAt(SCRIPT_EXACT, text, index);
    if (script === null || ATTRIBUTE_LIKE.test(script[1])) return undefined;
    const [bodyStart, bodyEnd] = script.indices[1];
    if (script[1].trim() !== '') units.push({ kind: 'js', text: script[1], firstLine: lineOf(lineStarts, bodyStart) });
    bodies.push([bodyStart, bodyEnd]);
  }
  const handlerText = blanked(text, bodies);
  HANDLER_TRIGGER.lastIndex = 0;
  let nextBody = 0;
  for (let found = HANDLER_TRIGGER.exec(handlerText); found !== null; found = HANDLER_TRIGGER.exec(handlerText)) {
    const handler = matchAt(HANDLER_EXACT, handlerText, found.index - 1);
    if (handler === null || ATTRIBUTE_LIKE.test(handler[1])) return undefined;
    const [valueStart, valueEnd] = handler.indices[1];
    while (nextBody < bodies.length && bodies[nextBody][1] <= valueStart) nextBody += 1;
    if (nextBody < bodies.length && bodies[nextBody][0] < valueEnd) return undefined;
    units.push({ kind: 'js', text: `(function () {${handler[1]}\n})`, firstLine: lineOf(lineStarts, valueStart) });
    HANDLER_TRIGGER.lastIndex = HANDLER_EXACT.lastIndex;
  }
  return units;
}

/** Judges an HTML file as `judge` does a unit: the lines of all its code units (at most `maxLines`) and the first cause among them. */
function judgeHtml({ text }, maxLines) {
  const units = htmlUnitsOf(text);
  if (units === undefined) return { lines: [], cause: 'eval-html-unreadable' };
  const results = units.map((unit) => judgeWithinStack(unit, maxLines));
  const cause = results.find((result) => result.cause !== undefined)?.cause;
  return { lines: [...new Set(results.flatMap(({ lines }) => lines))].sort((first, second) => first - second).slice(0, maxLines), ...(cause ? { cause } : {}) };
}

/** Judges one unit as `judge` does (an HTML file as `judgeHtml` does); a unit nested so deep that parsing or walking it overflows the stack is unscannable on its own (`eval-too-deep`). */
function judgeWithinStack(unit, maxLines) {
  try {
    return unit.kind === HTML_KIND ? judgeHtml(unit, maxLines) : judge(unit, maxLines);
  } catch (error) {
    if (error instanceof RangeError) return { lines: [], cause: 'eval-too-deep' };
    throw error;
  }
}

try {
  const { units, maxLines } = JSON.parse(readFileSync(0, 'utf8'));
  if (!Array.isArray(units) || !Number.isSafeInteger(maxLines) || maxLines < 1 || units.some(({ kind, text }) => !(Object.hasOwn(SCRIPT_KINDS, kind) || kind === HTML_KIND) || typeof text !== 'string')) throw new Error('unexpected input');
  process.stdout.write(JSON.stringify({ results: units.map((unit) => judgeWithinStack(unit, maxLines)) }));
} catch {
  process.exitCode = 2;
  await writeDiagnostic('eval-parser-failed', 'rules-eval-child.stderr');
}
