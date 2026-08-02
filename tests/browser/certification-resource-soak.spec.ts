import { expect, test } from "@playwright/test";

import { ELEMENT_DECODER_CAPACITY } from "../../packages/element/src/index.js";

interface BrowserCertificationApi {
  readonly ready: Promise<void>;
  runPublicHarness(options: Readonly<{
    stateTransitions: number;
    rapidInputs: number;
    lifecycleCycles: number;
    soakDurationMs: number;
    soakPlayers: number;
  }>): Promise<Readonly<{
    readonly status: "passed" | "failed" | "inconclusive";
    readonly soak: Readonly<{
      readonly status: "passed" | "failed" | "inconclusive";
      readonly samples: number;
      readonly runtimeCapacity: Readonly<{
        preparationBatchSize: number;
        decoderWorkersPerActiveElement: number;
        decoderRingSize: number;
        decodedSurfacesPerActiveElement: number;
      }>;
      readonly terminalCounters: readonly Readonly<Record<string, number>>[];
      readonly failures: readonly string[];
    }>;
  }>>;
}

test("the public certification soak admits three elements sequentially", async ({ page }) => {
  test.setTimeout(60_000);
  await page.goto("/certification.html");

  const report = await page.evaluate(async () => {
    const api = (window as typeof window & {
      readonly avalCertification: BrowserCertificationApi;
    }).avalCertification;
    await api.ready;
    return api.runPublicHarness({
      stateTransitions: 1,
      rapidInputs: 1,
      lifecycleCycles: 1,
      soakDurationMs: 0,
      soakPlayers: 3
    });
  });

  expect(report.status).toBe("passed");
  const soak = report.soak;
  expect(soak.status).toBe("passed");
  expect(soak.failures).toEqual([]);
  expect(soak.samples).toBe(3);
  expect(soak.terminalCounters).toHaveLength(3);
  for (const counters of soak.terminalCounters) {
    expect(counters).toEqual({ player: 0, decoder: 0, bytes: 0 });
  }
  expect(soak.runtimeCapacity).toEqual({
    preparationBatchSize: 1,
    decoderWorkersPerActiveElement: ELEMENT_DECODER_CAPACITY.workerCount,
    decoderRingSize: ELEMENT_DECODER_CAPACITY.ringSize,
    decodedSurfacesPerActiveElement:
      ELEMENT_DECODER_CAPACITY.workerCount * ELEMENT_DECODER_CAPACITY.ringSize
  });
});
