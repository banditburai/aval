# High-quality encoder defaults

## Goal

When an author omits the H.265 preset or VP9 deadline, the compiler must use
the highest-quality practical modes requested for this project:

- H.265: `veryslow`
- VP9: `best`

An explicitly authored value must always win. The normalized project and
`build.json` must continue to record the resolved value so a build remains
inspectable and reproducible.

## Scope

The defaults apply consistently to:

1. direct compilation when `--preset` or `--deadline` is omitted; and
2. project JSON when an H.265 `preset` or VP9 `deadline` field is omitted.

H.264 and AV1 defaults are unchanged. The compiler continues to remove audio.
MP4/MOV-only options such as `hvc1` tags and `faststart` remain inapplicable to
elementary video chunks stored in an AVAL asset.

The separate H.265 coded-height/conformance-crop issue is not part of this
change.

## Considered approaches

### Direct CLI defaults only

This is the smallest code change, but project files would still require the
same values explicitly. Two compiler entry points would therefore behave
differently.

### Direct and project defaults with normalized explicit output

This is the selected approach. Authored project types allow only these two
fields to be omitted. Validation supplies the defaults and returns the existing
normalized encoding types with required fields. Build reports remain strict and
must contain the resolved values.

### Encoder-wrapper hardcoding

The FFmpeg argument builder could silently substitute values at the final
process boundary. This is rejected because reports and preflight logic would
not know which policy was actually used.

## Design

Define the two defaults once in the compiler model and reuse them in direct
lowering and project validation. Do not change the allowlists.

Project-source typing distinguishes authored encodings from normalized
encodings: H.265 `preset` and VP9 `deadline` are optional only on authored
project input. After validation they are required. The build-report parser uses
the normalized path and continues rejecting reports that omit either field.

The generated starter explicitly uses `veryslow` and `best` so its policy is
self-documenting even if defaults change in a future compiler version. The
lend/borrow example uses those explicit requested values as well.

CLI help and authoring documentation state the new omission behavior and the
fact that slower modes can substantially increase compilation time.

## Verification

Focused tests must prove:

- omitted project H.265 preset becomes `veryslow`;
- omitted project VP9 deadline becomes `best`;
- every explicit allowlisted value remains unchanged;
- normalized build-report policies still reject omitted fields;
- direct H.265 and VP9 compilation lower to the new defaults;
- generated starter policy is `veryslow`/`best`;
- emitted FFmpeg arguments contain `-preset veryslow` or `-deadline best`;
- H.264 and AV1 behavior is unchanged.

Run compiler typechecking and the focused compiler/format suites, followed by
the repository build and diff-hygiene checks.
