/**
 * explorer — local kotoba Datom-log explorer (AWAI-3079).
 *
 * The former SPA fetched snapshots and content-addressed blocks from the apex
 * Worker. Here the logs are imported by the person (pasted text) and every
 * step runs on this device: parse, verify the CID chain, and browse EAVT.
 *
 *   importLog     : parse + verify + keep the log text locally.
 *   verifyLog     : re-run the chain check on a stored log.
 *   listEntities  : entities and their datom counts.
 *   browseEntity  : current value per attribute (last write wins) + history.
 *   queryDatoms   : entities that have an attribute (optionally = value).
 */
import type { LocalStore } from "../local-store.js";
import { getOne, idSlug, isNonEmpty, listAll, nowISO, put } from "./records.js";
import { parseLog, verifyChain, type Tx } from "./datom.js";

export { canonicalJson, txCid, parseLog, verifyChain, readEdn } from "./datom.js";

export const LOG = "cloud.itonami.apps.explorer.datomLog";
export const MAX_LOG_CHARS = 2_000_000;

export interface StoredLog { logId: string; text: string; txCount: number; datomCount: number; ok: boolean; brokenAt: number | null; head: string | null; importedAt: string; verifiedAt: string }

export interface ImportLogInput { logId: string; text: string }
export interface VerifyLogInput { logId: string }
export interface ListEntitiesInput { logId: string }
export interface BrowseEntityInput { logId: string; entity: string }
export interface QueryDatomsInput { logId: string; attribute: string; value?: string }

const key = (id: string) => `log-${idSlug(id)}`;

async function loadTxs(e: LocalStore, logId: string): Promise<{ log: StoredLog; txs: Tx[] } | null> {
  const r = isNonEmpty(logId) ? await getOne<StoredLog>(e, LOG, key(logId)) : null;
  return r ? { log: r.value, txs: parseLog(r.value.text) } : null;
}

export async function importLog(e: LocalStore, input: ImportLogInput) {
  if (!isNonEmpty(input.logId) || !isNonEmpty(input.text)) return { status: "rejected", error: "missingRequiredFields" };
  if (input.text.length > MAX_LOG_CHARS) return { status: "rejected", error: "logTooLarge", maxChars: MAX_LOG_CHARS };
  let txs: Tx[];
  try { txs = parseLog(input.text); } catch (err) { return { status: "rejected", error: "parseError", detail: (err as Error).message }; }
  if (txs.length === 0) return { status: "rejected", error: "emptyLog" };
  const v = await verifyChain(txs);
  const now = nowISO();
  const log: StoredLog = { logId: input.logId, text: input.text, txCount: txs.length, datomCount: txs.reduce((s, t) => s + t.datoms.length, 0), ok: v.ok, brokenAt: v.brokenAt, head: v.ok ? (v as { head: string }).head : null, importedAt: now, verifiedAt: now };
  await put(e, LOG, key(input.logId), log);
  return { status: "imported", ok: v.ok, txCount: log.txCount, datomCount: log.datomCount, head: log.head, brokenAt: v.brokenAt };
}

export async function verifyLog(e: LocalStore, input: VerifyLogInput) {
  const l = await loadTxs(e, input.logId);
  if (!l) return { status: "notFound" };
  const v = await verifyChain(l.txs);
  await put(e, LOG, key(input.logId), { ...l.log, ok: v.ok, brokenAt: v.brokenAt, head: v.ok ? (v as { head: string }).head : null, verifiedAt: nowISO() });
  return { status: "verified", ...v };
}

function eavt(txs: Tx[]) {
  return txs.flatMap((tx, t) => tx.datoms.map((d) => ({ op: d[0], e: String(d[1]), a: String(d[2]), v: d[3], t })));
}

export async function listEntities(e: LocalStore, input: ListEntitiesInput) {
  const l = await loadTxs(e, input.logId);
  if (!l) return { status: "notFound" };
  const counts = new Map<string, number>();
  for (const d of eavt(l.txs)) counts.set(d.e, (counts.get(d.e) ?? 0) + 1);
  const items = [...counts.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([entity, datoms]) => ({ entity, datoms }));
  return { status: "ok", verified: l.log.ok, items, total: items.length };
}

export async function browseEntity(e: LocalStore, input: BrowseEntityInput) {
  const l = await loadTxs(e, input.logId);
  if (!l) return { status: "notFound" };
  if (!isNonEmpty(input.entity)) return { status: "rejected", error: "missingRequiredFields" };
  const history = eavt(l.txs).filter((d) => d.e === input.entity);
  if (history.length === 0) return { status: "entityNotFound" };
  const current: Record<string, unknown> = {};
  for (const d of history) current[d.a] = d.v;
  return { status: "ok", verified: l.log.ok, entity: input.entity, current, history };
}

export async function queryDatoms(e: LocalStore, input: QueryDatomsInput) {
  const l = await loadTxs(e, input.logId);
  if (!l) return { status: "notFound" };
  if (!isNonEmpty(input.attribute)) return { status: "rejected", error: "missingRequiredFields" };
  const latest = new Map<string, unknown>();
  for (const d of eavt(l.txs)) if (d.a === input.attribute) latest.set(d.e, d.v);
  const hits = [...latest.entries()].filter(([, v]) => input.value === undefined || String(v) === input.value).map(([entity, value]) => ({ entity, value }));
  return { status: "ok", verified: l.log.ok, attribute: input.attribute, items: hits, total: hits.length };
}

export async function listLogs(e: LocalStore) {
  const items = (await listAll<StoredLog>(e, LOG)).map((r) => { const { text, ...rest } = r.value; return { ...rest, chars: text.length }; });
  return { items, total: items.length };
}
