export const CARD_HASH: string;
export const CARD_VERSION: string;
export const CARD_PATH: string;
export function signedEnvelope(body: any, key: any): any;
export function hash(value: unknown): string;
export function cardStatus(path?: string): {verified: boolean; hash: string | null; text: string};
export function verifyReceipts(rows: any[], options?: any): any;
export class Alignment {
 constructor(options: any);
 decide(action: any, options?: any): any;
 checkpoint(action: any, receipt: any): any;
 outcome(action: any, receipt: any, outcome: string): any;
 state(): any;
 heartbeat(): any;
 prompt(action: any): any;
 resume(envelope: any): any;
 revoke(envelope: any): any;
}
