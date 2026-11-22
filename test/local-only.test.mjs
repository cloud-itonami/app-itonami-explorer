// Shared checks: the app runs locally with no external operation, under the
// strict CSP and the single read-only Tauri command. Run after `npm run build`.
import test from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { resolve, join } from "node:path";

const root = fileURLToPath(new URL("../", import.meta.url));
const read = (p) => readFile(resolve(root, p), "utf8");
const CSP = "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src ipc: http://ipc.localhost";

async function distScripts() {
  const out = [];
  // The shipped host files and the guest's modules (inlined into dist/host-data.js).
  for (const dir of ["dist", ".guest-modules", ".guest-modules/domain"]) for (const name of await readdir(resolve(root, dir))) if (name.endsWith(".js") && name !== "kotoba-client-runtime.js") out.push(join(dir, name));
  return out;
}

test("descriptor declares local state and no external operation", async () => {
  const d = JSON.parse(await read("dist/descriptor.json"));
  assert.equal(d.schema, "kotoba.app.client-runtime.v1");
  assert.deepEqual(d.operations, []);
  assert.deepEqual(d.workers, []);
  assert.equal(d.profile, "restricted-wasm-v1");
  // The sandboxed guest has no storage until the runtime's host-mediated storage (KOTOBA-968).
  assert.equal(d["local-state"].adapter, "memory");
});

test("shipped scripts contain no network API", async () => {
  for (const file of await distScripts()) {
    const src = await read(file);
    for (const api of [/\bfetch\s*\(/, /XMLHttpRequest/, /\bWebSocket\b/, /\bEventSource\b/, /sendBeacon/, /import\s*\(\s*["'`]https?:/, /from\s+["']https?:/]) {
      assert.ok(!api.test(src), `${file} uses ${api}`);
    }
  }
});

test("CSP is strict in the host page and in the Tauri config; only the guest is admitted inline, by hash", async () => {
  const html = await read("dist/index.html");
  const csp = html.match(/Content-Security-Policy" content="([^"]+)"/)[1];
  const conf = JSON.parse(await read("src-tauri/tauri.conf.json"));
  assert.equal(conf.app.security.csp, csp);
  assert.match(csp, /^default-src 'none'; script-src 'self' 'sha256-[^']+' 'sha256-[^']+'; style-src 'self' 'sha256-[^']+'; img-src 'self' data:; connect-src ipc: http:\/\/ipc\.localhost;/);
  for (const tag of html.matchAll(/<script\b[^>]*>/gi)) assert.match(tag[0], /src=/);
  assert.equal(conf.$schema, "https://schema.tauri.app/config/3");
});

test("the Tauri host grants only the read-only host-info command", async () => {
  const caps = await readdir(resolve(root, "src-tauri/capabilities"));
  for (const name of caps) {
    const cap = JSON.parse(await read(join("src-tauri/capabilities", name)));
    assert.deepEqual(cap.permissions, ["allow-awai-host-info"]);
  }
  const cargo = await read("src-tauri/Cargo.toml");
  assert.match(cargo, /tauri = \{ version = "=3\.0\.0-alpha\.6"/);
  assert.doesNotMatch(cargo, /tauri-plugin-(http|fs|shell)/);
});

test("release manifest pins every shipped file", async () => {
  const release = JSON.parse(await read("dist/release.json"));
  for (const name of await readdir(resolve(root, "dist"))) if (name !== "release.json") assert.ok(release.files[name], `${name} is not pinned`);
});

test("every UI action is wired to a function and every collection is declared", async () => {
  const { app } = await import(resolve(root, ".guest-modules/app-def.js"));
  assert.ok(app.title && app.did && app.storageKey);
  assert.ok(app.actions.length > 0);
  for (const action of app.actions) {
    assert.equal(typeof action.run, "function", action.name);
    for (const f of action.fields) assert.ok(f.name && f.label, `${action.name} field`);
  }
  assert.ok(app.collections.length > 0);
});

test("the local store round-trips through storage and replaces on rewrite", async () => {
  const { LocalStore } = await import(resolve(root, ".guest-modules/local-store.js"));
  const mem = new Map();
  const storage = { getItem: (k) => mem.get(k) ?? null, setItem: (k, v) => mem.set(k, v) };
  const a = new LocalStore({ did: "did:example:t", storage, key: "t" });
  const w = await a.write({ collection: "c", record: { n: 1 }, rkey: "r1" });
  assert.equal(w.uri, "at://did:example:t/c/r1");
  await a.write({ collection: "c", record: { n: 2 }, rkey: "r1" });
  const b = new LocalStore({ did: "did:example:t", storage, key: "t" });
  assert.equal((await b.read({ collection: "c", rkey: "r1" })).records[0].value.n, 2);
  assert.equal(b.count("c"), 1);
  for (let i = 0; i < 5; i++) await b.write({ collection: "p", record: { i }, rkey: `k${i}` });
  const p1 = await b.read({ collection: "p", limit: 2 });
  const p2 = await b.read({ collection: "p", limit: 2, cursor: p1.cursor });
  assert.deepEqual([...p1.records, ...p2.records].map((r) => r.value.i), [0, 1, 2, 3]);
  const failing = new LocalStore({ did: "did:example:t", storage: { getItem: () => null, setItem: () => { throw new Error("quota"); } }, key: "t" });
  await assert.rejects(failing.write({ collection: "c", record: {}, rkey: "x" }), /local save failed/);
});

test("sealed records are returned only to dids in their read-cap", async () => {
  const { LocalStore } = await import(resolve(root, ".guest-modules/local-store.js"));
  const mem = new Map();
  const storage = { getItem: (k) => mem.get(k) ?? null, setItem: (k, v) => mem.set(k, v) };
  const owner = new LocalStore({ did: "did:example:owner", storage, key: "s" });
  const r = await owner.encryptedWrite({ innerType: "t.secret", record: { x: 1 }, recipients: ["did:example:friend"], rkey: "a" });
  assert.ok(r.keyId);
  assert.equal((await owner.encryptedRead({ innerType: "t.secret" })).records[0].value.x, 1);
  const friend = new LocalStore({ did: "did:example:friend", storage, key: "s" });
  assert.equal((await friend.encryptedRead({ innerType: "t.secret" })).records.length, 1);
  const outsider = new LocalStore({ did: "did:example:other", storage, key: "s" });
  assert.equal((await outsider.encryptedRead({ innerType: "t.secret" })).records.length, 0);
});
