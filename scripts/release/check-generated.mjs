#!/usr/bin/env node
import { spawnSync } from "node:child_process";

for (const [command, args] of [
  ["node", ["scripts/architecture/check-browser-runtime-boundaries.mjs"]],
  ["node", ["scripts/fixtures/verify-provenance.mjs"]],
  ["node", ["scripts/docs/check-docs.mjs"]],
  ["node", ["scripts/security/check-workflows.mjs"]]
]) {
  const result = spawnSync(command, args, { stdio: "inherit", timeout: 120_000 });
  if (result.error !== undefined) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
process.stdout.write(`${JSON.stringify({ status: "passed" })}\n`);
