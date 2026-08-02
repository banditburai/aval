import {
  maximumDecodedRgbaBytes,
  type CompiledManifest as Manifest,
  type EncodedChunkRecord,
  type ProductionRendition as Rendition,
  type UnitBlobRange
} from "@pixel-point/aval-format";
import { ELEMENT_DECODER_CAPACITY } from "./decoder-capacity.js";
import type { PlayerInput } from "./player-contract.js";
import type { ReadinessPlan } from "./readiness.js";
import {
  deriveRenderLayout,
  type RenderLayout
} from "./renderer-geometry.js";
import { MAX_ROUTE_PREFETCH_INTENTS } from "./route-prefetch.js";

export interface PlayerResourceBytes {
  readonly metadataBytes: number;
  readonly residentBlobBytes: number;
  readonly decoderBytes: number;
  readonly rendererRuntimeBytes: number;
  readonly maximumBytes: number;
  readonly enforceMaximum: boolean;
}

export interface CandidateBudgetInput {
  readonly manifest: Readonly<Manifest>;
  readonly rendition: Readonly<Rendition>;
  readonly unitBlobs: readonly Readonly<UnitBlobRange>[];
  readonly assetMode: "range" | "full";
  readonly metadataBytes: number;
  readonly residentBlobBytes: number;
  readonly readinessEncodedBytes: number;
  readonly rendererRuntimeBytes: number;
}

export interface RuntimeBudgetInput {
  readonly manifest: Readonly<Manifest>;
  readonly rendition: Readonly<Rendition>;
  readonly unitBlobs: readonly Readonly<UnitBlobRange>[];
  readonly metadataBytes: number;
  readonly residentBlobBytes: number;
  readonly decoderOpenFrameBytes: number;
  readonly rendererRuntimeBytes: number;
}

export function renditionRenderLayout(
  manifest: Readonly<Manifest>,
  rendition: Readonly<Rendition>
): Readonly<RenderLayout> {
  const color = rendition.alphaLayout.colorRect;
  const alpha = rendition.alphaLayout.type === "stacked"
    ? rendition.alphaLayout.alphaRect : undefined;
  return deriveRenderLayout({
    codedWidth: rendition.codedWidth,
    codedHeight: rendition.codedHeight,
    logicalWidth: manifest.canvas.width,
    logicalHeight: manifest.canvas.height,
    pixelAspect: manifest.canvas.pixelAspect,
    colorRect: color,
    ...(alpha === undefined ? {} : { alphaRect: alpha })
  });
}

export function reportPlayerResourceBytes(
  input: Readonly<Pick<PlayerInput, "onResourceBytes">>,
  resources: Readonly<PlayerResourceBytes> | null
): void {
  if (resources === null) {
    input.onResourceBytes(0);
    return;
  }
  const bytes = playerResourceByteTotal(resources);
  if (resources.enforceMaximum) assertPlayerResourceBudget(resources);
  input.onResourceBytes(bytes);
}

export function assertPlayerResourceBudget(
  resources: Readonly<PlayerResourceBytes>
): void {
  if (playerResourceByteTotal(resources) > resources.maximumBytes) {
    throw resourceBudgetError();
  }
}

export function playerResourceByteTotal(
  resources: Readonly<PlayerResourceBytes>
): number {
  return checkedResourceTotal([
    resources.metadataBytes,
    resources.residentBlobBytes,
    resources.decoderBytes,
    resources.rendererRuntimeBytes
  ]);
}

export function assertCandidateResourceBudget(
  input: Readonly<CandidateBudgetInput>
): void {
  const residentBlobBytes = input.assetMode === "full"
    ? input.residentBlobBytes : input.readinessEncodedBytes;
  const aggregate = checkedResourceTotal([
    input.metadataBytes,
    residentBlobBytes,
    encodedCopyCeiling(input.unitBlobs, input.manifest, input.rendition),
    checkedResourceProduct([
      ELEMENT_DECODER_CAPACITY.totalDecodedSurfaces,
      decodedSurfaceBytes(input.manifest, input.rendition)
    ]),
    input.rendererRuntimeBytes
  ]);
  if (aggregate > input.manifest.limits.maxRuntimeBytes) {
    throw resourceBudgetError();
  }
}

export function readinessResidentFrameCount(
  readiness: Readonly<ReadinessPlan>
): number {
  const resident = new Map<string, Set<number>>();
  for (const entry of readiness.resident) {
    resident.set(entry.unit, new Set(entry.frames));
  }
  let residentFrames = 0;
  for (const frames of resident.values()) {
    residentFrames = checkedResourceTotal([residentFrames, frames.size]);
  }
  return residentFrames;
}

export function assertRuntimeResourceBudget(
  input: Readonly<RuntimeBudgetInput>
): void {
  const minimumDecodedBytes = checkedResourceProduct([
    ELEMENT_DECODER_CAPACITY.totalDecodedSurfaces,
    decodedSurfaceBytes(input.manifest, input.rendition)
  ]);
  const aggregate = checkedResourceTotal([
    input.metadataBytes,
    input.residentBlobBytes,
    encodedCopyCeiling(input.unitBlobs, input.manifest, input.rendition),
    Math.max(input.decoderOpenFrameBytes, minimumDecodedBytes),
    input.rendererRuntimeBytes
  ]);
  if (aggregate > input.manifest.limits.maxRuntimeBytes) {
    throw resourceBudgetError();
  }
}

/** Exact encoded-copy ceiling implied by four queued wants plus active and retiring runs. */
export function encodedCopyCeilingForUnits(
  unitCopyBytes: readonly number[]
): number {
  const ordered = unitCopyBytes.map((value) => checkedResourceTotal([value]))
    .sort((left, right) => right - left);
  const maximum = ordered[0] ?? 0;
  return checkedResourceTotal([
    maximum,
    maximum,
    ...ordered.slice(0, MAX_ROUTE_PREFETCH_INTENTS)
  ]);
}

export function encodedUnitCopyBytes(
  records: readonly Readonly<EncodedChunkRecord>[],
  span: Readonly<{ chunkStart: number; chunkCount: number }>
): number {
  let bytes = 0;
  for (let index = 0; index < span.chunkCount; index += 1) {
    const record = records[span.chunkStart + index];
    if (record === undefined) throw new Error("Invalid AVAL asset");
    bytes = checkedResourceTotal([bytes, record.byteLength]);
  }
  return bytes;
}

export function checkedResourceTotal(values: readonly number[]): number {
  let total = 0;
  for (const value of values) {
    if (!Number.isSafeInteger(value) || value < 0 ||
      total > Number.MAX_SAFE_INTEGER - value) {
      throw resourceBudgetError();
    }
    total += value;
  }
  return total;
}

export function resourceBudgetError(): Error {
  const error = new RangeError("AVAL runtime resource budget is insufficient");
  error.name = "ResourceBudgetError";
  return error;
}

function encodedCopyCeiling(
  blobs: readonly Readonly<UnitBlobRange>[],
  manifest: Readonly<Manifest>,
  rendition: Readonly<Rendition>
): number {
  const copies = blobs
    .filter(({ rendition: id }) => id === rendition.id)
    .map(({ length }) => length);
  if (copies.length !== manifest.units.length) {
    throw new Error("Invalid AVAL asset");
  }
  return encodedCopyCeilingForUnits(copies);
}

function decodedSurfaceBytes(
  manifest: Readonly<Manifest>,
  rendition: Readonly<Rendition>
): number {
  return maximumDecodedRgbaBytes(
    manifest.codec,
    rendition.codedWidth,
    rendition.codedHeight
  );
}

function checkedResourceProduct(values: readonly number[]): number {
  let product = 1;
  for (const value of values) {
    if (!Number.isSafeInteger(value) || value < 0 ||
      value !== 0 && product > Math.floor(Number.MAX_SAFE_INTEGER / value)) {
      throw resourceBudgetError();
    }
    product *= value;
  }
  return product;
}
