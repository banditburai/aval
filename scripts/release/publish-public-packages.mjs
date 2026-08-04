#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

import { canonicalRegistryUrl, readStableRegistryState, runRegistryMutation } from "./registry-client.mjs";
import { loadVerifiedReleaseSet } from "./release-set.mjs";
import { RELEASE_PACKAGE_NAMES, RELEASE_VERSION } from "./release-set-model.mjs";

const DEFAULT_CONVERGENCE = Object.freeze({
  attempts: 121,
  delayMs: 5_000,
  wait: (delayMs) => new Promise((resolveWait) => setTimeout(resolveWait, delayMs))
});

export async function publishPublicPackages({ releaseSet, execute = false, adapter, convergence = DEFAULT_CONVERGENCE }) {
  validateReleaseSet(releaseSet);
  validateAdapter(adapter);
  validateConvergence(convergence);
  const records = [];

  for (const archive of releaseSet.packages) {
    const before = await adapter.read(archive.name, RELEASE_VERSION);
    validateRegistryState(before, archive.name);
    let action;
    if (before.integrity === null) action = "publish";
    else if (before.integrity !== archive.registryIntegrity) throw new Error(`${archive.name}@${RELEASE_VERSION} registry integrity conflict`);
    else if (before.tags.next !== RELEASE_VERSION) action = "tag-next";
    else action = "already-exact";

    if (execute && action === "publish") await adapter.publish(archive);
    if (execute && action === "tag-next") await adapter.setTag(archive.name, RELEASE_VERSION, "next");
    if (execute) await requireExactTag(adapter, archive, "next", convergence);
    records.push({
      name: archive.name,
      action,
      next: execute ? RELEASE_VERSION : before.tags.next ?? null,
      latest: before.tags.latest ?? null
    });
  }

  if (!execute) return Object.freeze({ mode: "dry-run", version: RELEASE_VERSION, packages: Object.freeze(records.map(Object.freeze)) });

  const beforeLatest = new Map();
  for (const archive of releaseSet.packages) {
    const state = await requireExactTag(adapter, archive, "next", convergence);
    beforeLatest.set(archive.name, state.tags.latest ?? null);
  }

  const promoted = [];
  try {
    for (const archive of releaseSet.packages) {
      const previous = beforeLatest.get(archive.name);
      if (previous === RELEASE_VERSION) continue;
      await adapter.setTag(archive.name, RELEASE_VERSION, "latest");
      promoted.push(archive.name);
      await requireExactTag(adapter, archive, "latest", convergence);
    }
  } catch (promotionError) {
    const rollbackErrors = [];
    for (const name of promoted.reverse()) {
      try {
        const previous = beforeLatest.get(name);
        if (previous === null) await adapter.removeTag(name, "latest");
        else await adapter.setTag(name, previous, "latest");
      } catch (error) { rollbackErrors.push(error); }
    }
    throw new AggregateError([promotionError, ...rollbackErrors], "latest promotion failed; earlier tag changes were compensated where possible");
  }

  for (const [index, archive] of releaseSet.packages.entries()) {
    const state = await requireExactTag(adapter, archive, "latest", convergence);
    records[index].next = state.tags.next ?? null;
    records[index].latest = state.tags.latest ?? null;
  }
  return Object.freeze({ mode: "executed", version: RELEASE_VERSION, packages: Object.freeze(records.map(Object.freeze)) });
}

async function requireExactTag(adapter, archive, tag, convergence) {
  let state;
  for (let attempt = 1; attempt <= convergence.attempts; attempt += 1) {
    state = await adapter.read(archive.name, RELEASE_VERSION);
    validateRegistryState(state, archive.name);
    if (state.integrity !== null && state.integrity !== archive.registryIntegrity) {
      throw new Error(`${archive.name}@${RELEASE_VERSION} registry integrity conflict`);
    }
    if (state.integrity === archive.registryIntegrity && state.tags[tag] === RELEASE_VERSION) return state;
    if (attempt < convergence.attempts) await convergence.wait(convergence.delayMs);
  }

  const waitedMs = (convergence.attempts - 1) * convergence.delayMs;
  if (state.integrity === null) {
    throw new Error(`${archive.name}@${RELEASE_VERSION} was not visible after ${formatDuration(waitedMs)} of registry polling`);
  }
  throw new Error(`${archive.name} ${tag} tag did not resolve to ${RELEASE_VERSION} after ${formatDuration(waitedMs)} of registry polling`);
}

function validateReleaseSet(releaseSet) {
  if (releaseSet === null || typeof releaseSet !== "object" || releaseSet.releaseVersion !== RELEASE_VERSION || !Array.isArray(releaseSet.packages)) throw new Error("publication requires the synchronized release set");
  if (releaseSet.packages.length !== RELEASE_PACKAGE_NAMES.length) throw new Error("publication requires exactly the public package set");
  for (const [index, archive] of releaseSet.packages.entries()) {
    if (archive === null || typeof archive !== "object" || archive.name !== RELEASE_PACKAGE_NAMES[index] || archive.version !== RELEASE_VERSION || typeof archive.path !== "string" || !isCanonicalIntegrity(archive.registryIntegrity)) {
      throw new Error(`publication release package is invalid at position ${String(index)}`);
    }
  }
}

function validateAdapter(adapter) {
  for (const method of ["read", "publish", "setTag", "removeTag"]) {
    if (adapter === null || typeof adapter !== "object" || typeof adapter[method] !== "function") throw new Error(`registry adapter is missing ${method}`);
  }
}

function validateConvergence(convergence) {
  if (convergence === null || typeof convergence !== "object") throw new Error("registry convergence policy is invalid");
  if (!Number.isSafeInteger(convergence.attempts) || convergence.attempts < 1) throw new Error("registry convergence attempts must be a positive integer");
  if (!Number.isSafeInteger(convergence.delayMs) || convergence.delayMs < 0) throw new Error("registry convergence delay must be a non-negative integer");
  if (typeof convergence.wait !== "function") throw new Error("registry convergence wait function is invalid");
}

function formatDuration(milliseconds) {
  if (milliseconds >= 60_000 && milliseconds % 60_000 === 0) return `${String(milliseconds / 60_000)} minutes`;
  if (milliseconds >= 1_000 && milliseconds % 1_000 === 0) return `${String(milliseconds / 1_000)} seconds`;
  return `${String(milliseconds)} ms`;
}

function validateRegistryState(state, name) {
  if (state === null || typeof state !== "object" || state.name !== name || state.version !== RELEASE_VERSION || state.tags === null || typeof state.tags !== "object" || Array.isArray(state.tags)) throw new Error(`${name} registry state is invalid`);
  if (state.integrity !== null && !isCanonicalIntegrity(state.integrity)) throw new Error(`${name} registry integrity is invalid`);
}

function isCanonicalIntegrity(value) {
  if (typeof value !== "string" || !/^sha512-[A-Za-z0-9+/]{86}==$/u.test(value)) return false;
  const encoded = value.slice(7);
  const bytes = Buffer.from(encoded, "base64");
  return bytes.byteLength === 64 && bytes.toString("base64") === encoded;
}

export function ensureAuthenticatedNpmIdentity({
  registry,
  interactive = process.stdin.isTTY === true && process.stdout.isTTY === true,
  spawn = spawnSync,
  write = (message) => process.stderr.write(message)
}) {
  const exactRegistry = canonicalRegistryUrl(registry);
  let identity = npmIdentity(spawn, exactRegistry);
  if (identity === null) {
    if (!interactive) {
      throw new Error("npm authentication is required; configure NODE_AUTH_TOKEN or run npm login --auth-type web before non-interactive publication");
    }
    write("No active npm session. Starting npm web login for @pixel-point; complete the approval in your browser.\n");
    const login = spawn("npm", [
      "login",
      "--auth-type",
      "web",
      "--scope",
      "@pixel-point",
      "--registry",
      exactRegistry
    ], { stdio: "inherit", timeout: 10 * 60_000 });
    if (login.error !== undefined) throw login.error;
    if (login.status !== 0) throw new Error(`npm web login failed${diagnosticSuffix(login)}`);
    identity = npmIdentity(spawn, exactRegistry);
    if (identity === null) throw new Error("npm web login completed without an authenticated registry session");
  }

  const membership = spawn("npm", ["org", "ls", "pixel-point", "--json", "--registry", exactRegistry], { encoding: "utf8", timeout: 30_000 });
  if (membership.error !== undefined) throw membership.error;
  if (membership.status !== 0) throw new Error(`npm @pixel-point membership lookup failed${diagnosticSuffix(membership)}`);
  let members;
  try { members = JSON.parse(String(membership.stdout)); }
  catch { throw new Error("npm returned invalid @pixel-point organization membership data"); }
  const authorized = Array.isArray(members) ? members.includes(identity) : members !== null && typeof members === "object" && Object.hasOwn(members, identity);
  if (!authorized) throw new Error(`${identity} is not an authorized @pixel-point npm organization member`);
  return identity;
}

function npmIdentity(spawn, registry) {
  const result = spawn("npm", ["whoami", "--registry", registry], { encoding: "utf8", timeout: 30_000 });
  if (result.error !== undefined) throw result.error;
  if (result.status !== 0) {
    const diagnostics = `${String(result.stderr ?? "")}\n${String(result.stdout ?? "")}`;
    if (/\b(?:ENEEDAUTH|E401)\b|\b401 Unauthorized\b|not logged in|need auth/iu.test(diagnostics)) return null;
    throw new Error(`npm identity check failed${diagnosticSuffix(result)}`);
  }
  const identity = String(result.stdout).trim();
  if (!/^[a-z0-9][a-z0-9-]{0,62}$/u.test(identity)) throw new Error("npm returned an invalid authenticated identity");
  return identity;
}

function diagnosticSuffix(result) {
  const value = `${String(result.stderr ?? "")}\n${String(result.stdout ?? "")}`.replace(/[\r\n]+/gu, " ").trim().slice(0, 500);
  return value === "" ? "" : `: ${value}`;
}

function npmAdapter(registry) {
  const options = { registry };
  return Object.freeze({
    read: (name, version) => readStableRegistryState(name, version, options),
    publish: (archive) => runRegistryMutation(["publish", archive.path, "--tag", "next", "--access", "public", "--ignore-scripts"], options),
    setTag: (name, version, tag) => runRegistryMutation(["dist-tag", "add", `${name}@${version}`, tag], options),
    removeTag: (name, tag) => runRegistryMutation(["dist-tag", "rm", name, tag], options)
  });
}

async function main() {
  const args = parseArguments(process.argv.slice(2));
  const execute = args.execute === "true";
  const policy = JSON.parse(await readFile(resolve(args.policy ?? "config/release/release-policy.json"), "utf8"));
  const packages = resolve(args.packages ?? `artifacts/${RELEASE_VERSION}/packages`);
  const packageIndex = JSON.parse(await readFile(resolve(args.index ?? `artifacts/${RELEASE_VERSION}/package-index.json`), "utf8"));
  const releaseSet = await loadVerifiedReleaseSet({ directory: packages, policy, packageIndex });
  const registry = canonicalRegistryUrl(policy.registry?.url);
  const identity = execute ? ensureAuthenticatedNpmIdentity({ registry }) : null;
  const result = await publishPublicPackages({ releaseSet, execute, adapter: npmAdapter(registry) });
  process.stdout.write(`${JSON.stringify({ status: "passed", registry, identity, ...result }, null, 2)}\n`);
}

function parseArguments(values) {
  const result = {};
  for (let index = 0; index < values.length; index += 1) {
    const key = values[index];
    if (!key?.startsWith("--")) throw new Error(`invalid argument ${String(key)}`);
    if (key === "--execute") result.execute = "true";
    else {
      const value = values[index + 1];
      if (value === undefined || value.startsWith("--")) throw new Error(`${key} requires a value`);
      result[key.slice(2)] = value;
      index += 1;
    }
  }
  return result;
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
