/**
 * The client's purchase readback cache, unchanged: createPurchaseReadbackCache({ loadPurchase, limit })
 * returns read, stageChange and close. Its read runs the host's verification and currentness callbacks
 * on every read and never persists settlement; invalid options throw TypeError. The plugin adds no rule,
 * state or age of its own.
 */
export { createPurchaseReadbackCache } from '@kynesyslabs/dacs-client';
