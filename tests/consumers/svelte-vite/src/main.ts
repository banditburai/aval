import { mount } from "svelte";

import App from "./App.svelte";

const target = document.querySelector<HTMLElement>("#app");
if (target === null) throw new Error("Svelte consumer mount point is missing");
mount(App, { target });
