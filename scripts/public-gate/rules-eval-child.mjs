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

const keyOf = (name) => (ts.isComputedPropertyName(name) ? literalKey(name.expression) : ts.isBigIntLiteral(name) ? undefined : name.text);
const LOGICAL = new Set(['BarBar', 'AmpersandAmpersand', 'QuestionQuestion'].flatMap((name) => [ts.SyntaxKind[`${name}Token`], ts.SyntaxKind[`${name}EqualsToken`]]));

/** The expressions a value can come from: both branches of a conditional, both operands of a logical operator, the right of `=`, else the expression itself. */
function valuesOf(expression) {
  const node = unwrap(expression);
  if (ts.isConditionalExpression(node)) return [...valuesOf(node.whenTrue), ...valuesOf(node.whenFalse)];
  const kind = ts.isBinaryExpression(node) && node.operatorToken.kind;
  if (LOGICAL.has(kind)) return [...valuesOf(node.left), ...valuesOf(node.right)];
  return kind === ts.SyntaxKind.EqualsToken ? valuesOf(node.right) : [node];
}
const isGlobalObject = (expression) => valuesOf(expression).some((node) => {
  if (ts.isIdentifier(node)) return GLOBAL_OBJECTS.has(node.text);
  if (ts.isPropertyAccessExpression(node)) return isGlobalObject(node.expression) && GLOBAL_OBJECTS.has(node.name.text);
  return ts.isElementAccessExpression(node) && isGlobalObject(node.expression) && GLOBAL_OBJECTS.has(literalKey(node.argumentExpression));
});
const INDEX = /^\d+$/;
const INDEXES = new WeakMap();
/** The position of `element` in its array literal or array pattern `container`; one pass indexes all of them. */
const indexIn = (container, element) => INDEXES.get(element) ?? (container.elements.forEach((item, index) => INDEXES.set(item, index)), INDEXES.get(element));

/** Whether the value `path` deep in `expression` is a global object. A step is a property key or array index as text, or null for any element; an array is no global object. */
function globalAt(expression, path) {
  const [step, ...rest] = path;
  return valuesOf(expression).some((node) => {
    if (isGlobalObject(node)) return path.every((key) => GLOBAL_OBJECTS.has(key));
    if (step === undefined || (step !== null && ts.isArrayLiteralExpression(node) && !INDEX.test(step))) return false;
    if (ts.isArrayLiteralExpression(node)) {
      const spreadAt = node.elements.findIndex(ts.isSpreadElement);
      return node.elements.some((element, index) => (ts.isSpreadElement(element) ? globalAt(element.expression, [null, ...rest])
        : (step === null || String(index) === step || (spreadAt >= 0 && index > spreadAt)) && globalAt(element, rest)));
    }
    return ts.isObjectLiteralExpression(node) && node.properties.some((property) => {
      if (ts.isSpreadAssignment(property)) return globalAt(property.expression, path);
      const value = ts.isPropertyAssignment(property) ? property.initializer : ts.isShorthandPropertyAssignment(property) ? property.name : undefined;
      return value !== undefined && (step === null || [step, undefined].includes(keyOf(property.name))) && globalAt(value, rest);
    });
  });
}

/** Whether a binding pattern or assignment target receives a global object from the value written beside it (see `globalAt`), `path` deep: an initializer or default, the right of `=`, the `of` operand, or an enclosing pattern's, reached through the key or index the target has in it (a rest element holds the array from its index on). */
function receivesGlobal(target, path = []) {
  const { parent } = target;
  const indexed = (container, index, isRest) => receivesGlobal(container, isRest ? [path[0] === null ? null : String(index + Number(path[0])), ...path.slice(1)] : [String(index), ...path]);
  if (ts.isVariableDeclaration(parent) || ts.isParameter(parent)) return parent.name === target && (parent.initializer ? globalAt(parent.initializer, path) : ts.isVariableDeclaration(parent) && receivesGlobal(parent.parent, path));
  if (ts.isBinaryExpression(parent)) return parent.operatorToken.kind === ts.SyntaxKind.EqualsToken && parent.left === target && (globalAt(parent.right, path) || receivesGlobal(parent, path));
  if (ts.isForOfStatement(parent)) return parent.initializer === target && globalAt(parent.expression, [null, ...path]);
  if (ts.isPropertyAssignment(parent)) return parent.initializer === target && receivesGlobal(parent.parent, [keyOf(parent.name) ?? null, ...path]);
  if (ts.isArrayLiteralExpression(parent)) return indexed(parent, indexIn(parent, target), false);
  if (ts.isSpreadElement(parent) && ts.isArrayLiteralExpression(parent.parent)) return indexed(parent.parent, indexIn(parent.parent, parent), true);
  if (!ts.isBindingElement(parent) || parent.name !== target) return false;
  const container = parent.parent;
  return (parent.initializer !== undefined && globalAt(parent.initializer, path))
    || (ts.isArrayBindingPattern(container) ? indexed(container, indexIn(container, parent), parent.dotDotDotToken !== undefined) : receivesGlobal(container, [(parent.propertyName && keyOf(parent.propertyName)) ?? null, ...path]));
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

const isStringArgument = (argument) => argument !== undefined && valuesOf(argument).some((node) => ts.isStringLiteralLike(node) || ts.isTemplateExpression(node)
  || (ts.isBinaryExpression(node) && (node.operatorToken.kind === ts.SyntaxKind.PlusToken || node.operatorToken.kind === ts.SyntaxKind.PlusEqualsToken) && (isStringArgument(node.left) || isStringArgument(node.right))));

/** The names of the globals a callee can reach, each written plainly or as a member of a global object with a literal key (undefined for any other form). */
const globalNamesOf = (callee) => valuesOf(callee).map((node) => {
  if (ts.isIdentifier(node)) return node.text;
  if (ts.isPropertyAccessExpression(node) && isGlobalObject(node.expression)) return node.name.text;
  return ts.isElementAccessExpression(node) && isGlobalObject(node.expression) ? literalKey(node.argumentExpression) : undefined;
});

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
      const name = key && keyOf(key);
      if (member.dotDotDotToken || ts.isSpreadAssignment(member) || name === undefined) computedMember = true;
      else if (DYNAMIC_NAMES.has(name)) flag(member);
    }
  };
  const visit = (node) => {
    // Types, interfaces, `implements` clauses and `declare` variable, function, class, enum and namespace statements are erased: nothing in them runs. A class `extends` clause does,
    // and so do a `declare` export assignment, import alias or class field, which the emitter keeps.
    if ((ts.isTypeNode(node) && !ts.isExpressionWithTypeArguments(node)) || ts.isInterfaceDeclaration(node)
      || (ts.isHeritageClause(node) && node.token === ts.SyntaxKind.ImplementsKeyword) || isDroppedDeclaration(node)) return;
    if (ts.isIdentifier(node)) {
      if (DYNAMIC_NAMES.has(node.text) && isUse(node)) flag(node);
    } else if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
      checkMember(node);
    } else if ((ts.isObjectBindingPattern(node) || ts.isObjectLiteralExpression(node)) && receivesGlobal(node)) {
      checkPattern(node);
    } else if (ts.isCallExpression(node) && globalNamesOf(node.expression).some((name) => TIMER_NAMES.has(name)) && isStringArgument(node.arguments[0])) {
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
