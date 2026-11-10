/**
 * Picks the local approval link out of one stderr line of the confirmation banner
 * (src/confirm.ts formatMessage). Shared by the live write cycle and its unit test,
 * so a banner wording change fails a unit test instead of silently starving the
 * live run of links.
 */
const LINK = /OPEN THIS PAGE: (http:\/\/127\.0\.0\.1:\d+\/a\/[A-Za-z0-9_-]{43})/;

export function approvalLinkFromLine(line: string): string | null {
  return LINK.exec(line)?.[1] ?? null;
}
