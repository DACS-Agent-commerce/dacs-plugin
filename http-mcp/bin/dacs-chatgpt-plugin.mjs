#!/usr/bin/env node
// Starts the DACS ChatGPT plugin server. Configuration comes only from the
// environment (see .env.example); nothing here reads wallet or credential files.
import { loadConfig, ConfigError } from '../src/config.mjs';
import { createApp } from '../src/app.mjs';
import { createLogger } from '../src/util/log.mjs';

let config;
try {
  config = loadConfig(process.env);
} catch (error) {
  if (error instanceof ConfigError) {
    process.stderr.write(`configuration error: ${error.message}\n`);
    process.exit(2);
  }
  throw error;
}

const logger = createLogger({ level: config.logLevel });
const { app, close, startDeliveryDeadlineWatch, stopDeliveryDeadlineWatch } = await createApp({ config, logger });
const server = app.listen(config.port, config.host, () => {
  startDeliveryDeadlineWatch();
  const address = server.address();
  logger.info('listening', { host: address.address, port: address.port, mcp: config.mcpUrl, authMode: config.authMode });
});
server.requestTimeout = 60_000;
server.headersTimeout = 20_000;

let stopping = false;
async function shutdown(signal) {
  if (stopping) return;
  stopping = true;
  stopDeliveryDeadlineWatch();
  logger.info('shutdown', { signal });
  const force = setTimeout(() => process.exit(1), 10_000);
  force.unref();
  server.close(async () => {
    await close().catch((error) => logger.error('shutdown_error', { message: error.message }));
    process.exit(0);
  });
  server.closeIdleConnections?.();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
