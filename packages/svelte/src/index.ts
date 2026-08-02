export { default as AvalComponent } from "./AvalComponent.svelte";
export { createAval } from "./controller.js";
export type {
  AvalBindingTarget,
  AvalComponentProps,
  AvalSources,
  AvalSvelteInstance,
  AvalSvelteStatus,
  CreateAvalOptions
} from "./types.js";
export type {
  AvalCrossOrigin,
  AvalDiagnostics,
  AvalErrorDetail,
  AvalFit,
  AvalMotion,
  AvalPrepareOptions,
  AvalRequestedStateChangeDetail,
  AvalTransitionDetail,
  AvalVisualStateChangeDetail,
  RuntimeReadiness,
  RuntimeReadinessResult
} from "@pixel-point/aval-element";
