#!/usr/bin/env node
import { resolve } from "node:path";

import { readStableRegistryState, runRegistryMutation } from "./registry-client.mjs";
import { reconcileRegistryMutation } from "./registry-reconciler.mjs";
import { loadBoundLedger, loadPublicationAuthorization, loadRegistryConsumerEvidence, publicationLedgerEnvelope, terminalLedgerStatus, validPublicationApproval, writePublicationLedger } from "./publication-support.mjs";
import { RELEASE_VERSION } from "./release-set-model.mjs";

const args = parse(process.argv.slice(2));
if (args.from !== "next" || args.to !== "latest") throw new Error("promotion must be next -> latest");
const execute = args.execute === "true";
if (execute && !validPublicationApproval(args.approval)) throw new Error("--approval is required for protected latest mutation");
const releaseRoot = resolve(required(args, "release-root"));
const output = resolve(required(args, "output"));
const timestamp = args.timestamp ?? new Date().toISOString();
const certification = await import(resolve("packages/certification/dist/index.js"));
const authorization = await loadPublicationAuthorization({
  releaseRoot,
  expectedCandidateDigest: required(args, "expected-candidate-digest"),
  expectedReleaseDigest: required(args, "expected-release-digest"),
  expectedReleaseSetDigest: required(args, "expected-release-set-digest"),
  expectedCommit: required(args, "expected-commit"),
  certification
});
const source = await loadBoundLedger({
  path: resolve(required(args, "ledger")),
  expectedDigest: required(args, "expected-ledger-digest"),
  authorization,
  certification
});
const consumerEvidence = await loadRegistryConsumerEvidence({
  path: resolve(required(args, "consumer-evidence")),
  expectedDigest: required(args, "expected-consumer-evidence-digest"),
  authorization,
  certification
});
certification.assertPromotionAllowed(source.ledger, authorization.releaseSet.order, {
  candidateManifestDigest: authorization.digest,
  releaseManifestDigest: authorization.releaseDigest,
  releaseSetDigest: authorization.releaseSet.releaseSetDigest
});
const sourceExact = exactNextOperations(source.ledger, authorization.releaseSet.order);
const registryOptions = { registry: authorization.policy.registry.url };
const operations = [];
let terminalError = null;

for (const archive of authorization.releaseSet.packages) {
  const published = sourceExact.get(archive.name);
  if (published === undefined || published.tarballSha256 !== archive.tarballSha256 || published.registryIntegrity !== archive.registryIntegrity) throw new Error(`source ledger package bytes differ from release: ${archive.name}`);
  const before = readStableRegistryState(archive.name, RELEASE_VERSION, registryOptions);
  const planned = certification.planExactTag({
    packageName: archive.name,
    version: RELEASE_VERSION,
    tarballSha256: archive.tarballSha256,
    registryIntegrity: archive.registryIntegrity,
    sequence: operations.length + 1,
    timestamp,
    approvalId: args.approval ?? "dry-run-no-registry-mutation",
    action: "tag",
    desiredTag: "latest",
    targetVersion: RELEASE_VERSION,
    requiredSourceTag: { tag: "next", version: RELEASE_VERSION },
    registry: before
  });
  if (!execute || planned.result === "already-exact") { operations.push(planned); continue; }
  const reconciled = reconcileRegistryMutation({
    planned,
    mutate: () => runRegistryMutation(["dist-tag", "add", `${archive.name}@${RELEASE_VERSION}`, "latest"], registryOptions),
    readState: () => readStableRegistryState(archive.name, RELEASE_VERSION, registryOptions),
    certification
  });
  operations.push(reconciled.operation);
  if (reconciled.error !== null) { terminalError = reconciled.error; break; }
}

if (execute && terminalError !== null) terminalError = compensateLatest({ operations, registryOptions, timestamp, terminalError, certification });
const status = execute ? terminalLedgerStatus(operations, terminalError) : "planned";
const ledger = publicationLedgerEnvelope(authorization, {
  phase: "promote-latest",
  mode: execute ? "executed" : "dry-run",
  status,
  previousLedgerDigest: source.digest,
  phaseEvidenceDigest: consumerEvidence.digest,
  createdAt: timestamp,
  operations
});
const written = await writePublicationLedger({ output, ledger, certification });
if (terminalError !== null) throw new AggregateError([terminalError], `latest promotion failed; ledger ${written.digest}`);
process.stdout.write(`${JSON.stringify({ status: "passed", mode: ledger.mode, output, ledgerDigest: written.digest })}\n`);

function compensateLatest({ operations, registryOptions, timestamp, terminalError, certification }) {
  let error = terminalError;
  const candidates = operations.filter((operation) => operation.tag === "latest" && operation.before !== RELEASE_VERSION && (operation.result === "applied" || operation.result === "ambiguous")).reverse();
  for (const completed of candidates) {
    try {
      const current = readStableRegistryState(completed.packageName, RELEASE_VERSION, registryOptions);
      const compensation = certification.planTagCompensation({
        packageName: completed.packageName,
        version: RELEASE_VERSION,
        tarballSha256: completed.tarballSha256,
        registryIntegrity: completed.registryIntegrity,
        sequence: operations.length + 1,
        timestamp,
        approvalId: `${completed.approvalId}-compensation`,
        desiredTag: "latest",
        targetVersion: completed.before,
        requiredCurrentTag: RELEASE_VERSION,
        registry: current
      });
      if (compensation.result === "conflict" || compensation.result === "already-exact") {
        operations.push(compensation);
        if (compensation.result === "conflict") error = new AggregateError([error], `concurrent latest mutation blocked compensation for ${completed.packageName}`);
        continue;
      }
      const reconciled = reconcileRegistryMutation({
        planned: compensation,
        mutate: () => completed.before === null
          ? runRegistryMutation(["dist-tag", "rm", completed.packageName, "latest"], registryOptions)
          : runRegistryMutation(["dist-tag", "add", `${completed.packageName}@${completed.before}`, "latest"], registryOptions),
        readState: () => readStableRegistryState(completed.packageName, RELEASE_VERSION, registryOptions),
        certification
      });
      operations.push(reconciled.operation);
      if (reconciled.error !== null) error = new AggregateError([error, reconciled.error], `latest compensation failed for ${completed.packageName}`);
    } catch (compensationError) {
      error = new AggregateError([error, compensationError], `latest compensation could not be planned for ${completed.packageName}`);
    }
  }
  return error;
}

function exactNextOperations(ledger, names) { return new Map(names.map((name) => [name, [...ledger.operations].reverse().find((operation) => operation.packageName === name && operation.tag === "next" && (operation.result === "applied" || operation.result === "already-exact"))])); }
function parse(values) { const result = {}; for (let index = 0; index < values.length; index += 2) { const key = values[index]; if (!key?.startsWith("--")) throw new Error(`invalid argument ${String(key)}`); result[key.slice(2)] = values[index + 1] ?? "true"; } return result; }
function required(values, key) { const value = values[key]; if (typeof value !== "string" || value.length < 1) throw new Error(`--${key} is required`); return value; }
