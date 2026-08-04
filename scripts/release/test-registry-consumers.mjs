#!/usr/bin/env node
import { createHash } from "node:crypto";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

import { readStableRegistryState } from "./registry-client.mjs";
import { loadPublicationAuthorization } from "./publication-support.mjs";
import { RELEASE_VERSION } from "./release-set-model.mjs";
import { verifyRegistryReleaseSet } from "./verify-registry.mjs";

const args = parse(process.argv.slice(2));
const certification = await import(resolve("packages/certification/dist/index.js"));
const authorization = await loadPublicationAuthorization({
  releaseRoot: resolve(required(args, "release-root")),
  expectedCandidateDigest: required(args, "expected-candidate-digest"),
  expectedReleaseDigest: required(args, "expected-release-digest"),
  expectedReleaseSetDigest: required(args, "expected-release-set-digest"),
  expectedCommit: required(args, "expected-commit"),
  certification
});
const output = resolve(required(args, "output"));
const registry = authorization.policy.registry.url;
verifyRegistryReleaseSet({
  releaseSet: authorization.releaseSet,
  tag: "next",
  readState: (name, version) => readStableRegistryState(name, version, { registry })
});
const temporary = await mkdtemp(join(tmpdir(), "aval-registry-consumers-"));
try {
  const exact = authorization.releaseSet.order.map((name) => `${name}@${RELEASE_VERSION}`);
  for (const fixture of ["node-esm", "typescript-nodenext", "typescript-bundler", "browser-vite"]) {
    const target = join(temporary, fixture);
    await cp(resolve("tests/consumers", fixture), target, { recursive: true });
    run("npm", ["install", "--ignore-scripts", "--no-audit", "--no-fund", "--no-package-lock", "--registry", registry, ...exact], target, 120_000);
    if (fixture === "node-esm") run(process.execPath, ["index.mjs"], target, 30_000);
    else if (fixture === "browser-vite") run(process.execPath, [resolve("node_modules/vite/bin/vite.js"), "build"], target, 60_000);
    else run(process.execPath, [resolve("node_modules/typescript/bin/tsc"), "-p", "tsconfig.json"], target, 60_000);
  }
  const evidence = {
    schemaVersion: "1.0",
    evidenceKind: "registry-consumers",
    status: "passed",
    candidateManifestDigest: authorization.digest,
    releaseManifestDigest: authorization.releaseDigest,
    releaseSetDigest: authorization.releaseSet.releaseSetDigest,
    registryUrl: registry,
    tag: "next",
    packages: authorization.releaseSet.order
  };
  const bytes = certification.canonicalJsonBytes(evidence);
  await writeFile(output, bytes, { flag: "wx", mode: 0o444 });
  process.stdout.write(`${JSON.stringify({ status: "passed", output, digest: createHash("sha256").update(bytes).digest("hex"), consumers: 4 })}\n`);
} finally {
  await rm(temporary, { recursive: true, force: true });
}

function run(command, commandArgs, cwd, timeout) { const result = spawnSync(command, commandArgs, { cwd, encoding: "utf8", timeout, maxBuffer: 4 * 1024 * 1024 }); if (result.error !== undefined) throw result.error; if (result.status !== 0) throw new Error(`${command} registry consumer failed: ${result.stderr || result.stdout}`); }
function parse(values) { const result = {}; for (let index = 0; index < values.length; index += 2) { const key = values[index]; if (!key?.startsWith("--")) throw new Error(`invalid argument ${String(key)}`); result[key.slice(2)] = values[index + 1] ?? "true"; } return result; }
function required(values, key) { const value = values[key]; if (typeof value !== "string" || value.length < 1) throw new Error(`--${key} is required`); return value; }
