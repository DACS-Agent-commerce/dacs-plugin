import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { writeDiagnostic } from './redact.mjs';

/**
 * The eval rule's parser, run as a child process by rules-eval.mjs. It reads `{ units: [{ kind, text }], maxLines }` from
 * stdin, parses each unit with the TypeScript compiler (parsing only; nothing is run), and writes `{ results: [{ lines,
 * cause? }] }` to stdout: for each unit the distinct 1-based lines of dynamic evaluation (at most `maxLines`) and, when
 * the unit cannot be judged, one cause. No text, name or path leaves this process; a failure leaves a fixed text on stderr.
 * The rules are syntactic and closed: no value is tracked, so a form they do not name is no finding.
 */

const SCRIPT_KINDS = { js: ts.ScriptKind.JS, jsx: ts.ScriptKind.JSX, ts: ts.ScriptKind.TS, tsx: ts.ScriptKind.TSX };
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

/** A test, kept per node, of whether a node holds anywhere in it, outside erased nodes, a use of one of `names`. */
function usesOf(names) {
  const held = new WeakMap();
  const holds = (node) => {
    if (!held.has(node)) held.set(node, !isErased(node) && ((ts.isIdentifier(node) && names.has(node.text) && isUse(node)) || ts.forEachChild(node, (child) => holds(child) || undefined) === true));
    return held.get(node);
  };
  return holds;
}
const holdsGlobalObject = usesOf(GLOBAL_OBJECTS);
const holdsTimer = usesOf(TIMER_NAMES);

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

/** Whether `callee` is a timer: an expression holding a use of setTimeout or setInterval, or such a literal-key member of an expression naming a global object. */
function isTimer(callee) {
  const node = unwrap(callee);
  if (holdsTimer(node)) return true;
  const key = ts.isPropertyAccessExpression(node) ? node.name.text : ts.isElementAccessExpression(node) ? keyText(node.argumentExpression) : undefined;
  return TIMER_NAMES.has(key) && holdsGlobalObject(node.expression);
}

/** The first timer arguments that cannot be a string: a function, a name or a property access. */
const CODE_FREE_ARGUMENTS = [ts.isArrowFunction, ts.isFunctionExpression, ts.isIdentifier, ts.isPropertyAccessExpression];
/** Whether `node` calls a timer with a first argument that may be a string: a tagged template, or any present argument but those above. */
function isStringTimerCall(node) {
  if (ts.isTaggedTemplateExpression(node)) return isTimer(node.tag);
  if (!ts.isCallExpression(node) || !isTimer(node.expression) || node.arguments.length === 0) return false;
  return !CODE_FREE_ARGUMENTS.some((isCodeFree) => isCodeFree(unwrap(node.arguments[0])));
}

/** Judges one unit: { lines, cause? }. */
function judge({ kind, text }, maxLines) {
  const source = ts.createSourceFile(`unit.${kind}`, text, ts.ScriptTarget.Latest, true, SCRIPT_KINDS[kind]);
  if (source.parseDiagnostics.length > 0) return { lines: [], cause: 'eval-parse-error' };
  const lines = new Set();
  let openKey = false;
  const visit = (node) => {
    if (isErased(node)) return;
    if ((namesDynamic(node) || isStringTimerCall(node)) && lines.size < maxLines) lines.add(source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1);
    openKey ||= readsOpenKey(node);
    ts.forEachChild(node, visit);
  };
  visit(source);
  return { lines: [...lines].sort((first, second) => first - second), ...(openKey ? { cause: 'eval-computed-member' } : {}) };
}

/** Judges one unit as `judge` does; a unit nested so deep that parsing or walking it overflows the stack is unscannable on its own (`eval-too-deep`). */
function judgeWithinStack(unit, maxLines) {
  try {
    return judge(unit, maxLines);
  } catch (error) {
    if (error instanceof RangeError) return { lines: [], cause: 'eval-too-deep' };
    throw error;
  }
}

try {
  const { units, maxLines } = JSON.parse(readFileSync(0, 'utf8'));
  if (!Array.isArray(units) || !Number.isSafeInteger(maxLines) || maxLines < 1 || units.some(({ kind, text }) => !Object.hasOwn(SCRIPT_KINDS, kind) || typeof text !== 'string')) throw new Error('unexpected input');
  process.stdout.write(JSON.stringify({ results: units.map((unit) => judgeWithinStack(unit, maxLines)) }));
} catch {
  process.exitCode = 2;
  await writeDiagnostic('eval-parser-failed', 'rules-eval-child.stderr');
}
