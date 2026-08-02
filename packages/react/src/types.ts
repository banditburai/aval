import type {
  AvalAdapterController,
  AvalAdapterOptions,
  AvalSources as AdapterAvalSources
} from "@pixel-point/aval-element/adapter";
import type {
  ComponentType,
  HTMLAttributes,
  RefObject
} from "react";

export type AvalSources = AdapterAvalSources;

export type UseAvalOptions = AvalAdapterOptions;

export type AvalBindingTarget =
  | Element
  | RefObject<Element | null>
  | null;

export interface AvalComponentProps
  extends Omit<
    HTMLAttributes<HTMLElement>,
    "children" | "dangerouslySetInnerHTML"
  > {
  readonly width?: number;
  readonly height?: number;
  readonly bindTo?: AvalBindingTarget;
}

export type AvalReactInstance = AvalAdapterController;

export interface UseAvalResult {
  readonly aval: AvalReactInstance;
  readonly AvalComponent: ComponentType<AvalComponentProps>;
}
