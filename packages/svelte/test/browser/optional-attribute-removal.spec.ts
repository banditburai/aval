import { expect, test } from "@playwright/test";

test("clears optional AVAL attributes after early registration without remounting", async ({
  page
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/");

  const player = page.getByTestId("player");
  for (const [attribute, value] of Object.entries({
    state: "idle",
    motion: "full",
    fit: "contain",
    crossorigin: "anonymous",
    width: "160",
    height: "90",
    autoplay: "manual",
    bindings: "none"
  })) await expect(player).toHaveAttribute(attribute, value);
  const initialPlayer = await player.elementHandle();
  if (initialPlayer === null) throw new Error("Expected an AVAL player host");

  await page.getByRole("button", { name: "Clear optional attributes" }).click();
  for (const attribute of [
    "state",
    "motion",
    "fit",
    "crossorigin",
    "width",
    "height"
  ]) {
    await expect(player).not.toHaveAttribute(attribute);
  }
  await expect(player).toHaveAttribute("autoplay", "manual");
  await expect(player).toHaveAttribute("bindings", "none");
  expect(await player.evaluate(
    (node, initial) => node === initial,
    initialPlayer
  )).toBe(true);
  await initialPlayer.dispose();
  expect(errors).toEqual([]);
});

test("reuses one controller across an explicit unmount and remount", async ({
  page
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/");

  const player = page.getByTestId("player");
  const initialPlayer = await player.elementHandle();
  if (initialPlayer === null) throw new Error("Expected an AVAL player host");

  await page.getByRole("button", { name: "Unmount player" }).click();
  await expect(player).toHaveCount(0);
  await page.getByRole("button", { name: "Inspect controller" }).click();
  await expect(page.getByTestId("controller-probe")).toHaveText("detached");
  await page.getByRole("button", { name: "Remount player" }).click();
  await expect(player).toHaveAttribute("autoplay", "manual");
  await expect(player).toHaveAttribute("bindings", "none");
  expect(await player.evaluate(
    (node, initial) => node !== initial,
    initialPlayer
  )).toBe(true);
  await expect(page.getByTestId("controller-readiness")).not.toBeEmpty();
  await page.getByRole("button", { name: "Inspect controller" }).click();
  await expect(page.getByTestId("controller-probe")).toHaveText("attached");

  await initialPlayer.dispose();
  expect(errors).toEqual([]);
});

test("catches an initial invalid state after early registration", async ({
  page
}) => {
  await page.goto("/");

  await expect(page.getByTestId("invalid-configuration-errors")).toHaveText(
    "1"
  );
  await expect(page.getByTestId("invalid-player")).toHaveAttribute(
    "state",
    "not an authored identifier"
  );
});
