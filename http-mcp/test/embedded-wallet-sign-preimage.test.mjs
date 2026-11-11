// Ordinary message signing stays separate from transaction signing: `sign`
// refuses a transaction hash and any "demos-tx:v1:" string before consent, while
// the wallet's own RPC-auth digest still signs through a module-private path.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import * as providerModule from '../public/portal/embedded-wallet/sdk-provider.mjs';
import { renderChallengeMessage, PURPOSES } from '../src/wallet/challenges.mjs';
import { verifyDemosSignature } from '../src/wallet/demos-signature.mjs';

const { createSdkWalletSession, createDevnetNativeWalletTransport } = providerModule;
globalThis.window ??= globalThis;
globalThis.document ??= { baseURI: 'http://127.0.0.1/portal/assets/embedded-wallet/' };
globalThis.location = new URL('http://127.0.0.1/');
const { Demos, Identities, validateMnemonic } = await import('../public/portal/embedded-wallet/demos-runtime.mjs');

const HASH = createHash('sha256').update('a transaction body').digest('hex');
const PAYEE = `0x${'71'.repeat(32)}`;

async function setup(extra = {}) {
  const signed = [], handed = [];
  class SpyDemos extends Demos {
    constructor(...args) {
      super(...args);
      // The bytes the SDK's own crypto is handed, exactly.
      const sign = this.crypto.sign.bind(this.crypto);
      this.crypto.sign = (algorithm, bytes) => { handed.push(Buffer.from(bytes)); return sign(algorithm, bytes); };
    }
    async signMessage(message, options) {
      signed.push(message);
      return super.signMessage(message, options);
    }
  }
  const approvals = [];
  const wallet = createSdkWalletSession({
    DemosCtor: SpyDemos, IdentitiesCtor: Identities, validateMnemonic,
    approve: async (request) => { approvals.push(request); return true; },
    ...extra,
  });
  const { address } = await wallet.create();
  return { wallet, signed, handed, approvals, address };
}

const refusal = (res, label) => { assert.equal(res.success, false, label); assert.equal(res.error.code, 'transaction_preimage_refused', label); };

const BOM = '\uFEFF';
const PREIMAGE = /^(0x)?[0-9a-fA-F]{64}$/;
const isPreimage = (text) => PREIMAGE.test(text) || text.startsWith('demos-tx:v1:');
// Every way the bytes handed to the SDK crypto can be read: as plain UTF-8, as the
// SDK reads them (a default TextDecoder drops one leading U+FEFF), and with every
// leading U+FEFF dropped.
const readings = (bytes) => {
  const once = new TextDecoder().decode(bytes);
  return [Buffer.from(bytes).toString('utf8'), once, once.replace(/^\uFEFF+/, '')];
};
const preimageReached = (handed) => handed.some((bytes) => readings(bytes).some(isPreimage));
// The text the SDK signs for a message, from the bytes it was handed.
const signedText = (bytes) => new TextDecoder().decode(bytes);

const MIXED = HASH.slice(0, 20).toUpperCase() + HASH.slice(20);
const HASHES = [['lowercase', HASH], ['uppercase', HASH.toUpperCase()], ['mixed-case', MIXED]];
// Every transaction signing form: bare, 0x and 0X hashes in each case, and the
// same with the domain prefix.
const FORMS = HASHES.flatMap(([label, hash]) => ['', '0x', '0X'].flatMap((prefix) => [
  [`${label} ${prefix || 'bare'} hash`, `${prefix}${hash}`],
  [`${label} ${prefix || 'bare'} hash in the domain form`, `demos-tx:v1:7:${prefix}${hash}`],
]));
// Zero-width and other default-ignorable characters (U+FEFF is covered apart).
const IGNORABLE = ['\u200B', '\u200C', '\u200D', '\u2060', '\u00AD', '\u034F', '\u061C', '\u180E', '\u200E', '\u200F', '\u202E', '\u2061', '\u3164', '\uFE0F', '\uFFA0', '\u{E0020}'];
const SPACES = [' ', '\t', '\n', '\r\n'];

for (const [label, message] of [
  ['bare lowercase hash', HASH],
  ['0x-prefixed hash', `0x${HASH}`],
  ['uppercase hash', HASH.toUpperCase()],
  ['0x-prefixed uppercase hash', `0x${HASH.toUpperCase()}`],
  ['mixed-case hash', HASH.slice(0, 20).toUpperCase() + HASH.slice(20)],
]) {
  test(`sign refuses a transaction hash before consent: ${label}`, async (t) => {
    const { wallet, signed, approvals } = await setup();
    t.after(() => wallet.lock());
    refusal(await wallet.request({ method: 'sign', params: [message] }));
    assert.equal(approvals.length, 0);
    assert.equal(signed.length, 0);
  });
}

for (const [label, message] of [
  ['domain string with chain id', `demos-tx:v1:7:${HASH}`],
  ['domain string with 0x hash and big chain id', `demos-tx:v1:9007199254740991:0x${HASH}`],
  ['bare prefix', 'demos-tx:v1:'],
  ['malformed after the prefix', 'demos-tx:v1:not a hash at all'],
]) {  test(`sign refuses the demos-tx:v1: prefix before consent: ${label}`, async (t) => {
    const { wallet, signed, approvals } = await setup();
    t.after(() => wallet.lock());
    refusal(await wallet.request({ method: 'sign', params: [message] }));
    assert.equal(approvals.length, 0);
    assert.equal(signed.length, 0);
  });
}

// The SDK decodes the message with a default TextDecoder before it signs, which
// drops one leading U+FEFF: "\uFEFF" + hash is signed as exactly the hash. The
// refusal is decided on the text the SDK signs, so none of these reach the signer.
for (const [label, leading] of [['one', BOM], ['two', BOM + BOM], ['three', BOM.repeat(3)]]) {
  test(`sign refuses every transaction form behind ${label} leading U+FEFF before consent`, async (t) => {
    const { wallet, signed, handed, approvals } = await setup();
    t.after(() => wallet.lock());
    const forms = [...FORMS, ['bare domain prefix', 'demos-tx:v1:'], ['malformed after the prefix', 'demos-tx:v1:not a hash at all']];
    for (const [form, text] of forms) refusal(await wallet.request({ method: 'sign', params: [leading + text] }), form);
    assert.equal(approvals.length, 0);
    assert.equal(signed.length, 0);
    assert.equal(handed.length, 0);
  });
}

// Zero-width and default-ignorable characters are kept by the SDK, so a message
// with one next to a hash signs those exact bytes, which are not a transaction
// form: they sign verbatim. Only a domain-form message that still begins with
// "demos-tx:v1:" (the character comes later) is refused.
test('sign: a default-ignorable character before, inside or after a hash signs verbatim unless the text still begins with demos-tx:v1:', async (t) => {
  const { wallet, signed, handed, approvals, address } = await setup();
  t.after(() => wallet.lock());
  let refused = 0, signedCount = 0;
  for (const [form, text] of FORMS) {
    const domain = text.startsWith('demos-tx:v1:');
    for (const char of IGNORABLE) {
      for (const [where, message, stillPrefixed] of [
        ['before', char + text, false],
        ['inside, near the front', text.slice(0, 5) + char + text.slice(5), false],
        ['inside, near the end', text.slice(0, -20) + char + text.slice(-20), domain],
        ['after', text + char, domain],
      ]) {
        const label = `${form}, U+${char.codePointAt(0).toString(16)} ${where}`;
        const calls = handed.length;
        const res = await wallet.request({ method: 'sign', params: [message] });
        if (stillPrefixed) {
          refusal(res, label);
          assert.equal(handed.length, calls, label);
          refused += 1;
          continue;
        }
        assert.equal(res.success, true, label);
        assert.equal(handed.length, calls + 1, label);
        assert.equal(signedText(handed.at(-1)), message, label);
        assert.equal(preimageReached([handed.at(-1)]), false, label);
        assert.equal(verifyDemosSignature({ address, message, signature: res.data.signature }), true, label);
        signedCount += 1;
      }
    }
  }
  assert.ok(refused > 100 && signedCount > 600, `${refused} refused, ${signedCount} signed`);
  assert.equal(approvals.length, signedCount);
  assert.equal(signed.length, signedCount);
});

test('sign: U+FEFF inside or after a hash is kept by the SDK and signs verbatim; spaces, tabs and newlines around a hash sign verbatim', async (t) => {
  const { wallet, handed, approvals, address } = await setup();
  t.after(() => wallet.lock());
  const messages = [];
  for (const [form, text] of FORMS) {
    const domain = text.startsWith('demos-tx:v1:');
    for (const [where, message, stillPrefixed] of [
      ['U+FEFF inside', text.slice(0, 5) + BOM + text.slice(5), false],
      ['U+FEFF after', text + BOM, domain],
      ...SPACES.flatMap((space) => [
        [`${JSON.stringify(space)} before`, space + text, false],
        [`${JSON.stringify(space)} after`, text + space, domain],
        [`${JSON.stringify(space)} both sides`, space + text + space, false],
        [`U+FEFF then ${JSON.stringify(space)} before`, BOM + space + text, false],
      ]),
    ]) {
      const label = `${form}, ${where}`;
      const calls = handed.length;
      const res = await wallet.request({ method: 'sign', params: [message] });
      if (stillPrefixed) {
        refusal(res, label);
        assert.equal(handed.length, calls, label);
        continue;
      }
      assert.equal(res.success, true, label);
      assert.equal(handed.length, calls + 1, label);
      assert.equal(preimageReached([handed.at(-1)]), false, label);
      assert.equal(verifyDemosSignature({ address, message: signedText(handed.at(-1)), signature: res.data.signature }), true, label);
      messages.push(message);
    }
  }
  assert.ok(messages.length > 200);
  assert.equal(approvals.length, messages.length);
});

// The SDK does not normalise, so a compatibility variant of the prefix or of a
// hash signs its own bytes (which are not a transaction form), and the
// signature verifies over exactly those bytes.
test('sign: NFC and NFKC variants of demos-tx:v1: and of a hash sign verbatim', async (t) => {
  const { wallet, handed, approvals, address } = await setup();
  t.after(() => wallet.lock());
  const fullwidthDigit = HASH.replace(/[0-9]/, (d) => String.fromCharCode(0xFF10 + Number(d)));
  const variants = [
    `demos-tx\uFF1Av1:7:${HASH}`,
    `demos-tx:v\u00B9:7:${HASH}`,
    `demos-tx:v\uFF11:7:${HASH}`,
    `demos\uFF0Dtx:v1:7:${HASH}`,
    `\uFF44emos-tx:v1:7:${HASH}`,
    fullwidthDigit,
    `0x${fullwidthDigit}`,
    `demos-tx\uFF1Av1:7:${fullwidthDigit}`,
  ];
  for (const message of variants) {
    assert.notEqual(message.normalize('NFKC'), message, 'a real compatibility variant');
    assert.equal(message.normalize('NFC'), message);
    const calls = handed.length;
    const res = await wallet.request({ method: 'sign', params: [message] });
    assert.equal(res.success, true, message);
    assert.equal(handed.length, calls + 1);
    assert.equal(signedText(handed.at(-1)), message, 'the SDK signs the text as given');
    assert.equal(isPreimage(signedText(handed.at(-1))), false, message);
    assert.equal(verifyDemosSignature({ address, message, signature: res.data.signature }), true, message);
    assert.equal(verifyDemosSignature({ address, message: message.normalize('NFKC'), signature: res.data.signature }), false, message);
  }
  assert.equal(approvals.length, variants.length);
});

test('ordinary messages still sign after exact approval: DACS agreement, portal challenge, and text that merely holds a hash', async (t) => {
  const { wallet, signed, approvals, address } = await setup();
  t.after(() => wallet.lock());
  const messages = [
    `dacs-payee-bound-agreement:v1:${HASH}`,
    `dacs-evidence:v1:${HASH}`,
    renderChallengeMessage({
      origin: 'https://plugin.example.test', purpose: PURPOSES.LOGIN, address, binding: { account: 'acct_fixture' },
      nonce: 'fixture-nonce', issuedAt: '2026-10-03T00:00:00.000Z', expiresAt: '2026-10-03T00:05:00.000Z',
    }),
    `please sign ${HASH}`,
    `${HASH} and more`,
    `${HASH}\n`,
    ` ${HASH}`,
    HASH.slice(1),
    `${HASH}0`,
    `0x${HASH}0`,
    `x demos-tx:v1:7:${HASH}`,
  ];
  for (const message of messages) {
    const res = await wallet.request({ method: 'sign', params: [message] });
    assert.equal(res.success, true, message);
    assert.equal(verifyDemosSignature({ address, message, signature: res.data.signature }), true);
  }
  assert.deepEqual(signed, messages);
  assert.deepEqual(approvals.map((a) => a.message), messages);
});

test('RPC authentication still signs its digest; the digest itself is refused as a page message', async (t) => {
  const { wallet, signed, approvals, address } = await setup({
    transactionTransport: createDevnetNativeWalletTransport({ profile: 'devnet-native', network: 'devnet-test', rpcUrl: 'http://127.0.0.1/portal/api/devnet-native-wallet-rpc', bindingUrl: 'http://127.0.0.1/portal/api/devnet-native-wallet-binding' }),
  });
  t.after(() => wallet.lock());
  const calls = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => { calls.push({ url: String(url), init }); return { ok: false, json: async () => ({ error: 'network_binding_unavailable' }) }; };
  t.after(() => { globalThis.fetch = realFetch; });
  const tx = { content: { type: 'native', from: address, to: PAYEE, amount: '2500000000', nonce: 1, data: ['native', { nativeOperation: 'send', args: [PAYEE, '2500000000'] }] } };
  const res = await wallet.request({ method: 'sendTransaction', params: [tx] });
  assert.equal(res.success, false);
  assert.equal(calls.length, 1);
  const headers = calls[0].init.headers;
  assert.equal(headers.identity, `ed25519:${address}`);
  const digest = createHash('sha256').update(`ed25519:${address}:${headers.timestamp}`).digest('hex');
  assert.deepEqual(signed, [digest]);
  assert.match(headers.signature, /^[0-9a-f]{128}$/);
  assert.equal(verifyDemosSignature({ address, message: digest, signature: headers.signature }), true);
  assert.equal(approvals.length, 0);
  // The same digest, asked for by a page, is a 64-hex string: refused.
  refusal(await wallet.request({ method: 'sign', params: [digest] }));
  assert.deepEqual(signed, [digest]);
  assert.equal(approvals.length, 0);
});

test('no page request method or exported name reaches the internal RPC-auth signer', async (t) => {
  const { wallet, signed, approvals } = await setup();
  t.after(() => wallet.lock());
  const surface = [...Object.keys(providerModule), ...Object.keys(wallet)];
  assert.deepEqual(surface.filter((name) => /sign|auth/i.test(name)), []);
  for (const method of ['signRpcAuthDigest', 'sourceAuthHeaders', 'signMessage', 'signRpcAuth', 'rpcAuth', 'sha256HexOfText']) {
    for (const params of [undefined, [HASH], [{ address: '0x', timestamp: '1' }], ['0x', '1']]) {
      const res = await wallet.request({ method, params });
      assert.equal(res.success, false, method);
      assert.equal(res.error.code, 'unsupported', method);
    }
  }
  assert.equal(signed.length, 0);
  assert.equal(approvals.length, 0);
});

// Fixed-seed generator (mulberry32).
function seeded(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), a | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

test('property: no input reaches the SDK signer as a hash or a demos-tx:v1: string (2400 random cases, fixed seed)', async (t) => {
  const { wallet, signed, handed, approvals, address } = await setup();
  t.after(() => wallet.lock());
  const rand = seeded(0x316);
  const pick = (list) => list[Math.floor(rand() * list.length)];
  const hex = () => Array.from({ length: 64 }, () => pick('0123456789abcdef')).join('');
  const recase = (text) => pick([(s) => s, (s) => s.toUpperCase(), (s) => [...s].map((c) => (rand() < 0.5 ? c.toUpperCase() : c)).join('')])(text);
  const pieces = [BOM, BOM, ...IGNORABLE, ...SPACES, 'x', 'note: ', 'please sign '];
  const noise = () => Array.from({ length: rand() < 0.5 ? 0 : 1 + Math.floor(rand() * 3) }, () => pick(pieces)).join('');
  const lead = () => (rand() < 0.3 ? BOM.repeat(1 + Math.floor(rand() * 2)) : '') + noise();
  const core = () => {
    const kind = Math.floor(rand() * 6);
    const hash = recase(hex());
    if (kind === 0) return hash;
    if (kind === 1) return pick(['0x', '0X']) + hash;
    if (kind === 2) return `demos-tx:v1:${Math.floor(rand() * Number.MAX_SAFE_INTEGER)}:${pick(['', '0x'])}${hash}`;
    if (kind === 3) return pick(['demos-tx:v1:', 'demos-tx:v1:junk']);
    if (kind === 4) return `${pick(['sign ', 'proof of ', ''])}${hash}${pick([' and more', '0', ''])}`;
    return `dacs-evidence:v1:${hash}`;
  };
  const sdkText = (message) => new TextDecoder().decode(new TextEncoder().encode(message));
  let refused = 0, ok = 0, rawStringPasses = 0;
  const CASES = 2400;
  for (let i = 0; i < CASES; i += 1) {
    let message = core();
    if (rand() < 0.4) { const at = Math.floor(rand() * message.length); message = message.slice(0, at) + pick(pieces) + message.slice(at); }
    message = lead() + message + noise();
    const calls = handed.length, asked = approvals.length;
    // A check on the raw string passes this message, yet the SDK would sign a transaction form.
    const rawStringMisses = !isPreimage(message) && isPreimage(sdkText(message));
    const res = await wallet.request({ method: 'sign', params: [message] });
    if (rawStringMisses) {
      rawStringPasses += 1;
      refusal(res, JSON.stringify(message));
    }
    if (!res.success) {
      refusal(res, JSON.stringify(message));
      assert.equal(handed.length, calls, 'a refused message never reaches the signer');
      assert.equal(approvals.length, asked, 'a refused message is never shown for approval');
      refused += 1;
      continue;
    }
    ok += 1;
    assert.equal(handed.length, calls + 1);
    assert.equal(preimageReached(handed.slice(calls)), false, JSON.stringify(message));
    assert.equal(verifyDemosSignature({ address, message: signedText(handed.at(-1)), signature: res.data.signature }), true, JSON.stringify(message));
  }
  // Not vacuous: the generator hit messages a raw-string check passes, and each was refused above.
  assert.equal(refused + ok, CASES);
  t.diagnostic(`${CASES} cases: ${refused} refused, ${ok} signed, ${rawStringPasses} that a raw-string check passes`);
  assert.ok(refused > 300 && ok > 300 && rawStringPasses > 50, `${refused} refused, ${ok} signed, ${rawStringPasses} raw-string misses`);
  assert.equal(signed.length, ok);
  assert.equal(approvals.length, ok);
});
