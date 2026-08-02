import { extname } from "node:path";

import { parse } from "svelte/compiler";

export function parseArchitectureSource(path, source) {
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

export function scriptProgramBody(ast, path) {
  const body = ast.instance?.content?.body;
  if (!Array.isArray(body)) {
    throw new Error(`${path}: architecture parser did not produce a script`);
  }
  return body;
}

export function visitAst(value, visitor, visited = new WeakSet()) {
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

export function moduleSpecifier(node) {
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

export function literalString(node) {
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

export function exportName(node) {
  if (node?.type === "Identifier") return node.name;
  return literalString(node);
}
