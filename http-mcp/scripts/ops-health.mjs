import { pathToFileURL } from 'node:url';
import { main } from '../bin/dacs-ops-health.mjs';
export { main };
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)process.exitCode=await main();
