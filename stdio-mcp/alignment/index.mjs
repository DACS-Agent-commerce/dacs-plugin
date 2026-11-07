import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash, createPrivateKey, createPublicKey, randomBytes, sign, verify } from "node:crypto";
const CARD_HASH = "f59a59914428bddcdef0a5e30d929f5ef44b075906211911ef46af0a5fdeb460";
const CARD_VERSION = "1";
const CARD_PATH = fileURLToPath(new URL("./ALIGNMENT_CARD.md", import.meta.url));
const canonical = (x) => JSON.stringify(normalize(x));
function normalize(x) {
  if (typeof x === "bigint") return x.toString();
  if (x === null || typeof x === "string" || typeof x === "boolean") return x;
  if (typeof x === "number" && Number.isFinite(x)) return x;
  if (Array.isArray(x)) return x.map(normalize);
  if (x && typeof x === "object") return Object.fromEntries(Object.keys(x).sort().filter((k) => x[k] !== void 0).map((k) => [k, normalize(x[k])]));
  throw Error("alignment_invalid_action");
}
const hash = (x) => createHash("sha256").update(canonical(x)).digest("hex");
const bytesHash = (x) => createHash("sha256").update(x).digest("hex");
const DIGITS = /^(0|[1-9][0-9]*)$/;
const zero = "0".repeat(64);
const forbidden = /* @__PURE__ */ new Set(["fraud", "harm", "deception", "coercion", "property_harm", "rights_harm"]);
const domain = "demos-conduct:v1:";
function signedEnvelope(body, key) {
  return { body, signature: sign(null, Buffer.from(domain + canonical(body)), key).toString("base64") };
}
function validEnvelope(e, key) {
  try {
    return !!key && verify(null, Buffer.from(domain + canonical(e.body)), key, Buffer.from(e.signature, "base64"));
  } catch {
    return false;
  }
}
function exists(p) {
  try {
    fs.lstatSync(p);
    return true;
  } catch (e) {
    if (e.code === "ENOENT") return false;
    throw e;
  }
}
function safePath(p) {
  for (let d = path.resolve(p); ; d = path.dirname(d)) {
    if (exists(d) && fs.lstatSync(d).isSymbolicLink()) throw Error("alignment_unsafe_path");
    if (d === path.dirname(d)) break;
  }
}
function privateRead(p) {
  safePath(p);
  const fd = fs.openSync(p, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const s = fs.fstatSync(fd);
    if (!s.isFile() || s.uid !== process.getuid() || s.mode & 63 || s.size > 16e6) throw Error("alignment_unsafe_file");
    return JSON.parse(fs.readFileSync(fd, "utf8"));
  } finally {
    fs.closeSync(fd);
  }
}
function atomic(p, x) {
  safePath(p);
  const tmp = p + "." + randomBytes(8).toString("hex");
  const fd = fs.openSync(tmp, "wx", 384);
  try {
    fs.writeFileSync(fd, canonical(x) + "\n");
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, p);
  const dir = fs.openSync(path.dirname(p), "r");
  try {
    fs.fsyncSync(dir);
  } finally {
    fs.closeSync(dir);
  }
}
function cardStatus(cardPath = CARD_PATH) {
  try {
    const text = fs.readFileSync(cardPath, "utf8");
    const verified = bytesHash(text) === CARD_HASH;
    return { verified, hash: bytesHash(text), text: verified ? text : "UNALIGNED BUILD: altered alignment card. Writes disabled; reads and repair available." };
  } catch {
    return { verified: false, hash: null, text: "Alignment card unavailable. Unaligned build: writes disabled; reads and repair available." };
  }
}
function approvalIdentity(approval, trusted) {
  return hash(trusted ? {hash:approval.hash,expires_at:approval.expires_at,stop_generation:approval.stop_generation,private_consent:approval.private_consent,nonce:approval.nonce} : approval.envelope.body);
}
function alignmentGate(action, { stopped = false, generation = 0, cardVerified = true, mandate = null, usage = "0", humanKey = null, revoked = [], approval = null, trustedApproval = false, now = Date.now(), phase = "preview", used = [] } = {}) {
  const amount = action.cost_os ?? "0";
  if (typeof amount !== "string" || !DIGITS.test(amount) || typeof action.kind !== "string") return { decision: "refuse", tier: 2, rules: ["A2"], outcome: "invalid_action" };
  if (action.read === true) return { decision: "allow", tier: 0, rules: ["A1"], outcome: cardVerified ? "read" : "unaligned_read" };
  if (stopped) return { decision: "stop", tier: 2, rules: ["A6"], outcome: "stopped" };
  if (!cardVerified) return { decision: "refuse", tier: 2, rules: ["A1"], outcome: "unaligned_build" };
  if (forbidden.has(action.category)) return { decision: "refuse", tier: 2, rules: ["A7"], outcome: "final_refusal" };
  if (action.identity_claim && !action.linked_claims?.includes(action.identity_claim)) return { decision: "refuse", tier: 2, rules: ["A3"], outcome: "identity_mismatch" };
  if (action.offer && action.shared_owner && !action.disclosed) return { decision: "refuse", tier: 2, rules: ["A4"], outcome: "ownership_not_disclosed" };
  if (action.private_data && !action.minimal) return { decision: "refuse", tier: 2, rules: ["A5"], outcome: "private_not_minimized" };
  const m = mandate?.body;
  const standing = !action.one_way && !action.private_data && validEnvelope(mandate, humanKey) && m.type === "mandate" && m.actor === action.actor && m.network === action.network && Array.isArray(m.scopes) && m.scopes.includes(action.kind) && Array.isArray(m.counterparties) && m.counterparties.includes(action.recipient) && typeof m.max_os === "string" && typeof m.cap_os === "string" && DIGITS.test(m.max_os) && DIGITS.test(m.cap_os) && DIGITS.test(usage) && BigInt(amount) <= BigInt(m.max_os) && BigInt(usage) + BigInt(amount) <= BigInt(m.cap_os) && Number.isSafeInteger(m.expires_at) && now < m.expires_at && typeof m.id === "string" && !revoked.includes(m.id);
  if (standing) return { decision: "allow", tier: 1, rules: ["A1", "A2"], outcome: "standing_mandate", mandate_hash: hash(m) };
  const exact = approval && approval.hash === hash(action) && (trustedApproval || validEnvelope(approval.envelope, humanKey) && approval.envelope.body.type === "approval" && approval.envelope.body.action_hash === hash(action) && approval.envelope.body.expires_at === approval.expires_at && approval.envelope.body.private_consent === approval.private_consent && approval.envelope.body.stop_generation === approval.stop_generation);
  if (exact && (!Number.isSafeInteger(approval.stop_generation) || approval.stop_generation !== generation)) return {decision:"refuse",tier:2,rules:["A6"],outcome:"stale_approval_generation"};
  if (exact && (!Number.isSafeInteger(approval.expires_at) || now >= approval.expires_at)) return { decision: "refuse", tier: 2, rules: ["A1"], outcome: "approval_timeout" };
  if (exact && phase === "execute" && used.includes(approvalIdentity(approval,trustedApproval))) return { decision: "refuse", tier: 2, rules: ["A1"], outcome: "approval_replayed" };
  if (exact && action.private_data && approval.private_consent !== true) return { decision: "refuse", tier: 2, rules: ["A5"], outcome: "private_consent_missing" };
  if (exact) return { decision: "allow", tier: 2, rules: ["A1", ...action.private_data ? ["A5"] : []], outcome: "exact_human_approval" };
  return { decision: "ask", tier: 2, rules: ["A1", "A2", ...action.private_data ? ["A5"] : []], outcome: "exact_approval_required" };
}
function verifyReceipts(rows, { issuer, cardHash = CARD_HASH, expectedHead, fromDay, toDay } = {}) {
  const failures = rows.length ? [] : ["missing_receipts"];
  let prev = zero, seq = 0;
  const days = /* @__PURE__ */ new Set();
  for (const r of rows) {
    const { signature, digest, ...body } = r;
    seq++;
    if (r.seq !== seq || r.previous !== prev) failures.push("chain_gap");
    if (r.card_hash !== cardHash || r.card_version !== CARD_VERSION || r.build !== "verified") failures.push("foreign_or_missing_card");
    if (!issuer || r.issuer !== issuer) failures.push("foreign_issuer");
    if (hash(body) !== digest || !validEnvelope({ body, signature }, r.issuer)) failures.push("bad_signature");
    if (r.kind === "heartbeat") days.add(r.day);
    prev = digest;
  }
  if (expectedHead !== void 0 && prev !== expectedHead) failures.push("tail_missing");
  if (fromDay && toDay) {
    for (let d = Date.parse(fromDay); d <= Date.parse(toDay); d += 864e5) if (!days.has(new Date(d).toISOString().slice(0, 10))) failures.push("missing_day");
  }
  return { valid: failures.length === 0, failures: [...new Set(failures)], head: prev, count: seq };
}
class Alignment {
  constructor({ home, cardPath = CARD_PATH, humanKey = null, killPaths = [], kill = () => false, onStop = () => {
  }, now = Date.now } = {}) {
    if (!home) throw Error("alignment_state_required");
    Object.assign(this, { home, cardPath, humanKey, killPaths, kill, onStop, now });
  }
  state() {
    return this.#locked((s) => structuredClone(s), false);
  }
  #locked(fn, save = true) {
    safePath(this.home);
    fs.mkdirSync(this.home, { recursive: true, mode: 448 });
    safePath(this.home);
    if (fs.statSync(this.home).mode & 63 || fs.statSync(this.home).uid !== process.getuid()) throw Error("alignment_unsafe_home");
    const lock = path.join(this.home, "conduct.lock");
    try {
      fs.mkdirSync(lock, { mode: 448 });
    } catch {
      throw Error("alignment_busy");
    }
    try {
      const keyFile = path.join(this.home, "conduct-key.json");
      let k;
      if (exists(keyFile)) k = privateRead(keyFile);
      else {
        k = { seed: randomBytes(32).toString("hex") };
        atomic(keyFile, k);
      }
      if (!/^[0-9a-f]{64}$/.test(k.seed)) throw Error("alignment_bad_key");
      this.key = createPrivateKey({ key: Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), Buffer.from(k.seed, "hex")]), format: "der", type: "pkcs8" });
      this.issuer = createPublicKey(this.key).export({ type: "spki", format: "pem" }).toString();
      const file = path.join(this.home, "conduct.json");
      const hadState = exists(file);
      const s = hadState ? privateRead(file) : { schema: "demos-conduct/1", receipts: [], heartbeats: [], usage: {}, authorizations: {}, used: [], revoked: [], stop: false, stop_generation: 0 };
      if(hadState){const {seal,...body}=s;if(!validEnvelope(seal,this.issuer)||seal.body.state_hash!==hash(body))throw Error('alignment_state_tampered');}
      delete s.seal;
      if (s.schema !== "demos-conduct/1" || !Array.isArray(s.receipts) || !Array.isArray(s.heartbeats) || !s.usage || !Array.isArray(s.used) || !Array.isArray(s.revoked) || !Number.isSafeInteger(s.stop_generation) || typeof s.stop !== "boolean") throw Error("alignment_bad_state");
      const check = verifyReceipts(s.receipts, { issuer: this.issuer });
      if (check.failures.some((x) => !["foreign_or_missing_card", "missing_receipts"].includes(x))) throw Error("alignment_broken_chain");
      const out = fn(s);
      if (save) this.#persist(s);
      return out;
    } finally {
      fs.rmdirSync(lock);
    }
  }
  #persist(s) {
    atomic(path.join(this.home, "conduct.json"), { ...s, seal: signedEnvelope({state_hash:hash(s)}, this.key) });
  }
  #receipt(s, action, r, kind = "decision") {
    const card = cardStatus(this.cardPath), body = { schema: "demos-conduct-receipt/1", kind, seq: s.receipts.length + 1, previous: s.receipts.at(-1)?.digest ?? zero, day: new Date(this.now()).toISOString().slice(0, 10), at: this.now(), issuer: this.issuer, card_version: CARD_VERSION, card_hash: card.hash, build: card.verified ? "verified" : "unaligned", action_hash: hash(action), tier: r.tier, rules: r.rules, decision: r.decision, outcome: r.outcome, ...(r.decision==='stop'?{stop_generation:s.stop_generation,stop_latency_ms:s.stop_latency_ms,irreversible_action_hashes:s.irreversible_action_hashes??[],inflight_action_hashes:s.inflight_action_hashes??[]}:{}), ...r.mandate_hash ? { mandate_hash: r.mandate_hash } : {} };
    const row = { ...body, digest: hash(body), signature: signedEnvelope(body, this.key).signature };
    s.receipts.push(row);
    return row;
  }
  #stop(s) {
    let active = this.kill();
    const signals = [];
    for (const p of [...this.killPaths, path.join(this.home, "STOP"), path.join(this.home, "KILL")]) if (exists(p)) {active = true; signals.push(fs.lstatSync(p).mtimeMs);}
    if (active && !s.stop) {
      s.stop = true;
      s.stop_generation++;
      s.stop_at = this.now();
      const signal=signals.length?Math.min(...signals):null;
      s.stop_latency_ms=signal!==null&&signal<=s.stop_at?Math.ceil(s.stop_at-signal):null;
      s.irreversible_action_hashes=[...new Set(s.receipts.filter(r=>['included','signed','unknown'].includes(r.outcome)).map(r=>r.action_hash))];
      const approvals=new Map(), completed=new Map();
      for(const r of s.receipts){
        if(s.authorizations?.[r.digest])approvals.set(r.action_hash,(approvals.get(r.action_hash)??0)+1);
        if(['included','signed','unknown','failed','cancelled'].includes(r.outcome))completed.set(r.action_hash,(completed.get(r.action_hash)??0)+1);
      }
      s.inflight_action_hashes=[...approvals].filter(([actionHash,count])=>count>(completed.get(actionHash)??0)).map(([actionHash])=>actionHash);
      s.revoked_all_at = this.now();
      // STOP is a durable fact even if resume, policy evaluation or cancellation fails.
      this.#receipt(s, {kind:"stop-observed", generation:s.stop_generation}, {decision:"stop",tier:0,rules:["A6"],outcome:"stop_observed"});
      this.#persist(s);
      this.onStop();
    }
    return s.stop;
  }
  decide(action, options = {}) {
    return this.#locked((s) => {
      const stopped = this.#stop(s);
      const m = options.mandate?.body;
      const mHash = m ? hash(m) : null;
      const revoked = [...s.revoked];
      if (s.revoked_all_at && m && (!Number.isSafeInteger(m.issued_at) || m.issued_at <= s.revoked_all_at)) revoked.push(m.id);
      const r = alignmentGate(action, { ...options, stopped, generation:s.stop_generation, cardVerified: cardStatus(this.cardPath).verified, humanKey: this.humanKey, now: this.now(), usage: s.usage[mHash] ?? "0", revoked, used: s.used });
      if (r.decision === "allow" && options.phase === "execute") {
        if (r.tier === 1) s.usage[mHash] = (BigInt(s.usage[mHash] ?? "0") + BigInt(action.cost_os ?? "0")).toString();
        if (r.tier === 2) s.used.push(approvalIdentity(options.approval,options.trustedApproval));
      }
      const receipt = this.#receipt(s, action, r);
      if (r.decision === "allow" && options.phase === "execute") {
        s.authorizations ??= {};
        s.authorizations[receipt.digest] = { generation: s.stop_generation, expires_at: r.tier === 1 ? m.expires_at : options.approval?.expires_at ?? this.now(), mandate_id: r.tier === 1 ? m.id : null };
      }
      return { ...r, receipt };
    });
  }
  checkpoint(action, receipt) {
    return this.#locked((s) => {
      const row = s.receipts.find((r2) => r2.digest === receipt?.digest);
      if (!row || row.action_hash !== hash(action) || row.decision !== "allow") throw Error("alignment_invalid_permit");
      const stopped = this.#stop(s), card = cardStatus(this.cardPath), a = s.authorizations?.[row.digest];
      let r = null;
      if (stopped) r = { decision: "stop", tier: row.tier, rules: ["A6"], outcome: "stopped" };
      else if (!card.verified) r = { decision: "refuse", tier: row.tier, rules: ["A1"], outcome: "unaligned_build" };
      else if (!a || a.generation !== s.stop_generation || this.now() >= a.expires_at || a.mandate_id && s.revoked.includes(a.mandate_id)) r = { decision: "refuse", tier: row.tier, rules: ["A1", "A2"], outcome: "permit_expired_or_revoked" };
      return r ? { ...r, receipt: this.#receipt(s, action, r) } : { decision: "allow", receipt: row };
    });
  }
  outcome(action, permit, outcome) {
    return this.#locked((s) => {
      if (!s.receipts.some((r) => r.digest === permit?.digest && r.action_hash === hash(action) && r.decision === "allow")) throw Error("alignment_invalid_permit");
      if (!["included", "signed", "unknown", "failed", "cancelled", "prepared"].includes(outcome)) throw Error("alignment_bad_outcome");
      return this.#receipt(s, action, { tier: permit.tier, rules: permit.rules, decision: "allow", outcome });
    });
  }
  resume(envelope) {
    return this.#locked((s) => {
      if (this.#stop(s) && this.killPaths.some(exists) || exists(path.join(this.home, "STOP")) || exists(path.join(this.home, "KILL")) || this.kill()) throw Error("alignment_stop_present");
      const b = envelope?.body;
      if (!validEnvelope(envelope, this.humanKey) || b.type !== "resume" || b.generation !== s.stop_generation || !Number.isSafeInteger(b.expires_at) || this.now() >= b.expires_at) throw Error("alignment_signed_resume_required");
      s.stop = false;
      this.#receipt(s, { kind: "resume", generation: b.generation }, { decision: "allow", tier: 0, rules: ["A6"], outcome: "resumed" });
    });
  }
  revoke(envelope) {
    return this.#locked((s) => {
      const b = envelope?.body;
      if (!validEnvelope(envelope, this.humanKey) || b.type !== "revoke" || typeof b.id !== "string" || !Number.isSafeInteger(b.expires_at) || this.now() >= b.expires_at) throw Error("alignment_signed_revocation_required");
      s.revoked.push(b.id);
      this.#receipt(s, { kind: "revoke", id: b.id }, { decision: "allow", tier: 0, rules: ["A2"], outcome: "revoked" });
    });
  }
  prompt(action) {
    return this.#locked((s) => this.#receipt(s, action, { decision: "ask", tier: 2, rules: ["A1"], outcome: "prompt_delivered" }));
  }
  heartbeat() {
    return this.#locked((s) => {
      const day = new Date(this.now()).toISOString().slice(0, 10);
      const old = s.heartbeats.find((h2) => h2.day === day);
      const rows = s.receipts.filter((r) => r.day === day && r.kind === "decision");
      const tiers = [0, 1, 2].map((t) => rows.filter((r) => r.tier === t).length);
      const stops = rows.filter((r) => r.decision === "stop");
      const line = `card ${cardStatus(this.cardPath).verified ? "verified" : "UNALIGNED"} \xB7 tiers ${tiers.join("/")} \xB7 refusals ${rows.filter((r) => r.decision === "refuse").length} \xB7 STOPs ${stops.length} latency ${stops.length ? (s.stop_latency_ms===null?"unknown":`${s.stop_latency_ms}ms`) : "n/a"} \xB7 prompts ${rows.filter((r) => r.outcome === "prompt_delivered").length} \xB7 battery unknown \xB7 false refusals unknown`;
      if (old?.line === line) return old;
      const receipt = this.#receipt(s, { kind: "heartbeat", day, line }, { decision: "allow", tier: 0, rules: ["A1"], outcome: "daily_heartbeat" }, "heartbeat");
      const h = { day, line, receipt };
      if (old) s.heartbeats[s.heartbeats.indexOf(old)] = h;
      else s.heartbeats.push(h);
      return h;
    });
  }
}
export {
  Alignment,
  CARD_HASH,
  CARD_PATH,
  CARD_VERSION,
  alignmentGate,
  cardStatus,
  hash,
  signedEnvelope,
  verifyReceipts
};
