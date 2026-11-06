// Names each test by its full suite path (`describe > ... > test`), so same-named
// tests in different blocks of one file stay distinct. Node emits test:start in
// definition order with the test's nesting level, which gives the ancestors.
// Skip and todo count when present, even as an empty reason, as in node:test.
// A summary keeps its file: only the file's own process reports one with it.
// A failed file process keeps its exit status (Node's message is just "test failed").
// Errors no test catches are reported as `test:late`: node:test turns an uncaught
// exception or rejection after a test ended into a diagnostic, and an error that
// kills the process after its summary (in an exit handler) leaves only Node's
// fatal-error trailer on stderr. Node does not report either as a failure when
// a test in the file already failed. It still completes the file-level test
// (named after the file, located at the file) with the process's exit code and
// signal, which `test:exit` passes on.
// A file that cannot load, because a module it imports is not there, ends with
// Node's fatal-error diagnostic on stderr and no test. When that diagnostic is
// the whole of stderr and names one missing file inside the run directory,
// `test:load-failure` passes the file's path on; any other shape gives none.
import { isAbsolute, relative, resolve, sep } from 'node:path';

const ASYNC_AFTER_END = /generated asynchronous activity after the test ended/;
const FATAL_TRAILER = /^Node\.js v\d+\.\d+\.\d+$/m;
const ERROR_HEADER = /^(?:[A-Za-z]+)?Error(?: \[[A-Za-z0-9_]+\])?: /;
const MODULE_NOT_FOUND = /^Error \[ERR_MODULE_NOT_FOUND\]: Cannot find module '([^'\n]+)' imported from /;
const MODULE_NOT_FOUND_CODE = /^ {2}code: 'ERR_MODULE_NOT_FOUND',?$/;
// Node's diagnostic for a missing import is well under 2 KiB; more is some other output.
const MAX_DIAGNOSTIC_BYTES = 16384;

// The path, relative to the run directory, of the file a diagnostic says is missing; undefined when the text is anything else.
function missingModulePath(stderr) {
  const lines = stderr.split('\n');
  const found = lines.filter((line) => ERROR_HEADER.test(line)).map((line) => MODULE_NOT_FOUND.exec(line));
  const last = lines.filter((line) => line !== '').at(-1);
  if (found.length !== 1 || !found[0] || !isAbsolute(found[0][1]) || last === undefined || !FATAL_TRAILER.test(last) ||
    lines.filter((line) => FATAL_TRAILER.test(line)).length !== 1 || lines.filter((line) => MODULE_NOT_FOUND_CODE.test(line)).length !== 1) return undefined;
  const path = relative(process.cwd(), found[0][1]);
  return path === '' || path.startsWith('..') || isAbsolute(path) ? undefined : path.split(sep).join('/');
}

export default async function* reporter(events) {
  const suites = [];
  const stderr = [];
  let summarized = false, started = false, stderrBytes = 0;
  for await (const { type, data } of events) {
    if (type === 'test:stderr' && stderrBytes <= MAX_DIAGNOSTIC_BYTES) {
      stderrBytes += Buffer.byteLength(data.message);
      stderr.push(data.message);
    }
    if (type === 'test:start') {
      if (data.nesting > 0) started = true;
      suites.length = data.nesting;
      suites.push(data.name);
    } else if (type === 'test:pass' || type === 'test:fail') {
      const test = [...suites.slice(0, data.nesting), data.name].join(' > '), error = data.details?.error;
      yield `${JSON.stringify({ type, test, skipped: data.skip !== undefined, todo: data.todo !== undefined,
        ...(type === 'test:fail' ? { error: error?.message, cause: error?.cause?.message, exitCode: error?.exitCode, signal: error?.signal } : {}) })}\n`;
    } else if (type === 'test:complete' && data.nesting === 0 && data.file === resolve(data.name)) {
      const error = data.details.passed ? { exitCode: 0, signal: null } : data.details.error;
      yield `${JSON.stringify({ type: 'test:exit', test: data.name, exitCode: error?.exitCode, signal: error?.signal })}\n`;
      const path = !started && !data.details.passed && error?.exitCode === 1 && stderrBytes <= MAX_DIAGNOSTIC_BYTES ? missingModulePath(stderr.join('')) : undefined;
      if (path !== undefined) yield `${JSON.stringify({ type: 'test:load-failure', path })}\n`;
    } else if (type === 'test:diagnostic' && data.file && ASYNC_AFTER_END.test(data.message)) {
      yield `${JSON.stringify({ type: 'test:late', error: data.message })}\n`;
    } else if (type === 'test:stderr' && summarized && FATAL_TRAILER.test(data.message)) {
      yield `${JSON.stringify({ type: 'test:late', error: 'uncaught error after the file\'s summary (see the TAP stderr)' })}\n`;
    } else if (type === 'test:summary') {
      if (data.file) summarized = true;
      yield `${JSON.stringify({ type, file: data.file ?? null, counts: data.counts, success: data.success })}\n`;
    }
  }
}
