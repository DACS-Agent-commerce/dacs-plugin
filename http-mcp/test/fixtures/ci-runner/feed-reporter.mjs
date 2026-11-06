// Runs the real reporter over the events given as a JSON array on stdin and prints its lines.
import reporter from '../../../scripts/test-file-reporter.mjs';

let input = '';
for await (const chunk of process.stdin) input += chunk;
for await (const line of reporter(JSON.parse(input))) process.stdout.write(line);
