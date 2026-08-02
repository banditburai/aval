import { chmod, copyFile, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { basename, join, relative, resolve, sep } from "node:path";
import { spawnSync } from "node:child_process";

import { RELEASE_PACKAGE_SPECS } from "./release-set-model.mjs";

const MAXIMUM_CLOSURE_PACKAGES = 256;
const MAXIMUM_MANIFEST_BYTES = 1024 * 1024;
const MAXIMUM_STAGED_PACKAGE_BYTES = 256 * 1024 * 1024;
const MAXIMUM_STAGED_PACKAGE_FILES = 16_384;
const CONSUMER_HARNESS_SUPPORT = Object.freeze({
  react: Object.freeze(["@types/react"]),
  svelte: Object.freeze(["@sveltejs/vite-plugin-svelte", "vite"])
});

/** Derive runtime peers and the reviewed tooling needed to exercise them in clean consumers. */
export function releaseConsumerInstallRoots(specifications = RELEASE_PACKAGE_SPECS) {
  if (!Array.isArray(specifications) || specifications.length === 0) throw new TypeError("release package specifications are invalid");
  const peers = [...new Set(specifications.flatMap((specification) => {
    if (specification === null || typeof specification !== "object" || specification.peerDependencies === null || typeof specification.peerDependencies !== "object" || Array.isArray(specification.peerDependencies)) {
      throw new TypeError("release package peer dependency contract is invalid");
    }
    return Object.keys(specification.peerDependencies).map(validatePackageName);
  }))].sort(compareText);
  return Object.freeze(peers.flatMap((name) => [name, ...(CONSUMER_HARNESS_SUPPORT[name] ?? [])]));
}

/** Pack the exact installed dependency closure used by clean release consumers. */
export async function packReleaseConsumerDependencies({ root, destination }) {
  const peerNames = [...new Set(RELEASE_PACKAGE_SPECS.flatMap(({ peerDependencies }) => Object.keys(peerDependencies)))].sort(compareText);
  const repository = resolve(root);
  const installedRoot = await realpath(join(repository, "node_modules"));
  const peerVersions = Object.fromEntries(await Promise.all(peerNames.map(async (name) => {
    const manifest = await readInstalledManifest(installedRoot, name);
    return [name, manifest.version];
  })));
  const archives = await packInstalledClosure({
    root: repository,
    destination,
    packages: releaseConsumerInstallRoots()
  });
  return Object.freeze({ archives, peerVersions: Object.freeze(peerVersions) });
}

/** Verify the exact runtime peer versions installed into one isolated consumer. */
export async function verifyInstalledPeerVersions(projectRoot, expectedVersions) {
  if (expectedVersions === null || typeof expectedVersions !== "object" || Array.isArray(expectedVersions)) throw new TypeError("expected peer versions are invalid");
  const installedRoot = await realpath(join(resolve(projectRoot), "node_modules"));
  for (const [name, version] of Object.entries(expectedVersions)) {
    if (typeof version !== "string" || version.length < 1) throw new TypeError(`expected peer version is invalid: ${name}`);
    const manifest = await readInstalledManifest(installedRoot, validatePackageName(name));
    if (manifest.version !== version) throw new Error(`packed consumer ${name} peer version drifted: ${String(manifest.version)}`);
  }
}

/** Pack named installed packages and the complete closure of their declared dependencies. */
export async function packInstalledClosure({ root, destination, packages }) {
  if (!Array.isArray(packages) || packages.length === 0 || packages.length > MAXIMUM_CLOSURE_PACKAGES) throw new TypeError("installed package closure roots are invalid");
  const repository = resolve(root);
  const installedRoot = await realpath(join(repository, "node_modules"));
  const archiveRoot = resolve(destination);
  await mkdir(archiveRoot, { recursive: true });
  const archiveRootInfo = await lstat(archiveRoot);
  if (!archiveRootInfo.isDirectory() || archiveRootInfo.isSymbolicLink()) throw new Error("local package archive destination must be a regular directory");

  const pending = packages.map(validatePackageName);
  const packed = new Map();
  while (pending.length > 0) {
    const name = pending.shift();
    if (packed.has(name)) continue;
    if (packed.size >= MAXIMUM_CLOSURE_PACKAGES) throw new Error("installed package dependency closure exceeds its bound");
    const manifest = await readInstalledManifest(installedRoot, name);
    const archive = await packLocalDependency({ repository, source: manifest.directory, destination: archiveRoot, manifest });
    packed.set(name, archive);
    for (const dependency of Object.keys(manifest.dependencies)) {
      if (!Object.hasOwn(manifest.optionalDependencies, dependency)) pending.push(validatePackageName(dependency));
    }
    for (const dependency of Object.keys(manifest.optionalDependencies)) {
      const validated = validatePackageName(dependency);
      if (await installedPackageExists(installedRoot, validated)) pending.push(validated);
    }
  }
  return Object.freeze([...packed.values()]);
}

async function readInstalledManifest(installedRoot, name) {
  const packagePath = join(installedRoot, ...packageNameSegments(name));
  const packageInfo = await lstat(packagePath);
  if (!packageInfo.isDirectory() || packageInfo.isSymbolicLink()) throw new Error(`installed package must be a regular directory: ${name}`);
  const directory = await realpath(packagePath);
  assertContained(installedRoot, directory, `installed package escapes node_modules: ${name}`);
  const manifestPath = join(directory, "package.json");
  const manifestInfo = await lstat(manifestPath);
  if (!manifestInfo.isFile() || manifestInfo.isSymbolicLink() || manifestInfo.size < 2 || manifestInfo.size > MAXIMUM_MANIFEST_BYTES) throw new Error(`installed package manifest is not a bounded regular file: ${name}`);
  const parsed = JSON.parse(await readFile(manifestPath, "utf8"));
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed) || parsed.name !== name || typeof parsed.version !== "string" || parsed.version.length < 1) throw new Error(`installed package manifest identity is invalid: ${name}`);
  const dependencies = installedDependencyMap(parsed.dependencies, name, "dependencies");
  const optionalDependencies = installedDependencyMap(parsed.optionalDependencies, name, "optionalDependencies");
  return Object.freeze({ name, version: parsed.version, directory, dependencies, optionalDependencies, packageJson: parsed });
}

function installedDependencyMap(value, owner, field) {
  const dependencies = value ?? {};
  if (dependencies === null || typeof dependencies !== "object" || Array.isArray(dependencies)) throw new Error(`installed package ${field} are invalid: ${owner}`);
  for (const [dependency, version] of Object.entries(dependencies)) {
    validatePackageName(dependency);
    if (typeof version !== "string" || version.length < 1 || version.length > 512) throw new Error(`installed dependency range is invalid: ${owner} -> ${dependency}`);
  }
  return Object.freeze({ ...dependencies });
}

async function installedPackageExists(installedRoot, name) {
  try {
    await lstat(join(installedRoot, ...packageNameSegments(name)));
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

async function packLocalDependency({ repository, source, destination, manifest }) {
  const stagingRoot = await mkdtemp(join(destination, ".pack-"));
  const staging = join(stagingRoot, "package");
  try {
    await copyInstalledPackage(source, staging);
    const packageJson = structuredClone(manifest.packageJson);
    if (packageJson.scripts !== undefined) {
      if (packageJson.scripts === null || typeof packageJson.scripts !== "object" || Array.isArray(packageJson.scripts)) throw new Error(`installed package scripts are invalid: ${manifest.name}`);
      packageJson.scripts = { ...packageJson.scripts };
      for (const lifecycle of ["prepack", "prepare", "postpack"]) delete packageJson.scripts[lifecycle];
      if (Object.keys(packageJson.scripts).length === 0) delete packageJson.scripts;
    }
    await writeFile(join(staging, "package.json"), `${JSON.stringify(packageJson, null, 2)}\n`, { flag: "wx", mode: 0o644 });
    const result = spawnSync(process.platform === "win32" ? "npm.cmd" : "npm", [
      "pack",
      "--json",
      "--ignore-scripts",
      "--cache",
      join(destination, ".npm-cache"),
      "--pack-destination",
      destination,
      staging
    ], {
      cwd: repository,
      encoding: "utf8",
      timeout: 120_000,
      maxBuffer: 4 * 1024 * 1024
    });
    if (result.error !== undefined) throw result.error;
    if (result.status !== 0) throw new Error(result.stderr || result.stdout);
    const report = JSON.parse(result.stdout);
    if (
      !Array.isArray(report) || report.length !== 1 ||
      report[0]?.name !== manifest.name || report[0]?.version !== manifest.version ||
      typeof report[0]?.filename !== "string" || basename(report[0].filename) !== report[0].filename
    ) throw new Error(`npm pack returned an unexpected report for ${manifest.name}`);
    return join(destination, report[0].filename);
  } finally {
    await rm(stagingRoot, { recursive: true, force: true });
  }
}

async function copyInstalledPackage(source, target) {
  const state = { bytes: 0, files: 0 };
  await copyInstalledDirectory(source, target, source, state);
}

async function copyInstalledDirectory(source, target, root, state) {
  await mkdir(target, { recursive: true });
  for (const entry of (await readdir(source, { withFileTypes: true })).sort((left, right) => compareText(left.name, right.name))) {
    if (source === root && (entry.name === "node_modules" || entry.name === "package.json")) continue;
    const sourcePath = join(source, entry.name);
    const targetPath = join(target, entry.name);
    const info = await lstat(sourcePath);
    if (info.isSymbolicLink()) throw new Error(`installed package contains a symbolic link: ${relative(root, sourcePath)}`);
    if (info.isDirectory()) {
      await copyInstalledDirectory(sourcePath, targetPath, root, state);
      continue;
    }
    if (!info.isFile()) throw new Error(`installed package contains a special file: ${relative(root, sourcePath)}`);
    state.files += 1;
    state.bytes += info.size;
    if (state.files > MAXIMUM_STAGED_PACKAGE_FILES || state.bytes > MAXIMUM_STAGED_PACKAGE_BYTES) throw new Error("installed package exceeds the local archive staging bounds");
    await copyFile(sourcePath, targetPath);
    await chmod(targetPath, info.mode & 0o777);
  }
}

function validatePackageName(value) {
  packageNameSegments(value);
  return value;
}

function packageNameSegments(value) {
  if (typeof value !== "string" || value.length < 1 || value.length > 214 || value.includes("\\")) throw new TypeError(`installed package name is invalid: ${String(value)}`);
  const segments = value.split("/");
  const scoped = value.startsWith("@");
  if (segments.length !== (scoped ? 2 : 1)) throw new TypeError(`installed package name is invalid: ${value}`);
  const names = scoped ? [segments[0].slice(1), segments[1]] : segments;
  if (names.some((segment) => !/^[a-z0-9][a-z0-9._-]*$/u.test(segment))) throw new TypeError(`installed package name is invalid: ${value}`);
  return scoped ? [`@${names[0]}`, names[1]] : names;
}

function assertContained(root, path, message) {
  const within = relative(root, path);
  if (within === "" || within === ".." || within.startsWith(`..${sep}`)) throw new Error(message);
}

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}
