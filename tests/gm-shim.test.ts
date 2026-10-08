import { test } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { GM_STORAGE_PREFIX, gmShimSource, shouldActivate } from "../pw/gm-shim";

interface GmWindow {
  GM_getValue<T = unknown>(key: string, defaultValue?: T): T;
  GM_setValue(key: string, value: unknown): void;
  GM_deleteValue(key: string): void;
  GM_listValues(): string[];
  GM_registerMenuCommand(name: string, callback: () => void): void;
  GM_setClipboard(text: string): void;
  unsafeWindow: unknown;
  localStorage: Storage;
  navigator: { clipboard?: { writeText(text: string): Promise<void> } };
}

function installShim(url = "https://mail.yandex.ru/"): GmWindow {
  const dom = new JSDOM("<!doctype html><html><body></body></html>", {
    url,
    runScripts: "outside-only",
  });
  const w = dom.window as unknown as GmWindow & { eval(src: string): unknown };
  w.eval(gmShimSource);
  return w;
}

test("GM storage roundtrips JSON values and survives through GM_listValues", () => {
  const w = installShim();
  const profile = { fio: "Иванов Иван", email: "a@yandex.ru" };
  w.GM_setValue("return-pd:profile-v1", profile);
  // Cross-realm objects (jsdom) fail strict deepEqual on prototypes: compare
  // through JSON so only the persisted value shape is asserted.
  assert.deepEqual(
    JSON.parse(JSON.stringify(w.GM_getValue("return-pd:profile-v1"))),
    profile,
  );
  assert.deepEqual(Array.from(w.GM_listValues()), ["return-pd:profile-v1"]);
  w.GM_deleteValue("return-pd:profile-v1");
  assert.equal(w.GM_getValue("return-pd:profile-v1"), undefined);
  assert.deepEqual(Array.from(w.GM_listValues()), []);
});

test("GM_getValue returns the default for absent and corrupt entries", () => {
  const w = installShim();
  assert.equal(w.GM_getValue("absent"), undefined);
  assert.deepEqual(
    JSON.parse(JSON.stringify(w.GM_getValue("absent", { a: 1 }))),
    { a: 1 },
  );
  // Corrupted JSON must degrade to the default, never throw (NFR-003).
  w.localStorage.setItem(GM_STORAGE_PREFIX + "corrupt", "{oops");
  assert.equal(w.GM_getValue("corrupt"), undefined);
  assert.deepEqual(Array.from(w.GM_listValues()), ["corrupt"]);
});

test("plugin keys are wrapped and isolated from the mail site's own keys", () => {
  const w = installShim();
  w.localStorage.setItem("yandex:own-key", "site data");
  w.GM_setValue("return-pd:receipt:x", { state: "sending" });
  assert.deepEqual(Array.from(w.GM_listValues()), ["return-pd:receipt:x"]);
  assert.equal(w.localStorage.getItem("yandex:own-key"), "site data");
  assert.ok(w.localStorage.getItem(GM_STORAGE_PREFIX + "return-pd:receipt:x"));
});

test("GM_registerMenuCommand is a safe no-op and unsafeWindow is the page window", () => {
  const w = installShim();
  assert.doesNotThrow(() => w.GM_registerMenuCommand("menu", () => {}));
  assert.equal(w.unsafeWindow, w);
});

test("GM_setClipboard writes through navigator.clipboard when available", async () => {
  const w = installShim();
  let captured = "";
  w.navigator.clipboard = {
    writeText: (text: string) => {
      captured = text;
      return Promise.resolve();
    },
  };
  w.GM_setClipboard("текст для копии");
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(captured, "текст для копии");
});

test("GM_setClipboard stays silent without a clipboard API", () => {
  const w = installShim();
  delete w.navigator.clipboard;
  assert.doesNotThrow(() => w.GM_setClipboard("ignored"));
});

test("shouldActivate allows only top frames on the @match mail hosts", () => {
  const hosts = [
    "mail.yandex.ru",
    "mail.yandex.com",
    "mail.yandex.by",
    "mail.yandex.kz",
    "mail.google.com",
  ];
  for (const host of hosts) {
    assert.equal(shouldActivate(host, true), true, host);
    assert.equal(
      shouldActivate(host.toUpperCase(), true),
      true,
      `${host} upper`,
    );
    assert.equal(shouldActivate(host, false), false, `${host} iframe`);
  }
  for (const host of [
    "passport.yandex.ru",
    "yandex.ru",
    "mail.yandex.ee",
    "evil-mail.yandex.ru.example.com",
    "",
  ]) {
    assert.equal(shouldActivate(host, true), false, host);
  }
});
