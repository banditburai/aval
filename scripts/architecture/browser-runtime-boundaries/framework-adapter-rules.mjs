import { readFile } from "node:fs/promises";
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

import {
  ADAPTER_COMMAND_NAMES,
  ADAPTER_COMMAND_NAME_SET,
  ADAPTER_SOURCE_PATH,
  ALLOWED_FRAMEWORK_AVAL_IMPORTS,
  CANONICAL_ADAPTER,
  CANONICAL_RUNTIME,
  FRAMEWORK_SOURCE_EXTENSIONS,
  FRAMEWORK_WRAPPERS,
  REVIEWED_ADAPTER_EXPORTS,
  compareText,
  isJsonObject
} from "./contracts.mjs";
import {
  exportName,
  literalString,
  moduleSpecifier,
  parseArchitectureSource,
  scriptProgramBody,
  visitAst
} from "./source-analysis.mjs";

export async function collectFrameworkProvenanceViolations(
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

export async function collectAdapterBarrelViolations(
  repositoryRoot,
  violations
) {
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
