---
description: Find DACS sellers in the public Directory and check a listing (search and check only)
argument-hint: "<what you want, e.g. 'image captioning'>"
allowed-tools: mcp__plugin_demos_demos__demos_dacs_discover, mcp__plugin_demos_demos__demos_dacs_listing_check
---

Find DACS sellers for: `$ARGUMENTS`

This command only searches and checks. It calls no tool other than the two above, and neither of them buys.

1. If the request above is empty, ask the user what they want to find, in one question.
2. Call `demos_dacs_discover` with that request. Search results are public Directory entries. Say so when you show them.
3. List the hits in a short numbered list (seller name, title, price hint as the seller wrote it, listing id and version; mark any `revoked` hit), and ask the user which one to check. Stop if there are no hits, and say that nothing was found.
4. Call `demos_dacs_listing_check` for the hit the user picks, with the seller claim, listing id and version exactly as `demos_dacs_discover` returned them. Never pass a `revocation` value, and never take one from the Directory hit.
5. Report the `decision` first, in plain words:
   - `accept` — every check passed. This is a check of the listing only; it is not a purchase and not an endorsement of the seller.
   - `reject` — name each failed check and what it means.
   - `indeterminate` — NOT verified. Name what could not be established. Never describe it as valid or "probably fine". With no revocation result supplied, `indeterminate` is the expected result for a sound Listing: the signed Listing checks passed, and whether it has been revoked is not established. Say that, and name the checks that passed.
6. The check covers the signed Listing. The title and price hint in the search summary are the Directory's text; the check does not verify them. Say so.
