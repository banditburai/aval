export interface StableReleaseVersion {
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
  readonly text: string;
}

export function parseStableVersion(value: string): StableReleaseVersion;
export function nextReleaseVersion(currentValue: string, request: string): string;
export function readReleaseVersion(root?: string): Promise<string>;
export function validateReleaseVersionState(root?: string, options?: Readonly<{
  includeLockfile?: boolean;
}>): Promise<Readonly<{
  version: string;
  publicPackages: number;
  packages: number;
}>>;
export function bumpReleaseVersion(root: string | undefined, request: string): Promise<Readonly<{
  previousVersion: string;
  version: string;
  updatedFiles: number;
}>>;
