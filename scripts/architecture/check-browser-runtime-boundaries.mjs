#!/usr/bin/env node

import { access, readFile, readdir, stat } from "node:fs/promises";
import {
  basename,
  dirname,
  extname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep
} from "node:path";
import { pathToFileURL } from "node:url";

import { parse } from "svelte/compiler";

const REMOVED_NAME = ["player", "web"].join("-");
const REMOVED_PACKAGE = ["@pixel-point/aval", REMOVED_NAME].join("-");
const REMOVED_DIRECTORY = ["packages", REMOVED_NAME].join("/");
const CANONICAL_RUNTIME = "@pixel-point/aval-element";
const CANONICAL_ADAPTER = `${CANONICAL_RUNTIME}/adapter`;
const ADAPTER_SOURCE_PATH = "packages/element/src/adapter.ts";

const FRAMEWORK_WRAPPERS = Object.freeze(["react", "svelte"]);

const ALLOWED_FRAMEWORK_AVAL_IMPORTS = new Set([
  CANONICAL_RUNTIME,
  CANONICAL_ADAPTER
]);

const FRAMEWORK_SOURCE_EXTENSIONS = new Set([
  ".cjs",
  ".cts",
  ".js",
  ".jsx",
  ".mjs",
  ".mts",
  ".svelte",
  ".ts",
  ".tsx"
]);

const ADAPTER_COMMAND_NAMES = Object.freeze([
  "getDiagnostics",
  "pause",
  "play",
  "prepare",
  "readyFor",
  "send",
  "setState"
]);
const ADAPTER_COMMAND_NAME_SET = new Set(ADAPTER_COMMAND_NAMES);

const REVIEWED_ADAPTER_EXPORTS = Object.freeze([
  Object.freeze({
    source: "./adapter-binding.js",
    name: "AvalAdapterBinding",
    kind: "type"
  }),
  Object.freeze({
    source: "./adapter-binding.js",
    name: "AvalAdapterCommands",
    kind: "type"
  }),
  Object.freeze({
    source: "./adapter-binding.js",
    name: "AvalAdapterController",
    kind: "type"
  }),
  Object.freeze({
    source: "./adapter-binding.js",
    name: "AvalAdapterStatus",
    kind: "type"
  }),
  Object.freeze({
    source: "./adapter-binding.js",
    name: "createAvalAdapterBinding",
    kind: "value"
  }),
  Object.freeze({
    source: "./adapter-options.js",
    name: "AvalAdapterCallbacks",
    kind: "type"
  }),
  Object.freeze({
    source: "./adapter-options.js",
    name: "AvalAdapterConfiguration",
    kind: "type"
  }),
  Object.freeze({
    source: "./adapter-options.js",
    name: "AvalAdapterOptions",
    kind: "type"
  }),
  Object.freeze({
    source: "./adapter-options.js",
    name: "AvalAdapterRenderOptions",
    kind: "type"
  }),
  Object.freeze({
    source: "./adapter-options.js",
    name: "AvalSources",
    kind: "type"
  }),
  Object.freeze({
    source: "./adapter-options.js",
    name: "createAvalAdapterConfiguration",
    kind: "value"
  })
]);

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

const REQUIRED_ELEMENT_SOURCES = Object.freeze([
  Object.freeze({
    path: "packages/element/src/aval-element.ts",
    label: "canonical element runtime source"
  }),
  Object.freeze({
    path: "packages/element/src/player.ts",
    label: "canonical element runtime source"
  }),
  Object.freeze({
    path: ADAPTER_SOURCE_PATH,
    label: "canonical element adapter source"
  }),
  Object.freeze({
    path: "packages/element/src/player-session.ts",
    label: "player session owner source"
  }),
  Object.freeze({
    path: "packages/element/src/player-media-runtime.ts",
    label: "player media owner source"
  }),
  Object.freeze({
    path: "packages/element/src/element-runtime-session.ts",
    label: "element runtime session owner source"
  })
]);

const FACADE_SIZE_LIMITS = Object.freeze(new Map([
  ["packages/element/src/aval-element.ts", 800],
  ["packages/element/src/player.ts", 200]
]));

const LARGE_PLAYER_OWNER_FILES = new Set([
  "player-media-runtime.ts",
  "player-session.ts"
]);

const FORBIDDEN_OWNER_NAMES = new Set([
  "ElementContext",
  "PlayerContext",
  "RuntimeContext"
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
  await collectFrameworkProvenanceViolations(
    repositoryRoot,
    scannedFiles,
    violations
  );
  await collectAdapterBarrelViolations(repositoryRoot, violations);
  const reviewedRuntimeFiles = await collectRuntimeOwnershipViolations(
    repositoryRoot,
    violations
  );
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
    scannedFiles: scannedFiles.length,
    reviewedRuntimeFiles
  });
}

async function collectRuntimeOwnershipViolations(
  repositoryRoot,
  violations
) {
  const sourceRoot = join(repositoryRoot, "packages", "element", "src");
  const entries = await readdir(sourceRoot, { withFileTypes: true });
  const paths = entries
    .filter((entry) => entry.isFile() && runtimeOwnerSource(entry.name))
    .map((entry) => `packages/element/src/${entry.name}`)
    .sort(compareText);

  for (const path of paths) {
    const source = await readFile(join(repositoryRoot, path), "utf8");
    const limit = runtimeSourceLimit(path);
    const actual = lineCount(source);
    if (actual > limit) {
      violations.push(`${path}: ${actual} lines exceeds reviewed cap ${limit}`);
    }
    collectOwnerBagViolations(path, source, violations);
  }
  return paths.length;
}

function runtimeOwnerSource(name) {
  return name === "aval-element.ts" ||
    name === "player.ts" ||
    name.startsWith("player-") && name.endsWith(".ts") ||
    name.startsWith("element-") && name.endsWith(".ts");
}

function runtimeSourceLimit(path) {
  const facadeLimit = FACADE_SIZE_LIMITS.get(path);
  if (facadeLimit !== undefined) return facadeLimit;
  const name = basename(path);
  if (name.startsWith("player-") && !LARGE_PLAYER_OWNER_FILES.has(name)) {
    return 500;
  }
  return 1_000;
}

function lineCount(source) {
  return source.split("\n").length - Number(source.endsWith("\n"));
}

function collectOwnerBagViolations(path, source, violations) {
  const ast = parseArchitectureSource(path, source);
  const findings = new Set();
  visitAst(ast, (node) => {
    if (ownerDeclarationName(node) !== null) {
      const name = ownerDeclarationName(node);
      if (FORBIDDEN_OWNER_NAMES.has(name)) {
        findings.add(`forbidden generic owner declaration ${name}`);
      }
      if (isConstructorInputName(name)) {
        collectInputBagFindings(node, name, findings);
      }
    }
    if (node.type === "MethodDefinition" && node.kind === "constructor") {
      for (const parameter of node.value?.params ?? []) {
        if (isUnknownRecord(typeAnnotation(parameter))) {
          findings.add(
            "constructor parameters must not use Record<string, unknown> owner bags"
          );
        }
      }
    }
  });
  for (const finding of [...findings].sort(compareText)) {
    violations.push(`${path}: ${finding}`);
  }
}

function ownerDeclarationName(node) {
  if (
    node.type !== "TSInterfaceDeclaration" &&
    node.type !== "TSTypeAliasDeclaration" &&
    node.type !== "ClassDeclaration"
  ) return null;
  return node.id?.type === "Identifier" ? node.id.name : null;
}

function isConstructorInputName(name) {
  return /(?:Dependencies|Input|Options|Services)$/u.test(name);
}

function collectInputBagFindings(node, name, findings) {
  const members = node.type === "TSInterfaceDeclaration"
    ? node.body?.body
    : node.type === "TSTypeAliasDeclaration" &&
      node.typeAnnotation?.type === "TSTypeLiteral"
      ? node.typeAnnotation.members
      : null;
  if (!Array.isArray(members)) return;
  for (const member of members) {
    if (member.type === "TSIndexSignature" && hasStringIndex(member)) {
      findings.add(`${name} must not use a string index signature`);
    }
    if (
      member.type === "TSPropertySignature" &&
      isUnknownRecord(typeAnnotation(member))
    ) {
      findings.add(
        `${name} properties must not use Record<string, unknown> owner bags`
      );
    }
  }
}

function hasStringIndex(member) {
  return (member.parameters ?? []).some((parameter) =>
    typeAnnotation(parameter)?.type === "TSStringKeyword"
  );
}

function typeAnnotation(node) {
  const annotation = node?.typeAnnotation;
  return annotation?.type === "TSTypeAnnotation"
    ? annotation.typeAnnotation
    : annotation ?? null;
}

function isUnknownRecord(node) {
  if (node?.type !== "TSTypeReference") return false;
  if (
    node.typeName?.type === "Identifier" &&
    node.typeName.name === "Readonly"
  ) {
    const [wrapped] = node.typeArguments?.params ?? [];
    return isUnknownRecord(wrapped);
  }
  const parameters = node.typeArguments?.params ?? [];
  return node.typeName?.type === "Identifier" &&
    node.typeName.name === "Record" &&
    parameters.length === 2 &&
    parameters[0]?.type === "TSStringKeyword" &&
    parameters[1]?.type === "TSUnknownKeyword";
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
  for (const source of REQUIRED_ELEMENT_SOURCES) {
    if (!await isFile(join(repositoryRoot, source.path))) {
      throw new Error(`${source.label} is missing: ${source.path}`);
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

  for (const wrapper of FRAMEWORK_WRAPPERS) {
    if (!hasExactWrapperRuntimeDependencies(manifests.get(wrapper))) {
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

function hasExactWrapperRuntimeDependencies(manifest) {
  const dependencies = dependencyNames(manifest);
  return dependencies.length === 1 &&
    dependencies[0] === CANONICAL_RUNTIME &&
    isAbsentOrEmptyDependencyRecord(manifest.optionalDependencies) &&
    isAbsentOrEmptyBundleList(manifest.bundledDependencies) &&
    isAbsentOrEmptyBundleList(manifest.bundleDependencies);
}

function isAbsentOrEmptyDependencyRecord(value) {
  return value === undefined ||
    isJsonObject(value) && Object.keys(value).length === 0;
}

function isAbsentOrEmptyBundleList(value) {
  return value === undefined || value === false ||
    Array.isArray(value) && value.length === 0;
}

async function collectFrameworkProvenanceViolations(
  repositoryRoot,
  scannedFiles,
  violations
) {
  const declaredCommands = new Map(FRAMEWORK_WRAPPERS.map((wrapper) => [
    wrapper,
    new Set()
  ]));
  for (const path of scannedFiles) {
    const wrapper = frameworkProductionWrapper(path);
    if (wrapper === null) continue;
    const source = await readFile(join(repositoryRoot, path), "utf8");
    const ast = parseArchitectureSource(path, source);
    const findings = new Set();

    visitAst(ast, (node) => {
      const specifier = moduleSpecifier(node);
      if (isDynamicModuleLoad(node) && specifier === null) {
        findings.add(
          "production dynamic module loads must use a static string specifier"
        );
      }
      if (specifier !== null) {
        collectModuleProvenanceFinding(
          repositoryRoot,
          path,
          specifier,
          findings
        );
      }
      for (const name of declaredAdapterCommands(node)) {
        declaredCommands.get(wrapper).add(name);
      }
    });

    for (const finding of [...findings].sort(compareText)) {
      violations.push(`${path}: ${finding}`);
    }
  }

  for (const wrapper of FRAMEWORK_WRAPPERS) {
    const commands = declaredCommands.get(wrapper);
    if (ADAPTER_COMMAND_NAMES.every((name) => commands.has(name))) {
      violations.push(
        `packages/${wrapper}/src: wrapper production containers collectively restate all adapter command names`
      );
    }
  }
}

function frameworkProductionWrapper(path) {
  const wrapper = FRAMEWORK_WRAPPERS.find((candidate) =>
    path.startsWith(`packages/${candidate}/src/`)
  );
  if (
    wrapper === undefined ||
    !FRAMEWORK_SOURCE_EXTENSIONS.has(extname(path))
  ) {
    return null;
  }
  const name = basename(path);
  return name.includes(".test.") || name.includes(".compile.")
    ? null
    : wrapper;
}

function isDynamicModuleLoad(node) {
  return node.type === "ImportExpression" ||
    node.type === "CallExpression" &&
    node.callee?.type === "Identifier" &&
    node.callee.name === "require";
}

function collectModuleProvenanceFinding(
  repositoryRoot,
  sourcePath,
  specifier,
  findings
) {
  if (
    isAvalModuleSpecifier(specifier) &&
    !ALLOWED_FRAMEWORK_AVAL_IMPORTS.has(specifier)
  ) {
    findings.add(
      `production AVAL imports may only target ${CANONICAL_RUNTIME} or ${CANONICAL_ADAPTER} (found ${specifier})`
    );
  }

  if (!specifier.startsWith(".")) return;
  const elementSource = resolve(repositoryRoot, "packages/element/src");
  const importedPath = resolve(
    dirname(join(repositoryRoot, sourcePath)),
    specifier
  );
  if (isPathWithin(elementSource, importedPath)) {
    findings.add(
      `production relative imports cannot reach packages/element/src (found ${specifier})`
    );
  }
}

function isAvalModuleSpecifier(specifier) {
  return specifier === "@pixel-point/aval" ||
    specifier.startsWith("@pixel-point/aval-") ||
    specifier.startsWith("@pixel-point/aval/");
}

function isPathWithin(root, candidate) {
  const path = relative(root, candidate);
  return path === "" || path !== ".." &&
    !path.startsWith(`..${sep}`) &&
    !isAbsolute(path);
}

function moduleSpecifier(node) {
  switch (node.type) {
    case "ExportAllDeclaration":
    case "ExportNamedDeclaration":
    case "ImportDeclaration":
      return literalString(node.source);
    case "ImportExpression":
      return literalString(node.source);
    case "TSImportType":
      return literalString(node.argument);
    case "TSExternalModuleReference":
      return literalString(node.expression);
    case "CallExpression":
      return node.callee?.type === "Identifier" &&
        node.callee.name === "require" &&
        node.arguments?.length === 1
        ? literalString(node.arguments[0])
        : null;
    default:
      return null;
  }
}

function literalString(node) {
  if (node?.type === "Literal" && typeof node.value === "string") {
    return node.value;
  }
  if (
    node?.type === "TemplateLiteral" &&
    node.expressions?.length === 0 &&
    node.quasis?.length === 1
  ) {
    return node.quasis[0].value.cooked ?? node.quasis[0].value.raw;
  }
  return null;
}

function declaredAdapterCommands(node) {
  const members = commandContainerMembers(node);
  if (members === null) return [];
  return members
    .map(memberName)
    .filter((name) => ADAPTER_COMMAND_NAME_SET.has(name));
}

function commandContainerMembers(node) {
  switch (node.type) {
    case "ClassBody":
    case "TSInterfaceBody":
      return node.body;
    case "ObjectExpression":
      return node.properties;
    case "TSTypeLiteral":
      return node.members;
    default:
      return null;
  }
}

function memberName(member) {
  if (!isJsonObject(member) || !("key" in member)) return null;
  const key = member.key;
  if (key?.type === "Identifier" && member.computed !== true) return key.name;
  return literalString(key);
}

async function collectAdapterBarrelViolations(repositoryRoot, violations) {
  const source = await readFile(
    join(repositoryRoot, ADAPTER_SOURCE_PATH),
    "utf8"
  );
  const ast = parseArchitectureSource(ADAPTER_SOURCE_PATH, source);
  const body = scriptProgramBody(ast, ADAPTER_SOURCE_PATH);
  const actualExports = [];
  let hasExactBarrelShape = true;
  let hasPublicTypesReexport = false;
  let hasStarExport = false;

  for (const node of body) {
    if (node.type === "ExportAllDeclaration") {
      hasStarExport = true;
      hasExactBarrelShape = false;
      if (isPublicTypesModule(literalString(node.source))) {
        hasPublicTypesReexport = true;
      }
      continue;
    }
    if (
      node.type !== "ExportNamedDeclaration" ||
      node.declaration !== null ||
      !Array.isArray(node.specifiers)
    ) {
      hasExactBarrelShape = false;
      continue;
    }

    const source = literalString(node.source);
    if (isPublicTypesModule(source)) hasPublicTypesReexport = true;
    if (source === null) {
      hasExactBarrelShape = false;
      continue;
    }
    for (const specifier of node.specifiers) {
      const local = exportName(specifier.local);
      const exported = exportName(specifier.exported);
      if (
        specifier.type !== "ExportSpecifier" ||
        local === null ||
        exported === null ||
        local !== exported
      ) {
        hasExactBarrelShape = false;
        continue;
      }
      actualExports.push({
        source,
        name: exported,
        kind: specifier.exportKind ?? node.exportKind ?? "value"
      });
    }
  }

  if (hasStarExport) {
    violations.push(`${ADAPTER_SOURCE_PATH} must not use star exports`);
  }
  if (hasPublicTypesReexport) {
    violations.push(`${ADAPTER_SOURCE_PATH} must not re-export public-types`);
  }
  if (
    !hasExactBarrelShape ||
    !sameAdapterExports(actualExports, REVIEWED_ADAPTER_EXPORTS)
  ) {
    violations.push(
      `${ADAPTER_SOURCE_PATH} must expose exactly the reviewed adapter API`
    );
  }
}

function exportName(node) {
  if (node?.type === "Identifier") return node.name;
  return literalString(node);
}

function isPublicTypesModule(source) {
  return source === "./public-types" || source === "./public-types.js";
}

function sameAdapterExports(actual, expected) {
  if (actual.length !== expected.length) return false;
  const actualKeys = actual.map(adapterExportKey).sort(compareText);
  const expectedKeys = expected.map(adapterExportKey).sort(compareText);
  return actualKeys.every((key, index) => key === expectedKeys[index]);
}

function adapterExportKey(value) {
  return JSON.stringify([value.source, value.name, value.kind]);
}

function parseArchitectureSource(path, source) {
  const parseable = extname(path) === ".svelte"
    ? source
    : `<script lang="ts">\n${source}\n</script>`;
  try {
    return parse(parseable, { filename: path, modern: true });
  } catch (cause) {
    throw new Error(
      `${path}: cannot be parsed for architecture provenance`,
      { cause }
    );
  }
}

function scriptProgramBody(ast, path) {
  const body = ast.instance?.content?.body;
  if (!Array.isArray(body)) {
    throw new Error(`${path}: architecture parser did not produce a script`);
  }
  return body;
}

function visitAst(value, visitor, visited = new WeakSet()) {
  if ((typeof value !== "object" || value === null) || visited.has(value)) {
    return;
  }
  visited.add(value);
  if (Array.isArray(value)) {
    for (const item of value) visitAst(item, visitor, visited);
    return;
  }
  if (typeof value.type === "string") visitor(value);
  for (const child of Object.values(value)) {
    visitAst(child, visitor, visited);
  }
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
