import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";

import { chromium } from "@playwright/test";

const projectDirectory = fileURLToPath(new URL("..", import.meta.url));
const expectedIdleFrames = Array.from({ length: 36 }, (_, index) => index);
const expectedActiveFrames = Array.from({ length: 33 }, (_, index) => index);

async function freePort() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert(address !== null && typeof address !== "string");
  const { port } = address;
  await new Promise((resolve, reject) => {
    server.close((error) => error === undefined ? resolve() : reject(error));
  });
  return port;
}

async function waitForServer(url, process) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (process.exitCode !== null) {
      throw new Error(`Vite exited before becoming ready (${process.exitCode}).`);
    }
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      // The server is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for ${url}.`);
}

async function stopProcess(process) {
  if (process.exitCode !== null) return;
  process.kill("SIGTERM");
  await Promise.race([
    new Promise((resolve) => process.once("exit", resolve)),
    new Promise((resolve) => setTimeout(resolve, 2_000))
  ]);
}

function latestPresentationScript(player) {
  const trace = player.getDiagnostics({ trace: true }).runtimeTrace ?? [];
  return [...trace]
    .reverse()
    .find((record) => record.graph?.presentation !== undefined)
    ?.graph?.presentation ?? null;
}

async function waitForPresentation(page, unitId, frameIndex) {
  await page.waitForFunction(
    ({ expectedUnit, expectedFrame }) => {
      const player = document.querySelector("aval-player");
      if (player === null) return false;
      const trace = player.getDiagnostics({ trace: true }).runtimeTrace ?? [];
      const presentation = [...trace]
        .reverse()
        .find((record) => record.graph?.presentation !== undefined)
        ?.graph?.presentation;
      return presentation?.unitId === expectedUnit &&
        presentation.frameIndex === expectedFrame;
    },
    { expectedUnit: unitId, expectedFrame: frameIndex },
    { polling: "raf", timeout: 6_000 }
  );
}

async function captureFrame(page, player, unitId, frameIndex) {
  await player.evaluate((element, target) => new Promise((resolve, reject) => {
    const deadline = performance.now() + 6_000;
    const pauseAtTarget = () => {
      const trace = element.getDiagnostics({ trace: true }).runtimeTrace ?? [];
      const presentation = [...trace]
        .reverse()
        .find((record) => record.graph?.presentation !== undefined)
        ?.graph?.presentation;
      if (
        presentation?.unitId === target.unitId &&
        presentation.frameIndex === target.frameIndex
      ) {
        element.pause();
        resolve();
        return;
      }
      if (performance.now() >= deadline) {
        reject(new Error(
          `Timed out waiting for ${target.unitId}:${target.frameIndex}.`
        ));
        return;
      }
      requestAnimationFrame(pauseAtTarget);
    };
    pauseAtTarget();
  }), { unitId, frameIndex });
  const presentation = await player.evaluate(latestPresentationScript);
  assert.equal(presentation?.unitId, unitId);
  assert.equal(presentation?.frameIndex, frameIndex);
  const screenshot = await player.screenshot();
  await player.evaluate(async (element) => element.resume());
  return screenshot;
}

async function comparePngs(page, first, second) {
  return page.evaluate(async ({ firstPng, secondPng }) => {
    async function pixels(base64) {
      const bytes = Uint8Array.from(atob(base64), (character) =>
        character.charCodeAt(0)
      );
      const bitmap = await createImageBitmap(new Blob([bytes], {
        type: "image/png"
      }));
      const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
      const context = canvas.getContext("2d", { willReadFrequently: true });
      if (context === null) throw new Error("2D canvas is unavailable.");
      context.drawImage(bitmap, 0, 0);
      return {
        data: context.getImageData(0, 0, bitmap.width, bitmap.height).data,
        width: bitmap.width
      };
    }

    const a = await pixels(firstPng);
    const b = await pixels(secondPng);
    if (a.data.length !== b.data.length) {
      throw new Error("Screenshot dimensions do not match.");
    }

    let squaredDifference = 0;
    let comparedChannels = 0;
    for (let index = 0; index < a.data.length; index += 4) {
      for (let channel = 0; channel < 3; channel += 1) {
        const difference = a.data[index + channel] - b.data[index + channel];
        squaredDifference += difference * difference;
        comparedChannels += 1;
      }
    }

    return {
      cornerRgb: Array.from(a.data.slice(0, 3)),
      rms: Math.sqrt(squaredDifference / comparedChannels)
    };
  }, {
    firstPng: first.toString("base64"),
    secondPng: second.toString("base64")
  });
}

const port = await freePort();
const url = `http://127.0.0.1:${port}/`;
const vite = spawn(
  "npm",
  ["run", "dev", "--", "--host", "127.0.0.1", "--port", String(port), "--strictPort"],
  {
    cwd: projectDirectory,
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"]
  }
);
let browser;

try {
  await waitForServer(url, vite);
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({
    viewport: { width: 1440, height: 900 }
  });
  const consoleErrors = [];
  const pageErrors = [];
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });
  page.on("pageerror", (error) => pageErrors.push(error.message));

  await page.goto(url, { waitUntil: "networkidle" });
  await page.waitForFunction(
    () => document.querySelector("aval-player")?.readiness ===
      "interactiveReady",
    undefined,
    { timeout: 30_000 }
  );
  await page.locator("input[type=color]").fill("#7c3aed");

  const player = page.locator("aval-player");
  const idleFrame0 = await captureFrame(page, player, "idle.body", 0);
  const idleTraceStart = await player.evaluate((element) =>
    element.getDiagnostics({ trace: true }).runtimeTrace?.at(-1)?.index ?? -1
  );
  const idleFrame35 = await captureFrame(page, player, "idle.body", 35);

  await waitForPresentation(page, "idle.body", 12);
  const clickTraceStart = await player.evaluate((element) =>
    element.getDiagnostics({ trace: true }).runtimeTrace?.at(-1)?.index ?? -1
  );
  await page.getByRole("button", { name: "Activate" }).click();
  await page.waitForFunction(() => {
    const element = document.querySelector("aval-player");
    return element?.requestedState === "active" &&
      element.visualState === "idle";
  });
  const queuedButton = await page.getByRole("button").evaluate((button) => ({
    disabled: button.disabled,
    text: button.textContent
  }));
  const activeFrame15 = await captureFrame(page, player, "active.body", 15);
  await waitForPresentation(page, "active.body", 32);
  await page.waitForFunction(
    () => document.querySelector("aval-player")?.visualState === "idle",
    undefined,
    { timeout: 5_000 }
  );

  const trace = await player.evaluate((element) =>
    element.getDiagnostics({ trace: true }).runtimeTrace ?? []
  );
  const idleFrames = [...new Set(trace
    .filter((record) => record.index >= idleTraceStart)
    .map((record) => record.media?.frame)
    .filter((frame) => frame?.unit === "idle.body")
    .map((frame) => frame.localFrame))]
    .slice(0, 36);
  const activeFrames = [...new Set(trace
    .filter((record) => record.index > clickTraceStart)
    .map((record) => record.media?.frame)
    .filter((frame) => frame?.unit === "active.body")
    .map((frame) => frame.localFrame))];
  const postClickFrames = trace
    .filter((record) => record.index > clickTraceStart)
    .map((record) => record.media?.frame)
    .filter((frame) => frame !== undefined);
  const firstActiveIndex = postClickFrames.findIndex((frame) =>
    frame.unit === "active.body"
  );
  const queuedIdleFrames = postClickFrames
    .slice(0, firstActiveIndex)
    .filter((frame) => frame.unit === "idle.body")
    .map((frame) => frame.localFrame);

  const idleComparison = await comparePngs(page, idleFrame0, idleFrame35);
  const activeComparison = await comparePngs(page, idleFrame0, activeFrame15);
  const diagnostics = await player.evaluate((element) =>
    element.getDiagnostics()
  );

  assert.deepEqual(idleFrames, expectedIdleFrames,
    "Idle did not present local frames 0 through 35 in order.");
  assert.deepEqual(activeFrames, expectedActiveFrames,
    "Active did not present local frames 0 through 32 in order.");
  assert(queuedIdleFrames.length > 0,
    "Activation did not wait for the idle loop boundary.");
  assert.equal(queuedIdleFrames.at(-1), 35,
    "Activation did not leave idle at local frame 35.");
  assert.equal(postClickFrames[firstActiveIndex]?.localFrame, 0,
    "Active did not enter at local frame 0.");
  assert.deepEqual(queuedButton, { disabled: true, text: "Queued" });
  assert(
    idleComparison.rms < 12,
    `Idle frame 35 does not loop smoothly to frame 0 (RMS ${idleComparison.rms.toFixed(2)}).`
  );
  assert(
    activeComparison.rms > 30,
    `Active frame 15 is not visually distinct (RMS ${activeComparison.rms.toFixed(2)}).`
  );
  assert.deepEqual(
    idleComparison.cornerRgb,
    [124, 58, 237],
    "The selected purple background is not visible through transparent pixels."
  );
  assert.equal(diagnostics.visualState, "idle");
  assert.equal(diagnostics.lastFailure, null);
  assert.deepEqual(consoleErrors, []);
  assert.deepEqual(pageErrors, []);
  assert(
    diagnostics.counters.underflow <= 1,
    `Activation held for ${diagnostics.counters.underflow} ticks.`
  );

  console.log(JSON.stringify({
    activeDisplacementRms: activeComparison.rms,
    activeFrames,
    backgroundCornerRgb: idleComparison.cornerRgb,
    idleFrames,
    idleSeamRms: idleComparison.rms,
    queuedIdleFrames,
    selectedBitDepth: diagnostics.runtime?.selectedBitDepth,
    selectedCodec: diagnostics.runtime?.selectedCodec,
    underflows: diagnostics.counters.underflow,
    status: "passed"
  }, null, 2));
} finally {
  await browser?.close();
  await stopProcess(vite);
}
