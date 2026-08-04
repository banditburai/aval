# Remove compiler init command design

## Outcome

Remove `init` completely from the public compiler CLI and programmatic CLI
types. Users compile an existing project directly with:

```sh
npx @pixel-point/aval-compiler compile motion.json --out dist/motion
```

The compiler will no longer generate example projects or advertise project
scaffolding as part of its product surface.

## Removed surface

The CLI parser stops recognizing `init`, the help text stops listing it, and
the dispatcher no longer imports or invokes the generator. The public index no
longer exports `InitCliArguments`. Both the starter generator and its
specialized no-replace directory publication helper are deleted, together with
their generator-specific tests.

`init` becomes an ordinary unknown command and follows the existing
`CLI_USAGE` diagnostic and exit-status path. A regression test owns that
behavior so the command cannot be accidentally reintroduced.

## Documentation and repository integration

Active READMEs, quick starts, compiler documentation, example guidance, and
documentation policy checks present direct scoped-package compilation. They do
not suggest installing the compiler or generating a starter first.

The checked `fixtures/starter/v1-idle-hover` directory remains static test data.
Packed-package browser verification, provenance composition, and public UI
policy checks use its authored files independently of the removed generator.
Fixture verification stops importing compiler build output to regenerate it.
Historical design and implementation records remain historical records rather
than being rewritten.

## Build hygiene

The compiler build cleans its distribution before TypeScript emission. This
ensures deleted source modules cannot survive as ignored stale `dist` files and
be copied into a future npm tarball.

## Verification

Focused CLI tests prove `init` is rejected and absent from help. Compiler tests,
type checking, documentation checks, fixture verification, a fresh compiler
build, and npm package-content inspection must pass. The freshly built and
packed compiler distribution must contain no `commands/init*` files or `init`
command documentation.
