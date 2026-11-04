import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { writeDiagnostic } from './redact.mjs';

/**
 * The eval rule's parser, run as a child process by rules-eval.mjs. It reads `{ units: [{ kind, text }], maxLines }` from
 * stdin, parses each unit with the TypeScript compiler (parsing only; nothing is run), and writes `{ results: [{ lines,
 * cause? }] }` to stdout: for each unit the distinct 1-based lines of dynamic evaluation (at most `maxLines`) and, when
 * the unit cannot be judged, one cause. No text, name or path leaves this process; a failure leaves a fixed text on stderr.
 */

const SCRIPT_KINDS = { js: ts.ScriptKind.JS, jsx: ts.ScriptKind.JSX, ts: ts.ScriptKind.TS, tsx: ts.ScriptKind.TSX };
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

/** Judges one unit: { lines, cause? }. */
function judge({ kind, text }, maxLines) {
  const source = ts.createSourceFile(`unit.${kind}`, text, ts.ScriptTarget.Latest, true, SCRIPT_KINDS[kind]);
  if (source.parseDiagnostics.length > 0) return { lines: [], cause: 'eval-parse-error' };
  const lines = new Set();
  let computedMember = false;
  const flag = (node) => {
    if (lines.size <= maxLines) lines.add(source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1);
  };
  const checkMember = (node) => {
    if (!isGlobalObject(node.expression)) return;
    const key = ts.isPropertyAccessExpression(node) ? node.name.text : literalKey(node.argumentExpression);
    if (key === undefined) computedMember = true;
    else if (DYNAMIC_NAMES.has(key)) flag(node);
  };
  const checkBinding = (element) => {
    const declaration = element.parent.parent;
    const key = element.propertyName ?? element.name;
    if (ts.isVariableDeclaration(declaration) && declaration.initializer && isGlobalObject(declaration.initializer) && (ts.isIdentifier(key) || ts.isStringLiteralLike(key)) && DYNAMIC_NAMES.has(key.text)) flag(element);
  };
  const visit = (node) => {
    if (ts.isTypeNode(node) && !ts.isExpressionWithTypeArguments(node)) return;
    if (ts.isIdentifier(node)) {
      if (DYNAMIC_NAMES.has(node.text) && isUse(node)) flag(node);
    } else if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
      checkMember(node);
    } else if (ts.isBindingElement(node) && ts.isObjectBindingPattern(node.parent)) {
      checkBinding(node);
    } else if (ts.isCallExpression(node) && TIMER_NAMES.has(globalNameOf(node.expression)) && isStringArgument(node.arguments[0])) {
      flag(node);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return { lines: [...lines].sort((first, second) => first - second), ...(computedMember ? { cause: 'eval-computed-member' } : {}) };
}

try {
  const { units, maxLines } = JSON.parse(readFileSync(0, 'utf8'));
  if (!Array.isArray(units) || !Number.isSafeInteger(maxLines) || maxLines < 1 || units.some(({ kind, text }) => !Object.hasOwn(SCRIPT_KINDS, kind) || typeof text !== 'string')) throw new Error('unexpected input');
  process.stdout.write(JSON.stringify({ results: units.map((unit) => judge(unit, maxLines)) }));
} catch {
  process.exitCode = 2;
  await writeDiagnostic('eval-parser-failed', 'rules-eval-child.stderr');
}
