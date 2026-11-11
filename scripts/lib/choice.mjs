/** Longest accepted selector value; longer input is refused before it is compared. */
export const MAX_SELECTOR_CHARS = 4096;

/** A refused command line; `cause` is missing-choice, invalid-choice, oversized-choice or bad-arguments. */
export class ChoiceError extends Error {
  constructor(cause, message) {
    super(message);
    this.name = 'ChoiceError';
    this.cause = cause;
  }
}

/** Returns `value` when it is exactly one of `allowed`; throws ChoiceError otherwise, never echoing the value. */
export function parseChoice(flag, value, allowed) {
  if (value === undefined) throw new ChoiceError('missing-choice', `${flag} is required`);
  if (value.length > MAX_SELECTOR_CHARS) throw new ChoiceError('oversized-choice', `${flag} value is over ${MAX_SELECTOR_CHARS} characters`);
  if (!allowed.includes(value)) throw new ChoiceError('invalid-choice', `${flag} must be one of: ${allowed.join(', ')}`);
  return value;
}

/** Parses `--flag value` pairs; throws ChoiceError(bad-arguments) for an unknown or repeated flag, a missing value (including a known flag where the value belongs) or a stray argument. */
export function parseFlags(argv, knownFlags) {
  const parsed = {};
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    if (!knownFlags.includes(flag)) throw new ChoiceError('bad-arguments', 'unknown or unexpected argument');
    if (flag in parsed) throw new ChoiceError('bad-arguments', `${flag} was given twice`);
    if (index + 1 >= argv.length || knownFlags.includes(argv[index + 1])) throw new ChoiceError('bad-arguments', `${flag} needs a value`);
    parsed[flag] = argv[index + 1];
  }
  return parsed;
}
