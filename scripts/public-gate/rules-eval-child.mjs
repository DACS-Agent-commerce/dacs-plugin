import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { writeDiagnostic } from './redact.mjs';

/**
 * The eval rule's parser, run as a child process by rules-eval.mjs. It reads `{ units: [{ kind, text }], maxLines }` from
 * stdin (a kind is js, jsx, ts, tsx or html, a whole HTML file), parses each unit with the TypeScript compiler (parsing only;
 * nothing is run), and writes `{ results: [{ lines, cause? }] }` to stdout: for each unit the distinct 1-based lines of dynamic
 * evaluation (at most `maxLines`) and, when the unit cannot be judged, one cause. No text, name or path leaves this process; a failure leaves a fixed text on stderr.
 */

const SCRIPT_KINDS = { js: ts.ScriptKind.JS, jsx: ts.ScriptKind.JSX, ts: ts.ScriptKind.TS, tsx: ts.ScriptKind.TSX };
/** The kind of a unit that is a whole HTML file, from which the child itself takes the code. */
const HTML_KIND = 'html';
/** The global functions whose use evaluates code. */
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

/** The text of a string or number literal key, else undefined. */
function literalKey(node) {
  const key = unwrap(node);
  return ts.isStringLiteralLike(key) || ts.isNumericLiteral(key) ? key.text : undefined;
}

const isGlobalObject = (expression) => {
  const node = unwrap(expression);
  if (ts.isIdentifier(node)) return GLOBAL_OBJECTS.has(node.text);
  if (ts.isPropertyAccessExpression(node)) return isGlobalObject(node.expression) && GLOBAL_OBJECTS.has(node.name.text);
  return ts.isElementAccessExpression(node) && isGlobalObject(node.expression) && GLOBAL_OBJECTS.has(literalKey(node.argumentExpression));
};

const holdsGlobal = (expression) => {
  const node = unwrap(expression);
  if (ts.isArrayLiteralExpression(node)) return node.elements.some((element) => holdsGlobal(ts.isSpreadElement(element) ? element.expression : element));
  if (ts.isConditionalExpression(node)) return holdsGlobal(node.whenTrue) || holdsGlobal(node.whenFalse);
  return isGlobalObject(node) || (ts.isBinaryExpression(node) && [ts.SyntaxKind.BarBarToken, ts.SyntaxKind.AmpersandAmpersandToken, ts.SyntaxKind.QuestionQuestionToken].includes(node.operatorToken.kind) && (holdsGlobal(node.left) || holdsGlobal(node.right)));
};

/** Whether a binding pattern or assignment target takes its values from a global object (or an array or conditional holding one, see `holdsGlobal`) written beside it: an initializer or default, the right of `=`, the `of` operand, or an enclosing pattern's. */
function takesFromGlobal(target) {
  const { parent } = target;
  if (ts.isVariableDeclaration(parent) || ts.isParameter(parent)) return parent.name === target && (parent.initializer ? holdsGlobal(parent.initializer) : takesFromGlobal(parent.parent));
  if (ts.isBinaryExpression(parent)) return parent.operatorToken.kind === ts.SyntaxKind.EqualsToken && parent.left === target && holdsGlobal(parent.right);
  if (ts.isForOfStatement(parent)) return parent.initializer === target && holdsGlobal(parent.expression);
  if (ts.isBindingElement(parent)) return (parent.initializer !== undefined && holdsGlobal(parent.initializer)) || takesFromGlobal(parent.parent);
  return ts.isPropertyAssignment(parent) ? takesFromGlobal(parent.parent) : ts.isArrayLiteralExpression(parent) && takesFromGlobal(parent);
}

/** A name this identifier declares or labels, or a property it names, is no use of the global of that name. */
function isUse(identifier) {
  const { parent } = identifier;
  const isName = parent.name === identifier && !ts.isShorthandPropertyAssignment(parent);
  const isLabel = (ts.isLabeledStatement(parent) || ts.isBreakOrContinueStatement(parent)) && parent.label === identifier;
  return !isName && !isLabel && parent.propertyName !== identifier;
}

const isStringArgument = (argument) => {
  const node = argument && unwrap(argument);
  if (!node) return false;
  if (ts.isStringLiteralLike(node) || ts.isTemplateExpression(node)) return true;
  return ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken && (isStringArgument(node.left) || isStringArgument(node.right));
};

/** The name of the global a callee reaches, written plainly or as a member of a global object with a literal key; else undefined. */
function globalNameOf(callee) {
  const node = unwrap(callee);
  if (ts.isIdentifier(node)) return node.text;
  if (ts.isPropertyAccessExpression(node) && isGlobalObject(node.expression)) return node.name.text;
  return ts.isElementAccessExpression(node) && isGlobalObject(node.expression) ? literalKey(node.argumentExpression) : undefined;
}

/** Judges one unit, whose first line is line `firstLine` of its file: { lines, cause? }. */
function judge({ kind, text, firstLine = 1 }, maxLines) {
  const source = ts.createSourceFile(`unit.${kind}`, text, ts.ScriptTarget.Latest, true, SCRIPT_KINDS[kind]);
  if (source.parseDiagnostics.length > 0) return { lines: [], cause: 'eval-parse-error' };
  const lines = new Set();
  let computedMember = false;
  const flag = (node) => {
    if (lines.size < maxLines) lines.add(source.getLineAndCharacterOfPosition(node.getStart(source)).line + firstLine);
  };
  const checkMember = (node) => {
    if (!isGlobalObject(node.expression)) return;
    const key = ts.isPropertyAccessExpression(node) ? node.name.text : literalKey(node.argumentExpression);
    if (key === undefined) computedMember = true;
    else if (DYNAMIC_NAMES.has(key)) flag(node);
  };
  const checkPattern = (pattern) => {
    for (const member of ts.isObjectBindingPattern(pattern) ? pattern.elements : pattern.properties) {
      const key = member.propertyName ?? member.name;
      const name = key && ts.isComputedPropertyName(key) ? literalKey(key.expression) : key?.text;
      if (member.dotDotDotToken || ts.isSpreadAssignment(member) || name === undefined) computedMember = true;
      else if (DYNAMIC_NAMES.has(name)) flag(member);
    }
  };
  const visit = (node) => {
    if (ts.isTypeNode(node) && !ts.isExpressionWithTypeArguments(node)) return;
    if (ts.isIdentifier(node)) {
      if (DYNAMIC_NAMES.has(node.text) && isUse(node)) flag(node);
    } else if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
      checkMember(node);
    } else if ((ts.isObjectBindingPattern(node) || ts.isObjectLiteralExpression(node)) && takesFromGlobal(node)) {
      checkPattern(node);
    } else if (ts.isCallExpression(node) && TIMER_NAMES.has(globalNameOf(node.expression)) && isStringArgument(node.arguments[0])) {
      flag(node);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return { lines: [...lines].sort((first, second) => first - second), ...(computedMember ? { cause: 'eval-computed-member' } : {}) };
}

/*
 * The only HTML forms read, all matched with linear patterns: a trigger finds each `<script` or `on…=`, and a sticky pattern at that
 * spot must then match its exact form, else the whole file is unreadable. Entities are never decoded.
 */
const SCRIPT_TRIGGER = /<script/gi;
const SCRIPT_EXACT = /<script(?: type="module"| type="text\/javascript"| src="[^"<>&]*")*>([^<]*)<\/script>/yd;
const HANDLER_TRIGGER = /(?<![A-Za-z0-9])on[A-Za-z0-9]*\s*=/gi;
const HANDLER_EXACT = / on[a-z]+="([^"&]*)"/yd;
/* The reader does not track tags, so code that holds an `on…=` not written as a property (`this.onerror=null` is one) may be a tag's attribute it cannot see. */
const ATTRIBUTE_LIKE = /(?<![A-Za-z0-9.])on[A-Za-z0-9]*\s*=/i;

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
 * body of a function. Returns undefined when a `<script` or an `on…=` is not in an exact form, or when the two readings meet: an
 * accepted script body or handler value that holds an attribute-like `on…=`, or a handler value that overlaps a script body (either
 * could be a quoted attribute value in the browser's reading, hiding real code). An accepted script body is blanked before the
 * handler trigger runs, and the trigger resumes after each accepted handler value (code, so `this.onerror=null` in it is no attribute).
 */
function htmlUnitsOf(text) {
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
