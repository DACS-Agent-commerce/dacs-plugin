# Host snippets

These snippets start **stdio**, which is the full local mode (off-chat approval and the key guard stay in that process). Replace the command with the installed `demos-mcp` binary. Do not put a mnemonic in the snippet.

`--transport http` binds `127.0.0.1` only (port `7391`, or `DEMOS_MCP_HTTP_PORT`). That process serves read, verify, and unsigned prepare. It does not hold keys and it does not submit. The approval page is not started there.

## VS Code

`.vscode/mcp.json`

```json
{
  "servers": {
    "demos": {
      "type": "stdio",
      "command": "demos-mcp",
      "args": []
    }
  }
}
```

## Codex

`~/.codex/config.toml`

```toml
[mcp_servers.demos]
command = "demos-mcp"
args = []
```

## Cursor

`mcp.json`

```json
{
  "mcpServers": {
    "demos": {
      "command": "demos-mcp",
      "args": []
    }
  }
}
```

Keyless HTTP, for a host that speaks streamable HTTP on the local machine:

```json
{
  "mcpServers": {
    "demos": {
      "url": "http://127.0.0.1:7391/mcp"
    }
  }
}
```

Start that URL with `demos-mcp --transport http`. The process writes a bearer to `http-auth.json` in the state directory (mode 0600) and does not print it. Send it as `Authorization: Bearer <token>`. Do not point the URL at a public address.
