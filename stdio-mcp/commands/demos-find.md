---
description: Find DACS sellers in the public Directory and check a listing (search and check only)
argument-hint: "<what you want, e.g. 'image captioning'>"
allowed-tools: mcp__plugin_demos_demos__demos_dacs_discover, mcp__plugin_demos_demos__demos_dacs_listing_check
---

Find DACS sellers for: `$ARGUMENTS`

This command is written to search and check, using the two read-only tools named above.

1. If the request above is empty, ask the user what they want to find, in one question.
2. Call `demos_dacs_discover` with that request. Search results are public Directory entries. Say so when you show them.
3. Read `listings`, `total`, `withheld` and `cursor` before you answer. If `listings` is not empty, list the hits in a short numbered list (seller name, title, price hint as the seller wrote it, listing id and version; mark any `revoked` hit as withdrawn), and ask the user which one to check. Then:
   - If `withheld` is above 0, give the `withheld` count. When `listings` is not empty, say that this many more hits were found but are not shown here. When `listings` is empty, say that hits were found but none can be shown here.
   - If `cursor` is not null, offer the next page: call `demos_dacs_discover` again with the same request and that `cursor` value, exactly as returned, if the user wants it.
   - If `listings` is empty, `withheld` is 0 and `cursor` is null, but `total` is above 0, say that the Directory reports `total` matches and this page shows none. Do not say that nothing was found.
   - Say that nothing was found only when `total` is 0, `withheld` is 0 and `cursor` is null. Then stop.
4. Call `demos_dacs_listing_check` for the hit the user picks, with the seller claim, listing id and version exactly as `demos_dacs_discover` returned them. Never pass a `revocation` value, and never take one from the Directory hit.
5. If the call returned an error instead of a `decision`, report the error plainly, say that the listing was not checked, and give no verdict. Do not call the listing valid, invalid or "probably fine". Otherwise, if the hit was marked `revoked`, report the withdrawal first, then the `decision`; if not, report the `decision` first. Report the `decision` in plain words:
   - If the hit was marked `revoked`, say that the Directory reports it withdrawn, whatever the decision is. Never call it unknown, and never say its revocation is not established.
   - `accept` — every check passed. This is a check of the listing only; it is not a purchase and not an endorsement of the seller.
   - `reject` — name each failed check and what it means.
   - `indeterminate` — NOT verified. Never describe it as valid or "probably fine". Look at every check in the result that is not `pass`.
     - If `5-revocation` is the only one, and the hit was not marked `revoked`, say: "the signed Listing checks passed; revocation is not established". Name the checks that passed.
     - If the hit was marked `revoked` and `5-revocation` is the only one, say that the signed Listing checks passed and name them. The withdrawal is already reported above.
     - Otherwise name each check that is not `pass`, with its detail and what it means. For example, `4-signature` not `pass` means the signature was not verified. Do not say the signed Listing checks passed. If the hit was marked `revoked`, leave out the "not established" wording for `5-revocation`.
6. The check covers the signed Listing. The title and price hint in the search summary are the Directory's text; the check does not verify them. Say so.
