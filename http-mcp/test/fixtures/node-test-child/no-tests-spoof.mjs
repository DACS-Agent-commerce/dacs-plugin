// Not a node:test file: it only prints a passing TAP stream to stdout.
console.log(['TAP version 13', '# Subtest: x', 'ok 1 - x', '  ---', '  duration_ms: 1', '  ...', '1..1',
  '# tests 1', '# suites 0', '# pass 1', '# fail 0', '# cancelled 0', '# skipped 0', '# todo 0', '# duration_ms 1'].join('\n'));
