import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { formatTimeline } from '../src/ops/purchase-timeline.mjs';
export { purchaseTimeline, formatTimeline } from '../src/ops/purchase-timeline.mjs';

if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href) {
  if(process.argv.length!==3){process.stderr.write('Usage: node scripts/purchase-timeline.mjs SERVER_LOG\n');process.exitCode=1;}
  else process.stdout.write(`${formatTimeline(readFileSync(process.argv[2],'utf8'))}\n`);
}
