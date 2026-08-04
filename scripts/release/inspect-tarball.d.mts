export interface InspectedTarball {
  readonly name: string;
  readonly version: string;
  readonly manifest: Readonly<Record<string, unknown>>;
  readonly files: readonly string[];
  readonly fileRecords: readonly Readonly<{ path: string; byteLength: number; mode: number; sha256: string }>[];
  readonly fileListSha256: string;
  readonly tarballSha256: string;
  readonly registryIntegrity: string;
  readonly byteLength: number;
  readonly unpackedSize: number;
}

export function inspectTarballBytes(input: Uint8Array, options?: Readonly<{
  label?: string;
  maximumArchiveBytes?: number;
  maximumUnpackedBytes?: number;
  maximumEntryBytes?: number;
}>): InspectedTarball;
export function inspectTarball(path: string, options?: Readonly<{
  label?: string;
  maximumArchiveBytes?: number;
  maximumUnpackedBytes?: number;
  maximumEntryBytes?: number;
}>): Promise<InspectedTarball>;
