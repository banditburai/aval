import type { ProductionRendition as Rendition } from
  "@pixel-point/aval-format";

import { Asset } from "./asset.js";
import { DecoderPool } from "./decoder-pool.js";
import type { PlayerCandidateProbeInput } from
  "./player-candidate-contract.js";
import { reducedMotionSelected, type PlayerDecoderDiagnostic,
  type PlayerInput } from "./player-contract.js";
import {
  publishPlayerDecoderDiagnostics,
  publishPlayerRendererDiagnostics,
  reportCurrentPlayerResourceBytes
} from "./player-media-observability.js";
import { PlayerMediaAdmissionAuthority } from
  "./player-media-admission-authority.js";
import { PlayerMediaRuntime } from "./player-media-runtime.js";
import { PlayerTelemetry } from "./player-telemetry.js";
import {
  PreparationDeadline,
  preparationTimeout
} from "./preparation-deadline.js";
import { CANDIDATE_PREPARATION_TIMEOUT_MS } from
  "./preparation-budget.js";
import { limit, unsupportedProfileError } from "./player-failures.js";
import {
  assertCandidateResourceBudget,
  checkedResourceTotal,
  readinessResidentFrameCount,
  renditionRenderLayout
} from "./player-resource-budget.js";
import { Renderer } from "./renderer.js";
import type { RendererContextChange } from "./renderer-contract.js";
import { RendererFailureError } from "./renderer-diagnostics.js";
import type { StaticReason } from "./public-types.js";
import { createReadinessPlan, type ReadinessPlan } from "./readiness.js";
import { retryableCandidateOutcome } from
  "./provisional-candidate-outcome.js";

export type PlayerMediaProbeResult =
  | Readonly<{
      kind: "candidate";
      media: PlayerMediaRuntime;
      telemetry: PlayerTelemetry;
      deadline: PreparationDeadline;
      staticReason: StaticReason | null;
      renditionId: string;
      requiresQualification: boolean;
      renditionCount: number;
    }>
  | Readonly<{
      kind: "rendition-rejected";
      renditionId: string;
      renditionCount: number;
      reason: "codec-unsupported";
      decoderDiagnostics: readonly Readonly<PlayerDecoderDiagnostic>[];
    }>
  | Readonly<{
      kind: "source-rejected";
      reason: "no-video-rendition";
    }>;

type AcceptedCandidate = Extract<
  PlayerMediaProbeResult, { readonly kind: "candidate" }
>;
type RejectedCandidate = Exclude<PlayerMediaProbeResult, AcceptedCandidate>;
type AcceptCandidate<T> = (candidate: AcceptedCandidate) => T;

const COLOR = Object.freeze({
  fullRange: false as const,
  matrix: "bt709" as const,
  primaries: "bt709" as const,
  transfer: "bt709" as const
});

/** Owns only provisional source/rendition admission until one runtime accepts it. */
export class PlayerMediaCandidateProbe {
  readonly #deadline: PreparationDeadline;
  readonly #authority: PlayerMediaAdmissionAuthority;

  public constructor(
    target: Readonly<PlayerInput>,
    deadline: PreparationDeadline
  ) {
    this.#deadline = deadline;
    this.#authority = new PlayerMediaAdmissionAuthority(target);
  }

  public probe(
    request: Readonly<PlayerCandidateProbeInput>
  ): Promise<Readonly<PlayerMediaProbeResult>> {
    return this.probeWith(request, (candidate) => candidate);
  }

  public probeWith<T>(
    request: Readonly<PlayerCandidateProbeInput>,
    acceptCandidate: AcceptCandidate<T>
  ): Promise<Readonly<T | RejectedCandidate>> {
    return this.#probeWith(request, acceptCandidate);
  }

  async #probeWith<T>(
    request: Readonly<PlayerCandidateProbeInput>,
    acceptCandidate: AcceptCandidate<T>
  ): Promise<Readonly<T | RejectedCandidate>> {
    try {
      const input = request.publications.input;
      this.#deadline.signal.throwIfAborted();
      const source = input.sources[request.sourceInputIndex];
      if (source === undefined) throw new Error("Invalid AVAL source cursor");
      const sourcePreparation = this.#authority.prepareSource(
        request.sourceInputIndex
      );
      if (sourcePreparation !== undefined) await sourcePreparation;
      if (this.#authority.empty) {
        const asset = await Asset.open(
          source,
          input.baseUrl,
          input.credentials,
          this.#deadline.signal,
          input.platform
        );
        this.#authority.retain(request.sourceInputIndex, asset);
        reportCurrentPlayerResourceBytes(input, asset);
      }
      const asset = this.#authority.retainedAsset(request.sourceInputIndex);
      const renditions = asset.manifest.renditions;
      if (asset.manifest.codec !== source.codec || renditions.length === 0) {
        await this.dispose();
        return Object.freeze({ kind: "source-rejected", reason: "no-video-rendition" });
      }
      const rendition = renditions[request.renditionIndex];
      if (rendition === undefined) {
        throw new Error("Invalid AVAL rendition cursor");
      }
      const sourceIndex = source.sourceIndex ?? request.sourceInputIndex;
      if (this.#deadline.timedOut) {
        throw preparationTimeout();
      }
      const staticReason = !input.visible
        ? "visibility-suspended" as const
        : reducedMotionSelected(input.motion, input.reduced)
          ? "reduced-motion" as const : null;
      if (staticReason !== null) return this.#acceptTransferred(
        this.#transfer(
          input, request, asset, rendition, sourceIndex, null, null,
          this.#deadline, staticReason, false, renditions.length
        ),
        acceptCandidate
      );
      const WorkerConstructor = input.platform.Worker;
      const VideoFrameConstructor = input.platform.VideoFrame;
      if (WorkerConstructor === null || input.platform.VideoDecoder === null ||
        VideoFrameConstructor === null) {
        throw unsupportedProfileError();
      }
      if (!input.decoderReady()) return this.#acceptTransferred(
        this.#transfer(
          input, request, asset, rendition, sourceIndex, null, null,
          this.#deadline, "decoder-queued", false, renditions.length
        ),
        acceptCandidate
      );
      const plan: Readonly<ReadinessPlan> = createReadinessPlan(
        asset.manifest,
        rendition.id,
        asset.blobs
      );
      const layout = renditionRenderLayout(asset.manifest, rendition);
      const config: VideoDecoderConfig = {
        codec: rendition.codec,
        codedWidth: rendition.codedWidth,
        codedHeight: rendition.codedHeight,
        displayAspectWidth: layout.storageWidth,
        displayAspectHeight: layout.storageHeight,
        colorSpace: COLOR,
        hardwareAcceleration: "no-preference",
        optimizeForLatency: true
      };
      let rendererRef: Renderer | null = null;
      let decodedBytes = 0;
      let encodedBytes = 0;
      const reportDecoderBytes = (increasing: boolean): void => {
        reportCurrentPlayerResourceBytes(
          input,
          asset,
          checkedResourceTotal([decodedBytes, encodedBytes]),
          rendererRef,
          increasing
        );
      };
      const decoders = this.#authority.createDecoders(
        request.sourceInputIndex,
        asset,
        () => new DecoderPool(config, {
          codedWidth: rendition.codedWidth,
          codedHeight: rendition.codedHeight,
          displayWidth: layout.storageWidth,
          displayHeight: layout.storageHeight,
          visibleRect: {
            x: 0,
            y: 0,
            width: layout.storageWidth,
            height: layout.storageHeight
          },
          colorSpace: COLOR
        }, {
          maxDecodedBytes: asset.manifest.limits.maxRuntimeBytes,
          onDecodedBytes: (bytes) => {
            const previous = decodedBytes;
            decodedBytes = bytes;
            try { reportDecoderBytes(bytes > previous); }
            catch (error) {
              decodedBytes = previous;
              throw error;
            }
          },
          onEncodedBytes: (bytes) => {
            const previous = encodedBytes;
            encodedBytes = bytes;
            try { reportDecoderBytes(bytes > previous); }
            catch (error) {
              encodedBytes = previous;
              throw error;
            }
          },
          Worker: WorkerConstructor,
          VideoFrame: VideoFrameConstructor,
          setTimeout: input.platform.setTimeout,
          clearTimeout: input.platform.clearTimeout,
          sampleFrameRate: asset.manifest.frameRate
        })
      );
      const decoderDiagnostics = () =>
        publishPlayerDecoderDiagnostics(
          input,
          decoders.snapshot().decoderDiagnostics,
          sourceIndex,
          rendition
        );
      let supported = false;
      try { supported = await limit(decoders.supported(), this.#deadline.signal); }
      catch (error) {
        const diagnostics = decoderDiagnostics();
        if (this.#deadline.timedOut) {
          throw preparationTimeout();
        }
        const outcome = retryableCandidateOutcome(error);
        if (!this.#deadline.signal.aborted && outcome?.rejection.stage === "probe") {
          await this.#authority.releaseRejectedAdmission(
            request.renditionIndex + 1 < renditions.length
          );
          return rejection(rendition.id, renditions.length, diagnostics);
        }
        throw error;
      }
      if (!supported) {
        const diagnostics = decoderDiagnostics();
        await this.#authority.releaseRejectedAdmission(
          request.renditionIndex + 1 < renditions.length
        );
        return rejection(rendition.id, renditions.length, diagnostics);
      }
      let renderer: Renderer;
      let contextChange: ((change: Readonly<RendererContextChange>) => void) | null = null;
      try {
        const maximum = asset.manifest.limits.maxRuntimeBytes;
        renderer = this.#authority.createRenderer(
          asset,
          decoders,
          () => new Renderer(input.canvas, layout, {
            maxTextureBytes: maximum,
            maxBackingBytes: maximum,
            maxRuntimeBytes: maximum,
            setTimeout: input.platform.setTimeout,
            clearTimeout: input.platform.clearTimeout,
            onContextChange: (change) => contextChange?.(change),
            initialPresentation: {
              width: input.initialPresentation.width,
              height: input.initialPresentation.height,
              dpr: input.initialPresentation.dpr,
              fit: input.initialPresentation.fit ?? asset.manifest.canvas.fit
            }
          })
        );
      } catch (error) {
        try { decoderDiagnostics(); }
        catch { /* diagnostics cannot replace the candidate outcome */ }
        if (error instanceof RendererFailureError) {
          publishPlayerRendererDiagnostics(
            input,
            Object.freeze([error.diagnostic]),
            sourceIndex,
            rendition
          );
        }
        throw error;
      }
      rendererRef = renderer;
      let candidateDeadline: PreparationDeadline;
      try {
        reportDecoderBytes(true);
        const admission = renderer.admit(readinessResidentFrameCount(plan));
        const resources = asset.snapshot();
        assertCandidateResourceBudget({
          manifest: asset.manifest,
          rendition,
          unitBlobs: asset.blobs,
          assetMode: resources.mode,
          metadataBytes: resources.metadataBytes,
          residentBlobBytes: resources.residentBlobBytes,
          readinessEncodedBytes: plan.encodedBytes,
          rendererRuntimeBytes: admission.runtimeBytes
        });
        candidateDeadline = this.#authority.createDeadline(
          asset,
          decoders,
          () => this.#deadline.forkDeferred(CANDIDATE_PREPARATION_TIMEOUT_MS)
        );
      } catch (error) {
        try { decoderDiagnostics(); }
        catch { /* diagnostics cannot replace the candidate outcome */ }
        throw error;
      }
      const result = this.#transfer(
        input, request, asset, rendition, sourceIndex, decoders, renderer,
        candidateDeadline, null, true, renditions.length
      );
      contextChange = (change) => result.media.contextChanged(change);
      return this.#acceptTransferred(result, acceptCandidate);
    } catch (error) {
      return this.#failAfterCleanup(error);
    }
  }

  public dispose(): Promise<void> {
    return this.#authority.dispose();
  }

  #transfer(
    input: Readonly<PlayerInput>,
    request: Readonly<PlayerCandidateProbeInput>,
    asset: Asset,
    rendition: Readonly<Rendition>,
    sourceIndex: number,
    decoders: DecoderPool | null,
    renderer: Renderer | null,
    deadline: PreparationDeadline,
    staticReason: StaticReason | null,
    requiresQualification: boolean,
    renditionCount: number
  ): AcceptedCandidate {
    const ownedDeadline = deadline === this.#deadline ? null : deadline;
    const telemetry = new PlayerTelemetry(Object.freeze({
      initialDecoderDiagnostics: request.decoderDiagnostics
    }));
    const media = this.#authority.transfer(Object.freeze({
      asset,
      decoders,
      renderer,
      ownedDeadline
    }), () => new PlayerMediaRuntime({
        input,
        asset,
        rendition,
        sourceIndex,
        decoders,
        renderer,
        deadline,
        telemetry
      }));
    return Object.freeze({
      kind: "candidate",
      media,
      telemetry,
      deadline,
      staticReason,
      renditionId: rendition.id,
      requiresQualification,
      renditionCount
    });
  }

  #acceptTransferred<T>(
    candidate: AcceptedCandidate,
    acceptCandidate: AcceptCandidate<T>
  ): Readonly<T> {
    const accepted = acceptCandidate(candidate);
    this.#authority.accept(candidate.media);
    return accepted;
  }

  async #failAfterCleanup(reason: unknown): Promise<never> {
    try { await this.dispose(); }
    catch { /* cleanup cannot replace the canonical probe failure */ }
    throw reason;
  }
}

function rejection(
  renditionId: string,
  renditionCount: number,
  decoderDiagnostics: readonly Readonly<PlayerDecoderDiagnostic>[]
): Extract<PlayerMediaProbeResult, { readonly kind: "rendition-rejected" }> {
  return Object.freeze({
    kind: "rendition-rejected",
    renditionId,
    renditionCount,
    reason: "codec-unsupported",
    decoderDiagnostics
  });
}
