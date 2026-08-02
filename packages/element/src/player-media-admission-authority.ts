import { Asset } from "./asset.js";
import type { DecoderPool } from "./decoder-pool.js";
import type { PlayerInput } from "./player-contract.js";
import { reportCurrentPlayerResourceBytes } from
  "./player-media-observability.js";
import type { PlayerMediaRuntime } from "./player-media-runtime.js";
import type { PreparationDeadline } from "./preparation-deadline.js";
import type { Renderer } from "./renderer.js";

interface RetainedAuthority {
  readonly kind: "retained";
  readonly sourceInputIndex: number;
  readonly asset: Asset;
}

interface AdmissionAuthority {
  readonly kind: "admitting";
  readonly sourceInputIndex: number;
  readonly asset: Asset;
  readonly decoders: DecoderPool;
  readonly renderer: Renderer | null;
  readonly ownedDeadline: PreparationDeadline | null;
}

interface TransferringAuthority {
  readonly kind: "transferring";
  readonly asset: Asset;
  readonly decoders: DecoderPool | null;
  readonly renderer: Renderer | null;
  readonly ownedDeadline: PreparationDeadline | null;
}

type ProbeAuthority =
  | Readonly<{ kind: "empty" }>
  | Readonly<RetainedAuthority>
  | Readonly<AdmissionAuthority>
  | Readonly<TransferringAuthority>
  | Readonly<{
      kind: "transferred";
      media: PlayerMediaRuntime;
      ownedDeadline: PreparationDeadline | null;
    }>;

const EMPTY_AUTHORITY = Object.freeze({ kind: "empty" as const });

/** Owns every provisional admission resource until one runtime is accepted. */
export class PlayerMediaAdmissionAuthority {
  readonly #target: Readonly<Pick<PlayerInput, "onResourceBytes">>;
  #authority: ProbeAuthority = EMPTY_AUTHORITY;
  #cleanup: Promise<void> | null = null;

  public constructor(
    target: Readonly<Pick<PlayerInput, "onResourceBytes">>
  ) {
    this.#target = target;
  }

  public prepareSource(sourceInputIndex: number): Promise<void> | undefined {
    const authority = this.#authority;
    if (authority.kind === "retained" &&
      authority.sourceInputIndex === sourceInputIndex) return;
    return authority.kind === "empty" ? undefined : this.dispose();
  }

  public get empty(): boolean { return this.#authority.kind === "empty"; }

  public retain(sourceInputIndex: number, asset: Asset): void {
    if (this.#authority.kind !== "empty") {
      throw new Error("Invalid AVAL retained asset authority");
    }
    this.#authority = Object.freeze({
      kind: "retained" as const,
      sourceInputIndex,
      asset
    });
  }

  public retainedAsset(sourceInputIndex: number): Asset {
    const authority = this.#authority;
    if (authority.kind !== "retained" ||
      authority.sourceInputIndex !== sourceInputIndex) {
      throw new Error("Invalid AVAL retained asset authority");
    }
    return authority.asset;
  }

  public createDecoders(
    sourceInputIndex: number,
    asset: Asset,
    create: () => DecoderPool
  ): DecoderPool {
    const retained = this.#authority;
    if (retained.kind !== "retained" || retained.asset !== asset ||
      retained.sourceInputIndex !== sourceInputIndex) {
      throw new Error("Invalid AVAL candidate admission authority");
    }
    const decoders = create();
    this.#authority = Object.freeze({
      kind: "admitting" as const,
      sourceInputIndex,
      asset,
      decoders,
      renderer: null,
      ownedDeadline: null
    });
    return decoders;
  }

  public createRenderer(
    asset: Asset,
    decoders: DecoderPool,
    create: () => Renderer
  ): Renderer {
    const authority = this.#requireAdmission(asset, decoders);
    if (authority.renderer !== null) {
      throw new Error("Invalid AVAL candidate renderer authority");
    }
    const renderer = create();
    this.#authority = Object.freeze({ ...authority, renderer });
    return renderer;
  }

  public createDeadline(
    asset: Asset,
    decoders: DecoderPool,
    create: () => PreparationDeadline
  ): PreparationDeadline {
    const authority = this.#requireAdmission(asset, decoders);
    if (authority.renderer === null || authority.ownedDeadline !== null) {
      throw new Error("Invalid AVAL candidate deadline authority");
    }
    const deadline = create();
    this.#authority = Object.freeze({
      ...authority,
      ownedDeadline: deadline
    });
    return deadline;
  }

  public transfer(
    input: Readonly<{
      asset: Asset;
      decoders: DecoderPool | null;
      renderer: Renderer | null;
      ownedDeadline: PreparationDeadline | null;
    }>,
    create: () => PlayerMediaRuntime
  ): PlayerMediaRuntime {
    const authority = this.#authority;
    const valid = authority.kind === "retained"
      ? authority.asset === input.asset && input.decoders === null &&
        input.renderer === null && input.ownedDeadline === null
      : authority.kind === "admitting" &&
        authority.asset === input.asset && authority.decoders === input.decoders &&
        authority.renderer === input.renderer &&
        authority.ownedDeadline === input.ownedDeadline;
    if (!valid) throw new Error("Invalid AVAL candidate asset transfer");
    this.#authority = Object.freeze({
      kind: "transferring" as const,
      ...input
    });
    const media = create();
    this.#authority = Object.freeze({
      kind: "transferred" as const,
      media,
      ownedDeadline: input.ownedDeadline
    });
    return media;
  }

  public accept(media: PlayerMediaRuntime): void {
    const authority = this.#authority;
    if (authority.kind !== "transferred" || authority.media !== media) {
      throw new Error("Invalid AVAL candidate runtime transfer");
    }
    this.#authority = EMPTY_AUTHORITY;
  }

  public async releaseRejectedAdmission(retainAsset: boolean): Promise<void> {
    try {
      if (retainAsset) await this.#resetAdmission();
      else await this.dispose();
    } catch { /* cleanup cannot replace the rendition rejection */ }
  }

  public dispose(): Promise<void> {
    if (this.#cleanup !== null) return this.#cleanup;
    const authority = this.#authority;
    const operation = this.#disposeAuthority(authority);
    this.#cleanup = operation;
    const clear = (): void => {
      if (this.#cleanup === operation) this.#cleanup = null;
    };
    void operation.then(clear, clear);
    return operation;
  }

  #requireAdmission(
    asset: Asset,
    decoders: DecoderPool
  ): Readonly<AdmissionAuthority> {
    const authority = this.#authority;
    if (authority.kind !== "admitting" || authority.asset !== asset ||
      authority.decoders !== decoders) {
      throw new Error("Invalid AVAL candidate admission authority");
    }
    return authority;
  }

  async #resetAdmission(): Promise<void> {
    const authority = this.#authority;
    if (authority.kind !== "admitting") {
      throw new Error("Invalid AVAL candidate admission authority");
    }
    const failures = disposeAdmissionResources(authority);
    if (failures.length > 0) throw failures[0];
    if (this.#authority === authority) {
      this.#authority = Object.freeze({
        kind: "retained" as const,
        sourceInputIndex: authority.sourceInputIndex,
        asset: authority.asset
      });
    }
  }

  async #disposeAuthority(authority: ProbeAuthority): Promise<void> {
    if (authority.kind === "empty") return;
    if (authority.kind === "transferred") {
      const failures: unknown[] = [];
      try { await authority.media.retire(); }
      catch (error) { failures.push(error); }
      try { authority.ownedDeadline?.dispose(); }
      catch (error) { failures.push(error); }
      if (failures.length > 0) throw failures[0];
    } else if (authority.kind === "retained") {
      await authority.asset.dispose();
      reportCurrentPlayerResourceBytes(this.#target, null);
    } else {
      const failures = disposeAdmissionResources(authority);
      let assetDisposed = false;
      try {
        await authority.asset.dispose();
        assetDisposed = true;
      } catch (error) { failures.push(error); }
      if (assetDisposed) {
        try { reportCurrentPlayerResourceBytes(this.#target, null); }
        catch (error) { failures.push(error); }
      }
      if (failures.length > 0) throw failures[0];
    }
    if (this.#authority === authority) this.#authority = EMPTY_AUTHORITY;
  }
}

function disposeAdmissionResources(
  authority: Readonly<AdmissionAuthority | TransferringAuthority>
): unknown[] {
  const failures: unknown[] = [];
  try { authority.ownedDeadline?.dispose(); }
  catch (error) { failures.push(error); }
  try { authority.decoders?.dispose(); }
  catch (error) { failures.push(error); }
  try { authority.renderer?.dispose(); }
  catch (error) { failures.push(error); }
  return failures;
}
