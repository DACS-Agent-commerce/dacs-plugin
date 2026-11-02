// Source-only ordinary packaging classification, shared by the release checker
// and its fixtures. The one public runtime manifest is not wallet state.
export const PUBLIC_RUNTIME_MANIFEST = 'public/portal/embedded-wallet/runtime-manifest.json';
const EXCLUDED = /^(test|references|scripts)\/|(^|\/)\.env$|\.sqlite|\.data\/|AGENTS\.md|STATUS\.md|ACCEPTANCE\.md/i;
export function forbiddenPackagePaths(files) {
  return files.filter((path) => EXCLUDED.test(path) ||
    (/wallet.*\.json/i.test(path) && path !== PUBLIC_RUNTIME_MANIFEST));
}
