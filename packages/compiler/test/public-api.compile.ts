import {
  CompilerError,
  H264_ENCODER_PRESETS,
  H265_ENCODER_PRESETS,
  VP9_DEADLINES,
  bt709LimitedAlphaLuma,
  bt709LimitedChroma2x2,
  bt709LimitedLuma,
  compileDirectInput,
  compileProjectFile,
  inspectAssetFile,
  parseCliArguments,
  runCli,
  roundSignedRatio,
  startDevCommand,
  unpackAssetFile,
  validateAssetFile,
  validateAssetReport,
  type CliArguments,
  type CliRuntime,
  type AlphaAuditSummary,
  type AlphaPolicyDecision,
  type AssetInspection,
  type AssetValidationReport,
  type Av1Encoding,
  type Bt709LimitedChroma,
  type CompileBundleResult,
  type DevSession,
  type DirectCompileOptions,
  type H264EncoderPreset,
  type H264Encoding,
  type H265Encoding,
  type InspectedChunkRange,
  type NormalizedSourceProject,
  type ProjectCompileOptions,
  type SourceAlphaPolicy,
  type SourceH265Encoding,
  type SourceProject,
  type SourceVideoEncoding,
  type SourceVp9Encoding,
  type UnpackReport,
  type VideoEncoding,
  type VideoRenditionInspection,
  type Vp9Encoding
} from "../src/index.js";

const direct: (input: DirectCompileOptions) => Promise<Readonly<CompileBundleResult>> =
  compileDirectInput;
const project: (input: ProjectCompileOptions) => Promise<Readonly<CompileBundleResult>> =
  compileProjectFile;
const directTimeoutOptions: DirectCompileOptions = {
  inputPath: "input.mov",
  outputPath: "output",
  loop: [0, 1],
  codec: "h264",
  alpha: "auto",
  probeTimeoutMs: 1_000,
  mediaTimeoutMs: 5_000
};
const preset: H264EncoderPreset = "veryslow";
const encoding: H264Encoding = {
  codec: "h264",
  preset,
  renditions: [{ id: "video.1x", width: 1_920, height: "auto", crf: 20 }]
};
const h265Encoding: H265Encoding = {
  codec: "h265",
  preset: "veryslow",
  threads: 8,
  renditions: [{ id: "video.1x", width: 1_920, height: "auto", crf: 32 }]
};
const vp9Encoding: Vp9Encoding = {
  codec: "vp9",
  deadline: "best",
  cpuUsed: 0,
  threads: 8,
  renditions: [{ id: "video.1x", width: 1_920, height: "auto", crf: 40 }]
};
const av1Encoding: Av1Encoding = {
  codec: "av1",
  bitDepth: 10,
  cpuUsed: 0,
  tiles: { columns: 4, rows: 2 },
  rowMt: true,
  threads: 32,
  renditions: [{ id: "video.1x", width: 1_920, height: "auto", crf: 15 }]
};
const encodings: readonly VideoEncoding[] = [
  av1Encoding,
  vp9Encoding,
  h265Encoding,
  encoding
];
const authoredH265Encoding: SourceH265Encoding = {
  codec: "h265",
  threads: 8,
  renditions: [{ id: "video.1x", width: 1_920, height: "auto", crf: 32 }]
};
const authoredVp9Encoding: SourceVp9Encoding = {
  codec: "vp9",
  cpuUsed: 0,
  threads: 8,
  renditions: [{ id: "video.1x", width: 1_920, height: "auto", crf: 40 }]
};
const authoredEncodings: readonly SourceVideoEncoding[] = [
  authoredH265Encoding,
  authoredVp9Encoding
];
const authoredProjectEncodings: SourceProject["encodings"] = authoredEncodings;
// @ts-expect-error normalized H.265 policies must record an explicit preset
const incompleteH265Encoding: H265Encoding = authoredH265Encoding;
// @ts-expect-error normalized VP9 policies must record an explicit deadline
const incompleteVp9Encoding: Vp9Encoding = authoredVp9Encoding;
const directCrfOptions: DirectCompileOptions = {
  inputPath: "input.mov",
  outputPath: "output",
  loop: [0, 1],
  codec: "h264",
  crf: 20,
  preset
};
const projectTimeoutOptions: ProjectCompileOptions = {
  projectPath: "project.json",
  outputPath: "output",
  probeTimeoutMs: 1_000,
  mediaTimeoutMs: 5_000
};
const parsed: CliArguments = parseCliArguments(["inspect", "asset.avl"]);
const runtime: CliRuntime = {};
const cli: Promise<number> = runCli(["--help"], runtime);
const inspection = inspectAssetFile("asset.avl");
const controller = new AbortController();
const cancelledInspection = inspectAssetFile("asset.avl", controller.signal);
const validation = validateAssetFile("asset.avl");
const cancelledValidation = validateAssetFile("asset.avl", controller.signal);
const validationReport = validateAssetReport("asset.avl");
const cancelledValidationReport = validateAssetReport("asset.avl", controller.signal);
const unpack = unpackAssetFile("asset.avl", "output");
const cancelledUnpack = unpackAssetFile("asset.avl", "output", controller.signal);
const error: Error = new CompilerError("CLI_USAGE", "test");
const policy: SourceAlphaPolicy = "auto";
const normalized = null as unknown as Readonly<NormalizedSourceProject>;
const sourceProject = null as unknown as Readonly<SourceProject>;
const audit = null as unknown as Readonly<AlphaAuditSummary>;
const assetInspection = null as unknown as Readonly<AssetInspection>;
const assetValidationReport = null as unknown as Readonly<AssetValidationReport>;
const inspectedChunk = null as unknown as Readonly<InspectedChunkRange>;
const videoInspection = null as unknown as Readonly<VideoRenditionInspection>;
const unpackReport = null as unknown as Readonly<UnpackReport>;
const decision = null as unknown as Readonly<AlphaPolicyDecision>;
const rounded: number = roundSignedRatio(-3, 2);
const luma: number = bt709LimitedLuma(1, 2, 3);
const alphaLuma: number = bt709LimitedAlphaLuma(128);
const chroma: Readonly<Bt709LimitedChroma> = bt709LimitedChroma2x2(
  new Uint8Array(12)
);

void direct;
void project;
void directTimeoutOptions;
void H264_ENCODER_PRESETS;
void H265_ENCODER_PRESETS;
void VP9_DEADLINES;
void encoding;
void encodings;
void authoredEncodings;
void authoredProjectEncodings;
void incompleteH265Encoding;
void incompleteVp9Encoding;
void directCrfOptions;
void projectTimeoutOptions;
void parsed;
void cli;
void inspection;
void cancelledInspection;
void validation;
void cancelledValidation;
void validationReport;
void cancelledValidationReport;
void unpack;
void cancelledUnpack;
void error;
void policy;
void normalized;
void sourceProject;
void audit;
void assetInspection;
void assetValidationReport;
void inspectedChunk;
void videoInspection;
void unpackReport;
void decision;
void rounded;
void luma;
void alphaLuma;
void chroma;

// Verify the public session shape without starting a watcher.
const sessionFactory: typeof startDevCommand = startDevCommand;
type Session = Awaited<ReturnType<typeof sessionFactory>>;
const sessionAssignable = null as unknown as Session satisfies DevSession;
void sessionAssignable;
