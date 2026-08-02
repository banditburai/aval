import { readFile, readdir } from "node:fs/promises";
import { basename, join } from "node:path";

import { compareText } from "./contracts.mjs";
import {
  exportName,
  moduleSpecifier,
  parseArchitectureSource,
  visitAst
} from "./source-analysis.mjs";

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

const CONCRETE_MEDIA_MODULES = new Set([
  "./asset.js",
  "./decoder.js",
  "./decoder-pool.js",
  "./renderer.js"
]);

const REVERSE_PLAYER_DEPENDENCIES = new Set([
  "./player.js",
  "./player-selection.js",
  "./player-session.js"
]);

const SESSION_RESOURCE_MODULES = new Set([
  ...CONCRETE_MEDIA_MODULES,
  "./renderer-contract.js",
  "./renderer-diagnostics.js",
  "./player-media-runtime.js"
]);

export async function collectRuntimeOwnershipViolations(
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
    collectPlayerDependencyFinding(path, node, findings);
    const name = ownerDeclarationName(node);
    if (name !== null) {
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

function collectPlayerDependencyFinding(path, node, findings) {
  const name = basename(path);
  if (!name.startsWith("player-") && name !== "player.ts") return;
  const specifier = moduleSpecifier(node);
  if (specifier === null) return;

  const isMediaOwner = name.startsWith("player-media-");
  if (!isMediaOwner && CONCRETE_MEDIA_MODULES.has(specifier)) {
    findings.add(
      `concrete media import ${specifier} is restricted to player-media owners`
    );
  }

  if (
    (isMediaOwner || [
      "player-failures.ts",
      "player-resource-budget.ts",
      "player-telemetry.ts"
    ].includes(name)) &&
    REVERSE_PLAYER_DEPENDENCIES.has(specifier)
  ) {
    findings.add(`owner dependency points back to ${specifier}`);
  }

  if (name !== "player-session.ts") return;
  if (SESSION_RESOURCE_MODULES.has(specifier)) {
    findings.add(
      `player session must use the media port instead of ${specifier}`
    );
  }
  if (
    specifier === "./player-contract.js" &&
    importedNames(node).has("PlayerInput")
  ) {
    findings.add("player session must not depend on the full PlayerInput bag");
  }
}

function importedNames(node) {
  if (node.type !== "ImportDeclaration") return new Set();
  return new Set((node.specifiers ?? []).flatMap((specifier) => {
    if (specifier.type !== "ImportSpecifier") return [];
    const imported = exportName(specifier.imported);
    return imported === null ? [] : [imported];
  }));
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
