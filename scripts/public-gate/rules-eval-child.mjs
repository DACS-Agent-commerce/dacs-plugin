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

/** Judges one unit: { lines, cause? }. */
function judge({ kind, text }, maxLines) {
  const source = ts.createSourceFile(`unit.${kind}`, text, ts.ScriptTarget.Latest, true, SCRIPT_KINDS[kind]);
  if (source.parseDiagnostics.length > 0) return { lines: [], cause: 'eval-parse-error' };
  const lines = new Set();
  let computedMember = false;
  const flag = (node) => {
    if (lines.size < maxLines) lines.add(source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1);
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
    // Types, interfaces, `implements` clauses and ambient (`declare`) declarations are erased: nothing in them runs. A class `extends` clause does.
    if ((ts.isTypeNode(node) && !ts.isExpressionWithTypeArguments(node)) || ts.isInterfaceDeclaration(node)
      || (ts.isHeritageClause(node) && node.token === ts.SyntaxKind.ImplementsKeyword) || (node.flags & ts.NodeFlags.Ambient) !== 0) return;
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
