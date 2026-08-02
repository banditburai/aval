import { mount } from "svelte";

import App from "./App.svelte";
import "./styles.css";

const target = document.querySelector<HTMLElement>("#app");

if (target === null) {
  throw new Error("Expected the Svelte application mount point");
}

mount(App, { target });
