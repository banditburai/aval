import {
  createAvalAdapterBinding,
  createAvalAdapterConfiguration,
  type AvalAdapterBinding,
  type AvalAdapterCallbacks,
  type AvalAdapterCommands,
  type AvalAdapterConfiguration,
  type AvalAdapterController,
  type AvalAdapterOptions,
  type AvalAdapterRenderOptions,
  type AvalAdapterStatus,
  type AvalSources
} from "@pixel-point/aval-element/adapter";

// @ts-expect-error element event details belong to the element root
import type { AvalErrorDetail } from "@pixel-point/aval-element/adapter";
// @ts-expect-error decoder diagnostics belong to the element root
import type { AvalDecoderDiagnostic } from "@pixel-point/aval-element/adapter";
// @ts-expect-error normalized source descriptors stay structural
import type { AvalAdapterSource } from "@pixel-point/aval-element/adapter";

const sources = {
  h264: "/motion/h264.avl"
} satisfies AvalSources;
const options: AvalAdapterOptions = { sources };
const configuration: Readonly<AvalAdapterConfiguration> =
  createAvalAdapterConfiguration(options);
const callbacks: Readonly<AvalAdapterCallbacks> = configuration.callbacks;
const render: Readonly<AvalAdapterRenderOptions> = configuration.render;
const autoplay: "visible" | "manual" = render.autoplay;
const bindings: "auto" | "none" = render.bindings;
const binding: AvalAdapterBinding = createAvalAdapterBinding(configuration);
const commands: Readonly<AvalAdapterCommands> = binding.commands;

declare const controller: AvalAdapterController;
const status: Readonly<AvalAdapterStatus> = controller;
const controllerCommands: Readonly<AvalAdapterCommands> = controller;

void [
  callbacks,
  render,
  autoplay,
  bindings,
  commands,
  status,
  controllerCommands
];
