export function packInstalledClosure(input: Readonly<{
  root: string;
  destination: string;
  packages: readonly string[];
}>): Promise<readonly string[]>;

export function releaseConsumerInstallRoots(specifications?: readonly Readonly<{
  peerDependencies: Readonly<Record<string, string>>;
}>[]): readonly string[];

export function packReleaseConsumerDependencies(input: Readonly<{
  root: string;
  destination: string;
}>): Promise<Readonly<{
  archives: readonly string[];
  peerVersions: Readonly<Record<string, string>>;
}>>;

export function verifyInstalledPeerVersions(
  projectRoot: string,
  expectedVersions: Readonly<Record<string, string>>
): Promise<void>;
