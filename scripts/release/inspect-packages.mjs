#!/usr/bin/env node
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { loadVerifiedReleaseSet, RELEASE_VERSION, releaseSetSummary } from "./release-set.mjs";

const args = parse(process.argv.slice(2));
const directory = resolve(args.packages ?? `artifacts/${RELEASE_VERSION}/packages`);
const output = resolve(args.output ?? `artifacts/${RELEASE_VERSION}/package-inspection.json`);
const indexPath = resolve(args.index ?? `artifacts/${RELEASE_VERSION}/package-index.json`);
const [policy, packageIndex] = await Promise.all([
  readFile("config/release/release-policy.json", "utf8").then(JSON.parse),
  readFile(indexPath, "utf8").then(JSON.parse)
]);
const verified = await loadVerifiedReleaseSet({ directory, policy, packageIndex });
const summary = releaseSetSummary(verified);
const document = { ...summary, status: "passed" };
await writeFile(output, `${JSON.stringify(document, null, 2)}\n`, { flag: "wx" });
process.stdout.write(`${JSON.stringify({ status: "passed", output, releaseSetDigest: verified.releaseSetDigest, packages: verified.packages.length })}\n`);
function parse(values) { const result = {}; for (let index = 0; index < values.length; index += 2) result[String(values[index]).replace(/^--/u, "")] = values[index + 1] ?? "true"; return result; }
