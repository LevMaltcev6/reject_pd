import { test } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { createLauncher, type PanelHandle } from "../src/launcher";

const tick = () => new Promise((r) => setTimeout(r, 0));
test("launcher survives subtree removal, body replacement, menu API failure, and open panels", async () => {
  const dom = new JSDOM("<!doctype html><body></body>");
  Object.assign(globalThis, {
    GM_registerMenuCommand: () => {
      throw Error("unavailable");
    },
  });
  const ui = createLauncher(
    async () => ({ open() {}, isAlive: () => true, dispose() {} }),
    dom.window.document,
  );
  const host = dom.window.document.getElementById("return-pd-launcher")!;
  dom.window.document.body.replaceChildren();
  await tick();
  assert.equal(host.isConnected, true);
  const body = dom.window.document.createElement("body");
  dom.window.document.body.replaceWith(body);
  await tick();
  assert.equal(host.parentElement, body);
  await ui.open();
  assert.notEqual((host as HTMLElement).style.display, "none");
  ui.dispose();
  await tick();
  assert.equal(host.isConnected, false);
  dom.window.close();
});
test("removed panel and failed open are recreated instead of reusing a dead handle", async () => {
  const dom = new JSDOM("<!doctype html><body></body>");
  Object.assign(globalThis, { GM_registerMenuCommand: () => {} });
  let created = 0,
    disposed = 0,
    alive = true;
  const ui = createLauncher(async () => {
    created++;
    alive = true;
    return {
      open() {},
      isAlive: () => alive,
      dispose() {
        disposed++;
      },
    };
  }, dom.window.document);
  await ui.open();
  alive = false;
  await ui.open();
  assert.equal(created, 2);
  assert.equal(disposed, 1);
  ui.dispose();
  dom.window.close();
});

test("removed frame is disposed immediately and cleanup errors cannot disable recovery", async () => {
  const dom = new JSDOM("<!doctype html><body></body>");
  let disposed = 0;
  const ui = createLauncher(async () => {
    const frame = dom.window.document.createElement("iframe");
    dom.window.document.body.append(frame);
    return {
      open() {},
      isAlive: () => frame.isConnected,
      dispose() {
        disposed++;
        frame.remove();
        throw Error("storage failed");
      },
    };
  }, dom.window.document);
  await ui.open();
  dom.window.document.querySelector("iframe")!.remove();
  await tick();
  assert.equal(disposed, 1);
  const host = dom.window.document.getElementById("return-pd-launcher")!;
  assert.equal(host.isConnected, true);
  await ui.open();
  assert.ok(dom.window.document.querySelector("iframe"));
  ui.dispose();
  dom.window.close();
});
test("concurrent button/menu clicks create only one panel", async () => {
  const dom = new JSDOM("<!doctype html><body></body>");
  let resolve!: (p: PanelHandle) => void;
  let calls = 0;
  const ui = createLauncher(() => {
    calls++;
    return new Promise((r) => {
      resolve = r;
    });
  }, dom.window.document);
  const a = ui.open(),
    b = ui.open();
  resolve({ open() {}, isAlive: () => true, dispose() {} });
  await Promise.all([a, b]);
  assert.equal(calls, 1);
  ui.dispose();
  dom.window.close();
});
