import { test } from "node:test";
import assert from "node:assert/strict";
import { friendlyLaunchError, isMailUrl } from "../pw/run";

test("missing browser downloads are classified with the install hint", () => {
  const message = [
    "browserType.launchPersistentContext: Executable doesn't exist at /…/chromium-1234/chrome-mac/Chromium.app/Contents/MacOS/Chromium",
    "Please run the following command to download new browsers:",
    "    npx playwright install",
  ].join("\n");
  const hint = friendlyLaunchError(new Error(message));
  assert.ok(hint?.includes("npx playwright install chromium"));
});

test("a locked or half-released profile is classified, not masked as a download", () => {
  for (const message of [
    "browserType.launchPersistentContext: Browser closed unexpectedly",
    "browserType.launchPersistentContext: Target page, context or browser has been closed",
    "The user data directory is already in use",
  ]) {
    const hint = friendlyLaunchError(new Error(message));
    assert.ok(hint?.includes("уже используется"), message);
    assert.ok(!hint?.includes("npx playwright"), message);
  }
});

test("unknown launch errors stay unclassified so the original text is shown", () => {
  assert.equal(
    friendlyLaunchError(
      new Error("browserType.launchPersistentContext: Segfault"),
    ),
    undefined,
  );
});

test("isMailUrl accepts only yandex mail URLs", () => {
  assert.equal(isMailUrl("https://mail.yandex.ru/inbox/"), true);
  assert.equal(isMailUrl("https://mail.yandex.com/#inbox"), true);
  assert.equal(isMailUrl("https://passport.yandex.ru/auth"), false);
  assert.equal(isMailUrl("https://yandex.ru/"), false);
  assert.equal(isMailUrl("https://mail.google.com/mail"), false);
});
