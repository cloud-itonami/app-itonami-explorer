import { describe, it, beforeEach } from "node:test";
import { expect } from "./expect.mjs";
import { LocalStore } from "../.guest-modules/local-store.js";
import { importLog, verifyLog, listEntities, browseEntity, queryDatoms, canonicalJson, txCid, readEdn, parseLog } from "../.guest-modules/domain/index.js";

// Oracle vectors: python3 3.15.0 json.dumps(sort_keys=True, separators=(",",":"), ensure_ascii=False)
// + hashlib.sha256, 2026-11-17 (AWAI-3079 .agent-output/oracle/datom-cid-vectors.json).
const CID1 = "b960959c639d83fca425e556d027a2af53e4b451d4b82441596fba127a5dfbbff";
const CID2 = "be7014a9edfa8d157a50a5fe4afd461c3c554abbfa901a12a44bc8c85c8607f1f";
const LOG = [
  "; kotoba Datom log",
  `{:tx/id "t1" :tx/as-of 1 :tx/prev "" :tx/cid "${CID1}" :tx/count 2 :tx/datoms [[:db/add "actor/ki" :actor/status "alive"] [:db/add "actor/ki" :actor/generation 3]]}`,
  "",
  `{:tx/id "t2" :tx/as-of 2 :tx/prev "${CID1}" :tx/cid "${CID2}" :tx/count 3 :tx/datoms [[:db/add "actor/kabi" :actor/name "カビ \\"mold\\""] [:db/add "actor/ki" :actor/status "dormant"] [:db/add "actor/ki" :actor/active false]]}`,
].join("\n");

describe("kotoba Datom codec (byte-compatible with the canonical writer)", () => {
  it("canonical JSON sorts keys, uses compact separators and keeps non-ASCII", () => {
    expect(canonicalJson({ b: 2, a: 1 })).toBe('{"a":1,"b":2}');
    expect(canonicalJson("a\"b")).toBe('"a\\"b"');
    expect(canonicalJson("カビ")).toBe('"カビ"');
    expect(canonicalJson({ prev: "", datoms: [[":db/add", "actor/ki", ":actor/status", "alive"], [":db/add", "actor/ki", ":actor/generation", 3]] }))
      .toBe('{"datoms":[[":db/add","actor/ki",":actor/status","alive"],[":db/add","actor/ki",":actor/generation",3]],"prev":""}');
  });

  it("computes the oracle CIDs", async () => {
    expect(await txCid([[":db/add", "actor/ki", ":actor/status", "alive"], [":db/add", "actor/ki", ":actor/generation", 3]], "")).toBe(CID1);
    expect(await txCid([[":db/add", "actor/kabi", ":actor/name", 'カビ "mold"'], [":db/add", "actor/ki", ":actor/status", "dormant"], [":db/add", "actor/ki", ":actor/active", false]], CID1)).toBe(CID2);
  });

  it("reads EDN tx lines and keeps float text", () => {
    const m: any = readEdn('{:a 1.0 :b [:k "s\\n"] :c nil}');
    expect(canonicalJson(m.get(":a"))).toBe("1.0");
    expect(m.get(":b")[1]).toBe("s\n");
    expect(m.get(":c")).toBe(null);
    expect(parseLog(LOG).length).toBe(2);
  });
});

describe("explorer", () => {
  let e: any;
  beforeEach(() => { e = new LocalStore({ did: "did:web:explorer.itonami.cloud" }); });

  it("imports and verifies a valid log", async () => {
    const r = await importLog(e, { logId: "main", text: LOG });
    expect(r.status).toBe("imported");
    expect(r.ok).toBe(true);
    expect(r.head).toBe(CID2);
    expect(r.datomCount).toBe(5);
    expect((await verifyLog(e, { logId: "main" })).ok).toBe(true);
  });

  it("detects a tampered transaction", async () => {
    const r = await importLog(e, { logId: "bad", text: LOG.replace('"alive"', '"dead"') });
    expect(r.ok).toBe(false);
    expect(r.brokenAt).toBe(0);
    expect((await importLog(e, { logId: "x", text: "{:tx/id" })).error).toBe("parseError");
    expect((await importLog(e, { logId: "y", text: "; only a comment" })).error).toBe("emptyLog");
  });

  it("browses entities and answers attribute queries", async () => {
    await importLog(e, { logId: "main", text: LOG });
    expect((await listEntities(e, { logId: "main" })).items.map((i: any) => i.entity).join()).toBe("actor/kabi,actor/ki");
    const ki = await browseEntity(e, { logId: "main", entity: "actor/ki" });
    expect(ki.current[":actor/status"]).toBe("dormant");
    expect(ki.current[":actor/generation"]).toBe(3);
    expect(ki.history.length).toBe(4);
    expect((await browseEntity(e, { logId: "main", entity: "nobody" })).status).toBe("entityNotFound");
    expect((await queryDatoms(e, { logId: "main", attribute: ":actor/status", value: "dormant" })).total).toBe(1);
    expect((await queryDatoms(e, { logId: "main", attribute: ":actor/status", value: "alive" })).total).toBe(0);
    expect((await verifyLog(e, { logId: "missing" })).status).toBe("notFound");
  });
});
