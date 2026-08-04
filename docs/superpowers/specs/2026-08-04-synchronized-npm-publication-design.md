# Synchronized npm publication design

## Outcome

Provide one operator-facing shell script that can bump, prepare, and publish the
repository's npm packages without allowing their versions to drift. Preserve the
existing public package boundary and dependency order.

## Public package set

The following six packages are the complete npm release set:

1. `@pixel-point/aval-graph`
2. `@pixel-point/aval-format`
3. `@pixel-point/aval-element`
4. `@pixel-point/aval-compiler`
5. `@pixel-point/aval-react`
6. `@pixel-point/aval-svelte`

They are already named under the requested `@pixel-point` scope. The private
`@pixel-point/aval-certification` package remains synchronized with the release
version because it validates release artifacts, but it is never published.
Applications, examples, fixtures, and consumer-test projects are not npm
libraries and remain unpublished.

## Rejected alternatives

A thin `npm version`/`npm publish` loop is too permissive: npm workspaces would
also select private applications and examples, and a mid-loop failure could
make an incomplete set visible under `latest`.

Adding Changesets or Lerna would duplicate the repository's existing release
model, artifact inspector, and consumer tests. Independent package versions are
also contrary to the requested synchronized-version policy.

## Command interface

Create `scripts/release/publish-packages.sh` with three subcommands:

- `bump <major|minor|patch|x.y.z>` computes or accepts the next stable SemVer and
  updates the synchronized release metadata.
- `prepare` validates the synchronized state, builds fresh distributions, packs
  the exact six-package set in dependency order, inspects the archives, and
  installs them into clean consumer fixtures.
- `publish` repeats preparation, verifies npm authentication and `@pixel-point`
  scope access, publishes the exact tarballs under `next`, verifies every exact
  registry version, and promotes the complete set to `latest` only after all six
  packages pass.

Preparation is the default safe operation; registry mutation only occurs for
the explicit `publish` subcommand. The script uses strict shell settings,
resolves the repository root from its own location, rejects unexpected
arguments, and propagates every failure.

## Version authority and synchronization

`config/release/release-policy.json` remains the canonical release version and
public package list. Replace release-time `1.0.0` literals in executable code
with the exported `RELEASE_VERSION` or the policy value so future bumps do not
require hand-editing release logic.

A focused Node helper performs the bump because structured JSON changes are
safer there than in shell text substitution. It will:

- validate stable SemVer input and calculate major, minor, or patch bumps;
- update all `packages/*/package.json` versions to the same value;
- update exact `@pixel-point/aval-*` dependency references in those manifests;
- update release configuration documents whose `releaseVersion` identifies the
  current candidate, while preserving unrelated protocol and tool versions;
- update exact workspace and starter/example references that must consume the
  new local release;
- regenerate `package-lock.json` through npm rather than editing third-party
  dependency records by pattern;
- fail unless the six public package manifests, private certification manifest,
  release policy, and internal dependency pins agree afterward.

Historical release notes and wire/project schema versions are not rewritten.

## Package metadata and artifacts

Every public manifest must explicitly contain `private: false`, MIT licensing,
the existing files allowlist, exports, Node engine, side-effect declaration,
and package-specific repository metadata for
`https://github.com/pixel-point/aval`. The release packer remains the authority
for fresh builds and deterministic tarballs. The new workflow must not publish
source trees, tests, build caches, or private certification code.

Artifacts are written beneath `artifacts/<version>/packages`. Inspection checks
the exact package count, names, versions, exports, internal dependency graph,
file allowlists, and archive integrity before publication.

## Publication behavior and failure handling

Packages are published in topological order under `next`: graph, format,
element, compiler, React, then Svelte. Existing exact versions are accepted only
when registry integrity matches the prepared archive; a conflicting immutable
version aborts the release.

No `latest` tag changes until all six exact versions and `next` tags verify. If
publication stops partway through, the already-published immutable versions may
remain, but users following `latest` do not see a partial release. Re-running the
same command reconciles exact matching versions and continues. Promotion updates
all six `latest` tags only after complete verification.

The script never stores npm credentials. It relies on the operator's npm login
or `NODE_AUTH_TOKEN`, confirms the authenticated identity, and uses public access
for scoped packages.

## Verification

Automated tests cover SemVer bumping, exact-version synchronization, rejection
of drift and prereleases, public/private package selection, dependency order,
and dry-run command construction. Repository verification runs the focused
release tests, type checking, fresh public builds, tarball inspection, and the
existing offline packed-consumer suite.

Actual registry publication is intentionally not performed while implementing
this workflow. It remains an explicit operator action through the completed
script.
