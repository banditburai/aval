import { defineAvalElement, type AvalElement } from "@pixel-point/aval-element";
import type {
  AvalAdapterController,
  AvalAdapterOptions
} from "@pixel-point/aval-element/adapter";
import {
  useAval,
  type AvalReactInstance,
  type AvalSources,
  type UseAvalOptions
} from "@pixel-point/aval-react";

defineAvalElement();
const motion = document.querySelector<AvalElement>("aval-player");
if (motion !== null) {
  motion.state = "success";
  void motion.prepare({ timeoutMs: 5_000 });
  motion.addEventListener("visualstatechange", (event) => {
    event.detail.to satisfies string;
    // @ts-expect-error event detail is immutable.
    event.detail.to = "other";
  });
}
const hook: typeof useAval = useAval;
const sources: AvalSources = { h264: "/motion.avl" };
const reactOptions: UseAvalOptions = { sources };
const sharedOptions: AvalAdapterOptions = reactOptions;

function exerciseReactController(
  controller: AvalReactInstance
): AvalAdapterController {
  void controller.prepare();
  controller.pause();
  return controller;
}

void [hook, sharedOptions, exerciseReactController];
