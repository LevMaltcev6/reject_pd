import { test } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { createSurface } from "../src/ui-surface";

test("keyboard, editing and clipboard events never reach mail capture listeners", async () => {
  const dom = new JSDOM("<!doctype html><body></body>");
  const { window } = dom;
  let intercepted = 0;
  const events = [
    "keydown",
    "keypress",
    "keyup",
    "beforeinput",
    "input",
    "copy",
    "cut",
    "paste",
    "compositionstart",
    "compositionupdate",
    "compositionend",
  ];
  for (const type of events)
    window.addEventListener(
      type,
      (e) => {
        intercepted++;
        e.preventDefault();
      },
      true,
    );
  // Demonstrate the previous Shadow DOM surface leaking to the host.
  const oldHost = window.document.createElement("div");
  window.document.body.append(oldHost);
  const oldRoot = oldHost.attachShadow({ mode: "open" });
  const oldInput = window.document.createElement("input");
  oldRoot.append(oldInput);
  oldInput.dispatchEvent(
    new window.KeyboardEvent("keydown", {
      key: "Backspace",
      composed: true,
      bubbles: true,
      cancelable: true,
    }),
  );
  assert.equal(intercepted, 1);
  intercepted = 0;
  const surface = await createSurface(window.document);
  const input = surface.frame.contentDocument!.createElement("input");
  surface.root.append(input);
  for (const type of events) {
    const event = new window.Event(type, {
      bubbles: true,
      composed: true,
      cancelable: true,
    });
    assert.equal(
      input.dispatchEvent(event),
      true,
      `${type} must preserve native default`,
    );
  }
  assert.equal(intercepted, 0);
  // Host shortcuts remain active when focus is outside our panel.
  window.document.body.dispatchEvent(
    new window.KeyboardEvent("keydown", { key: "j", bubbles: true }),
  );
  assert.equal(intercepted, 1);
  dom.window.close();
});

test("expanding/collapsing does not remount fields or lose value and selection", async () => {
  const dom = new JSDOM("<!doctype html><body></body>");
  const surface = await createSurface(dom.window.document);
  const input = surface.frame.contentDocument!.createElement("input");
  surface.root.append(input);
  input.value = "Иванов Иван";
  input.setSelectionRange(2, 5);
  surface.expand(true);
  surface.expand(false);
  surface.expand(true);
  assert.equal(surface.root.querySelector("input"), input);
  assert.equal(input.value, "Иванов Иван");
  assert.equal(input.selectionStart, 2);
  assert.equal(input.selectionEnd, 5);
  assert.equal(surface.frame.style.width, "100%");
  assert.equal(surface.frame.getAttribute("src"), null);
  dom.window.close();
});

test("compact progress leaves the mailbox accessible and reopening keeps the same form document", async () => {
  const dom = new JSDOM("<!doctype html><body></body>");
  const surface = await createSurface(dom.window.document);
  const document = surface.frame.contentDocument!;
  const input = document.createElement("input");
  input.value = "Фамилия Имя";
  input.setSelectionRange(2, 7);
  surface.root.append(input);
  surface.expand(true);
  surface.compact();
  assert.equal(surface.frame.style.width, "min(380px, 100vw)");
  assert.equal(surface.frame.style.height, "192px");
  assert.equal(surface.frame.style.display, "block");
  assert.equal(surface.frame.style.bottom, "84px");
  assert.equal(surface.frame.contentDocument, document);
  assert.equal(surface.root.querySelector("input"), input);
  assert.equal(input.value, "Фамилия Имя");
  assert.equal(input.selectionStart, 2);
  assert.equal(input.selectionEnd, 7);
  surface.expand(true);
  assert.equal(surface.frame.style.width, "100%");
  assert.equal(surface.frame.style.height, "100%");
  assert.equal(surface.frame.style.bottom, "0px");
  assert.equal(surface.root.querySelector("input"), input);
  surface.expand(false);
  assert.equal(surface.frame.style.display, "none");
  dom.window.close();
});
