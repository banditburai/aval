#!/usr/bin/env node
import { resolve } from "node:path";

import { readStableRegistryState, runRegistryMutation } from "./registry-client.mjs";
import { reconcileRegistryMutation } from "./registry-reconciler.mjs";
import { stageAuthorizedReleaseSet, verifyStagedArchive } from "./release-authorization.mjs";
import { loadPublicationAuthorization, publicationLedgerEnvelope, terminalLedgerStatus, validPublicationApproval, writePublicationLedger } from "./publication-support.mjs";
import { RELEASE_VERSION } from "./release-set-model.mjs";

const args = parse(process.argv.slice(2));
if ((args.tag ?? "next") !== "next") throw new Error("exact publication may initially use only the next tag");
const execute = args.execute === "true";
if (execute && !validPublicationApproval(args.approval)) throw new Error("--approval is required for registry mutation");
const releaseRoot = resolve(required(args, "release-root"));
const expectedCandidateDigest = required(args, "expected-candidate-digest");
const expectedReleaseDigest = required(args, "expected-release-digest");
const output = resolve(required(args, "output"));
const timestamp = args.timestamp ?? new Date().toISOString();
const certification = await import(resolve("packages/certification/dist/index.js"));
const authorization = await loadPublicationAuthorization({
  releaseRoot,
  expectedCandidateDigest,
  expectedReleaseDigest,
  expectedReleaseSetDigest: required(args, "expected-release-set-digest"),
  expectedCommit: required(args, "expected-commit"),
  certification
});
const staged = await stageAuthorizedReleaseSet(authorization);
const registryOptions = { registry: authorization.policy.registry.url };
const operations = [];
let terminalError = null;

try {
  for (const archive of staged.packages) {
    await verifyStagedArchive(archive);
    const before = readStableRegistryState(archive.name, RELEASE_VERSION, registryOptions);
    const handoffApproval = execute ? args["tag-approval"] ?? "missing-tag-authorization" : "dry-run-no-registry-mutation";
    const planned = certification.planExactPublication({
      packageName: archive.name,
      version: RELEASE_VERSION,
      tarballSha256: archive.tarballSha256,
      registryIntegrity: archive.registryIntegrity,
      desiredTag: "next",
      sequence: operations.length + 1,
      timestamp,
      approvalId: before.integrity === null ? args.approval ?? "dry-run-no-registry-mutation" : handoffApproval,
      registry: before
    });
    if (!execute || planned.result === "already-exact") {
      operations.push(planned);
      continue;
    }
    if (planned.action === "tag" && (!validPublicationApproval(args["tag-approval"]) || args["tag-approval"] === args.approval || args["execute-tag-handoff"] !== "true")) {
      operations.push(certification.failPublicationOperation(planned, before));
      terminalError = new Error(`${archive.name}@${RELEASE_VERSION} exists exactly; protected short-lived dist-tag approval is required`);
      break;
    }
    const reconciled = reconcileRegistryMutation({
      planned,
      mutate: () => planned.action === "publish"
        ? runRegistryMutation(["publish", archive.path, "--tag", "next", "--provenance", "--access", "public", "--ignore-scripts"], registryOptions)
        : runRegistryMutation(["dist-tag", "add", `${archive.name}@${RELEASE_VERSION}`, "next"], registryOptions),
      readState: () => readStableRegistryState(archive.name, RELEASE_VERSION, registryOptions),
      certification
    });
    operations.push(reconciled.operation);
    await verifyStagedArchive(archive);
    if (reconciled.error !== null) { terminalError = reconciled.error; break; }
  }

  if (execute && terminalError !== null) terminalError = await cleanupPartialNext({ operations, staged, registryOptions, timestamp, terminalError, certification });
  const status = execute ? terminalLedgerStatus(operations, terminalError) : "planned";
  const ledger = publicationLedgerEnvelope(authorization, {
    phase: "publish-next",
    mode: execute ? "executed" : "dry-run",
    status,
    previousLedgerDigest: null,
    createdAt: timestamp,
    operations
  });
  const written = await writePublicationLedger({ output, ledger, certification });
  if (terminalError !== null) throw new AggregateError([terminalError], `next publication failed; ledger ${written.digest}`);
  process.stdout.write(`${JSON.stringify({ status: "passed", mode: ledger.mode, output, ledgerDigest: written.digest })}\n`);
} finally {
  await staged.dispose();
}

async function cleanupPartialNext({ operations, staged, registryOptions, timestamp, terminalError, certification }) {
  const archives = new Map(staged.packages.map((entry) => [entry.name, entry]));
  let error = terminalError;
  const candidates = operations.filter((operation) => operation.tag === "next" && operation.before !== RELEASE_VERSION && (operation.result === "applied" || operation.result === "ambiguous")).reverse();
  for (const completed of candidates) {
    const archive = archives.get(completed.packageName);
    if (archive === undefined) continue;
    try {
      const current = readStableRegistryState(completed.packageName, RELEASE_VERSION, registryOptions);
      const compensation = certification.planTagCompensation({
        packageName: completed.packageName,
        version: RELEASE_VERSION,
        tarballSha256: completed.tarballSha256,
        registryIntegrity: completed.registryIntegrity,
        desiredTag: "next",
        targetVersion: completed.before,
        requiredCurrentTag: RELEASE_VERSION,
        sequence: operations.length + 1,
        timestamp,
        approvalId: `${completed.approvalId}-cleanup-next`,
        registry: current
      });
      if (compensation.result === "conflict" || compensation.result === "already-exact") {
        operations.push(compensation);
        if (compensation.result === "conflict") error = new AggregateError([error], `concurrent next-tag mutation blocked cleanup for ${completed.packageName}`);
        continue;
      }
      const reconciled = reconcileRegistryMutation({
        planned: compensation,
        mutate: () => completed.before === null
          ? runRegistryMutation(["dist-tag", "rm", completed.packageName, "next"], registryOptions)
          : runRegistryMutation(["dist-tag", "add", `${completed.packageName}@${completed.before}`, "next"], registryOptions),
        readState: () => readStableRegistryState(completed.packageName, RELEASE_VERSION, registryOptions),
        certification
      });
      operations.push(reconciled.operation);
      if (reconciled.error !== null) error = new AggregateError([error, reconciled.error], `partial next cleanup failed for ${completed.packageName}`);
    } catch (cleanupError) {
      error = new AggregateError([error, cleanupError], `partial next cleanup could not be planned for ${completed.packageName}`);
    }
  }
  return error;
}

function parse(values) { const result = {}; for (let index = 0; index < values.length; index += 2) { const key = values[index]; if (!key?.startsWith("--")) throw new Error(`invalid argument ${String(key)}`); result[key.slice(2)] = values[index + 1] ?? "true"; } return result; }
function required(values, key) { const value = values[key]; if (typeof value !== "string" || value.length < 1) throw new Error(`--${key} is required`); return value; }
