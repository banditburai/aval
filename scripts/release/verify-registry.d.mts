import type { RegistryPackageState } from "../../packages/certification/src/publication-ledger.js";
export function verifyRegistryReleaseSet(input: Readonly<{
  releaseSet: Readonly<{ packages: readonly Readonly<{ name: string; registryIntegrity: string }>[] }>;
  tag: "next" | "latest";
  readState: (name: string, version: string) => RegistryPackageState;
}>): readonly Readonly<{ name: string; version: string; registryIntegrity: string; tag: "next" | "latest" }>[];
