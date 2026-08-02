import { lstat, realpath } from "node:fs/promises";
import { dirname, extname, join, parse, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { CompilerError } from "../diagnostics.js";
import {
  isResolvedPathWithinRoot,
  readOpenedFile,
  resolveRealPathWithinRoot,
  type BoundedReadAdmission
} from "./dev-file-reader.js";

export const DEV_MODULE_PACKAGES = Object.freeze({
  element: "@pixel-point/aval-element",
  format: "@pixel-point/aval-format",
  graph: "@pixel-point/aval-graph"
} as const);

export type DevModulePackage = keyof typeof DEV_MODULE_PACKAGES;

export interface PackageEntryResolution {
  readonly entryPath: string;
  readonly packageRoot: string;
}

export type PackageEntryResolver = (packageName: string) => Promise<PackageEntryResolution>;

export type ModuleRead =
  | Readonly<{ status: "ok"; bytes: Buffer }>
  | Readonly<{ status: "missing" }>
  | Readonly<{ status: "too-large" }>
  | Readonly<{ status: "busy" }>;

export interface PackageModuleStore {
  read(packageName: DevModulePackage, relativePath: string, admission: BoundedReadAdmission): Promise<ModuleRead>;
  roots(): Readonly<Record<DevModulePackage, string>>;
}

export function rewriteDevModuleImports(bytes: Buffer, sessionPath: string): Buffer {
  if (!/^\/[A-Za-z0-9_-]{43}\/$/u.test(sessionPath)) throw new TypeError("dev module session path is invalid");
  const source = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  const rewritten = source.replace(/(["'])@pixel-point\/aval-(element|format|graph)\1/gu, (_match, _quote: string, packageName: DevModulePackage) => JSON.stringify(`${sessionPath}modules/${packageName}/index.js`));
  return Buffer.from(rewritten, "utf8");
}

const MAX_MODULE_BYTES = 1024 * 1024;
const MAX_PACKAGE_MANIFEST_BYTES = 64 * 1024;

export async function createPackageModuleStore(
  resolveEntry: PackageEntryResolver = resolveCompilerPackageEntry
): Promise<PackageModuleStore> {
  const entries = await Promise.all(Object.entries(DEV_MODULE_PACKAGES).map(async ([key, packageName]) => {
    try {
      const resolved = await resolveEntry(packageName);
      const [canonicalRoot, canonicalEntry] = await Promise.all([realpath(resolved.packageRoot), realpath(resolved.entryPath)]);
      const entryStats = await lstat(canonicalEntry);
      if (!entryStats.isFile() || !isResolvedPathWithinRoot(canonicalRoot, canonicalEntry)) throw new CompilerError("IO_FAILED", `Resolved ${packageName} entry escapes its package root`);
      const distributionRoot = await realpath(join(canonicalRoot, "dist"));
      const [distributionStats, builtEntry] = await Promise.all([lstat(distributionRoot), resolveRealPathWithinRoot(distributionRoot, join(distributionRoot, "index.js"))]);
      if (!distributionStats.isDirectory() || !isResolvedPathWithinRoot(canonicalRoot, distributionRoot) || builtEntry === null) throw new CompilerError("IO_FAILED", `Resolved ${packageName} has no contained built distribution`);
      return [key as DevModulePackage, distributionRoot] as const;
    } catch (cause) {
      if (cause instanceof CompilerError) throw cause;
      throw new CompilerError("IO_FAILED", `Could not prepare built dev dependency ${packageName}`, { cause });
    }
  }));
  const roots = Object.freeze(Object.fromEntries(entries)) as Readonly<Record<DevModulePackage, string>>;
  return Object.freeze({
    async read(packageName: DevModulePackage, relativePath: string, admission: BoundedReadAdmission): Promise<ModuleRead> {
      if (!/^[A-Za-z0-9_./-]+\.js$/u.test(relativePath) || relativePath.split("/").some((part) => part === "" || part === "." || part === "..")) return Object.freeze({ status: "missing" });
      const root = roots[packageName];
      const candidate = resolve(root, relativePath);
      if (extname(candidate) !== ".js" || !isResolvedPathWithinRoot(root, candidate)) return Object.freeze({ status: "missing" });
      const release = admission.tryAcquire();
      if (release === null) return Object.freeze({ status: "busy" });
      try {
        const canonicalPath = await resolveRealPathWithinRoot(root, candidate);
        if (canonicalPath === null) return Object.freeze({ status: "missing" });
        const read = await readOpenedFile(canonicalPath, MAX_MODULE_BYTES, root);
        if (read.status === "ok" || read.status === "too-large") return read;
        return Object.freeze({ status: "missing" });
      } finally {
        release();
      }
    },
    roots: () => roots
  });
}

/** Resolve from the compiler module's own dependency context, then identify the exact owning package root. */
export async function resolveCompilerPackageEntry(packageName: string): Promise<PackageEntryResolution> {
  let entryPath: string;
  try {
    const resolved = import.meta.resolve(packageName);
    if (!resolved.startsWith("file:")) throw new TypeError("package entry is not a file URL");
    entryPath = fileURLToPath(resolved);
  } catch (cause) {
    throw new CompilerError("IO_FAILED", `Could not resolve dev dependency ${packageName} from @pixel-point/aval-compiler`, { cause });
  }
  const packageRoot = await findOwningPackageRoot(entryPath, packageName);
  if (packageRoot === null) throw new CompilerError("IO_FAILED", `Could not verify dev dependency ${packageName}`);
  return Object.freeze({ entryPath, packageRoot });
}

export async function findOwningPackageRoot(entryPath: string, expectedName: string): Promise<string | null> {
  let cursor = dirname(resolve(entryPath));
  for (let depth = 0; depth < 32; depth += 1) {
    const manifestPath = join(cursor, "package.json");
    try {
      const read = await readOpenedFile(manifestPath, MAX_PACKAGE_MANIFEST_BYTES);
      if (read.status === "ok" && read.bytes.byteLength > 0) {
        const manifest = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(read.bytes)) as unknown;
        if (manifest !== null && typeof manifest === "object" && !Array.isArray(manifest) && (manifest as Record<string, unknown>).name === expectedName) return realpath(cursor);
      }
    } catch {
      // Keep walking: nested module layouts can contain unrelated package manifests.
    }
    const parent = dirname(cursor);
    if (parent === cursor || cursor === parse(cursor).root) break;
    cursor = parent;
  }
  return null;
}
