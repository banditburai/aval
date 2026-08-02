import type {
  AvalAdapterCommands,
  AvalAdapterOptions,
  AvalAdapterStatus,
  AvalSources as AdapterAvalSources
} from "@pixel-point/aval-element/adapter";
import type { Readable } from "svelte/store";
import type { HTMLAttributes } from "svelte/elements";

export type AvalSources = AdapterAvalSources;

export type CreateAvalOptions = AvalAdapterOptions;

export type AvalSvelteStatus = AvalAdapterStatus;

export type AvalBindingTarget = Element | null;

export type AvalSvelteInstance =
  Readable<Readonly<AvalSvelteStatus>> & Readonly<AvalAdapterCommands>;

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
