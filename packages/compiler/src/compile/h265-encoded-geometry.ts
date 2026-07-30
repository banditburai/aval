import type {
  H265CropSummary,
  VideoRenditionGeometry
} from "@pixel-point/aval-format";

import { CompilerError } from "../diagnostics.js";

export interface H265EncodedSurface {
  readonly codedWidth: number;
  readonly codedHeight: number;
  readonly log2CtbSize: number;
  readonly crop: Readonly<H265CropSummary>;
}

export function reconcileH265EncodedGeometry(
  geometry: Readonly<VideoRenditionGeometry>,
  surface: Readonly<H265EncodedSurface>,
  rendition?: string
): Readonly<VideoRenditionGeometry> {
  const codedWidth = codedDimension(surface.codedWidth, "width", rendition);
  const codedHeight = codedDimension(surface.codedHeight, "height", rendition);
  const codingTreeBlockSize = ctbSize(surface.log2CtbSize, rendition);
  const [storageX, storageY, storageWidth, storageHeight] =
    geometry.decodedStorageRect;
  const rightPadding = codedWidth - storageWidth;
  const bottomPadding = codedHeight - storageHeight;
  const crop = surface.crop;
  if (
    storageX !== 0 ||
    storageY !== 0 ||
    rightPadding < 0 ||
    bottomPadding < 0 ||
    rightPadding >= codingTreeBlockSize ||
    bottomPadding >= codingTreeBlockSize ||
    !cropFactsAreIntegers(crop) ||
    crop.left !== 0 ||
    crop.top !== 0 ||
    crop.visibleWidth !== storageWidth ||
    crop.visibleHeight !== storageHeight ||
    crop.right !== rightPadding ||
    crop.bottom !== bottomPadding
  ) {
    throw invalid(
      "H.265 encoded geometry crop does not expose exact decoded storage",
      rendition
    );
  }
  return Object.freeze({
    ...geometry,
    codedWidth,
    codedHeight,
    codedRgbaBytes: checkedProduct(rendition, codedWidth, codedHeight, 4)
  });
}

function codedDimension(
  value: number,
  name: string,
  rendition: string | undefined
): number {
  if (!Number.isSafeInteger(value) || value < 2 || value % 2 !== 0) {
    throw invalid(
      `H.265 encoded geometry ${name} must be a positive even integer`,
      rendition
    );
  }
  return value;
}

function ctbSize(
  log2CtbSize: number,
  rendition: string | undefined
): number {
  if (
    !Number.isSafeInteger(log2CtbSize) ||
    log2CtbSize < 3 ||
    log2CtbSize > 6
  ) {
    throw invalid(
      "H.265 encoded geometry CTB size must be between 8 and 64 luma samples",
      rendition
    );
  }
  return 2 ** log2CtbSize;
}

function cropFactsAreIntegers(
  crop: Readonly<H265CropSummary> | undefined
): crop is Readonly<H265CropSummary> {
  if (typeof crop !== "object" || crop === null) return false;
  return [
    crop.left,
    crop.right,
    crop.top,
    crop.bottom,
    crop.visibleWidth,
    crop.visibleHeight
  ].every((value, index) =>
    Number.isSafeInteger(value) &&
    value >= (index < 4 ? 0 : 1)
  );
}

function checkedProduct(
  rendition: string | undefined,
  ...values: number[]
): number {
  let result = 1;
  for (const value of values) {
    result *= value;
    if (!Number.isSafeInteger(result) || result < 1) {
      throw invalid(
        "H.265 encoded geometry byte size exceeds safe arithmetic",
        rendition
      );
    }
  }
  return result;
}

function invalid(message: string, rendition: string | undefined): CompilerError {
  return new CompilerError("ASSET_INVALID", message, {
    phase: "encode",
    ...(rendition === undefined ? {} : { rendition })
  });
}
