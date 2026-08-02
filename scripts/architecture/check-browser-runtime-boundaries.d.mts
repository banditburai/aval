export interface BrowserRuntimeBoundaryResult {
  readonly status: "passed";
  readonly canonicalRuntime: "@pixel-point/aval-element";
  readonly scannedFiles: number;
}

export function checkBrowserRuntimeBoundaries(
  root?: string
): Promise<BrowserRuntimeBoundaryResult>;
