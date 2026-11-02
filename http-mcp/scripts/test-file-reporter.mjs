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
import { resolve } from 'node:path';

const ASYNC_AFTER_END = /generated asynchronous activity after the test ended/;
const FATAL_TRAILER = /^Node\.js v\d+\.\d+\.\d+$/m;
export default async function* reporter(events) {
  const suites = [];
  let summarized = false;
  for await (const { type, data } of events) {
    if (type === 'test:start') {
      suites.length = data.nesting;
      suites.push(data.name);
    } else if (type === 'test:pass' || type === 'test:fail') {
      const test = [...suites.slice(0, data.nesting), data.name].join(' > '), error = data.details?.error;
      yield `${JSON.stringify({ type, test, skipped: data.skip !== undefined, todo: data.todo !== undefined,
        ...(type === 'test:fail' ? { error: error?.message, cause: error?.cause?.message, exitCode: error?.exitCode, signal: error?.signal } : {}) })}\n`;
    } else if (type === 'test:complete' && data.nesting === 0 && data.file === resolve(data.name)) {
      const error = data.details.passed ? { exitCode: 0, signal: null } : data.details.error;
      yield `${JSON.stringify({ type: 'test:exit', test: data.name, exitCode: error?.exitCode, signal: error?.signal })}\n`;
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
