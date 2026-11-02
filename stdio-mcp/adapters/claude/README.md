# Claude adapter

The Claude Code plugin stays at the repository root so the existing install path keeps working:

- `.claude-plugin/plugin.json` and `marketplace.json`
- `.mcp.json` (stdio, full local mode, off-chat approval)
- `commands/` and `skills/`

This folder does not replace those files. Other hosts use `adapters/HOSTS.md` and `adapters/gemini/gemini-extension.json`.

Stdio (`demos-mcp` with no transport flag) is the full local server. `--transport http` is the keyless read, verify, and unsigned-prepare server on 127.0.0.1. It does not hold keys and does not submit.
