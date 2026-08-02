import type {
  AvalAdapterOptions,
  AvalAdapterStatus,
  AvalSources as AdapterAvalSources
} from "@pixel-point/aval-element/adapter";
import type {
  AvalDiagnostics,
  AvalPrepareOptions,
  RuntimeReadinessResult
} from "@pixel-point/aval-element";
import type { Readable } from "svelte/store";
import type { HTMLAttributes } from "svelte/elements";

export type AvalSources = AdapterAvalSources;

export type CreateAvalOptions = AvalAdapterOptions;

export type AvalSvelteStatus = AvalAdapterStatus;

export type AvalBindingTarget = Element | null;

export interface AvalSvelteInstance
  extends Readable<Readonly<AvalSvelteStatus>> {
  prepare(
    options?: Readonly<AvalPrepareOptions>
  ): Promise<RuntimeReadinessResult>;
  setState(name: string): Promise<void>;
  send(event: string): boolean;
  readyFor(state: string): boolean;
  play(): Promise<void>;
  pause(): void;
  getDiagnostics(
    options?: Readonly<{ readonly trace?: boolean }>
  ): Readonly<AvalDiagnostics> | null;
}

export interface AvalComponentProps
  extends Omit<
    HTMLAttributes<HTMLElement>,
    "children" | "height" | "width"
  > {
  readonly aval: AvalSvelteInstance;
  readonly bindTo?: AvalBindingTarget | undefined;
  readonly width?: number | undefined;
  readonly height?: number | undefined;
}
