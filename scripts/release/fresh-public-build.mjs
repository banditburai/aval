import { constants as fsConstants } from "node:fs";
import { copyFile, lstat, mkdir, mkdtemp, open, readdir, rename, rm, writeFile } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import { spawnSync } from "node:child_process";

import { RELEASE_PACKAGE_NAMES, releasePackageDirectory, releasePackageSpecification } from "./release-set-model.mjs";
import { ensureCompilerCliExecutable } from "./compiler-cli-mode.mjs";
import { ELEMENT_RELEASE_WORKER } from "./element-release-contract.mjs";

const BUILD_STEPS = Object.freeze({
  "element-worker": Object.freeze({
    outputs: Object.freeze([ELEMENT_RELEASE_WORKER.output]),
    run({ repository, distribution }) {
      const result = spawnSync(process.execPath, [
        resolve(repository, "scripts/release/minify-element-worker.mjs"),
        "--out",
        distribution
      ], { cwd: repository, stdio: "inherit", timeout: 5 * 60_000 });
      if (result.error !== undefined) throw result.error;
      if (result.status !== 0) throw new Error("private element worker minification failed");
    }
  })
});

export async function buildFreshPublicDistributions(root) {
  const repository = resolve(root);
  const lockPath = join(repository, ".git", "aval-release-build.lock");
  const lock = await open(lockPath, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL, 0o600).catch((error) => {
    if (error?.code === "EEXIST") throw new Error("another fresh public distribution build is active");
    throw error;
  });
  let temporary;
  try { temporary = await mkdtemp(join(repository, ".aval-public-build-")); }
  catch (error) { await lock.close().catch(() => undefined); await rm(lockPath, { force: true }); throw error; }
  try {
    await lock.writeFile(`${String(process.pid)}\n`);
    await lock.sync();
    const staged = new Map();
    for (const name of RELEASE_PACKAGE_NAMES) {
      const distribution = await stagePublicDistribution({ repository, name, temporary, staged });
      staged.set(name, distribution);
    }
    await installVerifiedDistributions({ root: repository, staged, backupRoot: join(temporary, "backup") });
  } finally {
    await lock.close().catch(() => undefined);
    await rm(lockPath, { force: true });
    await rm(temporary, { recursive: true, force: true });
  }
}

/** Build only the element package into a verified temporary directory, then atomically replace its dist. */
export async function buildFreshElementDistribution(root) {
  const repository = resolve(root);
  const temporary = await mkdtemp(join(repository, ".aval-element-build-"));
  try {
    const staged = new Map();
    const elementIndex = RELEASE_PACKAGE_NAMES.indexOf("@pixel-point/aval-element");
    if (elementIndex < 0) throw new Error("element package is absent from the reviewed release set");
    for (const name of RELEASE_PACKAGE_NAMES.slice(0, elementIndex)) {
      staged.set(name, packageDirectory(repository, name, "dist"));
    }
    const distribution = await stagePublicDistribution({
      repository,
      name: "@pixel-point/aval-element",
      temporary,
      staged
    });
    const target = packageDirectory(repository, "@pixel-point/aval-element", "dist");
    const backup = join(temporary, "backup");
    await preflightExistingDistribution("@pixel-point/aval-element", target);
    const existed = await pathExists(target);
    if (existed) await rename(target, backup);
    try { await rename(distribution, target); }
    catch (error) { if (existed) await rename(backup, target); throw error; }
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

async function stagePublicDistribution({ repository, name, temporary, staged }) {
  const specification = releasePackageSpecification(name);
  const short = specification.directory;
  const distribution = join(temporary, "dist", short);
  await mkdir(distribution, { recursive: true });
  const source = packageDirectory(repository, name, "src");
  const config = join(temporary, `tsconfig.${short}.json`);
  let sourceFiles;
  if (specification.buildConfig.kind === "typescript") {
    await writeFile(config, `${JSON.stringify(privateTypeScriptBuildConfig(repository, specification, distribution, staged), null, 2)}\n`, { flag: "wx", mode: 0o400 });
    sourceFiles = listProgramSourceFiles({ repository, config, source, specification });
    runPrivateBuild({
      repository,
      name,
      command: resolve(repository, "node_modules/typescript/bin/tsc"),
      args: ["-p", config, "--pretty", "false"]
    });
  } else if (specification.buildConfig.kind === "svelte-package") {
    const buildWorkspace = join(temporary, "svelte-package", short);
    await mkdir(buildWorkspace, { recursive: true });
    await Promise.all(["package.json", "svelte.config.js"].map((path) =>
      copyFile(resolve(repository, "packages", short, path), join(buildWorkspace, path))
    ));
    const svelteConfig = join(buildWorkspace, "tsconfig.json");
    await writeFile(svelteConfig, `${JSON.stringify(privateSvelteBuildConfig(repository, specification, source, staged), null, 2)}\n`, { flag: "wx", mode: 0o400 });
    sourceFiles = await listSveltePackageSourceFiles({ source, specification });
    runPrivateBuild({
      repository,
      workingDirectory: buildWorkspace,
      name,
      command: resolve(repository, "node_modules/@sveltejs/package/svelte-package.js"),
      args: ["-i", source, "-o", distribution, "--tsconfig", svelteConfig]
    });
  } else {
    throw new Error(`unknown private public build kind for ${name}: ${String(specification.buildConfig.kind)}`);
  }
  for (const stepName of specification.buildConfig.buildSteps) reviewedBuildStep(stepName).run({ repository, distribution });
  for (const target of Object.values(specification.bin)) await ensureCompilerCliExecutable(distributionEntry(distribution, target));
  await assertDistributionDerived({ source, sourceFiles, distribution, packageName: name });
  return distribution;
}

/** Atomically replace each verified dist directory and restore the complete prior set on any failure. */
export async function installVerifiedDistributions({ root, staged, backupRoot, renameEntry = rename, removeEntry = rm }) {
  await preflightExistingDistributions(root);
  await mkdir(backupRoot, { recursive: true });
  const installed = [];
  try {
    for (const name of RELEASE_PACKAGE_NAMES) {
      const short = releasePackageDirectory(name);
      const target = packageDirectory(root, name, "dist");
      const backup = join(backupRoot, short);
      const source = staged.get(name);
      if (typeof source !== "string") throw new Error(`verified staged distribution is missing for ${name}`);
      const existed = await pathExists(target);
      if (existed) await renameEntry(target, backup);
      try { await renameEntry(source, target); }
      catch (error) { if (existed) await renameEntry(backup, target); throw error; }
      installed.push(Object.freeze({ target, backup, existed }));
    }
  } catch (installError) {
    const failures = [installError];
    for (const entry of [...installed].reverse()) {
      try {
        await removeEntry(entry.target, { recursive: true, force: true });
        if (entry.existed) await renameEntry(entry.backup, entry.target);
      } catch (restoreError) { failures.push(restoreError); }
    }
    if (failures.length > 1) throw new AggregateError(failures, "fresh distribution install failed and prior-set restoration was incomplete");
    throw installError;
  }
}

function privateTypeScriptBuildConfig(root, specification, distribution, staged) {
  const source = packageDirectory(root, specification.name, "src");
  const build = specification.buildConfig;
  if (typeof specification.buildInfo !== "string") throw new Error(`${specification.name} TypeScript release build has no build-info contract`);
  const config = {
    extends: packageDirectory(root, specification.name, build.config),
    compilerOptions: {
      ...build.compilerOptions,
      rootDir: source,
      outDir: distribution,
      tsBuildInfoFile: join(distribution, specification.buildInfo),
      paths: stagedDeclarationPaths(staged)
    }
  };
  if (build.source.kind === "files") {
    return {
      ...config,
      files: [...build.source.paths, ...build.additionalSources].map((path) => slash(join(source, path))),
      include: []
    };
  }
  return {
    ...config,
    include: [...build.source.include, ...build.additionalSources].map((path) => slash(join(source, path))),
    exclude: build.source.exclude.map((path) => slash(join(source, path)))
  };
}

function privateSvelteBuildConfig(root, specification, source, staged) {
  const selection = specification.buildConfig.source;
  if (selection.kind !== "files") throw new Error(`${specification.name} Svelte package must use an exact file-source contract`);
  return {
    extends: packageDirectory(root, specification.name, specification.buildConfig.config),
    compilerOptions: {
      paths: stagedDeclarationPaths(staged)
    },
    files: [...selection.paths, ...specification.buildConfig.additionalSources].map((path) => slash(join(source, path))),
    include: []
  };
}

export function stagedDeclarationPaths(staged) {
  const paths = {};
  for (const [packageName, distribution] of staged) {
    const specification = releasePackageSpecification(packageName);
    for (const entry of specification.productionEntries) {
      const target = specification.exports[entry.export]?.types;
      if (typeof target !== "string" || !target.startsWith("./dist/") || target.includes("..") || target.includes("\\")) {
        throw new Error(`${packageName} production export ${entry.export} has no safe declaration target`);
      }
      const specifier = entry.export === "." ? packageName : `${packageName}${entry.export.slice(1)}`;
      paths[specifier] = Object.freeze([join(distribution, target.slice("./dist/".length))]);
    }
  }
  return Object.freeze(paths);
}

function runPrivateBuild({ repository, workingDirectory = repository, name, command, args }) {
  const result = spawnSync(process.execPath, [command, ...args], { cwd: workingDirectory, stdio: "inherit", timeout: 5 * 60_000 });
  if (result.error !== undefined) throw result.error;
  if (result.status !== 0) throw new Error(`private fresh public build failed for ${name}`);
}

async function listSveltePackageSourceFiles({ source, specification }) {
  const available = (await collectFiles(resolve(source)))
    .filter((path) => isReleaseSource(path, specification))
    .sort(compareText);
  const selection = specification.buildConfig.source;
  if (selection.kind !== "files") throw new Error(`${specification.name} Svelte package must use an exact file-source contract`);
  const reviewed = [...selection.paths, ...specification.buildConfig.additionalSources].sort(compareText);
  if (new Set(reviewed).size !== reviewed.length || reviewed.length === 0) throw new Error(`${specification.name} Svelte release source selection is invalid`);
  if (!sameArray(available, reviewed)) {
    throw new Error(`${specification.name} Svelte package source closure drifted: expected ${reviewed.join(", ")}; received ${available.join(", ")}`);
  }
  return Object.freeze(reviewed);
}

function listProgramSourceFiles({ repository, config, source, specification }) {
  const result = spawnSync(process.execPath, [
    resolve(repository, "node_modules/typescript/bin/tsc"),
    "-p",
    config,
    "--pretty",
    "false",
    "--listFilesOnly"
  ], { cwd: repository, encoding: "utf8", timeout: 5 * 60_000 });
  if (result.error !== undefined) throw result.error;
  if (result.status !== 0) {
    if (result.stdout) process.stderr.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
    throw new Error(`private release source-closure discovery failed for ${specification.name}`);
  }
  const sourceRoot = resolve(source);
  const prefix = `${sourceRoot}${sep}`;
  const sourceFiles = result.stdout
    .split(/\r?\n/u)
    .map((path) => path.trim())
    .filter((path) => path !== "")
    .map((path) => resolve(path))
    .filter((path) => path.startsWith(prefix))
    .map((path) => slash(relative(sourceRoot, path)))
    .sort(compareText);
  if (sourceFiles.length === 0) throw new Error(`${specification.name} compiler program has no package source files`);
  if (new Set(sourceFiles).size !== sourceFiles.length) throw new Error(`${specification.name} compiler program contains duplicate package source files`);
  for (const path of sourceFiles) {
    if (!isReleaseSource(path, specification)) throw new Error(`${specification.name} compiler program contains non-release source: ${path}`);
  }
  return Object.freeze(sourceFiles);
}

async function preflightExistingDistributions(root) {
  for (const name of RELEASE_PACKAGE_NAMES) {
    const path = packageDirectory(root, name, "dist");
    await preflightExistingDistribution(name, path);
  }
}

async function preflightExistingDistribution(name, path) {
  try { const info = await lstat(path); if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(`${name} existing distribution is not a regular directory`); }
  catch (error) { if (error?.code !== "ENOENT") throw error; }
}

async function pathExists(path) { try { await lstat(path); return true; } catch (error) { if (error?.code === "ENOENT") return false; throw error; } }
function slash(path) { return path.split(sep).join("/"); }

export async function assertDistributionDerived({ source, sourceFiles, distribution, packageName }) {
  const specification = releasePackageSpecification(packageName);
  if (!Array.isArray(sourceFiles) || sourceFiles.length === 0) throw new Error(`${packageName} has no compiler-derived release source files`);
  const availableSources = new Set((await collectFiles(resolve(source))).filter((path) => isReleaseSource(path, specification)));
  const reviewedSources = [...sourceFiles].sort(compareText);
  if (new Set(reviewedSources).size !== reviewedSources.length) throw new Error(`${packageName} release source closure contains duplicates`);
  for (const path of reviewedSources) {
    if (!isReleaseSource(path, specification) || !availableSources.has(path)) throw new Error(`${packageName} release source closure contains an invalid source: ${path}`);
  }
  const expected = new Set();
  for (const path of reviewedSources) {
    if (path.endsWith(".json")) {
      expected.add(path);
      continue;
    }
    if (path.endsWith(".d.ts")) continue;
    if (path.endsWith(".svelte")) {
      expected.add(path);
      expected.add(`${path}.d.ts`);
      continue;
    }
    const stem = path.endsWith(".tsx") ? path.slice(0, -4) : path.slice(0, -3);
    expected.add(`${stem}.js`);
    expected.add(`${stem}.d.ts`);
    if (specification.buildConfig.sourceMaps) {
      expected.add(`${stem}.js.map`);
      expected.add(`${stem}.d.ts.map`);
    }
  }
  for (const stepName of specification.buildConfig.buildSteps) {
    for (const output of reviewedBuildStep(stepName).outputs) expected.add(output);
  }
  if (typeof specification.buildInfo === "string") expected.add(specification.buildInfo);
  const outputs = await collectFiles(resolve(distribution));
  for (const path of outputs) {
    if (!expected.has(path)) throw new Error(`${packageName} distribution output is not in the exact release emission contract: ${path}`);
    if (/(?:^|\/)(?:[^/]+\.(?:test|compile)\.(?:js|d\.ts|svelte(?:\.d\.ts)?)|[^/]*test-support\.(?:js|d\.ts|svelte(?:\.d\.ts)?))$/u.test(path)) throw new Error(`${packageName} distribution contains test output: ${path}`);
  }
  for (const path of expected) if (!outputs.includes(path)) throw new Error(`${packageName} fresh distribution is missing required source-derived output: ${path}; emitted ${outputs.join(", ") || "nothing"}`);
  if (outputs.length !== expected.size) throw new Error(`${packageName} fresh distribution output count does not match the exact emission contract`);
  return Object.freeze({ sourceFiles: Object.freeze(reviewedSources), outputs: Object.freeze(outputs) });
}

async function collectFiles(root, directory = root, output = []) {
  for (const entry of (await readdir(directory, { withFileTypes: true })).sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0)) {
    const path = join(directory, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`release build symlink is forbidden: ${relative(root, path).split(sep).join("/")}`);
    if (entry.isDirectory()) await collectFiles(root, path, output);
    else if (entry.isFile()) output.push(relative(root, path).split(sep).join("/"));
    else throw new Error(`release build special entry is forbidden: ${relative(root, path).split(sep).join("/")}`);
  }
  return output;
}

function isReleaseSource(path, specification) {
  return specification.buildConfig.additionalSources.includes(path) || (
    specification.buildConfig.kind === "svelte-package"
      ? /\.(?:ts|svelte)$/u.test(path) && !/\.(?:test|compile)\.(?:ts|svelte)$/u.test(path) && !/test-support\.(?:ts|svelte)$/u.test(path)
      : /\.tsx?$/u.test(path) && !/\.(?:test|compile)\.tsx?$/u.test(path) && !/test-support\.tsx?$/u.test(path)
  );
}
function packageDirectory(root, name, child) { return resolve(root, "packages", releasePackageDirectory(name), child); }
function reviewedBuildStep(name) {
  const step = BUILD_STEPS[name];
  if (step === undefined) throw new Error(`unknown reviewed release build step: ${String(name)}`);
  return step;
}
function distributionEntry(distribution, target) {
  if (typeof target !== "string" || !target.startsWith("./dist/") || target.includes("..") || target.includes("\\")) throw new Error(`release bin target is unsafe: ${String(target)}`);
  return join(distribution, target.slice("./dist/".length));
}
function compareText(left, right) { return left < right ? -1 : left > right ? 1 : 0; }
function sameArray(left, right) { return left.length === right.length && left.every((value, index) => value === right[index]); }
