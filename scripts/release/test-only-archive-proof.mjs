import { lstat, realpath } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import { tmpdir } from "node:os";

import { validateApprovedPublicationMetadata } from "./publication-metadata.mjs";
import { RELEASE_VERSION } from "./release-set-model.mjs";

export function testOnlyPublicationMetadata() {
  return validateApprovedPublicationMetadata({
    schemaVersion: "1.0",
    releaseVersion: RELEASE_VERSION,
    status: "approved",
    reviewId: "test-only-metadata-proof-001",
    reviewerRole: "qualified-publication-metadata-reviewer",
    reviewedAt: "2026-07-12T00:00:00.000Z",
    repositoryUrl: "https://github.com/aval-test-only/non-release-proof.git",
    homepageUrl: "https://github.com/aval-test-only/non-release-proof",
    bugsUrl: "https://github.com/aval-test-only/non-release-proof/issues",
    registryScopeAuthority: {
      scope: "@pixel-point",
      registryUrl: "https://registry.npmjs.org/",
      owner: "aval-test-only",
      evidenceId: "test-only-scope-proof-001"
    },
    note: "Synthetic local packed-browser proof authority. Forbidden from candidate, final-release, registry, and repository artifact paths."
  });
}

export async function assertTestOnlyArchiveOutput(path, repositoryRoot) {
  const lexicalTemporaryRoot = resolve(tmpdir());
  const canonicalTemporaryRoot = await realpath(lexicalTemporaryRoot);
  const output = resolve(path);
  const temporaryRelative = relative(lexicalTemporaryRoot, output);
  if (temporaryRelative === ".." || temporaryRelative.startsWith(`..${sep}`)) throw new Error("test-only archive proof output must be under one marked OS-temporary root");
  const parts = temporaryRelative.split(sep);
  const markerIndex = parts.findIndex((part) => part.startsWith("aval-packed-archive-proof-"));
  if (markerIndex < 0) throw new Error("test-only archive proof output must be under one marked OS-temporary root");
  const marker = join(lexicalTemporaryRoot, ...parts.slice(0, markerIndex + 1));
  const markerInfo = await lstat(marker);
  if (!markerInfo.isDirectory() || markerInfo.isSymbolicLink()) throw new Error("test-only archive proof marker must be a real private directory");
  const canonicalMarker = await realpath(marker);
  requireWithin(canonicalTemporaryRoot, canonicalMarker, "test-only marker");
  for (let index = markerIndex + 1; index < parts.length - 1; index += 1) {
    const existing = join(lexicalTemporaryRoot, ...parts.slice(0, index + 1));
    try {
      const info = await lstat(existing);
      if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("test-only archive proof parent is not a real directory");
      requireWithin(canonicalMarker, await realpath(existing), "test-only output parent");
    } catch (error) { if (error?.code === "ENOENT") break; throw error; }
  }
  const repository = await realpath(resolve(repositoryRoot));
  requireOutside(repository, canonicalMarker, "test-only marker");
  if (output.split(sep).some((part) => part === "artifacts" || part === "candidate" || part === "final-release")) throw new Error("test-only archive proof output uses a release-authority path");
  return output;
}

function requireWithin(root, path, label) { const value = relative(root, path); if (value === ".." || value.startsWith(`..${sep}`)) throw new Error(`${label} escapes its authority root`); }
function requireOutside(root, path, label) { const value = relative(root, path); if (value === "" || value !== ".." && !value.startsWith(`..${sep}`)) throw new Error(`${label} must remain outside the repository`); }
