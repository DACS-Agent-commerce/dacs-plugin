---
description: Find DACS sellers in the public Directory and check a listing (search and check only)
argument-hint: "<what you want, e.g. 'image captioning'>"
allowed-tools: mcp__plugin_demos_demos__demos_dacs_discover, mcp__plugin_demos_demos__demos_dacs_listing_check
---

Find DACS sellers for: `$ARGUMENTS`

This command is written to search and check, using the two read-only tools named above.

1. If the request above is empty, ask the user what they want to find, in one question.
2. Call `demos_dacs_discover` with that request. Search results are public Directory entries. Say so when you show them.
3. List the hits in a short numbered list (seller name, title, price hint as the seller wrote it, listing id and version; mark any `revoked` hit), and ask the user which one to check. Stop if there are no hits, and say that nothing was found.
4. Call `demos_dacs_listing_check` for the hit the user picks, with the seller claim, listing id and version exactly as `demos_dacs_discover` returned them. Never pass a `revocation` value, and never take one from the Directory hit.
5. Report the `decision` first, in plain words:
   - `accept` — every check passed. This is a check of the listing only; it is not a purchase and not an endorsement of the seller.
   - `reject` — name each failed check and what it means.
   - `indeterminate` — NOT verified. Never describe it as valid or "probably fine". Look at every check in the result that is not `pass`.
     - If `5-revocation` is the only one, and the hit was not marked `revoked`, say: "the signed Listing checks passed; revocation is not established". Name the checks that passed.
     - Otherwise name each check that is not `pass`, with its detail and what it means. For example, `4-signature` not `pass` means the signature was not verified. Do not say the signed Listing checks passed.
     - If the hit was marked `revoked`, say the Directory reports it withdrawn. Do not say revocation is unknown.
6. The check covers the signed Listing. The title and price hint in the search summary are the Directory's text; the check does not verify them. Say so.
