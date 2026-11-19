#!/usr/bin/env node
// Plugin launcher: runs the built server, or explains how to build it.
// (stdout is the MCP stream, so diagnostics go to stderr only.)
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// The printed command is for a POSIX shell (sh, bash, zsh). Single quotes keep every
// character literal there, so the folder is wrapped in them and each ' is written '\''.
const shQuote = (s) => `'${s.replaceAll("'", `'\\''`)}'`;

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const entry = join(root, 'dist', 'index.js');
if (!existsSync(entry) || !existsSync(join(root, 'node_modules', '@kynesyslabs', 'demosdk'))) {
  process.stderr.write(
    `demos-mcp is not built yet. Run:\n  cd ${shQuote(root)} && npm ci && npm run build\nthen restart Claude Code (or run /mcp to reconnect).\n`,
  );
  process.exit(1);
}
await import(pathToFileURL(entry).href);
