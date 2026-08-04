# Publication runbook

## Operator commands

The synchronized npm workflow publishes exactly six packages:
`@pixel-point/aval-graph`, `@pixel-point/aval-format`,
`@pixel-point/aval-element`, `@pixel-point/aval-compiler`,
`@pixel-point/aval-react`, and `@pixel-point/aval-svelte`. Certification,
applications, examples, and fixtures are never published.

Start a release by bumping every package and exact internal dependency together:

```sh
./scripts/release/publish-packages.sh bump patch
```

`major`, `minor`, or an exact increasing stable version such as `1.2.0` are also
accepted. Review and commit the version change, then prepare the immutable
tarballs:

```sh
./scripts/release/publish-packages.sh prepare
```

After inspecting the generated `artifacts/<version>/package-inspection.json`,
publish using an npm login or `NODE_AUTH_TOKEN` authorized for the
`@pixel-point` organization:

```sh
./scripts/release/publish-packages.sh publish
```

In a local interactive terminal, `publish` checks `npm whoami` and automatically
starts npm's web login when no session exists. Complete the approval in the
browser; the script then retries authentication and continues. Non-interactive
CI never opens a browser and requires credentials such as `NODE_AUTH_TOKEN` to
be configured before the command starts.

The command publishes in dependency order under `next`, verifies the complete
release, and only then promotes every package to `latest`. Re-running is safe
when already-published tarball integrity is identical; conflicting immutable
bytes abort the release.

npm can return `404 Not Found` from its read endpoints briefly after accepting
a publish or dist-tag mutation. The publisher treats that missing state as
registry propagation and polls for up to ten minutes for the exact integrity
and tag. A visible checksum conflict still aborts immediately. If npm remains
invisible after the polling window, the command reports a propagation timeout;
rerun the same `publish` command to reconcile the accepted package and continue
with the remaining package set.

## Certified workflow

Publication uses the already certified tarballs. It never checks out source or
rebuilds packages.

1. Verify candidate and release manifests, report index, tarball SHA-256 and
   registry integrity, API reports, SBOMs, notices, and reviewer approvals.
   Before the first public publish, add the canonical public repository,
   homepage, and issue-tracker URLs to package metadata once those real URLs
   exist; never publish invented or placeholder links.
   Confirm `config/release/legal-review.json` is approved by a qualified human;
   tooling never approves licensing or patent questions automatically.
2. In the protected npm environment, read each exact `name@1.0.0` and `next`
   tag before mutation.
3. If the version exists, continue only when integrity is exactly identical.
4. Publish dependency order under `next`: graph, format, element, compiler,
   React, Svelte.
5. Install exact registry versions into clean consumers and run browser smoke.
6. With a separate approval, promote all exact versions to `latest`.
7. Preserve the publication ledger and registry verification digest.

A partial publish must not reach `latest`. Never overwrite or unpublish an
immutable version.

Trusted npm OIDC publishing currently requires Node 22.14.0 or newer and npm
11.5.1 or newer. OIDC authenticates `npm publish` but not `npm dist-tag`.
Therefore the automated protected workflow stops after exact `next` publication
and registry consumers; the separate `latest` promotion command must run in a
protected operator session with short-lived authorization and a recorded
approval. Do not store a long-lived promotion token in the repository or
workflow.
