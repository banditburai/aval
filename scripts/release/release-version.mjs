#!/usr/bin/env node
import { readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const STABLE_SEMVER = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/u;
const INTERNAL_PREFIX = "@pixel-point/aval-";
const DEPENDENCY_FIELDS = Object.freeze([
  "dependencies",
  "devDependencies",
  "optionalDependencies",
  "peerDependencies"
]);
const RELEASE_CONFIGS = Object.freeze([
  "api-changes.json",
  "legal-review.json",
  "publication-metadata.json",
  "release-policy.json"
]);
const CONSUMER_ROOTS = Object.freeze(["apps", "examples", "fixtures"]);
const IGNORED_DIRECTORIES = new Set([
  ".git",
  ".next",
  ".svelte-kit",
  ".vercel",
  "artifacts",
  "dist",
  "node_modules",
  "out",
  "output",
  "temp",
  "test-results"
]);

export function parseStableVersion(value) {
  if (typeof value !== "string") throw new TypeError("release version must be stable SemVer text");
  const match = STABLE_SEMVER.exec(value);
  if (match === null) throw new Error(`release version must be canonical stable SemVer: ${JSON.stringify(value)}`);
  const parts = match.slice(1).map((part) => Number(part));
  if (parts.some((part) => !Number.isSafeInteger(part))) throw new Error("release version exceeds safe integer bounds");
  return Object.freeze({ major: parts[0], minor: parts[1], patch: parts[2], text: value });
}

export function nextReleaseVersion(currentValue, request) {
  const current = parseStableVersion(currentValue);
  if (request === "major") return `${String(current.major + 1)}.0.0`;
  if (request === "minor") return `${String(current.major)}.${String(current.minor + 1)}.0`;
  if (request === "patch") return `${String(current.major)}.${String(current.minor)}.${String(current.patch + 1)}`;
  const requested = parseStableVersion(request);
  if (compareVersions(requested, current) <= 0) throw new Error(`exact release version must be greater than ${current.text}`);
  return requested.text;
}

export async function readReleaseVersion(root = DEFAULT_ROOT) {
  const policy = await readJson(join(resolve(root), "config/release/release-policy.json"));
  return parseStableVersion(policy.releaseVersion).text;
}

export async function validateReleaseVersionState(root = DEFAULT_ROOT, options = {}) {
  const repository = resolve(root);
  const policy = await readJson(join(repository, "config/release/release-policy.json"));
  const version = parseStableVersion(policy.releaseVersion).text;
  if (!Array.isArray(policy.publicPackages) || policy.publicPackages.length < 1 || new Set(policy.publicPackages).size !== policy.publicPackages.length) {
    throw new Error("release policy public package set is invalid");
  }
  const publicPackages = new Set(policy.publicPackages);
  for (const name of publicPackages) {
    if (typeof name !== "string" || !name.startsWith(INTERNAL_PREFIX)) throw new Error(`public package is outside @pixel-point: ${String(name)}`);
  }

  const packagePaths = await directPackageManifests(join(repository, "packages"));
  const manifests = await Promise.all(packagePaths.map(async (path) => ({ path, value: await readJson(path) })));
  const names = new Set();
  for (const { path, value } of manifests) {
    if (typeof value.name !== "string" || names.has(value.name)) throw new Error(`package identity is invalid or duplicated: ${path}`);
    names.add(value.name);
    if (value.version !== version) throw new Error(`${value.name} version drift: expected ${version}, received ${String(value.version)}`);
    if (publicPackages.has(value.name) && value.private !== false) throw new Error(`${value.name} must be explicitly public`);
    if (!publicPackages.has(value.name) && value.private !== true) throw new Error(`${value.name} is outside the public release set and must be private`);
    validateInternalReferences(value, publicPackages, version, path);
  }
  for (const name of publicPackages) if (!names.has(name)) throw new Error(`public package is missing from packages/: ${name}`);

  const consumerPaths = await collectConsumerPackageManifests(repository);
  for (const path of consumerPaths) validateInternalReferences(await readJson(path), publicPackages, version, path);

  for (const name of RELEASE_CONFIGS) {
    const path = join(repository, "config/release", name);
    const config = await readJson(path);
    if (config.releaseVersion !== version) throw new Error(`${name} version drift: expected ${version}, received ${String(config.releaseVersion)}`);
  }

  if (options.includeLockfile !== false) await validateLockfile(repository, publicPackages, version);
  return Object.freeze({ version, publicPackages: publicPackages.size, packages: manifests.length });
}

export async function bumpReleaseVersion(root = DEFAULT_ROOT, request) {
  const repository = resolve(root);
  const previousVersion = await readReleaseVersion(repository);
  const version = nextReleaseVersion(previousVersion, request);
  const policyPath = join(repository, "config/release/release-policy.json");
  const policy = await readJson(policyPath);
  const publicPackages = new Set(policy.publicPackages);
  const updates = new Map();

  for (const path of await directPackageManifests(join(repository, "packages"))) {
    const manifest = await readJson(path);
    updates.set(path, synchronizeManifest(manifest, publicPackages, version, true));
  }
  for (const path of await collectConsumerPackageManifests(repository)) {
    const manifest = await readJson(path);
    const synchronized = synchronizeManifest(manifest, publicPackages, version, false);
    if (JSON.stringify(synchronized) !== JSON.stringify(manifest)) updates.set(path, synchronized);
  }
  for (const name of RELEASE_CONFIGS) {
    const path = join(repository, "config/release", name);
    const config = { ...(await readJson(path)), releaseVersion: version };
    if (name === "legal-review.json" || name === "publication-metadata.json") {
      config.status = "pending";
      config.reviewId = null;
      config.reviewerRole = null;
      config.reviewedAt = null;
    }
    updates.set(path, config);
  }
  const readmePath = join(repository, "README.md");
  try {
    const readme = await readFile(readmePath, "utf8");
    const synchronized = readme.replaceAll(
      new RegExp(`(@pixel-point/aval-[a-z0-9-]+@)${escapeRegularExpression(previousVersion)}\\b`, "gu"),
      `$1${version}`
    );
    if (synchronized !== readme) updates.set(readmePath, synchronized);
  } catch (error) { if (error?.code !== "ENOENT") throw error; }

  for (const [path, value] of updates) {
    if (typeof value === "string") await writeTextAtomic(path, value);
    else await writeJsonAtomic(path, value);
  }
  await validateReleaseVersionState(repository, { includeLockfile: false });
  return Object.freeze({ previousVersion, version, updatedFiles: updates.size });
}

function synchronizeManifest(manifest, publicPackages, version, ownVersion) {
  const result = structuredClone(manifest);
  if (ownVersion) result.version = version;
  for (const field of DEPENDENCY_FIELDS) {
    const dependencies = result[field];
    if (dependencies === undefined) continue;
    if (dependencies === null || typeof dependencies !== "object" || Array.isArray(dependencies)) throw new Error(`${String(result.name)} ${field} is invalid`);
    for (const name of Object.keys(dependencies)) if (publicPackages.has(name)) dependencies[name] = version;
  }
  return result;
}

function validateInternalReferences(manifest, publicPackages, version, path) {
  for (const field of DEPENDENCY_FIELDS) {
    const dependencies = manifest[field];
    if (dependencies === undefined) continue;
    if (dependencies === null || typeof dependencies !== "object" || Array.isArray(dependencies)) throw new Error(`${path} ${field} is invalid`);
    for (const [name, value] of Object.entries(dependencies)) {
      if (publicPackages.has(name) && value !== version) throw new Error(`${path} internal dependency drift: ${name} must be exactly ${version}`);
    }
  }
}

async function validateLockfile(repository, publicPackages, version) {
  const lockPath = join(repository, "package-lock.json");
  const lock = await readJson(lockPath);
  if (lock === null || typeof lock !== "object" || lock.packages === null || typeof lock.packages !== "object" || Array.isArray(lock.packages)) throw new Error("package-lock.json package map is invalid");
  for (const [path, entry] of Object.entries(lock.packages)) {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) continue;
    if (path.startsWith("packages/") && typeof entry.name === "string" && entry.name.startsWith(INTERNAL_PREFIX) && entry.version !== version) {
      throw new Error(`package-lock.json ${entry.name} version drift: expected ${version}`);
    }
    validateInternalReferences(entry, publicPackages, version, `package-lock.json#packages/${path}`);
  }
}

async function directPackageManifests(packagesRoot) {
  const entries = await readdir(packagesRoot, { withFileTypes: true });
  return entries.filter((entry) => entry.isDirectory()).map((entry) => join(packagesRoot, entry.name, "package.json")).sort();
}

async function collectConsumerPackageManifests(repository) {
  const result = [];
  for (const directory of CONSUMER_ROOTS) {
    const root = join(repository, directory);
    await walk(root, result).catch((error) => {
      if (error?.code !== "ENOENT") throw error;
    });
  }
  return result.sort();
}

async function walk(directory, result) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (!IGNORED_DIRECTORIES.has(entry.name)) await walk(path, result);
    } else if (entry.isFile() && entry.name === "package.json") result.push(path);
  }
}

function compareVersions(left, right) {
  return left.major - right.major || left.minor - right.minor || left.patch - right.patch;
}

function escapeRegularExpression(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

async function readJson(path) {
  try { return JSON.parse(await readFile(path, "utf8")); }
  catch (error) { throw new Error(`could not read canonical JSON ${path}`, { cause: error }); }
}

async function writeJsonAtomic(path, value) {
  await writeTextAtomic(path, `${JSON.stringify(value, null, 2)}\n`);
}

async function writeTextAtomic(path, value) {
  const temporary = `${path}.${String(process.pid)}.tmp`;
  try {
    await writeFile(temporary, value, { flag: "wx" });
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}

async function main() {
  const [command = "check", request, ...extra] = process.argv.slice(2);
  if (extra.length > 0) throw new Error("unexpected release-version arguments");
  if (command === "current" && request === undefined) {
    process.stdout.write(`${await readReleaseVersion(DEFAULT_ROOT)}\n`);
    return;
  }
  if (command === "check" && request === undefined) {
    process.stdout.write(`${JSON.stringify({ status: "passed", ...(await validateReleaseVersionState(DEFAULT_ROOT)) })}\n`);
    return;
  }
  if (command === "bump" && request !== undefined) {
    process.stdout.write(`${JSON.stringify({ status: "passed", ...(await bumpReleaseVersion(DEFAULT_ROOT, request)) })}\n`);
    return;
  }
  throw new Error("usage: release-version.mjs current | check | bump <major|minor|patch|x.y.z>");
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
