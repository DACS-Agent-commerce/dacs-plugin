// Browser tests that drive a purchase call requireSdkPurchases right before their first purchase step. They boot the
// app through loadConfig, which still refuses SDK purchases on, so src/app.mjs builds its off composition: listing
// verification and every purchase action refuse sdk_purchases_off, and such a test stops here with one fixed line
// instead of a page timeout, after the steps before it have run. Its test/expected-until-card.json entry names the card that composes purchases again; that card removes
// the call together with the entry.
export const SDK_PURCHASES_OFF = 'SDK purchases are off: src/app.mjs composes no listing verifier or purchase service, so the purchase path this test drives refuses sdk_purchases_off';

/** Resolves when the app at `origin` reports SDK purchases on in /health; otherwise rejects Error SDK_PURCHASES_OFF. */
export async function requireSdkPurchases(origin) {
  const health = await (await fetch(new URL('/health', origin))).json();
  if (health?.sdkPurchases?.switch !== 'on') throw new Error(SDK_PURCHASES_OFF);
}
