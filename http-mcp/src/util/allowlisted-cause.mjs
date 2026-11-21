// The client's held-profile refusal (profile_not_admitted) keeps the failure behind it as `cause`. Answers show
// that cause's code only when it is one of the client's own admission codes, never its message or any other text.
const ADMISSION_CAUSE = /^(?:runtime_unsupported|tp1_[a-z0-9_]{1,48})$/;

/** Returns `error.cause.code` when it is `runtime_unsupported` or a `tp1_` code, otherwise undefined. */
export function allowlistedCause(error) {
  const code = error?.cause?.code;
  return typeof code === 'string' && ADMISSION_CAUSE.test(code) ? code : undefined;
}
