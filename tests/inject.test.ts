import { test } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { buildInitScript } from "../pw/inject";
import { GM_STORAGE_PREFIX } from "../pw/gm-shim";

const BUNDLE = "/*BUNDLE-START*/ window.__bundleRan = true; /*BUNDLE-END*/";

test("init script orders guard, shim, activation signal and bundle", () => {
  const src = buildInitScript(BUNDLE);
  const iframeGuard = src.indexOf("window.self !== window.top");
  const shim = src.indexOf("GM_getValue");
  const activation = src.indexOf("__pdActivated()");
  const bundle = src.indexOf("/*BUNDLE-START*/");
  const bundleEnd = src.indexOf("/*BUNDLE-END*/");
  assert.ok(iframeGuard >= 0, "top-frame guard present");
  assert.ok(shim > iframeGuard, "shim installed after the guard");
  assert.ok(activation > shim, "activation signal fires after the shim");
  assert.ok(bundle > activation, "bundle runs after everything else");
  assert.ok(src.includes('"mail.yandex.ru"'), "@match host list present");
  assert.ok(src.trim().endsWith("})();"), "wrapped into an IIFE");
  assert.equal(bundleEnd > bundle, true, "bundle embedded unchanged");
});

interface ProbeWindow {
  eval(src: string): unknown;
  __seq: string[];
  __activated?: boolean;
  __bundleRan?: boolean;
  __shimOk?: boolean;
  __pdActivated?: () => void;
  GM_getValue<T = unknown>(key: string, defaultValue?: T): T;
  localStorage: Storage;
  document: Document;
}

function probeDom(url: string): ProbeWindow {
  const dom = new JSDOM("<!doctype html><html><body></body></html>", {
    url,
    runScripts: "outside-only",
  });
  const w = dom.window as unknown as ProbeWindow;
  w.__seq = [];
  w.__pdActivated = () => {
    w.__activated = true;
    w.__seq.push("activated");
  };
  return w;
}

test("init script activates the plugin end-to-end on a mail host", () => {
  const w = probeDom("https://mail.yandex.ru/inbox/");
  const probeBundle = `
    window.__seq.push("bundle");
    window.__shimOk = typeof GM_getValue === "function" && typeof unsafeWindow === "object";
    GM_setValue("return-pd:probe", { ok: true });
  `;
  w.eval(buildInitScript(probeBundle));
  // jsdom stays in "loading" under runScripts: "outside-only"; fire the
  // lifecycle event the real browser would deliver.
  if (w.document.readyState === "loading") {
    w.document.dispatchEvent(
      new (w as unknown as { Event: typeof Event }).Event("DOMContentLoaded"),
    );
  }
  assert.deepEqual(w.__seq, ["activated", "bundle"]);
  assert.equal(w.__shimOk, true, "shim globals exist before the bundle runs");
  assert.ok(
    w.localStorage.getItem(GM_STORAGE_PREFIX + "return-pd:probe"),
    "shim stores under the wrapped key",
  );
});

test("init script stays inert outside the mail hosts", () => {
  const w = probeDom("https://passport.yandex.ru/auth");
  w.eval(buildInitScript("window.__bundleRan = true;"));
  assert.equal(w.__bundleRan, undefined);
  assert.equal(w.__activated, undefined);
});

test("init script stays inert inside iframes", () => {
  const w = probeDom("https://mail.yandex.ru/inbox/");
  // Simulate a child frame: shadow window.self so it no longer equals window.top.
  Object.defineProperty(w, "self", {
    value: {},
    configurable: true,
  });
  w.eval(buildInitScript("window.__bundleRan = true;"));
  assert.equal(w.__bundleRan, undefined, "no plugin inside frames");
});
