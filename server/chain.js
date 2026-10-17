// The public record on Solana (devnet).
//
// When the community confirms something (a hazard confirmed or fixed, litter picked up or gone),
// ScootSense writes one line into Solana's public ledger with the Memo program, e.g.
//
//   ScootSense | hazard H12 pothole confirmed | 3 confirmations, seen on 4 rides | 43.7841,-79.187 | sha256:9f2c…
//
// The hash covers the facts stored in Tiger (chain.records.snapshot). Anyone can recompute it,
// so if our database is ever edited afterwards, verify() shows the mismatch. The riders who
// helped get SCOOT points (a Token-2022 token on devnet, no monetary value), minted to the
// wallet they linked; rewards wait in Tiger until a wallet is linked.
//
// Writes are queued in Tiger first, then sent after the reply (Vercel waitUntil), so a slow
// network never slows the app down, and a failed send is retried later.
import crypto from 'node:crypto';
import { Connection, Keypair, PublicKey, Transaction, TransactionInstruction, sendAndConfirmTransaction, clusterApiUrl } from '@solana/web3.js';
import { TOKEN_2022_PROGRAM_ID, getAssociatedTokenAddressSync, createAssociatedTokenAccountIdempotentInstruction, createMintToInstruction } from '@solana/spl-token';
import { waitUntil } from '@vercel/functions';
import * as users from './userdb.js';
import * as store from './store.js';
import { CLASS_INFO } from '../shared/signal.js';

const CLUSTER = 'devnet';
const MEMO_PROGRAM = new PublicKey('MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr');
/** Network footprint per transaction, from the Solana Foundation's sustainability dashboard. */
export const FOOTPRINT = { gCo2PerTx: 0.00257, whPerTx: 0.00806, source: 'Solana Foundation sustainability dashboard', asOf: '2026-10-16' };
/** SCOOT per helper; one reward per person per confirmed event, capped. */
const POINTS = { detected: 2, confirmed: 1, photo: 2, fixed: 1, reported: 3, seen: 1, gone: 1, picked: 5 };
const MAX_REWARD = 10;

const bad = (msg, status = 400) => Object.assign(new Error(msg), { status });
const tiger = () => users.backend() === 'tiger';
const round4 = (x) => Math.round(x * 1e4) / 1e4;
export const explorer = (id, type = 'tx') => `https://explorer.solana.com/${type}/${id}?cluster=${CLUSTER}`;

// ---------------------------------------------------------------- setup

let payer = null;
let conn = null;

function ready() {
  if (payer !== null) return Boolean(payer);
  payer = false;
  if (process.env.SOLANA_SECRET_KEY && process.env.SOLANA_MINT) {
    try {
      payer = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(process.env.SOLANA_SECRET_KEY)));
      conn = new Connection(process.env.SOLANA_RPC || clusterApiUrl(CLUSTER), 'confirmed');
    } catch {
      console.error('SOLANA_SECRET_KEY is not a valid secret key array; Solana is off');
      payer = false;
    }
  }
  return Boolean(payer);
}
export const enabled = () => ready();
const mint = () => new PublicKey(process.env.SOLANA_MINT.trim());

// ---------------------------------------------------------------- hashing

/** JSON with sorted keys, so the same facts always hash the same. */
const canon = (v) => (Array.isArray(v) ? `[${v.map(canon).join(',')}]`
  : v && typeof v === 'object' ? `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canon(v[k])}`).join(',')}}`
    : JSON.stringify(v));
export const hashOf = (snapshot) => crypto.createHash('sha256').update(canon(snapshot)).digest('hex');

// ---------------------------------------------------------------- storage (Tiger, or memory when local)

function mem() {
  const db = store.getDb();
  db.chain ??= { records: [], rewards: [], wallets: {}, seq: 0 };
  return db.chain;
}

const recordFrom = (r) => ({ id: r.id, time: new Date(r.time).toISOString(), kind: r.kind, ref: r.ref, event: r.event, snapshot: r.snapshot,
  hash: r.hash, memo: r.memo, status: r.status, signature: r.signature, error: r.error });
const rewardFrom = (r) => ({ id: r.id, time: new Date(r.time).toISOString(), actorId: r.actor_id ?? r.actorId, recordId: r.record_id ?? r.recordId,
  amount: r.amount, reason: r.reason, status: r.status, wallet: r.wallet, signature: r.signature, error: r.error, ref: r.ref });

/** Queue one confirmed event and the rewards for the people who helped. Returns null if already on record. */
async function recordEvent({ kind, ref, event, summary, facts, helpers }) {
  const snapshot = { app: 'ScootSense', v: 1, kind, ref, event, facts, at: new Date().toISOString() };
  const hash = hashOf(snapshot);
  const memo = `ScootSense | ${summary} | sha256:${hash}`;
  const byActor = new Map();
  for (const h of helpers) {
    if (!h.actor || h.actor === 'anon') continue;
    const cur = byActor.get(h.actor) || { amount: 0, reasons: [] };
    cur.amount += h.amount;
    if (!cur.reasons.includes(h.reason)) cur.reasons.push(h.reason);
    byActor.set(h.actor, cur);
  }
  let recordId;
  if (tiger()) {
    const { rows } = await users.sql(`INSERT INTO chain.records (kind, ref, event, snapshot, hash, memo) VALUES ($1, $2, $3, $4, $5, $6)
      ON CONFLICT (kind, ref, event) DO NOTHING RETURNING id`, [kind, ref, event, JSON.stringify(snapshot), hash, memo]);
    if (!rows[0]) return null;
    recordId = rows[0].id;
    for (const [actor, r] of byActor) {
      await users.sql('INSERT INTO chain.rewards (actor_id, record_id, amount, reason) VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING',
        [actor, recordId, Math.min(r.amount, MAX_REWARD), r.reasons.join(', ')]);
    }
  } else {
    const m = mem();
    if (m.records.some((r) => r.kind === kind && r.ref === ref && r.event === event)) return null;
    recordId = ++m.seq;
    const time = new Date().toISOString();
    m.records.push({ id: recordId, time, kind, ref, event, snapshot, hash, memo, status: 'pending', signature: null, error: null });
    for (const [actor, r] of byActor) {
      m.rewards.push({ id: ++m.seq, time, actorId: actor, recordId, amount: Math.min(r.amount, MAX_REWARD), reason: r.reasons.join(', '), status: 'pending', wallet: null, signature: null });
    }
    store.save();
  }
  schedule();
  return recordId;
}

// ---------------------------------------------------------------- events

/** A hazard was confirmed by the community, or reported fixed. `h` is the raw hazard. */
export async function hazardEvent(h, event) {
  const label = (CLASS_INFO[h.type]?.label || h.type).toLowerCase();
  const facts = { type: h.type, severity: h.severity, confirmations: h.votes.confirm, dismissals: h.votes.dismiss,
    rides: h.rideIds.length, lat: round4(h.lat), lng: round4(h.lng), firstSeen: h.firstSeen };
  const ref = `H${h.no}`;
  const helpers = [];
  if (event === 'confirmed') {
    const riders = store.getDb().rides.filter((r) => h.rideIds.includes(r.id) && r.userId).map((r) => r.userId);
    riders.forEach((actor) => helpers.push({ actor, amount: POINTS.detected, reason: `detected ${ref} on a ride` }));
    (h.voters || []).filter((v) => v.vote === 'confirm').forEach((v) => helpers.push({ actor: v.by, amount: POINTS.confirmed, reason: `confirmed ${ref}` }));
    (h.photos || []).filter((p) => p.by && p.analysis?.isRoadDefect).forEach((p) => helpers.push({ actor: p.by, amount: POINTS.photo, reason: `photographed ${ref}` }));
  } else {
    (h.voters || []).filter((v) => v.vote === 'fixed').forEach((v) => helpers.push({ actor: v.by, amount: POINTS.fixed, reason: `reported ${ref} fixed` }));
  }
  const summary = event === 'confirmed'
    ? `hazard ${ref} ${label} confirmed | ${facts.confirmations} confirmation${facts.confirmations === 1 ? '' : 's'}, seen on ${facts.rides} ride${facts.rides === 1 ? '' : 's'} | ${facts.lat},${facts.lng}`
    : `hazard ${ref} ${label} reported fixed | ${facts.lat},${facts.lng}`;
  return recordEvent({ kind: 'hazard', ref, event, summary, facts, helpers });
}

/** A litter pin came off the map: picked up, or confirmed gone by other riders. */
export async function litterEvent(l, outcome, by) {
  const ref = `L${l.no}`;
  const checks = l.checks || [];
  const people = (answer) => [...new Set(checks.filter((c) => c.answer === answer && c.by && c.by !== 'anon').map((c) => c.by))];
  const seen = people('still');
  const materials = [...new Set((l.items || []).map((i) => i.material).filter(Boolean))].sort();
  const facts = { items: (l.items || []).length, materials, outcome, seenStillThere: seen.length, reportedOn: String(l.at || '').slice(0, 10) };
  const helpers = [];
  if (outcome === 'picked' && by) helpers.push({ actor: by, amount: POINTS.picked, reason: `picked up ${ref}` });
  if (outcome === 'gone') people('gone').forEach((actor) => helpers.push({ actor, amount: POINTS.gone, reason: `reported ${ref} gone` }));
  seen.forEach((actor) => helpers.push({ actor, amount: POINTS.seen, reason: `confirmed ${ref} was there` }));
  // The reporter is rewarded once someone else backed the report up.
  if (l.reporterId && (seen.some((a) => a !== l.reporterId) || (outcome === 'picked' && by && by !== l.reporterId))) {
    helpers.push({ actor: l.reporterId, amount: POINTS.reported, reason: `reported ${ref}` });
  }
  const what = facts.items ? `${facts.items} item${facts.items === 1 ? '' : 's'}${materials.length ? ` (${materials.join(', ')})` : ''}` : 'litter';
  const summary = `litter ${ref} ${outcome === 'picked' ? 'picked up' : 'confirmed gone'} | ${what} | ${seen.length} rider${seen.length === 1 ? '' : 's'} confirmed it was there`;
  return recordEvent({ kind: 'litter', ref, event: outcome === 'picked' ? 'picked' : 'gone', summary, facts, helpers });
}

// ---------------------------------------------------------------- sending

let flushing = null;

/** Send queued records, then rewards for riders with a linked wallet. One sender per instance. */
export function flush() {
  if (!ready()) return Promise.resolve();
  flushing ??= (async () => {
    try {
      for (let i = 0; i < 10; i++) { const r = await claim('records'); if (!r) break; await sendRecord(r); }
      for (let i = 0; i < 20; i++) { const w = await claim('rewards'); if (!w) break; await sendReward(w); }
    } finally {
      flushing = null;
    }
  })();
  return flushing;
}

/** Keep sending after the reply has gone out (Vercel keeps the function alive for it). */
function schedule() {
  if (!ready()) return;
  const p = flush().catch((e) => console.error('solana', e.message));
  try { waitUntil(p); } catch {}
}
export const kick = schedule;

const RETRY = `(status = 'pending' OR (status = 'sending' AND claimed_at < now() - interval '2 minutes') OR (status = 'failed' AND claimed_at < now() - interval '5 minutes'))`;

const RETRY_R = `(r.status = 'pending' OR (r.status = 'sending' AND r.claimed_at < now() - interval '2 minutes') OR (r.status = 'failed' AND r.claimed_at < now() - interval '5 minutes'))`;

async function claim(kind) {
  if (tiger()) {
    if (kind === 'records') {
      const { rows } = await users.sql(`UPDATE chain.records SET status = 'sending', claimed_at = now() WHERE id = (
        SELECT id FROM chain.records WHERE ${RETRY} ORDER BY id LIMIT 1 FOR UPDATE SKIP LOCKED) RETURNING *`);
      return rows[0] ? recordFrom(rows[0]) : null;
    }
    const { rows } = await users.sql(`UPDATE chain.rewards w SET status = 'sending', claimed_at = now(), wallet = x.address FROM (
        SELECT r.id, wl.address, rec.ref FROM chain.rewards r
        JOIN chain.wallets wl ON wl.actor_id = r.actor_id
        JOIN chain.records rec ON rec.id = r.record_id AND rec.status = 'sent'
        WHERE ${RETRY_R}
        ORDER BY r.id LIMIT 1 FOR UPDATE OF r SKIP LOCKED) x
      WHERE w.id = x.id RETURNING w.*, x.ref`);
    return rows[0] ? rewardFrom(rows[0]) : null;
  }
  const m = mem();
  const old = (t) => Date.now() - new Date(t || 0).getTime();
  const due = (x) => x.status === 'pending' || (x.status === 'sending' && old(x.claimedAt) > 120e3) || (x.status === 'failed' && old(x.claimedAt) > 300e3);
  if (kind === 'records') {
    const r = m.records.find(due);
    if (r) Object.assign(r, { status: 'sending', claimedAt: new Date().toISOString() });
    return r || null;
  }
  const w = m.rewards.find((x) => due(x) && m.wallets[x.actorId] && m.records.find((r) => r.id === x.recordId)?.status === 'sent');
  if (w) Object.assign(w, { status: 'sending', claimedAt: new Date().toISOString(), wallet: m.wallets[w.actorId].address, ref: m.records.find((r) => r.id === w.recordId).ref });
  return w || null;
}

async function mark(kind, id, status, signature = null, error = null) {
  if (tiger()) {
    await users.sql(`UPDATE chain.${kind} SET status = $2, signature = COALESCE($3, signature), error = $4, sent_at = CASE WHEN $2 = 'sent' THEN now() ELSE sent_at END WHERE id = $1`,
      [id, status, signature, error]);
  } else {
    const x = mem()[kind].find((r) => r.id === id);
    Object.assign(x, { status, signature: signature || x.signature, error });
    store.save();
  }
}

const memoIx = (text) => new TransactionInstruction({ keys: [{ pubkey: payer.publicKey, isSigner: true, isWritable: true }], programId: MEMO_PROGRAM, data: Buffer.from(text, 'utf8') });
const send = (ixs) => sendAndConfirmTransaction(conn, new Transaction().add(...ixs), [payer], { commitment: 'confirmed' });

async function sendRecord(r) {
  try {
    await mark('records', r.id, 'sent', await send([memoIx(r.memo)]));
  } catch (e) {
    console.error('solana record', r.id, e.message);
    await mark('records', r.id, 'failed', null, e.message.slice(0, 300));
  }
}

async function sendReward(w) {
  try {
    const owner = new PublicKey(w.wallet);
    const ata = getAssociatedTokenAddressSync(mint(), owner, false, TOKEN_2022_PROGRAM_ID);
    const sig = await send([
      createAssociatedTokenAccountIdempotentInstruction(payer.publicKey, ata, owner, mint(), TOKEN_2022_PROGRAM_ID),
      createMintToInstruction(mint(), ata, payer.publicKey, w.amount, [], TOKEN_2022_PROGRAM_ID),
      memoIx(`ScootSense reward | ${w.amount} SCOOT | ${w.reason}`),
    ]);
    await mark('rewards', w.id, 'sent', sig);
  } catch (e) {
    console.error('solana reward', w.id, e.message);
    await mark('rewards', w.id, 'failed', null, e.message.slice(0, 300));
  }
}

// ---------------------------------------------------------------- wallets & reading

export async function linkWallet(actor, address) {
  let pk;
  try { pk = new PublicKey(String(address || '').trim()); } catch { throw bad('That does not look like a Solana wallet address'); }
  if (!PublicKey.isOnCurve(pk.toBytes())) throw bad('Use your wallet address (from Phantom), not a token or program address');
  if (tiger()) {
    await users.sql(`INSERT INTO chain.wallets (actor_id, address) VALUES ($1, $2)
      ON CONFLICT (actor_id) DO UPDATE SET address = EXCLUDED.address, linked_at = now()`, [actor, pk.toBase58()]);
  } else {
    mem().wallets[actor] = { address: pk.toBase58(), linkedAt: new Date().toISOString() };
    store.save();
  }
  schedule(); // pay out anything that was waiting for a wallet
}

export async function unlinkWallet(actor) {
  if (tiger()) await users.sql('DELETE FROM chain.wallets WHERE actor_id = $1', [actor]);
  else { delete mem().wallets[actor]; store.save(); }
}

const view = (w) => ({ amount: w.amount, reason: w.reason, time: w.time, status: w.status === 'sent' ? 'sent' : w.status === 'failed' ? 'retrying' : 'waiting',
  url: w.signature ? explorer(w.signature) : null });

/** The signed-in rider's SCOOT: what was sent, what waits for a wallet, and its tiny footprint. */
export async function mine(actor) {
  let wallet = null;
  let list = [];
  if (actor && tiger()) {
    wallet = (await users.sql('SELECT address FROM chain.wallets WHERE actor_id = $1', [actor])).rows[0]?.address || null;
    list = (await users.sql('SELECT * FROM chain.rewards WHERE actor_id = $1 ORDER BY id DESC LIMIT 50', [actor])).rows.map(rewardFrom);
  } else if (actor) {
    wallet = mem().wallets[actor]?.address || null;
    list = mem().rewards.filter((r) => r.actorId === actor).reverse().slice(0, 50);
  }
  const sum = (f) => list.filter(f).reduce((s, r) => s + r.amount, 0);
  const txs = list.filter((r) => r.status === 'sent').length;
  return {
    enabled: ready(), cluster: CLUSTER, wallet, walletUrl: wallet ? explorer(wallet, 'address') : null,
    mint: process.env.SOLANA_MINT?.trim() || null,
    total: sum(() => true), sent: sum((r) => r.status === 'sent'), waiting: sum((r) => r.status !== 'sent'),
    rewards: list.slice(0, 20).map(view),
    footprint: { transactions: txs, gCo2: +(txs * FOOTPRINT.gCo2PerTx).toFixed(5), ...FOOTPRINT },
  };
}

/** The public record, newest first. Optionally only for one hazard / litter pin (ref like H12, L3). */
export async function ledger({ ref, limit = 30 } = {}) {
  let rows;
  if (tiger()) {
    rows = (await users.sql(`SELECT * FROM chain.records ${ref ? 'WHERE ref = $2' : ''} ORDER BY id DESC LIMIT $1`, ref ? [limit, ref] : [limit])).rows.map(recordFrom);
  } else {
    rows = mem().records.filter((r) => !ref || r.ref === ref).slice(-limit).reverse();
  }
  return rows.map((r) => ({ id: r.id, time: r.time, kind: r.kind, ref: r.ref, event: r.event, memo: r.memo,
    status: r.status === 'sent' ? 'on-chain' : r.status === 'failed' ? 'retrying' : 'queued', url: r.signature ? explorer(r.signature) : null }));
}

async function getRecord(id) {
  if (tiger()) {
    const { rows } = await users.sql('SELECT * FROM chain.records WHERE id = $1', [Number(id) || 0]);
    return rows[0] ? recordFrom(rows[0]) : null;
  }
  return mem().records.find((r) => r.id === Number(id)) || null;
}

/**
 * Check our database against the chain: recompute the hash of the facts we stored and compare
 * it with the hash in the on-chain memo. With tamper=true, a copy of the facts is edited first
 * (nothing is changed) to show what happens if someone alters the record.
 */
export async function verify(id, { tamper = false } = {}) {
  const r = await getRecord(id);
  if (!r) throw bad('Record not found', 404);
  if (!r.signature) return { id: r.id, onChain: false, status: r.status, memo: r.memo };
  if (!ready()) throw bad('Solana is not set up on this server', 503);
  const tx = await conn.getTransaction(r.signature, { commitment: 'confirmed', maxSupportedTransactionVersion: 0 });
  const log = tx?.meta?.logMessages?.find((l) => l.includes('Memo (len'));
  let onChainMemo = null;
  if (log) { try { onChainMemo = JSON.parse(log.slice(log.indexOf('"'))); } catch { onChainMemo = log.slice(log.indexOf('"') + 1, -1); } }
  const onChainHash = /sha256:([0-9a-f]{64})/.exec(onChainMemo || '')?.[1] || null;
  const snapshot = structuredClone(r.snapshot);
  let edit = null;
  if (tamper) {
    const key = ['confirmations', 'seenStillThere', 'items', 'severity'].find((k) => typeof snapshot.facts?.[k] === 'number');
    edit = { field: key, from: snapshot.facts[key], to: snapshot.facts[key] + 10 };
    snapshot.facts[key] += 10;
  }
  const dbHash = hashOf(snapshot);
  return {
    id: r.id, ref: r.ref, event: r.event, onChain: Boolean(tx), match: Boolean(onChainHash) && dbHash === onChainHash,
    onChainMemo, onChainHash, dbHash, facts: snapshot.facts, edit,
    slot: tx?.slot ?? null, blockTime: tx?.blockTime ? new Date(tx.blockTime * 1000).toISOString() : null, url: explorer(r.signature),
  };
}

// ---------------------------------------------------------------- routes

export function mountChain(app) {
  const actor = (req) => req.session?.uid || req.session?.gid || null;
  const needActor = (req) => { const a = actor(req); if (!a) throw bad('Sign in, or continue as a guest, first', 401); return a; };

  app.get('/api/chain/status', (_req, res) => {
    schedule();
    res.json({ enabled: ready(), cluster: CLUSTER, mint: process.env.SOLANA_MINT?.trim() || null,
      mintUrl: process.env.SOLANA_MINT ? explorer(process.env.SOLANA_MINT.trim(), 'address') : null,
      appWallet: ready() ? payer.publicKey.toBase58() : null, footprint: FOOTPRINT, points: POINTS });
  });
  app.get('/api/chain/me', async (req, res) => { schedule(); res.json(await mine(actor(req))); });
  app.put('/api/chain/wallet', async (req, res) => { const a = needActor(req); await linkWallet(a, req.body?.address); res.json(await mine(a)); });
  app.delete('/api/chain/wallet', async (req, res) => { const a = needActor(req); await unlinkWallet(a); res.json(await mine(a)); });
  app.get('/api/chain/ledger', async (req, res) => {
    schedule();
    res.json({ enabled: ready(), cluster: CLUSTER, records: await ledger({ ref: req.query.ref ? String(req.query.ref).toUpperCase() : null, limit: Math.min(100, Number(req.query.limit) || 30) }) });
  });
  app.get('/api/chain/records/:id/verify', async (req, res) => res.json(await verify(req.params.id, { tamper: req.query.tamper === '1' })));
}
