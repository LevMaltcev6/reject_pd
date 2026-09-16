import { test } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import type { PreparedLetter } from "../src/adapters";
import { SendUncertainError, sendLetter } from "../src/send-letter";

function fixture(provider: "gmail" | "yandex") {
  const dom = new JSDOM("<!doctype html><body></body>", {
    url:
      provider === "gmail"
        ? "https://mail.google.com/mail/u/0/"
        : "https://mail.yandex.ru/",
  });
  const w = dom.window;
  for (const key of ["document", "HTMLElement", "getComputedStyle"] as const)
    Object.defineProperty(globalThis, key, {
      configurable: true,
      writable: true,
      value: key === "getComputedStyle" ? w.getComputedStyle.bind(w) : w[key],
    });
  w.HTMLElement.prototype.getClientRects = function () {
    return [{ width: 100, height: 30 }] as unknown as DOMRectList;
  };
  const root = document.createElement("div");
  if (provider === "gmail") root.setAttribute("role", "dialog");
  else root.className = "composeReact";
  root.innerHTML =
    '<div contenteditable="true">Expected body</div><button>Send</button>';
  document.body.append(root);
  const body = root.querySelector<HTMLElement>("[contenteditable]")!;
  const prepared: PreparedLetter = {
    root,
    body,
    provider,
    assertActive() {
      assert.equal(body.isConnected, true);
    },
  };
  let clicks = 0;
  const button = root.querySelector("button")!;
  button.addEventListener("click", () => clicks++);
  const status = document.createElement("div");
  status.setAttribute("role", "status");
  document.body.append(status);
  const sent = provider === "gmail" ? "Message sent" : "Письмо отправлено";
  return {
    dom,
    root,
    button,
    status,
    sent,
    clicks: () => clicks,
    async send() {
      const abort = new AbortController();
      const timeout = setTimeout(() => abort.abort(), 350);
      try {
        await sendLetter(prepared, abort.signal, () => {});
      } finally {
        clearTimeout(timeout);
      }
    },
  };
}

for (const provider of ["gmail", "yandex"] as const) {
  test(`${provider}: a success notice replaced by failure before the editor closes is not a send confirmation`, async () => {
    const f = fixture(provider);
    try {
      f.button.addEventListener("click", () => {
        f.status.textContent = f.sent;
        setTimeout(() => {
          f.status.textContent =
            provider === "gmail"
              ? "Message not sent"
              : "Не удалось отправить письмо";
          f.root.remove();
        }, 30);
      });
      await assert.rejects(f.send(), SendUncertainError);
      assert.equal(f.clicks(), 1);
    } finally {
      f.dom.window.close();
    }
  });

  test(`${provider}: a success notice still current when the editor closes confirms sending`, async () => {
    const f = fixture(provider);
    try {
      f.button.addEventListener("click", () => {
        f.status.textContent = f.sent;
        setTimeout(() => f.root.remove(), 30);
      });
      await f.send();
      assert.equal(f.clicks(), 1);
    } finally {
      f.dom.window.close();
    }
  });
}

for (const [provider, className] of [
  ["gmail", "a3s"],
  ["yandex", "js-message-body"],
  ["yandex", "react-message-wrapper__body"],
] as const)
  test(`${provider}: a matching alert in viewed message content (${className}) cannot confirm sending`, async () => {
    const f = fixture(provider);
    try {
      f.button.addEventListener("click", () => {
        const message = document.createElement("div");
        message.className = className;
        const content = document.createElement("div");
        content.setAttribute("role", "alert");
        content.textContent = f.sent;
        message.append(content);
        document.body.append(message);
        f.root.remove();
      });
      await assert.rejects(f.send(), SendUncertainError);
      assert.equal(f.clicks(), 1);
    } finally {
      f.dom.window.close();
    }
  });
