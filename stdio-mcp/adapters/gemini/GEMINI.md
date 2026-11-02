# Demos MCP

Stdio runs the full local server: reads, receipt checks, and wallet writes that wait for the local approval page. Do not put a mnemonic or keystore passphrase in this file.

`--transport http` is a separate keyless process on 127.0.0.1. It can read, verify a receipt, and return an unsigned draft. It cannot sign or submit.
