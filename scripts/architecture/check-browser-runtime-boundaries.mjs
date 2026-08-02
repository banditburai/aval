#!/usr/bin/env node

import { access, readFile, readdir, stat } from "node:fs/promises";
import { extname, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const REMOVED_NAME = ["player", "web"].join("-");
const REMOVED_PACKAGE = ["@pixel-point/aval", REMOVED_NAME].join("-");
const REMOVED_DIRECTORY = ["packages", REMOVED_NAME].join("/");
const CANONICAL_RUNTIME = "@pixel-point/aval-element";

const REVIEWED_PACKAGES = Object.freeze([
  Object.freeze({
    directory: "certification",
    name: "@pixel-point/aval-certification"
  }),
  Object.freeze({
    directory: "compiler",
    name: "@pixel-point/aval-compiler"
  }),
  Object.freeze({
    directory: "element",
    name: CANONICAL_RUNTIME
  }),
  Object.freeze({
    directory: "format",
    name: "@pixel-point/aval-format"
  }),
  Object.freeze({
    directory: "graph",
    name: "@pixel-point/aval-graph"
  }),
  Object.freeze({
    directory: "react",
    name: "@pixel-point/aval-react"
  }),
  Object.freeze({
    directory: "svelte",
    name: "@pixel-point/aval-svelte"
  })
]);

const REVIEWED_PACKAGE_DIRECTORIES = new Set(
  REVIEWED_PACKAGES.map(({ directory }) => directory)
);

const ELEMENT_SOURCE_SENTINELS = Object.freeze([
  "packages/element/src/aval-element.ts",
  "packages/element/src/player.ts"
]);

const GENERATED_DIRECTORY_NAMES = new Set([
  ".git",
  ".next",
  ".playwright",
  ".playwright-cli",
  ".svelte-kit",
  ".vercel",
  "artifacts",
  "coverage",
  "dist",
  "node_modules",
  "out",
  "output",
  "playwright-report",
  "test-results"
]);

const HISTORICAL_DIRECTORY_PATHS = new Set([
  "docs/evidence",
  "docs/superpowers"
]);

const TEXT_EXTENSIONS = new Set([
  ".cjs",
  ".css",
  ".cts",
  ".html",
  ".js",
  ".json",
  ".jsx",
  ".md",
  ".mjs",
  ".mts",
  ".ps1",
  ".py",
  ".sh",
  ".svelte",
  ".toml",
  ".ts",
  ".tsx",
  ".txt",
  ".webmanifest",
  ".yaml",
  ".yml"
]);

const TEXT_FILE_NAMES = new Set([
  ".gitignore",
  ".npmrc",
  "Dockerfile",
  "LICENSE",
  "Makefile"
]);

export async function checkBrowserRuntimeBoundaries(
  root = process.cwd()
) {
  const repositoryRoot = resolve(root);
  const rootManifest = await readRequiredManifest(
    join(repositoryRoot, "package.json"),
    "repository root package manifest"
  );
  assertWorkspaceRoot(rootManifest);

  const manifests = await readReviewedPackageManifests(repositoryRoot);
  await assertElementSourceSentinels(repositoryRoot);

  const violations = [];
  await collectPackageTopologyViolations(repositoryRoot, violations);
  collectManifestViolations(manifests, violations);

  if (await exists(join(repositoryRoot, REMOVED_DIRECTORY))) {
    violations.push(`${REMOVED_DIRECTORY}: removed parallel runtime directory exists`);
  }
  const removedReport = join("etc", "api", `${REMOVED_NAME}.api.md`);
  if (await exists(join(repositoryRoot, removedReport))) {
    violations.push(`${removedReport}: removed parallel runtime API report exists`);
  }

  const files = [];
  await collectTextFiles(repositoryRoot, ".", files);
  const scannedFiles = [...new Set(files)].sort(compareText);
  for (const path of scannedFiles) {
    const text = await readFile(join(repositoryRoot, path), "utf8");
    if (
      text.includes(REMOVED_PACKAGE) ||
      text.includes(REMOVED_DIRECTORY) ||
      text.includes(REMOVED_NAME)
    ) {
      violations.push(`${path}: references the removed parallel runtime`);
    }
  }

  if (violations.length > 0) {
    throw new Error([
      "canonical browser runtime boundary failed:",
      ...violations.sort(compareText).map((violation) => `- ${violation}`)
    ].join("\n"));
  }

  return Object.freeze({
    status: "passed",
    canonicalRuntime: CANONICAL_RUNTIME,
    scannedFiles: scannedFiles.length
  });
}

function assertWorkspaceRoot(manifest) {
  const workspaces = Array.isArray(manifest.workspaces)
    ? manifest.workspaces
    : null;
  if (
    manifest.private !== true ||
    workspaces === null ||
    !workspaces.includes("packages/*")
  ) {
    throw new Error(
      "repository root package manifest does not identify the AVAL workspace"
    );
  }
}

async function readReviewedPackageManifests(repositoryRoot) {
  const manifests = new Map();
  for (const reviewedPackage of REVIEWED_PACKAGES) {
    const label = reviewedPackage.directory === "element"
      ? "canonical element package manifest"
      : `reviewed package manifest packages/${reviewedPackage.directory}`;
    const manifest = await readRequiredManifest(
      join(repositoryRoot, "packages", reviewedPackage.directory, "package.json"),
      label
    );
    manifests.set(reviewedPackage.directory, manifest);
  }
  return manifests;
}

async function assertElementSourceSentinels(repositoryRoot) {
  for (const sentinel of ELEMENT_SOURCE_SENTINELS) {
    if (!await isFile(join(repositoryRoot, sentinel))) {
      throw new Error(`canonical element runtime source is missing: ${sentinel}`);
    }
  }
}

async function collectPackageTopologyViolations(repositoryRoot, violations) {
  const packageRoot = join(repositoryRoot, "packages");
  const entries = await readdir(packageRoot, { withFileTypes: true });
  for (const entry of entries) {
    if (
      entry.isDirectory() &&
      !REVIEWED_PACKAGE_DIRECTORIES.has(entry.name)
    ) {
      violations.push(
        `packages/${entry.name} is outside the reviewed package architecture`
      );
    }
  }
}

function collectManifestViolations(manifests, violations) {
  for (const reviewedPackage of REVIEWED_PACKAGES) {
    const manifest = manifests.get(reviewedPackage.directory);
    if (manifest.name !== reviewedPackage.name) {
      violations.push(
        `packages/${reviewedPackage.directory} must be named ${reviewedPackage.name}`
      );
    }
  }

  for (const wrapper of ["react", "svelte"]) {
    const dependencies = dependencyNames(manifests.get(wrapper));
    if (
      dependencies.length !== 1 ||
      dependencies[0] !== CANONICAL_RUNTIME
    ) {
      violations.push(
        `packages/${wrapper} must depend exactly on ${CANONICAL_RUNTIME}`
      );
    }
  }
}

function dependencyNames(manifest) {
  if (!isJsonObject(manifest.dependencies)) return [];
  return Object.keys(manifest.dependencies).sort(compareText);
}

async function readRequiredManifest(path, label) {
  let source;
  try {
    source = await readFile(path, "utf8");
  } catch (error) {
    if (isMissing(error)) throw new Error(`${label} is missing`);
    throw error;
  }

  let value;
  try {
    value = JSON.parse(source);
  } catch {
    throw new Error(`${label} is not valid JSON`);
  }
  if (!isJsonObject(value)) {
    throw new Error(`${label} must contain a JSON object`);
  }
  return value;
}

function isJsonObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function collectTextFiles(repositoryRoot, path, output) {
  const absolute = join(repositoryRoot, path);
  const entries = await readdir(absolute, { withFileTypes: true });

  for (const entry of entries) {
    const child = join(path, entry.name);
    const normalized = relative(repositoryRoot, join(repositoryRoot, child))
      .replaceAll("\\", "/");
    if (entry.isDirectory()) {
      if (
        HISTORICAL_DIRECTORY_PATHS.has(normalized) ||
        GENERATED_DIRECTORY_NAMES.has(entry.name)
      ) continue;
      await collectTextFiles(repositoryRoot, child, output);
      continue;
    }
    if (
      !entry.isFile() ||
      !TEXT_EXTENSIONS.has(extname(entry.name)) &&
      !TEXT_FILE_NAMES.has(entry.name)
    ) continue;
    output.push(normalized);
  }
}

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch (error) {
    if (isMissing(error)) return false;
    throw error;
  }
}

async function isFile(path) {
  try {
    return (await stat(path)).isFile();
  } catch (error) {
    if (isMissing(error)) return false;
    throw error;
  }
}

function isMissing(error) {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

const executedPath = process.argv[1] === undefined
  ? null
  : pathToFileURL(resolve(process.argv[1])).href;
if (executedPath === import.meta.url) {
  const result = await checkBrowserRuntimeBoundaries();
  process.stdout.write(`${JSON.stringify(result)}\n`);
}
