/**
 * kotoba Datom log codec (AWAI-3079): a TypeScript port of the canonical
 * `kotoba.datom` (kotoba-lang/kotodama src/kotoba/datom.cljk) parts the
 * explorer needs: canonical JSON, tx CID, log-line reading and chain checks.
 *
 * CID = "b" + sha256-hex(canonical-json({"prev": prev, "datoms": datoms})),
 * canonical JSON = sorted keys, "," / ":" separators, no ASCII escaping
 * (Python json.dumps parity). Datoms are [":db/add" e a v] with keywords as
 * ":…" strings.
 *
 * Floats keep their original EDN text (EdnFloat), so "1.0" stays "1.0" in the
 * preimage as the Python/JVM writers produce it.
 */

export class EdnFloat {
  readonly raw: string;
  constructor(raw: string) { this.raw = raw; }
  valueOf() { return Number(this.raw); }
  toJSON() { return Number(this.raw); }
}

export class EdnKeyword {
  readonly name: string; // includes the leading ":"
  constructor(name: string) { this.name = name; }
  toString() { return this.name; }
  toJSON() { return this.name; }
}

export type EdnValue = string | number | boolean | null | EdnFloat | EdnKeyword | EdnValue[] | Map<string, EdnValue>;

// ─── EDN reader (the subset a Datom log line uses) ─────────────────

export function readEdn(text: string): EdnValue {
  let i = 0;
  const ws = () => {
    for (;;) {
      while (i < text.length && /[\s,]/.test(text[i])) i++;
      if (text[i] === ";") { while (i < text.length && text[i] !== "\n") i++; continue; }
      break;
    }
  };
  const fail = (msg: string): never => { throw new Error(`EDN: ${msg} at ${i}`); };
  const tokenEnd = () => { let j = i; while (j < text.length && !/[\s,()[\]{}"]/.test(text[j])) j++; return j; };
  const value = (): EdnValue => {
    ws();
    const c = text[i];
    if (c === undefined) return fail("unexpected end");
    if (c === "{") { i++; const m = new Map<string, EdnValue>(); for (;;) { ws(); if (text[i] === "}") { i++; return m; } const k = value(); const v = value(); m.set(String(k), v); } }
    if (c === "[" || c === "(") { const close = c === "[" ? "]" : ")"; i++; const out: EdnValue[] = []; for (;;) { ws(); if (text[i] === close) { i++; return out; } if (i >= text.length) fail("unclosed list"); out.push(value()); } }
    if (c === "#") {
      if (text[i + 1] === "{") { i++; const set = value() as Map<string, EdnValue>; return set as unknown as EdnValue; }
      i++; const end = tokenEnd(); i = end; return value(); // tagged literal: keep the tagged value
    }
    if (c === '"') {
      i++; let s = "";
      for (;;) {
        const ch = text[i++];
        if (ch === undefined) fail("unclosed string");
        if (ch === '"') return s;
        if (ch === "\\") {
          const n = text[i++];
          const esc: Record<string, string> = { n: "\n", t: "\t", r: "\r", b: "\b", f: "\f", '"': '"', "\\": "\\" };
          if (n === "u") { s += String.fromCharCode(parseInt(text.slice(i, i + 4), 16)); i += 4; }
          else if (n in esc) s += esc[n];
          else fail(`bad escape \\${n}`);
        } else s += ch;
      }
    }
    const end = tokenEnd();
    const tok = text.slice(i, end);
    if (!tok) return fail(`unexpected ${c}`);
    i = end;
    if (tok === "nil") return null;
    if (tok === "true") return true;
    if (tok === "false") return false;
    if (tok.startsWith(":")) return new EdnKeyword(tok);
    if (/^[+-]?\d+N?$/.test(tok)) return Number(tok.replace(/N$/, ""));
    if (/^[+-]?(\d+\.\d*|\d*\.\d+|\d+)([eE][+-]?\d+)?M?$/.test(tok)) return new EdnFloat(tok.replace(/M$/, ""));
    return tok; // symbol: keep its text
  };
  const v = value();
  ws();
  if (i < text.length) fail("trailing input");
  return v;
}

// ─── canonical JSON + CID ──────────────────────────────────────────

function jsonEscape(s: string): string {
  let out = "";
  for (const ch of s) {
    const code = ch.codePointAt(0)!;
    if (ch === '"') out += '\\"';
    else if (ch === "\\") out += "\\\\";
    else if (ch === "\b") out += "\\b";
    else if (ch === "\t") out += "\\t";
    else if (ch === "\n") out += "\\n";
    else if (ch === "\f") out += "\\f";
    else if (ch === "\r") out += "\\r";
    else if (code < 0x20) out += "\\u" + code.toString(16).padStart(4, "0");
    else out += ch;
  }
  return out;
}

export function canonicalJson(v: unknown): string {
  if (v instanceof EdnKeyword) return `"${jsonEscape(v.name)}"`;
  if (v instanceof EdnFloat) return v.raw;
  if (typeof v === "string") return `"${jsonEscape(v)}"`;
  if (typeof v === "boolean") return v ? "true" : "false";
  if (typeof v === "number") { if (!Number.isFinite(v)) throw new Error("canonicalJson: non-finite number"); return String(v); }
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(",")}]`;
  if (v instanceof Map) return `{${[...v.keys()].sort().map((k) => `"${jsonEscape(k)}":${canonicalJson(v.get(k))}`).join(",")}}`;
  if (v && typeof v === "object") { const o = v as Record<string, unknown>; return `{${Object.keys(o).sort().map((k) => `"${jsonEscape(k)}":${canonicalJson(o[k])}`).join(",")}}`; }
  throw new Error("canonicalJson: unsupported value");
}

/** EDN keywords become their ":…" string, as kotoba.datom/normalize-datoms does. */
export function normalizeDatoms(datoms: unknown): unknown[][] {
  if (!Array.isArray(datoms)) throw new Error("tx/datoms must be a vector");
  return datoms.map((d) => {
    if (!Array.isArray(d)) throw new Error("datom must be a vector");
    return d.map((x) => (x instanceof EdnKeyword ? x.name : x));
  });
}

async function sha256Hex(text: string): Promise<string> {
  const bytes = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(bytes), (b) => b.toString(16).padStart(2, "0")).join("");
}

export async function txCid(datoms: unknown[][], prevCid = ""): Promise<string> {
  return "b" + (await sha256Hex(canonicalJson({ prev: prevCid, datoms })));
}

export interface Tx { id: unknown; asOf: unknown; prev: string; cid: string; count: number | null; datoms: unknown[][] }

/** One tx map per line; blank and ";" lines skipped. Oldest first. */
export function parseLog(text: string): Tx[] {
  const txs: Tx[] = [];
  for (const [n, raw] of String(text ?? "").split(/\r?\n/).entries()) {
    const line = raw.trim();
    if (!line || line.startsWith(";")) continue;
    let m: EdnValue;
    try { m = readEdn(line); } catch (err) { throw new Error(`line ${n + 1}: ${(err as Error).message}`); }
    if (!(m instanceof Map)) throw new Error(`line ${n + 1}: not a tx map`);
    txs.push({
      id: m.get(":tx/id") ?? null, asOf: m.get(":tx/as-of") ?? null,
      prev: String(m.get(":tx/prev") ?? ""), cid: String(m.get(":tx/cid") ?? ""),
      count: typeof m.get(":tx/count") === "number" ? (m.get(":tx/count") as number) : null,
      datoms: normalizeDatoms(m.get(":tx/datoms") ?? []),
    });
  }
  return txs;
}

/** Recompute every CID from (datoms, prev). Mirrors kotoba.datom verify-chain. */
export async function verifyChain(txs: Tx[]) {
  let prev = "";
  for (const [i, tx] of txs.entries()) {
    const cid = await txCid(tx.datoms, prev);
    if (tx.prev !== prev || tx.cid !== cid) return { ok: false, length: txs.length, brokenAt: i, expectedCid: cid, foundCid: tx.cid };
    prev = cid;
  }
  return { ok: true, length: txs.length, brokenAt: null, head: prev };
}
