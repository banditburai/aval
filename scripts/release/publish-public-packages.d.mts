export interface PublicPackageArchive {
  readonly name: string;
  readonly version: string;
  readonly path: string;
  readonly registryIntegrity: string;
}

export interface PublicPackageRegistryAdapter {
  read(name: string, version: string): unknown | Promise<unknown>;
  publish(archive: PublicPackageArchive): unknown | Promise<unknown>;
  setTag(name: string, version: string, tag: "next" | "latest"): unknown | Promise<unknown>;
  removeTag(name: string, tag: "latest"): unknown | Promise<unknown>;
}

export interface RegistryConvergencePolicy {
  readonly attempts: number;
  readonly delayMs: number;
  readonly wait: (delayMs: number) => unknown | Promise<unknown>;
}

export function ensureAuthenticatedNpmIdentity(options: Readonly<{
  registry: string;
  interactive?: boolean;
  spawn?: typeof import("node:child_process").spawnSync;
  write?: (message: string) => unknown;
}>): string;

export function publishPublicPackages(input: Readonly<{
  releaseSet: Readonly<{ releaseVersion: string; packages: readonly PublicPackageArchive[] }>;
  execute?: boolean;
  adapter: PublicPackageRegistryAdapter;
  convergence?: RegistryConvergencePolicy;
}>): Promise<Readonly<{
  mode: "dry-run" | "executed";
  version: string;
  packages: readonly Readonly<{
    name: string;
    action: "publish" | "tag-next" | "already-exact";
    next: string | null;
    latest: string | null;
  }>[];
}>>;
