#!/usr/bin/env node
import { createHash } from "node:crypto";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const fixture = dirname(fileURLToPath(import.meta.url));
const root = resolve(fixture, "../../..");
const output = resolve(fixture, "provenance.json");

async function descriptor(path) {
  const bytes = await readFile(resolve(root, path));
  return {
    path,
    bytes: bytes.byteLength,
    sha256: createHash("sha256").update(bytes).digest("hex")
  };
}

async function main() {
  const frameDirectory = resolve(fixture, "source/frames");
  const frameNames = (await readdir(frameDirectory))
    .filter((name) => /^frame-\d{4}\.png$/u.test(name))
    .sort();
  const document = {
    provenanceVersion: "1.0",
    fixture: "aval-v1-four-codec-source",
    license: await descriptor("fixtures/compiler/v1/source/ASSET-LICENSE.md"),
    project: await descriptor("fixtures/compiler/v1/source/motion.json"),
    sourceGenerator: "repository fixture 1.0",
    sourceProvenance: {
      provenancePath: "fixtures/starter/v1-idle-hover/provenance.json",
      provenanceSha256: createHash("sha256")
        .update(await readFile(resolve(root, "fixtures/starter/v1-idle-hover/provenance.json")))
        .digest("hex")
    },
    frames: await Promise.all(frameNames.map((name) =>
      descriptor(`fixtures/compiler/v1/source/frames/${name}`)
    ))
  };
  const serialized = `${JSON.stringify(document, null, 2)}\n`;
  if (process.argv.includes("--check")) {
    const current = await readFile(output, "utf8");
    if (current !== serialized) throw new Error(`${relative(root, output)} drifted`);
    return;
  }
  await writeFile(output, serialized);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
