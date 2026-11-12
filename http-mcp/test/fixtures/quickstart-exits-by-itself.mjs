// A server that answers /health and the MCP listing like the quickstart one,
// then exits 0 by itself. The quickstart test's shutdown check must fail on it.
import { createServer } from 'node:http';

const reply = (res, body) => {
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
};

createServer((req, res) => {
  let raw = '';
  req.on('data', (d) => (raw += d));
  req.on('end', () => {
    if (req.url === '/health') {
      return reply(res, { status: 'ok', dependencies: { directory: { configured: false }, chain: { configured: false } } });
    }
    if (req.method !== 'POST' || req.url !== '/mcp') { res.writeHead(405); return res.end(); }
    const { id, method } = JSON.parse(raw);
    if (id === undefined) { res.writeHead(202); return res.end(); }
    if (method === 'initialize') {
      return reply(res, { jsonrpc: '2.0', id, result: { protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'fixture', version: '1' } } });
    }
    if (method === 'tools/list') {
      return reply(res, { jsonrpc: '2.0', id, result: { tools: [{ name: 'search_agents', inputSchema: { type: 'object' } }] } });
    }
    reply(res, { jsonrpc: '2.0', id, result: { isError: true, content: [{ type: 'text', text: 'directory not configured' }] } });
    if (method === 'tools/call') setTimeout(() => process.exit(0), 10);
  });
}).listen(Number(process.env.PORT), '127.0.0.1');
