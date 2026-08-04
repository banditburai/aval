# `motion.json` documentation design

## Goal

Make the compiler entry point self-contained enough that a new user can create
and compile a valid AVAL project without searching the source tree. The README
must show a short, complete `motion.json` beside the first compile command and
link directly to an authoritative reference page that documents the format,
accepted options, and larger examples.

## Approaches considered

### Expand the existing versioned project page

Turn `docs/project/1.0.md` into the authoritative `motion.json` reference. Keep
the versioned path, add a minimal example and compile command at the top, and
expand it with exact field tables and focused examples. Rename its README TOC
label to make the page discoverable.

This is the selected approach because project schema `1.0` already has one
canonical page and the documentation checker already treats it as required.
It avoids two pages drifting from the exact compiler schema.

### Add a second `docs/motion-json.md` page

A friendly path would be immediately recognizable, but it would duplicate the
versioned schema reference or require a thin redirect page. Either outcome adds
maintenance without adding information.

### Put the complete reference in the README

This maximizes visibility but makes the README too long and mixes a quick entry
point with graph and encoder reference material. The README should demonstrate
the path and link to details, not own the full contract.

## README changes

The first **Compile an AVAL project** section will:

1. link `motion.json` directly to `docs/project/1.0.md` in its opening sentence;
2. show one compact but complete loop project using a local video source and a
   VP9 encoding;
3. state the media assumptions needed for that example to compile;
4. show the scoped `npx @pixel-point/aval-compiler compile ...` command directly
   after the JSON;
5. link to the reference again after the example for all fields and codecs.

The **Documentation** TOC entry will be renamed from the technical
“Project schema 1.0” label to “`motion.json` format and options.”

## Reference-page structure

`docs/project/1.0.md` will become a practical reference while remaining the
exact project-schema `1.0` contract:

- minimal working project and compile command;
- top-level field table;
- canvas, frame-rate, alpha, and identifier rules;
- video and PNG-sequence source shapes;
- codec-specific encoding tables, rendition rules, accepted ranges, and
  materialized defaults;
- unit shapes for `body`, `bridge`, `reversible`, and `one-shot`;
- state, edge, trigger, start-policy, transition, and binding options;
- a PNG-sequence example and a two-state navigation pointer;
- strict-validation and useful compiler commands.

Every accepted value and default will be taken from the current compiler schema
and model constants. The page will distinguish required fields from the two
authored optional fields: H.265 `preset` and VP9 `deadline`.

## Validation

Documentation checks must pass, including relative-link validation. The README
example will be extracted as JSON and validated with the compiler's project
schema. The focused compiler schema tests and `git diff --check` will also run.
No compiler behavior or public package contract changes.
