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
    height: "90"
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
  expect(await player.evaluate(
    (node, initial) => node === initial,
    initialPlayer
  )).toBe(true);
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
