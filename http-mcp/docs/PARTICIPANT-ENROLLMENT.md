# Participant enrollment file

The enrollment file lists the seller implementations the operator has
approved. The SDK client signs a request to a seller only when exactly one
current, unrevoked entry in this file names that seller's claim. The client
reads the file's entries through `participantImplementations.entriesFor(claim)`,
and `loadParticipantEnrollment` in `src/sdk/participant-enrollment.mjs` loads
them.

With `DACS_SDK_PURCHASES` set to `off`, the only value the server accepts today
(see [SWITCHES.md](SWITCHES.md)), the server does not read the file.

## Location

The file is `participant-enrollment.json` in the server's data directory
(`DACS_DATA_DIR`, by default `.data` in the working directory). No other path
is read, and no setting moves the file. Keep the data directory private to the
server's user (mode `0700`). The file must be a regular file. A symlink is
refused.

No request route reads, serves or writes the file. The server never writes it.

## Format

One JSON document of at most 1 MiB:

```json
{
  "format": "dacs-participant-enrollment/v1",
  "entries": [
    {
      "claim": "did:demos:agent:<64 lowercase hex>",
      "profile": {
        "id": "dacs-testnet-tp1",
        "revision": "TP-1",
        "base": "<40 lowercase hex>",
        "chainIdentity": "<64 lowercase hex>",
        "pinVersion": "<identity pin>"
      },
      "modules": { "CORE": "0.3", "DACS-1": "0.7", "DACS-2": "0.6", "DACS-3": "0.5", "DACS-4": "0.8", "DACS-5": "0.5" },
      "evidence": "<what the approval rests on>",
      "revoked": false
    }
  ]
}
```

- `format` is `dacs-participant-enrollment/v1`.
- `entries` holds at most 1024 entries, each with exactly the five fields above.
- `claim` is the seller's `did:demos:agent` claim, in lowercase. A claim appears
  in at most one entry.
- `profile` has exactly the five TP-1 profile fields and `modules` exactly the
  six TP-1 module versions, each a string. The client compares both with its
  own bound profile when it signs, so an entry that names another profile is
  loaded but never authorizes a request.
- `evidence` is a non-empty string of at most 1024 characters. It records why
  the operator approved the implementation, for example a review reference.
- `revoked` is `true` or `false`.

A field the format does not name, at any level, refuses the whole file. So does
a JSON member written twice or a byte order mark.

## Refusals

When the file is there, the loader takes all of it or none of it. It refuses
with the SDK's `WireError` (status 500):

- `tp1_enrollment_invalid`: the file is not one JSON document, is over 1 MiB,
  or breaks the format above. The refusal's detail names the first problem
  found, for example `duplicate_claim` or `entry_fields`.
- `tp1_enrollment_unreadable`: the file cannot be opened or read, is a symlink
  or is not a regular file. The detail is the system error code, such as
  `EACCES` or `ELOOP`.

With no file at that path, no seller is enrolled, and the client refuses every
seller request with `tp1_participant_profile_mismatch`.

## Changes and revocation

The loader reads the file once and keeps its entries; nothing reloads them. A
server loads the file at startup, so a change made while it runs takes effect
at the next restart, and a malformed edit is found then.

To revoke an implementation, remove its entry or set `"revoked": true`, then
restart the server.
