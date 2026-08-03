import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";

import { chromium } from "@playwright/test";

const projectDirectory = fileURLToPath(new URL("..", import.meta.url));
const background = "#7c3aed";

const scenarios = Object.freeze([
  scenario("idle.12", "active.12", 2, true),
  scenario("idle.12", "active.12", 11, false),
  scenario("idle.24", "active.24", 2, true),
  scenario("idle.24", "active.24", 11, false),
  scenario("idle.36", "active.36", 2, true),
  scenario("idle.36", "active.36", 11, false)
]);

function scenario(idleState, activeState, triggerFrame, capturePixels) {
  const suffix = idleState.slice("idle.".length);
  const nextSuffix = suffix === "12" ? "24" : suffix === "24" ? "36" : "12";
  return Object.freeze({
    activeFrames: suffix === "36" ? 28 : 36,
    activeState,
    activeUnit: `${activeState}.body`,
    capturePixels,
    idleState,
    idleUnit: `${idleState}.body`,
    nextIdleState: `idle.${nextSuffix}`,
    nextIdleUnit: `idle.${nextSuffix}.body`,
    triggerFrame
  });
}

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

async function pauseAt(player, unitId, frameIndex, afterIndex = -1) {
  return player.evaluate((element, target) => new Promise((resolve, reject) => {
    const deadline = performance.now() + 10_000;
    const inspect = () => {
      const trace = element.getDiagnostics({ trace: true }).runtimeTrace ?? [];
      const record = [...trace].reverse().find((candidate) =>
        candidate.kind === "content-tick"
      );
      if (
        record !== undefined &&
        record.index > target.afterIndex &&
        record.graph?.presentation?.unitId === target.unitId &&
        record.graph.presentation.frameIndex === target.frameIndex &&
        record.scheduler.displayedCursor?.unit === target.unitId &&
        record.scheduler.displayedCursor.localFrame === target.frameIndex
      ) {
        element.pause();
        resolve({
          index: record.index,
          presentationOrdinal: record.presentationOrdinal,
          unitInstance: record.scheduler.displayedCursor?.unitInstance ?? null
        });
        return;
      }
      if (performance.now() >= deadline) {
        reject(new Error(
          `Timed out waiting for ${target.unitId}:${String(target.frameIndex)}.`
        ));
        return;
      }
      requestAnimationFrame(inspect);
    };
    inspect();
  }), { afterIndex, unitId, frameIndex });
}

async function resume(player) {
  await player.evaluate(async (element) => element.resume());
}

async function captureAt(player, unitId, frameIndex, afterIndex = -1) {
  await pauseAt(player, unitId, frameIndex, afterIndex);
  return player.screenshot();
}

async function pngComparison(page, first, second) {
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
      return context.getImageData(0, 0, bitmap.width, bitmap.height).data;
    }

    const a = await pixels(firstPng);
    const b = await pixels(secondPng);
    if (a.length !== b.length) throw new Error("Screenshot sizes differ.");
    let squaredDifference = 0;
    let comparedChannels = 0;
    for (let index = 0; index < a.length; index += 4) {
      for (let channel = 0; channel < 3; channel += 1) {
        const difference = a[index + channel] - b[index + channel];
        squaredDifference += difference * difference;
        comparedChannels += 1;
      }
    }
    return {
      cornerRgb: Array.from(a.slice(0, 3)),
      rms: Math.sqrt(squaredDifference / comparedChannels)
    };
  }, {
    firstPng: first.toString("base64"),
    secondPng: second.toString("base64")
  });
}

function frameRecords(trace, afterIndex) {
  return trace.filter((record) =>
    record.index > afterIndex &&
    record.kind === "content-tick" &&
    record.media?.kind === "frame" &&
    typeof record.media.frame?.unit === "string" &&
    Number.isSafeInteger(record.media.frame?.localFrame)
  );
}

function localFrames(records, unit) {
  return records
    .filter((record) => record.media.frame.unit === unit)
    .map((record) => record.media.frame.localFrame);
}

function integerRange(length, start = 0) {
  return Array.from({ length }, (_, index) => start + index);
}

function assertOrdinals(records, label) {
  const ordinals = records.map((record) => {
    assert.notEqual(record.presentationOrdinal, null, `${label} lacks an ordinal.`);
    return BigInt(record.presentationOrdinal);
  });
  for (let index = 1; index < ordinals.length; index += 1) {
    assert.equal(
      ordinals[index],
      ordinals[index - 1] + 1n,
      `${label} content ordinals are not consecutive.`
    );
  }
}

function assertOneUnitInstance(records, label) {
  const instances = records.map((record) =>
    record.scheduler.displayedCursor?.unitInstance ?? null
  );
  assert(instances.length > 0, `${label} has no displayed records.`);
  assert.notEqual(instances[0], null, `${label} has no unit instance.`);
  for (const instance of instances) {
    assert.equal(instance, instances[0], `${label} changed unit instance.`);
  }
}

async function runScenario(browser, url, input) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const consoleErrors = [];
  const pageErrors = [];
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });
  page.on("pageerror", (error) => pageErrors.push(error.message));

  try {
    await page.goto(url, { waitUntil: "networkidle" });
    await page.waitForFunction(
      () => document.querySelector("aval-player")?.readiness ===
        "interactiveReady",
      undefined,
      { timeout: 30_000 }
    );
    await page.locator("input[type=color]").fill(background);

    const player = page.locator("aval-player");
    const trigger = await pauseAt(player, input.idleUnit, input.triggerFrame);
    const boundaryPng = input.capturePixels ? await player.screenshot() : null;
    const before = await player.evaluate((element) => element.getDiagnostics({
      trace: true
    }));
    assert.equal(before.visualState, input.idleState);
    assert.equal(before.paused, true);
    assert.equal(
      before.counters.underflow,
      0,
      `${input.idleState} underflowed before activation.`
    );
    assert.equal(await page.getByRole("button").isEnabled(), true);

    await page.getByRole("button", { name: "Activate" }).click();
    await page.waitForFunction((target) => {
      const element = document.querySelector("aval-player");
      return element?.requestedState === target &&
        element.visualState?.startsWith("idle.") === true;
    }, input.activeState);
    assert.deepEqual(
      await page.getByRole("button").evaluate((button) => ({
        disabled: button.disabled,
        text: button.textContent
      })),
      { disabled: true, text: "Queued" }
    );

    await resume(player);

    let activeFirstPng = null;
    let activeLastPng = null;
    let nextIdleFirstPng = null;
    if (input.capturePixels) {
      activeFirstPng = await captureAt(
        player,
        input.activeUnit,
        0,
        trigger.index
      );
      await resume(player);
      activeLastPng = await captureAt(
        player,
        input.activeUnit,
        input.activeFrames - 1
      );
      await resume(player);
      nextIdleFirstPng = await captureAt(
        player,
        input.nextIdleUnit,
        0,
        trigger.index
      );
      await resume(player);
    }
    await pauseAt(player, input.nextIdleUnit, 1, trigger.index);

    const diagnostics = await player.evaluate((element) =>
      element.getDiagnostics({ trace: true })
    );
    const trace = diagnostics.runtimeTrace ?? [];
    const records = frameRecords(trace, trigger.index);
    const firstActiveIndex = records.findIndex((record) =>
      record.media.frame.unit === input.activeUnit
    );
    assert(firstActiveIndex >= 0, `${input.activeState} never started.`);

    const beforeActive = records.slice(0, firstActiveIndex);
    assert(
      beforeActive.every((record) => record.media.frame.unit === input.idleUnit),
      `${input.activeState} entered another idle phase before activation.`
    );
    const expectedIdle = input.triggerFrame === 11
      ? []
      : integerRange(11 - input.triggerFrame, input.triggerFrame + 1);
    assert.deepEqual(
      localFrames(beforeActive, input.idleUnit),
      expectedIdle,
      `${input.activeState} did not leave at its safety boundary.`
    );

    const activeRecords = records.filter((record) =>
      record.media.frame.unit === input.activeUnit
    );
    assert.deepEqual(
      localFrames(activeRecords, input.activeUnit),
      integerRange(input.activeFrames),
      `${input.activeState} did not present every active frame exactly once.`
    );
    assertOrdinals(activeRecords, input.activeState);
    assertOneUnitInstance(activeRecords, input.activeState);

    const firstActive = activeRecords[0];
    assert.equal(firstActive.routeReady, true);
    assert.equal(firstActive.selectedBoundary, "finish");
    assert.equal(firstActive.graph?.presentation?.state, input.activeState);
    assert.equal(firstActive.graph?.presentation?.frameIndex, 0);
    assert.equal(firstActive.scheduler.displayedCursor?.unit, input.activeUnit);
    assert.equal(firstActive.scheduler.displayedCursor?.localFrame, 0);

    const nextIdleRecords = records.filter((record) =>
      record.media.frame.unit === input.nextIdleUnit
    );
    assert.deepEqual(
      localFrames(nextIdleRecords, input.nextIdleUnit),
      [0, 1],
      `${input.activeState} did not resume the correct idle phase.`
    );

    const activeLastRecord = activeRecords.at(-1);
    const nextIdleFirst = nextIdleRecords[0];
    assert(activeLastRecord.index < nextIdleFirst.index);
    assert.equal(
      records.indexOf(nextIdleFirst),
      records.indexOf(activeLastRecord) + 1,
      `${input.activeState} inserted a content frame before the idle return.`
    );
    assert.notEqual(activeLastRecord.presentationOrdinal, null);
    assert.notEqual(nextIdleFirst.presentationOrdinal, null);
    assert.equal(
      BigInt(nextIdleFirst.presentationOrdinal),
      BigInt(activeLastRecord.presentationOrdinal) + 1n,
      `${input.activeState} did not return on the next content ordinal.`
    );
    assert.notEqual(
      activeLastRecord.scheduler.displayedCursor?.unitInstance,
      nextIdleFirst.scheduler.displayedCursor?.unitInstance
    );

    assert.equal(diagnostics.visualState, input.nextIdleState);
    assert.equal(diagnostics.requestedState, input.nextIdleState);
    assert.equal(diagnostics.lastFailure, null);
    assert.equal(diagnostics.runtime?.selectedBitDepth, 8);
    assert.match(diagnostics.runtime?.selectedCodec ?? "", /^vp09\./);
    assert.equal(
      diagnostics.counters.underflow,
      before.counters.underflow,
      `${input.activeState} introduced an underflow.`
    );
    assert.deepEqual(consoleErrors, []);
    assert.deepEqual(pageErrors, []);
    assert.deepEqual(
      await page.getByRole("button").evaluate((button) => ({
        disabled: button.disabled,
        text: button.textContent
      })),
      { disabled: false, text: "Activate" }
    );

    let pixels = null;
    if (
      boundaryPng !== null && activeFirstPng !== null &&
      activeLastPng !== null && nextIdleFirstPng !== null
    ) {
      const departure = await pngComparison(page, boundaryPng, activeFirstPng);
      const arrival = await pngComparison(page, activeLastPng, nextIdleFirstPng);
      assert.deepEqual(departure.cornerRgb, [124, 58, 237]);
      assert(
        departure.rms < 15,
        `${input.activeState} departure is discontinuous (RMS ${departure.rms.toFixed(2)}).`
      );
      if (input.activeState === "active.36") {
        assert(
          arrival.rms > 10,
          `The approved active.36 source jump was not preserved (RMS ${arrival.rms.toFixed(2)}).`
        );
      } else {
        assert(
          arrival.rms < 15,
          `${input.activeState} return is discontinuous (RMS ${arrival.rms.toFixed(2)}).`
        );
      }
      pixels = {
        arrivalRms: arrival.rms,
        backgroundCornerRgb: departure.cornerRgb,
        departureRms: departure.rms
      };
    }

    return {
      activeFrames: localFrames(activeRecords, input.activeUnit),
      activeState: input.activeState,
      nextIdleState: input.nextIdleState,
      pixels,
      queuedIdleFrames: localFrames(beforeActive, input.idleUnit),
      selectedBitDepth: diagnostics.runtime?.selectedBitDepth,
      selectedCodec: diagnostics.runtime?.selectedCodec,
      triggerFrame: input.triggerFrame,
      underflowDelta: diagnostics.counters.underflow - before.counters.underflow
    };
  } finally {
    await page.close();
  }
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
  const results = [];
  for (const input of scenarios) {
    results.push(await runScenario(browser, url, input));
  }
  console.log(JSON.stringify({ results, status: "passed" }, null, 2));
} finally {
  await browser?.close();
  await stopProcess(vite);
}
