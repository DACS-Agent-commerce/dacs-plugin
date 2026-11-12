// Per-file scanner for the purchase-path checker. Static only: it parses source
// text and never imports or executes the modules it scans.
//
// createModuleScanner(context) returns scan(file). Everything it reads comes from
// the context; there is no module-level state:
//   ts            the TypeScript compiler module (parser)
//   config        {primitives, forbiddenDirs?, registrationCalls?}
//   resolve       (spec, importer, mode) => {kind: 'builtin'|'local'|'package', file?, spec?, name?} | null
//   exportOrigin  (file, name) => 'package' | other; optional, every export specifier is checked without it
//   rel           absolute path => project-relative path used in reports
//   report        sinks {violation(row), unverifiable(row), waiver(row), edge(row)}
//   modules       Map of file => scan result, shared across calls (memo and cycle guard)
// A local import is scanned through the same context, so one scan reaches its local graph.
import fs from 'node:fs';

export function createModuleScanner(context) {
  const {ts, config, resolve, rel, report, modules} = context ?? {};
  const exportOrigin = context?.exportOrigin ?? (() => 'unknown');
  if (!ts || typeof resolve !== 'function' || typeof rel !== 'function' || !(modules instanceof Map) || !Array.isArray(config?.primitives)
    || !['violation', 'unverifiable', 'waiver', 'edge'].every(k => typeof report?.[k] === 'function')) throw new Error('invalid scanner context');
  const flag = (sink, rule, file, line = 0, detail = '') => report[sink]({rule, file: rel(file), line, detail});
  // A computed-key write is only an export or definition risk when it targets an export object
  // or assigns a function/class under a name the primitive matcher cannot see. Ordinary data
  // writes (f.days[day] = ..., out[k] = v) are not export surfaces.
  // Parentheses and type-only wrappers (as, !, <T>, satisfies) never change the value.
  const wrapper = x => ts.isParenthesizedExpression(x) || ts.isAsExpression(x) || ts.isNonNullExpression(x) || ts.isTypeAssertionExpression(x) || ts.isSatisfiesExpression(x);
  const unparen = x => { while (x && wrapper(x)) x = x.expression; return x; };
  // The outermost wrapper around x, the node whose parent actually uses the value.
  const outerOf = x => { while (x.parent && wrapper(x.parent)) x = x.parent; return x; };
  const computedKey = e => !ts.isStringLiteralLike(e.argumentExpression) && !ts.isNumericLiteral(e.argumentExpression);
  const isAssignment = p => ts.isBinaryExpression(p) && p.operatorToken.kind >= ts.SyntaxKind.FirstAssignment && p.operatorToken.kind <= ts.SyntaxKind.LastAssignment;
  // Operators whose result can be one of their own operands; any other binary operator makes a new value.
  const operandPassingOperators = [ts.SyntaxKind.BarBarToken, ts.SyntaxKind.AmpersandAmpersandToken, ts.SyntaxKind.QuestionQuestionToken, ts.SyntaxKind.CommaToken];
  const memberName = p => ts.isPropertyAccessExpression(p) ? p.name.text : ts.isStringLiteralLike(p.argumentExpression) ? p.argumentExpression.text : '';
  // ||=, &&= and ??= give back the old value when they keep it, so their result carries the left read on.
  const logicalAssignmentOperators = [ts.SyntaxKind.BarBarEqualsToken, ts.SyntaxKind.AmpersandAmpersandEqualsToken, ts.SyntaxKind.QuestionQuestionEqualsToken];
  const resultDiscarded = a => ts.isExpressionStatement(outerOf(a).parent);
  // True when the value of the expression o is only inspected, assigned over or discarded, so it cannot
  // be handed on as a callable. A member read is data unless it picks call/apply/bind off the value, or
  // unless anyMemberRead is set: the global object's members include eval, Function and process, and
  // every member of those leads on (eval.constructor is Function). A template substitution is text
  // unless the template is tagged, which hands the value to the tag.
  const usedAsData = (o, anyMemberRead = false) => {
    const p = o.parent;
    if ((ts.isPropertyAccessExpression(p) || ts.isElementAccessExpression(p)) && p.expression === o) return !anyMemberRead && !['call', 'apply', 'bind'].includes(memberName(p));
    if (ts.isBinaryExpression(p)) {
      if (!isAssignment(p)) return !operandPassingOperators.includes(p.operatorToken.kind);
      return p.left === o && (!logicalAssignmentOperators.includes(p.operatorToken.kind) || resultDiscarded(p));
    }
    if (ts.isConditionalExpression(p)) return p.condition === o;
    if (ts.isTemplateSpan(p)) return !ts.isTaggedTemplateExpression(p.parent.parent);
    return ts.isElementAccessExpression(p) || ts.isPrefixUnaryExpression(p) || ts.isPostfixUnaryExpression(p) || ts.isTypeOfExpression(p) || ts.isVoidExpression(p)
      || ts.isDeleteExpression(p) || ts.isIfStatement(p) || ts.isWhileStatement(p) || ts.isDoStatement(p);
  };
  const calledDirectly = o => ts.isCallExpression(o.parent) && o.parent.expression === o;
  // x[k] with a key the scanner cannot read, whose value can be a function: bound, passed, returned,
  // listed, constructed or combined. A direct call x[k]() is reported by the call rule instead.
  const computedCallableRead = n => ts.isElementAccessExpression(n) && computedKey(n) && !usedAsData(outerOf(n)) && !calledDirectly(outerOf(n));
  const exportTarget = x => { x = unparen(x); return (ts.isIdentifier(x) && ['exports', 'globalThis', 'global', 'self', 'window'].includes(x.text)) || (ts.isPropertyAccessExpression(x) && ts.isIdentifier(x.expression) && x.expression.text === 'module' && x.name.text === 'exports'); };
  const globalObject = x => { x = unparen(x); return ts.isIdentifier(x) && ['globalThis', 'global', 'self', 'window'].includes(x.text); };
  // eval/Function count wherever they are read as a value (bare, aliased, comma, or as a
  // member of the global object), not only when called by their bare name. A key the scanner cannot
  // read (globalThis[key]) can name them too, so any read of the global object through one counts.
  const reflectiveRead = n => {
    if (ts.isElementAccessExpression(n)) return globalObject(n.expression) && (ts.isStringLiteralLike(n.argumentExpression) ? ['eval', 'Function'].includes(n.argumentExpression.text) : computedKey(n) && !usedAsData(outerOf(n), true));
    if (!ts.isIdentifier(n) || !['eval', 'Function'].includes(n.text)) return false;
    const p = n.parent;
    if (ts.isPropertyAccessExpression(p) && p.name === n) return globalObject(p.expression);
    if (ts.isTypeOfExpression(p) || (ts.isBinaryExpression(p) && p.operatorToken.kind === ts.SyntaxKind.InstanceOfKeyword && p.right === n)) return false;
    if ((ts.isPropertyAssignment(p) || ts.isMethodDeclaration(p) || ts.isPropertyDeclaration(p) || ts.isPropertySignature(p) || ts.isMethodSignature(p)) && p.name === n) return false;
    for (let a = p; a; a = a.parent) { if (ts.isTypeNode(a) || ts.isInterfaceDeclaration(a) || ts.isTypeAliasDeclaration(a)) return false; if (ts.isFunctionLike(a) || ts.isSourceFile(a)) break; }
    return true;
  };
  const computedDefinitionRisk = n => { const r = unparen(n.right); return exportTarget(n.left.expression) || ts.isFunctionLike(r) || ts.isClassExpression(r); };

  return function scan(file) {
    if (modules.has(file)) return modules.get(file);
    const result = {file: rel(file), imports: [], registrations: [], waivedReadback: new Map()}; modules.set(file, result);
    if (['src/dacs/', ...(config.forbiddenDirs ?? [])].some(d => result.file.startsWith(d))) flag('violation', 'local-dacs-module', file);
    if (file.endsWith('.json')) { try { JSON.parse(fs.readFileSync(file, 'utf8')); } catch { flag('unverifiable', 'unreadable-json', file); } return result; }
    if (!/\.(?:[mc]?[jt]s|[jt]sx)$/.test(file)) { flag('unverifiable', 'unsupported-module-kind', file); return result; }
    let text; try { text = fs.readFileSync(file, 'utf8'); } catch { flag('unverifiable', 'unreadable-module', file); return result; }
    const ast = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
    if (ast.parseDiagnostics.length) flag('unverifiable', 'parse-error', file);
    const lineOf = n => ast.getLineAndCharacterOfPosition(n.getStart(ast)).line + 1;
    const commentWaivers = [], comments = new Map();
    const collectComments = n => {
      for (const range of [...(ts.getLeadingCommentRanges(text, n.getFullStart()) ?? []), ...(ts.getTrailingCommentRanges(text, n.end) ?? [])]) comments.set(range.pos, range);
      ts.forEachChild(n, collectComments);
    }; collectComments(ast);
    for (const range of comments.values()) if (range.kind === ts.SyntaxKind.SingleLineCommentTrivia) {
      const m = text.slice(range.pos, range.end).match(/^\/\/\s*thin-plugin-waiver primitive:([\w-]+)(?:\s+--\s*(.*))?$/);
      if (m) commentWaivers.push({primitive: m[1], line: ast.getLineAndCharacterOfPosition(range.pos).line + 1, reason: (m[2] ?? '').trim(), used: false});
    }
    // Reference-tracked calls (primitive `references`, e.g. getTxByHash): any member
    // reference (x.m, x?.m, x['m']), destructured property, bare use, lexical alias
    // (const f = x.m; const {m: f} = x) or call of a waived same-module/imported
    // readback function counts as the call, so an alias cannot hide it.
    const refRules = config.primitives.filter(r => Array.isArray(r.references) && r.references.length);
    const refNames = new Set(refRules.flatMap(r => r.references));
    // A module whose readback waivers are not settled yet (an import cycle) cannot vouch for them.
    result.readbackWaivers = commentWaivers.some(w => refRules.some(r => r.id === w.primitive));
    const aliasOf = new Map(), namespaceOf = new Map(), waivedMethods = new Map(), checkedTargets = new Set(), refNodes = [];
    const inType = n => { for (let a = n.parent; a; a = a.parent) { if (ts.isTypeNode(a) || ts.isInterfaceDeclaration(a) || ts.isTypeAliasDeclaration(a)) return true; if (ts.isFunctionLike(a) || ts.isSourceFile(a)) return false; } return false; };
    const ambient = n => ast.isDeclarationFile || (() => { for (let a = n; a; a = a.parent) if (ts.canHaveModifiers(a) && ts.getModifiers(a)?.some(m => m.kind === ts.SyntaxKind.DeclareKeyword)) return true; return false; })();
    const bindingNames = (name, out = []) => { if (ts.isIdentifier(name)) out.push(name); else for (const e of name.elements ?? []) if (!ts.isOmittedExpression(e)) bindingNames(e.name, out); return out; };
    const declaredIn = (scope, text) => {
      const ids = [];
      if (ts.isFunctionLike(scope)) { for (const p of scope.parameters ?? []) bindingNames(p.name, ids); if (ts.isFunctionExpression(scope) && scope.name) ids.push(scope.name); }
      if (ts.isCatchClause(scope) && scope.variableDeclaration) bindingNames(scope.variableDeclaration.name, ids);
      if ((ts.isForStatement(scope) || ts.isForOfStatement(scope) || ts.isForInStatement(scope)) && scope.initializer && ts.isVariableDeclarationList(scope.initializer)) for (const d of scope.initializer.declarations) bindingNames(d.name, ids);
      if (ts.isBlock(scope) || ts.isSourceFile(scope) || ts.isModuleBlock(scope)) for (const s of scope.statements) {
        if (ts.isVariableStatement(s)) for (const d of s.declarationList.declarations) bindingNames(d.name, ids);
        else if ((ts.isFunctionDeclaration(s) || ts.isClassDeclaration(s)) && s.name) ids.push(s.name);
        else if (ts.isImportEqualsDeclaration(s)) ids.push(s.name);
        else if (ts.isImportDeclaration(s) && s.importClause) { const c = s.importClause; if (c.name) ids.push(c.name); if (c.namedBindings) { if (ts.isNamespaceImport(c.namedBindings)) ids.push(c.namedBindings.name); else for (const e of c.namedBindings.elements) ids.push(e.name); } }
      }
      return ids.find(i => i.text === text) ?? null;
    };
    const inModuleStatement = n => { let d = n; while (d && !ts.isVariableDeclaration(d)) d = d.parent; return !!d && ts.isVariableDeclarationList(d.parent) && ts.isVariableStatement(d.parent.parent) && ts.isSourceFile(d.parent.parent.parent); };
    const resolveBinding = id => { for (let s = id.parent; s; s = s.parent) { const hit = declaredIn(s, id.text); if (hit) return hit; } return null; };
    // A computed-key write of a function passed by reference (api[k] = helper, api[k] = ns.helper)
    // hides the exported name exactly like a function expression does. Data bindings stay exempt.
    const functionValued = r => {
      r = unparen(r);
      if (r && ts.isPropertyAccessExpression(r) && ts.isIdentifier(unparen(r.expression))) { const b = resolveBinding(unparen(r.expression)); return !!b && (ts.isNamespaceImport(b.parent) || ts.isImportClause(b.parent)); }
      if (!r || !ts.isIdentifier(r)) return false;
      const b = resolveBinding(r);
      if (!b) return !['undefined', 'NaN', 'Infinity'].includes(r.text);
      const p = b.parent, init = ts.isVariableDeclaration(p) && p.name === b ? unparen(p.initializer) : null;
      return ts.isFunctionDeclaration(p) || ts.isClassDeclaration(p) || ts.isImportSpecifier(p) || ts.isImportClause(p) || ts.isNamespaceImport(p) || (!!init && (ts.isFunctionLike(init) || ts.isClassExpression(init)));
    };
    // A module that forwards a local module's bindings (export ... from, or a local export of an
    // imported binding) cannot vouch for them while it is unsettled either, even with no waiver of its own.
    const localSpec = (x, mode = 'import') => !!x && ts.isStringLiteralLike(x) && resolve(x.text, file, mode)?.kind === 'local';
    const fromLocalImport = id => { for (let a = resolveBinding(id)?.parent; a; a = a.parent) { if (ts.isImportDeclaration(a)) return localSpec(a.moduleSpecifier); if (ts.isImportEqualsDeclaration(a)) return ts.isExternalModuleReference(a.moduleReference) && localSpec(a.moduleReference.expression, 'require'); } return false; };
    const exported = s => !!ts.getModifiers(s)?.some(m => m.kind === ts.SyntaxKind.ExportKeyword);
    result.forwardsLocal = ast.statements.some(s => (ts.isExportDeclaration(s) && !s.isTypeOnly && (s.moduleSpecifier ? localSpec(s.moduleSpecifier) : ts.isNamedExports(s.exportClause ?? {}) && s.exportClause.elements.some(e => fromLocalImport(e.propertyName ?? e.name))))
      || (ts.isExportAssignment(s) && ts.isIdentifier(unparen(s.expression)) && fromLocalImport(unparen(s.expression)))
      || (ts.isImportEqualsDeclaration(s) && exported(s) && fromLocalImport(s.name)));
    // Readback waivers a local dependency exports (name => reference), scanning it first.
    const depWaivers = (spec, at, mode = 'import') => {
      const r = resolve(spec.text, file, mode);
      if (r?.kind !== 'local') return null;
      const dep = scan(r.file);
      if (!dep.settled && (dep.readbackWaivers || dep.forwardsLocal)) flag('unverifiable', 'cyclic-waived-import', file, lineOf(at), spec.text);
      return dep.waivedReadback?.size ? dep.waivedReadback : null;
    };
    // A namespace of a waived dependency is followed through h.x, h['x'] and a plain destructuring
    // (const {x, y: z} = h); any other use (export {h}, copying or passing it) is unverifiable.
    const plainPattern = p => ts.isObjectBindingPattern(p) && p.elements.every(e => !e.dotDotDotToken && ts.isIdentifier(e.name) && (!e.propertyName || ts.isIdentifier(e.propertyName) || ts.isStringLiteralLike(e.propertyName)));
    const namespaceFollowed = n => {
      const o = outerOf(n), p = o.parent;
      return (ts.isPropertyAccessExpression(p) && p.expression === o) || (ts.isElementAccessExpression(p) && p.expression === o && ts.isStringLiteralLike(p.argumentExpression))
        || (ts.isVariableDeclaration(p) && p.initializer === o && plainPattern(p.name));
    };
    // The literal member name an object-pattern element reads: x, "x" or ["x"]. Null for any other computed key.
    const patternKey = e => {
      const key = e.propertyName ?? e.name;
      if (ts.isComputedPropertyName(key)) { const x = unparen(key.expression); return ts.isStringLiteralLike(x) ? x.text : null; }
      return ts.isIdentifier(key) || ts.isStringLiteralLike(key) ? key.text : null;
    };
    const memberRef = n => { n = unparen(n); if (!n) return null; if (ts.isPropertyAccessExpression(n) && refNames.has(n.name.text)) return n.name.text; if (ts.isElementAccessExpression(n) && ts.isStringLiteralLike(n.argumentExpression) && refNames.has(n.argumentExpression.text)) return n.argumentExpression.text; return null; };
    // A module-level binding of a readback member (including nested object/array patterns) can be
    // exported, so until the module is settled it cannot vouch for itself, like a waived helper.
    const bindsReadbackMember = (name, initializer) => ts.isIdentifier(name) ? !!memberRef(initializer)
      : name.elements.some(e => {
        if (ts.isOmittedExpression(e)) return false;
        return (ts.isObjectBindingPattern(name) && refNames.has(patternKey(e))) || bindsReadbackMember(e.name);
      });
    result.readbackWaivers ||= ast.statements.some(s => ts.isVariableStatement(s) && s.declarationList.declarations.some(d => bindsReadbackMember(d.name, d.initializer)));
    // Plain destructures of local namespaces can forward readback aliases too. Mark them before
    // scanning dependencies: in a cycle, the namespace's waivers may not be available yet.
    result.forwardsLocal ||= ast.statements.some(s => ts.isVariableStatement(s) && s.declarationList.declarations.some(d => {
      const init = unparen(d.initializer);
      if (!init || !ts.isIdentifier(init) || !plainPattern(d.name) || !d.name.elements.length) return false;
      const b = resolveBinding(init);
      return !!b && (ts.isNamespaceImport(b.parent) || ts.isImportEqualsDeclaration(b.parent)) && fromLocalImport(init);
    }));
    const isDeclName = id => { const p = id.parent; return !!p && (((ts.isVariableDeclaration(p) || ts.isBindingElement(p) || ts.isParameter(p) || ts.isFunctionDeclaration(p) || ts.isFunctionExpression(p) || ts.isClassDeclaration(p) || ts.isImportSpecifier(p) || ts.isImportClause(p) || ts.isNamespaceImport(p) || ts.isImportEqualsDeclaration(p) || ts.isExportSpecifier(p) || ts.isPropertyAssignment(p) || ts.isMethodDeclaration(p) || ts.isPropertyDeclaration(p) || ts.isPropertySignature(p) || ts.isMethodSignature(p) || ts.isPropertyAccessExpression(p)) && p.name === id) || (ts.isBindingElement(p) && p.propertyName === id) || (ts.isExportSpecifier(p) && p.propertyName === id)); };
    const refOf = n => {
      let name = null;
      if (ts.isPropertyAccessExpression(n) || ts.isElementAccessExpression(n)) name = memberRef(n);
      if (!name && ts.isPropertyAccessExpression(n) && waivedMethods.has(n.name.text) && ts.isCallExpression(n.parent) && n.parent.expression === n) name = waivedMethods.get(n.name.text);
      if (!name && (ts.isPropertyAccessExpression(n) || ts.isElementAccessExpression(n)) && namespaceOf.size && ts.isIdentifier(unparen(n.expression))) {
        const b = resolveBinding(unparen(n.expression)), key = ts.isPropertyAccessExpression(n) ? n.name.text : ts.isStringLiteralLike(n.argumentExpression) ? n.argumentExpression.text : null;
        if (b && key && namespaceOf.get(b)?.has(key)) name = namespaceOf.get(b).get(key);
      }
      if (!name && ts.isBindingElement(n) && ts.isObjectBindingPattern(n.parent) && refNames.has(patternKey(n))) name = patternKey(n);
      if (!name && ts.isIdentifier(n) && !isDeclName(n)) {
        if (refNames.has(n.text)) name = n.text;
        else if (aliasOf.size) { const b = resolveBinding(n); if (b && aliasOf.has(b)) name = aliasOf.get(b); }
      }
      return name && !inType(n) ? name : null;
    };
    const callsIn = node => { const calls = new Set(), literals = []; const walk = n => {
      if (ts.isCallExpression(n) || ts.isNewExpression(n)) calls.add(n.expression.getText(ast));
      if (refNames.size) { const r = refOf(n); if (r) calls.add(r); }
      if (ts.isStringLiteralLike(n) || ts.isTemplateHead(n) || ts.isTemplateMiddle(n) || ts.isTemplateTail(n)) literals.push(n.text); ts.forEachChild(n, walk);
    }; walk(node); return {calls, literals}; };
    const matches = (rule, body) => (rule.calls?.length ? rule.calls : rule.references ?? []).every(c => [...body.calls].some(x => x === c || x.endsWith('.' + c))) && (!rule.literals?.length || rule.literals.some(s => body.literals.includes(s)));
    if (refNames.size) {
      // Lexical aliases of a readback member: const f = x.getTxByHash / const {getTxByHash: f} = x.
      const collectAliases = n => {
        if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && memberRef(n.initializer)) aliasOf.set(n.name, memberRef(n.initializer));
        if (ts.isBindingElement(n) && ts.isObjectBindingPattern(n.parent) && ts.isIdentifier(n.name) && refNames.has(patternKey(n))) aliasOf.set(n.name, patternKey(n));
        // const {show} = h, where h is the namespace of a waived dependency.
        if (ts.isVariableDeclaration(n) && n.initializer && ts.isIdentifier(unparen(n.initializer)) && plainPattern(n.name)) {
          const b = resolveBinding(unparen(n.initializer)), w = b && namespaceOf.get(b);
          if (w) for (const e of n.name.elements) { const ref = w.get((e.propertyName ?? e.name).text); if (ref) aliasOf.set(e.name, ref); }
        }
        ts.forEachChild(n, collectAliases);
      };
      // Waived readback functions in a local dependency count as readback for their importers,
      // through named, renamed, default, namespace and import-equals imports and through re-exports.
      // A form that cannot carry them (export * as ns) is unverifiable instead.
      for (const n of ast.statements) {
        if (ts.isImportDeclaration(n) && ts.isStringLiteralLike(n.moduleSpecifier) && n.importClause) {
          const c = n.importClause, w = depWaivers(n.moduleSpecifier, n);
          if (w && c.name && w.has('default')) aliasOf.set(c.name, w.get('default'));
          if (w && c.namedBindings && ts.isNamedImports(c.namedBindings)) for (const e of c.namedBindings.elements) { const ref = w.get((e.propertyName ?? e.name).text); if (ref) aliasOf.set(e.name, ref); }
          if (w && c.namedBindings && ts.isNamespaceImport(c.namedBindings)) namespaceOf.set(c.namedBindings.name, w);
        }
        if (ts.isImportEqualsDeclaration(n) && ts.isExternalModuleReference(n.moduleReference) && ts.isStringLiteralLike(n.moduleReference.expression)) {
          const w = depWaivers(n.moduleReference.expression, n, 'require');
          if (w) namespaceOf.set(n.name, w);
          if (w && exported(n)) flag('unverifiable', 'untracked-waived-import', file, lineOf(n), n.moduleReference.expression.text);
        }
        if (ts.isExportDeclaration(n) && n.moduleSpecifier && ts.isStringLiteralLike(n.moduleSpecifier)) {
          const w = depWaivers(n.moduleSpecifier, n);
          if (w && !n.exportClause) for (const [k, v] of w) { if (k !== 'default') result.waivedReadback.set(k, v); }
          if (w && n.exportClause && ts.isNamedExports(n.exportClause)) for (const e of n.exportClause.elements) { const ref = w.get((e.propertyName ?? e.name).text); if (ref) result.waivedReadback.set(e.name.text, ref); }
          if (w && n.exportClause && ts.isNamespaceExport(n.exportClause)) flag('unverifiable', 'untracked-waived-import', file, lineOf(n), n.moduleSpecifier.text);
        }
      }
      collectAliases(ast);
      // A waiver covers only its own declaration: callers of a waived readback function are
      // readback themselves (to a fixpoint), so a display-only waiver cannot feed a paid decision.
      const decls = [];
      const collectDecls = n => {
        if ((ts.isFunctionDeclaration(n) || ts.isMethodDeclaration(n)) && n.body && n.name && (ts.isIdentifier(n.name) || ts.isStringLiteralLike(n.name))) decls.push({node: n, target: n, id: n.name, method: ts.isMethodDeclaration(n)});
        if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.initializer && ts.isFunctionLike(n.initializer)) decls.push({node: n, target: n.initializer, id: n.name, method: false});
        if (ts.isPropertyAssignment(n) && ts.isFunctionLike(n.initializer) && (ts.isIdentifier(n.name) || ts.isStringLiteralLike(n.name))) decls.push({node: n, target: n.initializer, id: n.name, method: true});
        ts.forEachChild(n, collectDecls);
      }; collectDecls(ast);
      for (let changed = true; changed;) {
        changed = false;
        for (const d of decls) if (!d.done) {
          const body = callsIn(d.target), line = lineOf(d.node);
          for (const rule of refRules) if (matches(rule, body) && commentWaivers.some(w => w.primitive === rule.id && w.reason.length >= 8 && [line - 1, line].includes(w.line))) {
            const ref = rule.references[0]; d.done = changed = true;
            if (d.method) waivedMethods.set(d.id.text, ref); else aliasOf.set(d.id, ref);
            result.waivedReadback.set(d.id.text, ref);
            if (ts.getModifiers(d.node)?.some(m => m.kind === ts.SyntaxKind.DefaultKeyword)) result.waivedReadback.set('default', ref);
          }
        }
      }
      // Local re-exports of a readback binding (export {show as view}, export default show, export const read = x.m).
      // A type-only export carries no runtime value, so it neither forwards a readback binding nor lets a namespace escape.
      for (const s of ast.statements) {
        if (ts.isVariableStatement(s) && exported(s)) for (const d of s.declarationList.declarations) for (const id of bindingNames(d.name)) if (aliasOf.has(id)) result.waivedReadback.set(id.text, aliasOf.get(id));
        if (ts.isExportDeclaration(s) && !s.isTypeOnly && !s.moduleSpecifier && s.exportClause && ts.isNamedExports(s.exportClause)) for (const e of s.exportClause.elements.filter(x => !x.isTypeOnly)) { const b = resolveBinding(e.propertyName ?? e.name); if (b && aliasOf.has(b)) result.waivedReadback.set(e.name.text, aliasOf.get(b)); if (b && namespaceOf.has(b)) flag('unverifiable', 'namespace-escape', file, lineOf(e), b.text); }
        if (ts.isExportAssignment(s) && !s.isExportEquals && ts.isIdentifier(s.expression)) { const b = resolveBinding(s.expression); if (b && aliasOf.has(b)) result.waivedReadback.set('default', aliasOf.get(b)); }
      }
    }
    const primitive = (node, name, rules = config.primitives) => {
      if (!name || !node) return;
      // Declaration-only signatures (.d.ts, declare, overloads) carry no implementation.
      if (ambient(node) || ((ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node)) && !node.body)) return;
      const line = lineOf(node), target = node.initializer ?? (ts.isBinaryExpression(node) ? node.right : node), fnLike = target && ts.isFunctionLike(target), body = callsIn(target);
      if (fnLike) checkedTargets.add(target);
      for (const rule of rules) {
        const named = rule.names?.includes(name);
        const structural = fnLike && (rule.calls?.length || rule.references?.length) && matches(rule, body);
        if (!named && !structural) continue;
        const w = commentWaivers.find(w => w.primitive === rule.id && [line - 1, line].includes(w.line));
        if (w && w.reason.length >= 8) { w.used = true; report.waiver({file: rel(file), line, primitive: rule.id, reason: w.reason}); }
        else flag('violation', 'local-protocol-primitive', file, line, `${rule.id}:${name}`);
      }
    };
    const addImport = (node, expression, mode = 'import', typeOnly = false) => {
      if (!expression || !ts.isStringLiteralLike(expression) || ts.isTemplateExpression(expression)) { flag('unverifiable', 'nonliteral-import', file, lineOf(node)); return; }
      const spec = expression.text, resolution = resolve(spec, file, mode);
      if (!resolution) { flag('unverifiable', 'unresolved-import', file, lineOf(node), spec.startsWith('/') || /^[A-Za-z][A-Za-z0-9+.-]*:/.test(spec) ? '<non-local-specifier>' : spec); return; }
      result.imports.push({...resolution, line: lineOf(node), typeOnly});
      report.edge({from: rel(file), to: resolution.file ? rel(resolution.file) : resolution.spec, kind: resolution.kind, typeOnly});
      if (resolution.kind === 'local') scan(resolution.file);
      return resolution;
    };
    // createRequire under any imported name, or as a member (m.createRequire), makes a require.
    const requireFactories = new Set(['createRequire']);
    for (const s of ast.statements) if (ts.isImportDeclaration(s) && ts.isStringLiteral(s.moduleSpecifier) && ['module', 'node:module'].includes(s.moduleSpecifier.text) && ts.isNamedImports(s.importClause?.namedBindings ?? {})) for (const e of s.importClause.namedBindings.elements) if ((e.propertyName ?? e.name).text === 'createRequire') requireFactories.add(e.name.text);
    const requireFactory = x => { x = unparen(x); return (ts.isIdentifier(x) && requireFactories.has(x.text)) || (ts.isPropertyAccessExpression(x) && x.name.text === 'createRequire'); };
    const walk = n => {
      if (refNames.size && refOf(n)) refNodes.push(n);
      if (namespaceOf.size && ts.isIdentifier(n) && !isDeclName(n) && !inType(n)) { const b = resolveBinding(n); if (b && namespaceOf.has(b) && !namespaceFollowed(n)) flag('unverifiable', 'namespace-escape', file, lineOf(n), n.text); }
      if (ts.isImportDeclaration(n)) addImport(n, n.moduleSpecifier, 'import', !!n.importClause && (n.importClause.isTypeOnly || (!n.importClause.name && ts.isNamedImports(n.importClause.namedBindings ?? {}) && n.importClause.namedBindings.elements.length > 0 && n.importClause.namedBindings.elements.every(e => e.isTypeOnly))));
      if (ts.isExportDeclaration(n)) {
        const r = n.moduleSpecifier && addImport(n, n.moduleSpecifier, 'import', n.isTypeOnly || (ts.isNamedExports(n.exportClause ?? {}) && n.exportClause.elements.length > 0 && n.exportClause.elements.every(e => e.isTypeOnly)));
        // An export specifier is a definition unless its binding resolves, through local
        // imports/barrels, to a locked registry package boundary.
        for (const e of n.exportClause?.elements ?? []) if (!n.isTypeOnly && !e.isTypeOnly && r?.kind !== 'package' && r?.kind !== 'builtin' && exportOrigin(file, e.name.text) !== 'package') primitive(e, e.name.text);
      }
      if (ts.isImportEqualsDeclaration(n) && ts.isExternalModuleReference(n.moduleReference)) addImport(n, n.moduleReference.expression, 'require', n.isTypeOnly);
      if (ts.isCallExpression(n)) {
        if (n.expression.kind === ts.SyntaxKind.ImportKeyword || n.expression.getText(ast) === 'require' || n.expression.getText(ast).endsWith('.require')) {
          const mode = n.expression.kind === ts.SyntaxKind.ImportKeyword ? 'import' : 'require', r = addImport(n, n.arguments[0], mode);
          // The value a dynamic import or require() returns is not followed, so a waived dependency is unverifiable there.
          if (refNames.size && r?.kind === 'local' && depWaivers(n.arguments[0], n, mode)) flag('unverifiable', 'untracked-waived-import', file, lineOf(n), n.arguments[0].text);
        }
        if (['registerTool', 'register', ...(config.registrationCalls ?? [])].includes(ts.isPropertyAccessExpression(n.expression) ? n.expression.name.text : n.expression.getText(ast)) && ts.isStringLiteralLike(n.arguments[0] ?? {})) result.registrations.push(n.arguments[0].text);
        if (['require.resolve', 'import.meta.resolve'].includes(n.expression.getText(ast))) flag('unverifiable', 'reflective-loader', file, lineOf(n));
        // A call through a non-literal key (x[k](), x['a' + 'b']()) can reach a readback member unseen.
        const callee = unparen(n.expression);
        if (refNames.size && ts.isElementAccessExpression(callee) && computedKey(callee)) flag('unverifiable', 'computed-member-call', file, lineOf(n));
        if ((ts.isPropertyAccessExpression(callee) ? callee.name.text : ts.isIdentifier(callee) ? callee.text : '') === 'getBuiltinModule') flag('unverifiable', 'reflective-loader', file, lineOf(n));
        if (ts.isCallExpression(callee) && requireFactory(callee.expression)) flag('unverifiable', 'aliased-require', file, lineOf(n));
      }
      if (reflectiveRead(n)) flag('unverifiable', 'reflective-loader', file, lineOf(n));
      else if (refNames.size && computedCallableRead(n)) flag('unverifiable', 'computed-member-read', file, lineOf(n));
      if (ts.isIdentifier(n) && n.text === 'require' && !(ts.isCallExpression(n.parent) && n.parent.expression === n) && !(ts.isPropertyAccessExpression(n.parent) && (n.parent.name === n || (n.parent.expression === n && !['call', 'apply', 'bind'].includes(n.parent.name.text)))) && !(ts.isVariableDeclaration(n.parent) && n.parent.name === n) && !ts.isImportEqualsDeclaration(n.parent)) flag('unverifiable', 'aliased-require', file, lineOf(n));
      if (ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.EqualsToken && ts.isElementAccessExpression(n.left)) { if (ts.isStringLiteralLike(n.left.argumentExpression)) primitive(n, n.left.argumentExpression.text); else if (computedDefinitionRisk(n) || functionValued(n.right)) flag('unverifiable', 'computed-export', file, lineOf(n)); }
      if (ts.isComputedPropertyName(n) && !ts.isStringLiteralLike(unparen(n.expression))) flag('unverifiable', 'computed-member', file, lineOf(n));
      if (ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.EqualsToken && ts.isPropertyAccessExpression(n.left)) primitive(n, n.left.name.text);
      if (ts.isBindingElement(n) && n.initializer && ts.isIdentifier(n.name)) primitive(n, n.name.text);
      if (ts.isVariableDeclaration(n) && (n.initializer?.getText(ast) === 'require' || (ts.isCallExpression(unparen(n.initializer) ?? {}) && requireFactory(unparen(n.initializer).expression) && n.name.getText(ast) !== 'require'))) flag('unverifiable', 'aliased-require', file, lineOf(n));
      if (ts.isFunctionDeclaration(n) || ts.isMethodDeclaration(n) || ts.isClassDeclaration(n) || ts.isVariableDeclaration(n) || (ts.isPropertyAssignment(n) && ts.isFunctionLike(n.initializer))) primitive(n, n.name && (ts.isIdentifier(n.name) || ts.isStringLiteralLike(n.name)) ? n.name.text : ts.isComputedPropertyName(n.name ?? {}) && ts.isStringLiteralLike(unparen(n.name.expression)) ? unparen(n.name.expression).text : null);
      ts.forEachChild(n, walk);
    }; walk(ast);
    // A readback reference must sit inside a checked definition. Inside an unnamed function
    // (e.g. an inline tool callback) the function itself is checked; outside any function,
    // provenance cannot be established and the module is unverifiable.
    for (const n of refNodes) {
      if (ambient(n)) continue;
      let fn = null, covered = false;
      for (let a = n.parent; a; a = a.parent) if (ts.isFunctionLike(a)) { fn ??= a; if (checkedTargets.has(a)) { covered = true; break; } }
      if (covered) continue;
      if (fn) { primitive(fn, '<anonymous>', refRules); continue; }
      // An alias definition, or a default re-export that its importers inherit as readback, is not a use.
      // Only a statement of the module itself is an alias definition its exports can forward: a hoisted var in a
      // block, or a declaration in a namespace, is not found by the binding lookup, and export = forwards nothing.
      const aliasDef = (((ts.isVariableDeclaration(n.parent) && n.parent.initializer && unparen(n.parent.initializer) === n && aliasOf.has(n.parent.name)) || (ts.isBindingElement(n) && aliasOf.has(n.name))) && inModuleStatement(n))
        || (ts.isIdentifier(n) && ts.isExportAssignment(n.parent) && !n.parent.isExportEquals && n.parent.expression === n);
      if (!aliasDef) flag('unverifiable', 'readback-reference-escape', file, lineOf(n), refOf(n));
    }
    for (const w of commentWaivers) if (!w.used || w.reason.length < 8) flag('violation', 'invalid-or-unused-waiver', file, w.line, w.primitive);
    result.settled = true;
    return result;
  };
}
