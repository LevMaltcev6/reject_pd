import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";

const bundle = readFileSync(
  new URL("../dist/return-pd.user.js", import.meta.url),
  "utf8",
);
const tick = () => new Promise((r) => setTimeout(r, 10));

test("built Yandex UI starts preparation without a profile, avatar or account check", async () => {
  const dom = new JSDOM(
    '<!doctype html><body><button id="compose">Compose</button></body>',
    {
      url: "https://mail.yandex.ru/",
      runScripts: "outside-only",
    },
  );
  const w = dom.window;
  w.HTMLElement.prototype.getClientRects = function () {
    return [{ width: 100, height: 30 }] as unknown as DOMRectList;
  };
  const values = new Map<string, unknown>();
  let opened = 0;
  w.document.getElementById("compose")!.onclick = () => {
    opened++;
  };
  Object.assign(w, {
    structuredClone,
    GM_listValues: () => [...values.keys()],
    GM_getValue: (key: string) => values.get(key),
    GM_setValue: (key: string, v: unknown) =>
      values.set(key, structuredClone(v)),
    GM_deleteValue: (key: string) => values.delete(key),
    GM_registerMenuCommand: () => {},
    GM_setClipboard: () => {},
    GM_openInTab: () => assert.fail("Preparation must use the current tab"),
  });
  Object.defineProperty(w.navigator, "locks", {
    value: {
      request: async (
        _n: unknown,
        _opts: unknown,
        fn: (lock: object) => unknown,
      ) => fn({}),
    },
  });
  w.eval(bundle);
  w.document
    .getElementById("return-pd-launcher")!
    .shadowRoot!.querySelector("button")!
    .click();
  let root: ShadowRoot | null = null;
  for (let i = 0; i < 100; i++) {
    root =
      w.document.querySelector("iframe")?.contentDocument?.body
        .firstElementChild?.shadowRoot || null;
    if (root?.querySelector('input[name="fio"]')) break;
    await tick();
  }
  assert.ok(root?.querySelector('input[name="fio"]'), "panel must open");
  assert.match(root!.querySelector(".account")!.textContent!, /текущая сессия/);
  const accountButton = [...root!.querySelectorAll("button")].find(
    (b) => b.textContent === "Проверить аккаунт",
  )!;
  assert.equal((accountButton.closest(".toolbar") as HTMLElement).hidden, true);
  for (const [name, value] of [
    ["fio", "Иванов Иван"],
    ["email", "reply@example.org"],
  ]) {
    const input = root!.querySelector<HTMLInputElement>(
      `input[name="${name}"]`,
    )!;
    input.value = value;
    input.dispatchEvent(new w.Event("input", { bubbles: true }));
  }
  root!.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click();
  const launch = root!.querySelector<HTMLButtonElement>("button.primary")!;
  assert.equal(launch.disabled, false);
  launch.click();
  for (let i = 0; i < 100 && !opened; i++) await tick();
  assert.equal(opened, 1);
  assert.equal(w.location.href, "https://mail.yandex.ru/");
  assert.equal(
    [...values.keys()].some((key) => key.startsWith("return-pd:job:")),
    false,
  );
  assert.equal(
    w.document.getElementById("return-pd-launcher")!.isConnected,
    true,
  );
  w.dispatchEvent(new w.Event("pagehide"));
  dom.window.close();
});
const cases = [
  { name: "ordinary inbox", query: "", storageThrows: false },
  { name: "storage failure", query: "", storageThrows: true },
  {
    name: "pending worker",
    query: "?pd_task=12345678-1234-1234-1234-123456789012",
    storageThrows: false,
    pending: true,
  },
  { name: "invalid job marker", query: "?pd_task=bad", storageThrows: false },
  {
    name: "stale job marker",
    query: "?pd_task=12345678-1234-1234-1234-123456789012",
    storageThrows: false,
  },
];
for (const scenario of cases)
  test(`built userscript retains entry point: ${scenario.name}`, async () => {
    const dom = new JSDOM("<!doctype html><body></body>", {
      url: "https://mail.yandex.ru/" + scenario.query,
      runScripts: "outside-only",
    });
    const w = dom.window;
    const menus: string[] = [];
    Object.assign(w, {
      GM_listValues: () => {
        if (scenario.storageThrows) throw Error("storage denied");
        return [];
      },
      GM_getValue: () => undefined,
      GM_setValue: () => {},
      GM_deleteValue: () => {},
      GM_registerMenuCommand: (name: string) => menus.push(name),
    });
    Object.defineProperty(w.navigator, "locks", {
      value: {
        request: async (
          _name: unknown,
          _opts: unknown,
          fn: (lock: object) => unknown,
        ) =>
          "pending" in scenario && scenario.pending
            ? new Promise(() => {})
            : fn({}),
      },
    });
    w.eval(bundle);
    // Entry point exists synchronously, not after a worker completes.
    const host = w.document.getElementById("return-pd-launcher");
    assert.ok(host);
    await tick();
    assert.ok(host.isConnected);
    assert.ok(
      host.shadowRoot!.querySelector("button")!.textContent?.includes("0.2.8"),
    );
    assert.ok(menus.some((x) => x.includes("0.2.8")));
    w.document.body.replaceChildren();
    await tick();
    assert.ok(host.isConnected);
    const replacement = w.document.createElement("body");
    w.document.body.replaceWith(replacement);
    await tick();
    assert.equal(host.parentElement, replacement);
    dom.window.close();
  });
