import "@pixel-point/aval-element/auto";
import type {
  AvalAdapterController,
  AvalAdapterOptions
} from "@pixel-point/aval-element/adapter";
import {
  useAval,
  type AvalReactInstance,
  type UseAvalOptions
} from "@pixel-point/aval-react";

if (customElements.get("aval-player") === undefined) {
  throw new Error("auto entry did not register the element");
}
if (typeof useAval !== "function") {
  throw new Error("React root has no useAval hook");
}

const reactOptions: UseAvalOptions = {
  sources: { h264: "/motion.avl" }
};
const sharedOptions: AvalAdapterOptions = reactOptions;
const optionsFromShared: UseAvalOptions = sharedOptions;

function exerciseReactController(
  controller: AvalReactInstance
): AvalAdapterController {
  controller.pause();
  void controller.readyFor("idle");
  return controller;
}

void [optionsFromShared, exerciseReactController];
