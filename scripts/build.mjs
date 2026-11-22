// Static build for restricted-wasm-v1 (KOTOBA-159). dist/index.html is the trusted host page
// (src/ui/host.html, host.js) with the canonical runtime from vendor/ (digest-checked against
// vendor/PINS.json). The app is one self-contained guest document: src/ui/guest.html with the
// app's modules inlined by guest-bundle.mjs (TypeScript domain sources stripped with Node's built-in
// type stripping) and style.css inline, pinned by SHA-256 and the source commit in dist/host-data.js.
// The page policy admits the runtime's guest preamble, the guest script and the guest style by
// hash. The stripped modules are also written to .guest-modules/ for the tests (not shipped).
import { mkdir, copyFile, readFile, writeFile, rm, readdir } from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { resolve, join, dirname } from "node:path";
import { createHash } from "node:crypto";
import { clientRuntimeProblems } from "../vendor/kotoba-client-runtime.js";
import { bundleModules } from "./guest-bundle.mjs";
import { checkNoSubmit } from "./check-no-submit.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const out = resolve(root, "dist");
const modulesOut = resolve(root, ".guest-modules");
const meta = JSON.parse(await readFile(resolve(root, "package.json"), "utf8"));
const app = meta.itonami;
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const cspHash = (text) => `'sha256-${createHash("sha256").update(text, "utf8").digest("base64")}'`;

const pins = JSON.parse(await readFile(resolve(root, "vendor/PINS.json"), "utf8"));
for (const [name, digest] of Object.entries(pins.files)) {
  if (sha(await readFile(resolve(root, "vendor", name))) !== digest) throw new Error(`canonical runtime pin drift: ${name}`);
}

// The shared client-runtime descriptor: no external operation. The sandboxed guest has no storage
// until the runtime's host-mediated storage (KOTOBA-968), so local state is memory.
export const descriptor = {
  schema: "kotoba.app.client-runtime.v1", target: "browser", profile: "restricted-wasm-v1", entry: "index.html",
  "local-state": { adapter: "memory", schema: app.storageKey, version: 1 }, workers: [], operations: [],
};
const problems = clientRuntimeProblems(descriptor, [], []);
if (problems.length) throw new Error(`invalid descriptor: ${JSON.stringify(problems)}`);

// The guest's modules, laid out as before (app.js next to local-store.js, domain/ below).
const modules = { "app.js": await readFile(resolve(root, "src/ui/app.js"), "utf8") };
for (const name of ["local-store.js", "app-def.js", "guest-form.js"]) modules[name] = await readFile(resolve(root, "src", name), "utf8");
for (const name of (await readdir(resolve(root, "src/domain"))).sort()) {
  const text = await readFile(resolve(root, "src/domain", name), "utf8");
  if (name.endsWith(".ts")) modules[`domain/${name.replace(/\.ts$/, ".js")}`] = stripTypeScriptTypes(text, { mode: "strip" });
  else if (name.endsWith(".js")) modules[`domain/${name}`] = text;
}
await rm(modulesOut, { recursive: true, force: true });
for (const [name, text] of Object.entries(modules)) {
  await mkdir(dirname(join(modulesOut, name)), { recursive: true });
  await writeFile(join(modulesOut, name), text);
}
export const guestScript = bundleModules(modules, "app.js");
checkNoSubmit(guestScript, "the restricted guest script");
export const guestStyle = await readFile(resolve(root, "src/ui/style.css"), "utf8");
if (/<\/style/i.test(guestStyle)) throw new Error("src/ui/style.css contains </style");
const preamble = /^const GUEST_PREAMBLE = '<script>([^'\\]*)<\/script>';$/m.exec(await readFile(resolve(root, "vendor/kotoba-client-runtime.js"), "utf8"))?.[1];
if (!preamble) throw new Error("the canonical runtime has no GUEST_PREAMBLE this build can hash");
export const CSP = `default-src 'none'; script-src 'self' ${cspHash(preamble)} ${cspHash(guestScript)}; style-src 'self' ${cspHash(guestStyle)}; img-src 'self' data:; connect-src ipc: http://ipc.localhost; object-src 'none'; frame-src 'none'; base-uri 'none'; form-action 'none'`;

const confPath = resolve(root, "src-tauri/tauri.conf.json");
const conf = JSON.parse(await readFile(confPath, "utf8"));
if (conf.app.security.csp !== CSP) {
  if (!process.argv.includes("--update-csp")) throw new Error("tauri.conf.json CSP is not the one derived from the guest; run `node scripts/build.mjs --update-csp` and commit it");
  conf.app.security.csp = CSP;
  await writeFile(confPath, JSON.stringify(conf) + "\n");
}

let commit = null; let dirty = false;
try {
  commit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
  dirty = execFileSync("git", ["status", "--porcelain"], { cwd: root, encoding: "utf8" }).trim() !== "";
} catch { commit = process.env.ITONAMI_SOURCE_COMMIT ?? null; dirty = process.env.ITONAMI_SOURCE_DIRTY === "true"; }
if (!/^[0-9a-f]{40}$/.test(commit ?? "")) throw new Error("restricted-wasm-v1 pins the guest to its source commit: build from a git checkout or set ITONAMI_SOURCE_COMMIT");
const template = await readFile(resolve(root, "src/ui/guest.html"), "utf8");
for (const marker of ["{{STYLE}}", "{{SCRIPT}}"]) if (template.split(marker).length !== 2) throw new Error(`guest.html must contain ${marker} once`);
export const guest = template.replace("{{STYLE}}", () => guestStyle).replace("{{SCRIPT}}", () => guestScript);
checkNoSubmit(guest, "the restricted guest");
if (guest.length > 8388608) throw new Error("the guest exceeds the 8 MiB mount budget");
const guestBytes = new TextEncoder().encode(guest);
const artifact = { revision: commit, sha256: sha(guestBytes), "max-bytes": guestBytes.byteLength };

await rm(out, { recursive: true, force: true });
await mkdir(out, { recursive: true });
const host = await readFile(resolve(root, "src/ui/host.html"), "utf8");
if (host.split("@CSP@").length !== 2) throw new Error("host.html has no CSP build marker");
await writeFile(join(out, "index.html"), host.replace("@CSP@", () => CSP));
for (const name of ["host.js", "host.css"]) await copyFile(resolve(root, "src/ui", name), join(out, name));
for (const name of Object.keys(pins.files)) await copyFile(resolve(root, "vendor", name), join(out, name));
await writeFile(join(out, "descriptor.json"), JSON.stringify(descriptor, null, 2) + "\n");
await writeFile(join(out, "host-data.js"), `export default ${JSON.stringify({ descriptor, artifact, guest }, null, 1)};\n`);
const names = ["index.html", "host.js", "host.css", ...Object.keys(pins.files), "descriptor.json", "host-data.js"];
const files = {};
for (const name of names) files[name] = sha(await readFile(join(out, name)));
await writeFile(join(out, "release.json"), JSON.stringify({
  schema: "awai.app.artifact.v1", id: app.id, version: meta.version, tauri: "3.0.0-alpha.6", profile: descriptor.profile, runtimePins: pins,
  guest: artifact, source_commit: commit, dirty, files,
}, null, 2) + "\n");
console.log(`${app.title} static build (${descriptor.profile}): ${names.length} pinned files, guest ${guestBytes.byteLength} bytes`);
