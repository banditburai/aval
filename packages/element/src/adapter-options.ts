import type {
  AvalCrossOrigin,
  AvalErrorDetail,
  AvalFit,
  AvalMotion,
  AvalRequestedStateChangeDetail,
  AvalSourceCodec,
  AvalTransitionDetail,
  AvalVisualStateChangeDetail,
  RuntimeReadinessResult
} from "./public-types.js";
import { SOURCE_CODEC_PRIORITY } from "./source-codec-policy.js";

export type AvalSources = Readonly<{
  readonly av1?: string;
  readonly vp9?: string;
  readonly h265?: string;
  readonly h264?: string;
}> & (
  | Readonly<{ readonly av1: string }>
  | Readonly<{ readonly vp9: string }>
  | Readonly<{ readonly h265: string }>
  | Readonly<{ readonly h264: string }>
);

export interface AvalAdapterOptions {
  readonly sources: AvalSources;
  readonly state?: string;
  readonly autoplay?: boolean;
  readonly autoBind?: boolean;
  readonly motion?: AvalMotion;
  readonly fit?: AvalFit;
  readonly crossOrigin?: AvalCrossOrigin;
  readonly onReady?: (
    result: Readonly<RuntimeReadinessResult>
  ) => void;
  readonly onRequestedStateChange?: (
    detail: Readonly<AvalRequestedStateChangeDetail>
  ) => void;
  readonly onVisualStateChange?: (
    detail: Readonly<AvalVisualStateChangeDetail>
  ) => void;
  readonly onTransitionStart?: (
    detail: Readonly<AvalTransitionDetail>
  ) => void;
  readonly onTransitionEnd?: (
    detail: Readonly<AvalTransitionDetail>
  ) => void;
  readonly onError?: (detail: Readonly<AvalErrorDetail>) => void;
}

export interface AvalAdapterCallbacks {
  readonly onReady: AvalAdapterOptions["onReady"];
  readonly onRequestedStateChange: AvalAdapterOptions["onRequestedStateChange"];
  readonly onVisualStateChange: AvalAdapterOptions["onVisualStateChange"];
  readonly onTransitionStart: AvalAdapterOptions["onTransitionStart"];
  readonly onTransitionEnd: AvalAdapterOptions["onTransitionEnd"];
  readonly onError: AvalAdapterOptions["onError"];
}

export interface AvalAdapterSource {
  readonly codec: AvalSourceCodec;
  readonly src: string;
}

export interface AvalAdapterRenderOptions {
  readonly sources: readonly Readonly<AvalAdapterSource>[];
  readonly sourceKey: string;
  readonly state: string | undefined;
  readonly autoplay: boolean;
  readonly autoBind: boolean;
  readonly motion: AvalMotion | undefined;
  readonly fit: AvalFit | undefined;
  readonly crossOrigin: AvalCrossOrigin | undefined;
}

export interface AvalAdapterConfiguration {
  readonly render: Readonly<AvalAdapterRenderOptions>;
  readonly callbacks: Readonly<AvalAdapterCallbacks>;
}

const SOURCE_CODEC_SET = new Set<string>(SOURCE_CODEC_PRIORITY);

export function normalizeAvalSources(
  sources: AvalSources
): readonly Readonly<AvalAdapterSource>[] {
  if (sources === null || typeof sources !== "object" || Array.isArray(sources)) {
    throw new TypeError("AVAL adapter sources must be a codec-keyed object");
  }
  for (const key of Reflect.ownKeys(sources)) {
    if (typeof key !== "string" || !SOURCE_CODEC_SET.has(key)) {
      throw new TypeError(
        `AVAL adapter source codec is unsupported: ${String(key)}`
      );
    }
  }

  const normalized: AvalAdapterSource[] = [];
  for (const codec of SOURCE_CODEC_PRIORITY) {
    if (!Object.prototype.hasOwnProperty.call(sources, codec)) continue;
    const value = sources[codec];
    if (typeof value !== "string" || value.trim().length === 0) {
      throw new TypeError(
        `AVAL adapter ${codec} source must be a non-empty URL string`
      );
    }
    normalized.push(Object.freeze({ codec, src: value }));
  }
  if (normalized.length === 0) {
    throw new TypeError(
      "AVAL adapter sources must include at least one codec URL"
    );
  }
  return Object.freeze(normalized);
}

export function createAvalAdapterConfiguration(
  options: Readonly<AvalAdapterOptions>
): Readonly<AvalAdapterConfiguration> {
  if (options === null || typeof options !== "object") {
    throw new TypeError("AVAL adapter options must be an object");
  }
  const sources = normalizeAvalSources(options.sources);
  if (options.autoplay !== undefined && typeof options.autoplay !== "boolean") {
    throw new TypeError("AVAL adapter autoplay must be a boolean");
  }
  if (options.autoBind !== undefined && typeof options.autoBind !== "boolean") {
    throw new TypeError("AVAL adapter autoBind must be a boolean");
  }

  const render: Readonly<AvalAdapterRenderOptions> = Object.freeze({
    sources,
    sourceKey: JSON.stringify(sources.map(({ codec, src }) => [codec, src])),
    state: options.state,
    autoplay: options.autoplay ?? true,
    autoBind: options.autoBind ?? true,
    motion: options.motion,
    fit: options.fit,
    crossOrigin: options.crossOrigin
  });
  const callbacks: Readonly<AvalAdapterCallbacks> = Object.freeze({
    onReady: options.onReady,
    onRequestedStateChange: options.onRequestedStateChange,
    onVisualStateChange: options.onVisualStateChange,
    onTransitionStart: options.onTransitionStart,
    onTransitionEnd: options.onTransitionEnd,
    onError: options.onError
  });
  return Object.freeze({ render, callbacks });
}

export function sameAvalRenderOptions(
  left: Readonly<AvalAdapterRenderOptions>,
  right: Readonly<AvalAdapterRenderOptions>
): boolean {
  return left.sourceKey === right.sourceKey &&
    left.state === right.state &&
    left.autoplay === right.autoplay &&
    left.autoBind === right.autoBind &&
    left.motion === right.motion &&
    left.fit === right.fit &&
    left.crossOrigin === right.crossOrigin;
}
