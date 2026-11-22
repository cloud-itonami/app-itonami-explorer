// restricted-wasm-v1 (KOTOBA-159): the guest artifact, its pin, the release gate and forms.
import test from "node:test";
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import * as runtime from "../vendor/kotoba-client-runtime.js";
import { deployAllowed, disabledFeatures } from "../scripts/deploy-gate.mjs";

const root = new URL("../", import.meta.url);
const read = (p) => readFile(new URL(p, root), "utf8");

test("the guest is one self-contained document, pinned and verified by the canonical runtime", async () => {
  const { default: host } = await import(new URL("dist/host-data.js", root));
  const release = JSON.parse(await read("dist/release.json"));
  assert.deepEqual(release.guest, host.artifact);
  assert.match(host.artifact.revision, /^[0-9a-f]{40}$/);
  assert.equal((await runtime.verifyClientArtifact(new TextEncoder().encode(host.guest), host.artifact)).verified, true);
  await assert.rejects(runtime.verifyClientArtifact(new TextEncoder().encode(host.guest.replace("Explorer", "Explorar")), host.artifact), /digest mismatch/);
  const scripts = [...host.guest.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)];
  assert.equal(scripts.length, 1);
  const html = await read("dist/index.html");
  assert.ok(html.includes(`'sha256-${createHash("sha256").update(scripts[0][2], "utf8").digest("base64")}'`));
  assert.ok(!/<link\b|<script\b[^>]*\bsrc=/i.test(host.guest));
  const file = join(tmpdir(), `explorer-guest-${process.pid}.mjs`);
  await writeFile(file, scripts[0][2]);
  execFileSync(process.execPath, ["--check", file]);
  assert.deepEqual(runtime.clientRuntimeProblems(host.descriptor, [], []), []);
  assert.equal(runtime.clientRuntimeConnectSrc(host.descriptor, [], [], []), "connect-src 'none'");
});

test("forms use itonami-lib's bindForm", async () => {
  const app = await read("src/ui/app.js");
  assert.match(app, /bindForm\(form, \(\) => runAction\(action, form\)\)/);
  assert.ok(!/onsubmit|type: "submit"/.test(app));
});

test("release gate: blocked while a feature from before the move is off (negative control: no disclosure page needed)", async () => {
  const ok200 = async () => new Response("", { status: 200 });
  const ids = (await disabledFeatures()).map((f) => f.id);
  assert.deepEqual(ids, ["records-kept"]);
  assert.equal((await deployAllowed({ fetchImpl: ok200 })).ok, false);
  assert.deepEqual(await deployAllowed({ fetchImpl: ok200, features: [] }), { ok: true, reasons: [] });
  const pkg = JSON.parse(await read("package.json"));
  for (const s of ["build:desktop", "build:android"]) assert.ok(pkg.scripts[s].startsWith("node scripts/deploy-gate.mjs && "), s);
});
