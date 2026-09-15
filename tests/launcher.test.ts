import { test } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { mountUI } from "../src/ui";

test("launcher and menu exist before frame creation; failed frame does not remove launcher", async () => {
  const dom = new JSDOM("<!doctype html><body></body>");
  Object.assign(globalThis, { document: dom.window.document });
  const commands: (() => void)[] = [];
  Object.assign(globalThis, {
    GM_registerMenuCommand: (_: string, fn: () => void) => commands.push(fn),
  });
  const ui = mountUI();
  const host = document.querySelector("#return-pd-launcher") as HTMLElement;
  const root = host.shadowRoot!;
  const button = root.querySelector("button")!;
  assert.ok(button.textContent?.includes("Обращения по ПД"));
  assert.equal(document.querySelector("iframe"), null);
  assert.equal(commands.length, 1);
  commands[0]();
  const frame = document.querySelector("iframe")!;
  Object.defineProperty(frame, "contentDocument", { value: null });
  frame.dispatchEvent(new dom.window.Event("load"));
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(document.querySelector("iframe"), null);
  assert.equal(root.querySelector("p")!.hidden, false);
  assert.equal(button.textContent, "↗ Обращения по ПД · 0.2.6");
  assert.notEqual(host.style.display, "none");
  assert.equal(button.disabled, false);
  ui.dispose();
  dom.window.close();
});
