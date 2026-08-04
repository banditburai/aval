import { describe, expect, it, vi } from "vitest";

import {
  ensureAuthenticatedNpmIdentity,
  publishPublicPackages
} from "../../scripts/release/publish-public-packages.mjs";
import { RELEASE_PACKAGE_NAMES, RELEASE_VERSION } from "../../scripts/release/release-set-model.mjs";

const integrity = `sha512-${Buffer.alloc(64, 7).toString("base64")}`;

describe("synchronized public package publication", () => {
  it("plans every package in dependency order without mutating the registry", async () => {
    const adapter = registryAdapter();
    const result = await publishPublicPackages({ releaseSet: releaseSet(), execute: false, adapter });
    expect(result.mode).toBe("dry-run");
    expect(result.packages.map(({ name }) => name)).toEqual(RELEASE_PACKAGE_NAMES);
    expect(result.packages.every(({ action }) => action === "publish")).toBe(true);
    expect(adapter.publish).not.toHaveBeenCalled();
    expect(adapter.setTag).not.toHaveBeenCalled();
  });

  it("publishes missing exact versions under next and promotes only the complete set", async () => {
    const adapter = registryAdapter();
    const result = await publishPublicPackages({ releaseSet: releaseSet(), execute: true, adapter });
    expect(result.mode).toBe("executed");
    expect(adapter.publish.mock.calls.map(([archive]) => archive.name)).toEqual(RELEASE_PACKAGE_NAMES);
    expect(adapter.setTag.mock.calls.slice(-RELEASE_PACKAGE_NAMES.length).map(([name, version, tag]) => [name, version, tag]))
      .toEqual(RELEASE_PACKAGE_NAMES.map((name) => [name, RELEASE_VERSION, "latest"]));
    expect(result.packages.every(({ next, latest }) => next === RELEASE_VERSION && latest === RELEASE_VERSION)).toBe(true);
  });

  it("waits for a successfully published version to become visible", async () => {
    const adapter = registryAdapter();
    const readVisibleState = adapter.read.getMockImplementation()!;
    let hiddenReads = 2;
    adapter.read.mockImplementation(async (name, version) => {
      if (name === RELEASE_PACKAGE_NAMES[0] && adapter.publish.mock.calls.length > 0 && hiddenReads > 0) {
        hiddenReads -= 1;
        return { name, version, integrity: null, tags: {}, deprecation: null };
      }
      return readVisibleState(name, version);
    });
    const wait = vi.fn(async () => undefined);

    await expect(publishPublicPackages({
      releaseSet: releaseSet(),
      execute: true,
      adapter,
      convergence: { attempts: 4, delayMs: 1, wait }
    })).resolves.toMatchObject({ mode: "executed" });
    expect(wait).toHaveBeenCalledTimes(2);
  });

  it("reports a propagation timeout when a published version stays missing", async () => {
    const adapter = registryAdapter();
    const readVisibleState = adapter.read.getMockImplementation()!;
    adapter.read.mockImplementation(async (name, version) => {
      if (name === RELEASE_PACKAGE_NAMES[0] && adapter.publish.mock.calls.length > 0) {
        return { name, version, integrity: null, tags: {}, deprecation: null };
      }
      return readVisibleState(name, version);
    });
    const wait = vi.fn(async () => undefined);

    await expect(publishPublicPackages({
      releaseSet: releaseSet(),
      execute: true,
      adapter,
      convergence: { attempts: 3, delayMs: 1, wait }
    })).rejects.toThrow(/was not visible after 2 ms/u);
    expect(wait).toHaveBeenCalledTimes(2);
  });

  it("fails immediately when conflicting bytes appear after publication", async () => {
    const adapter = registryAdapter();
    const readVisibleState = adapter.read.getMockImplementation()!;
    adapter.read.mockImplementation(async (name, version) => {
      if (name === RELEASE_PACKAGE_NAMES[0] && adapter.publish.mock.calls.length > 0) {
        return {
          name,
          version,
          integrity: `sha512-${Buffer.alloc(64, 8).toString("base64")}`,
          tags: { next: RELEASE_VERSION },
          deprecation: null
        };
      }
      return readVisibleState(name, version);
    });
    const wait = vi.fn(async () => undefined);

    await expect(publishPublicPackages({
      releaseSet: releaseSet(),
      execute: true,
      adapter,
      convergence: { attempts: 3, delayMs: 1, wait }
    })).rejects.toThrow(/integrity conflict/u);
    expect(wait).not.toHaveBeenCalled();
  });

  it("reconciles identical immutable versions and rejects different bytes", async () => {
    const identical = registryAdapter(Object.fromEntries(RELEASE_PACKAGE_NAMES.map((name) => [name, {
      integrity,
      tags: { next: RELEASE_VERSION, latest: RELEASE_VERSION }
    }])));
    const result = await publishPublicPackages({ releaseSet: releaseSet(), execute: true, adapter: identical });
    expect(result.packages.every(({ action }) => action === "already-exact")).toBe(true);
    expect(identical.publish).not.toHaveBeenCalled();

    const conflicting = registryAdapter({
      [RELEASE_PACKAGE_NAMES[0]!]: {
        integrity: `sha512-${Buffer.alloc(64, 8).toString("base64")}`,
        tags: {}
      }
    });
    await expect(publishPublicPackages({ releaseSet: releaseSet(), execute: true, adapter: conflicting }))
      .rejects.toThrow(/integrity conflict/u);
  });

  it("restores earlier latest tags when promotion fails partway through", async () => {
    const previous = "0.9.0";
    const initial = Object.fromEntries(RELEASE_PACKAGE_NAMES.map((name) => [name, {
      integrity,
      tags: { next: RELEASE_VERSION, latest: previous }
    }]));
    const adapter = registryAdapter(initial);
    const originalSetTag = adapter.setTag.getMockImplementation()!;
    adapter.setTag.mockImplementation(async (name, version, tag) => {
      if (tag === "latest" && name === RELEASE_PACKAGE_NAMES[2] && version === RELEASE_VERSION) throw new Error("simulated promotion failure");
      return originalSetTag(name, version, tag);
    });

    await expect(publishPublicPackages({ releaseSet: releaseSet(), execute: true, adapter }))
      .rejects.toThrow(/latest promotion failed/u);
    expect((await adapter.read(RELEASE_PACKAGE_NAMES[0]!, RELEASE_VERSION)).tags.latest).toBe(previous);
    expect((await adapter.read(RELEASE_PACKAGE_NAMES[1]!, RELEASE_VERSION)).tags.latest).toBe(previous);
  });
});

describe("npm publication authentication", () => {
  const registry = "https://registry.npmjs.org/";

  it("uses an existing authenticated organization session without logging in", () => {
    const spawn = vi.fn()
      .mockReturnValueOnce(processResult({ stdout: "alex\n" }))
      .mockReturnValueOnce(processResult({ stdout: '{"alex":"owner"}\n' }));

    expect(ensureAuthenticatedNpmIdentity({ registry, interactive: true, spawn, write: vi.fn() })).toBe("alex");
    expect(spawn).toHaveBeenCalledTimes(2);
    expect(spawn.mock.calls[0]?.[1]).toEqual(["whoami", "--registry", registry]);
    expect(spawn.mock.calls.some(([, args]) => args[0] === "login")).toBe(false);
  });

  it("runs web login in an interactive terminal and retries the identity check", () => {
    const write = vi.fn();
    const spawn = vi.fn()
      .mockReturnValueOnce(processResult({ status: 1, stderr: "npm error code ENEEDAUTH\n" }))
      .mockReturnValueOnce(processResult())
      .mockReturnValueOnce(processResult({ stdout: "alex\n" }))
      .mockReturnValueOnce(processResult({ stdout: '{"alex":"owner"}\n' }));

    expect(ensureAuthenticatedNpmIdentity({ registry, interactive: true, spawn, write })).toBe("alex");
    expect(write).toHaveBeenCalledWith(expect.stringMatching(/web login/u));
    expect(spawn.mock.calls[1]?.[1]).toEqual([
      "login",
      "--auth-type",
      "web",
      "--scope",
      "@pixel-point",
      "--registry",
      registry
    ]);
    expect(spawn.mock.calls[1]?.[2]).toMatchObject({ stdio: "inherit" });
    expect(spawn.mock.calls[2]?.[1]).toEqual(["whoami", "--registry", registry]);
  });

  it("keeps non-interactive publication fail-closed without launching a browser", () => {
    const spawn = vi.fn()
      .mockReturnValueOnce(processResult({ status: 1, stderr: "npm error code E401\n" }));

    expect(() => ensureAuthenticatedNpmIdentity({ registry, interactive: false, spawn, write: vi.fn() }))
      .toThrow(/NODE_AUTH_TOKEN|npm login/u);
    expect(spawn).toHaveBeenCalledTimes(1);
  });

  it("does not misclassify registry connectivity failures as missing authentication", () => {
    const spawn = vi.fn()
      .mockReturnValueOnce(processResult({ status: 1, stderr: "npm error code ENETUNREACH\n" }));

    expect(() => ensureAuthenticatedNpmIdentity({ registry, interactive: true, spawn, write: vi.fn() }))
      .toThrow(/identity check failed/u);
    expect(spawn).toHaveBeenCalledTimes(1);
  });
});

function releaseSet() {
  return {
    releaseVersion: RELEASE_VERSION,
    packages: RELEASE_PACKAGE_NAMES.map((name) => ({
      name,
      version: RELEASE_VERSION,
      path: `/artifacts/${name.slice(1).replace("/", "-")}.tgz`,
      registryIntegrity: integrity
    }))
  };
}

function registryAdapter(initial: Record<string, { integrity: string | null; tags: Record<string, string> }> = {}) {
  const states = new Map<string, { integrity: string | null; tags: Record<string, string> }>(RELEASE_PACKAGE_NAMES.map((name) => {
    const state = initial[name] ?? { integrity: null, tags: {} };
    return [name, { integrity: state.integrity, tags: { ...state.tags } }];
  }));
  const read = vi.fn(async (name: string, version: string) => {
    const state = states.get(name)!;
    return { name, version, integrity: state.integrity, tags: { ...state.tags }, deprecation: null };
  });
  const publish = vi.fn(async (archive: { name: string; registryIntegrity: string }) => {
    const state = states.get(archive.name)!;
    state.integrity = archive.registryIntegrity;
    state.tags.next = RELEASE_VERSION;
  });
  const setTag = vi.fn(async (name: string, version: string, tag: string) => {
    states.get(name)!.tags[tag] = version;
  });
  const removeTag = vi.fn(async (name: string, tag: string) => {
    delete states.get(name)!.tags[tag];
  });
  return { read, publish, setTag, removeTag };
}

function processResult({
  status = 0,
  stdout = "",
  stderr = ""
}: Readonly<{ status?: number; stdout?: string; stderr?: string }> = {}) {
  return { status, stdout, stderr, signal: null, pid: 123, output: [null, stdout, stderr] };
}
