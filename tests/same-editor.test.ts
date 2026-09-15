import { test } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import {
  installMailEditorFixture,
  installYandexRecipientFixture,
  editorText,
} from "./mail-editor-fixture";
import { currentMailContext, fillLetter } from "../src/adapters";
import { SendUncertainError, sendLetter } from "../src/send-letter";
import type { Letter } from "../src/types";

function fixture(provider: "gmail" | "yandex") {
  const dom = new JSDOM(
    '<!doctype html><body><a aria-label="Google Account: Test (me@example.invalid)"></a><button id="compose">Написать</button><div role="status" id="send-status"></div></body>',
    {
      url:
        provider === "gmail"
          ? "https://mail.google.com/mail/u/1/"
          : "https://mail.yandex.ru/",
    },
  );
  const w = dom.window;
  const mailEditor = installMailEditorFixture(w, provider);
  for (const key of [
    "document",
    "location",
    "HTMLElement",
    "HTMLInputElement",
    "HTMLTextAreaElement",
    "Event",
    "InputEvent",
    "KeyboardEvent",
    "getComputedStyle",
  ] as const) {
    Object.defineProperty(globalThis, key, {
      configurable: true,
      writable: true,
      value: key === "getComputedStyle" ? w.getComputedStyle.bind(w) : w[key],
    });
  }
  w.HTMLElement.prototype.getClientRects = function () {
    return [{ width: 100, height: 30 }] as unknown as DOMRectList;
  };
  const status = document.querySelector<HTMLElement>("#send-status")!;
  const popup = document.createElement("div");
  if (provider === "gmail") popup.setAttribute("role", "dialog");
  else popup.className = "composeReact";
  let opened = 0;
  let clicks = 0;
  let onSend = () => {};
  document.querySelector("#compose")!.addEventListener("click", () => {
    opened++;
    popup.innerHTML =
      provider === "gmail"
        ? '<div class="recipient-row"><input name="to"></div><input name="subjectbox"><div contenteditable="true" role="textbox" aria-label="Message Body"></div><button id="send">Send</button>'
        : '<div class="ComposeRecipients-ToField"><input name="to"></div><input name="subject"><div class="composeReact-MBody"><div contenteditable="true"></div></div><div class="ComposeControlPanel-SendButton"><button id="send">Отправить</button></div>';
    const body = popup.querySelector<HTMLElement>("[contenteditable]")!;
    mailEditor.register(body);
    const input = popup.querySelector<HTMLInputElement>('input[name="to"]')!;
    const recipientModel =
      provider === "yandex"
        ? installYandexRecipientFixture(w, input)
        : undefined;
    if (provider === "gmail")
      input.addEventListener("keydown", (event) => {
        if (event.key !== "Enter") return;
        const chip = document.createElement("span");
        chip.setAttribute("email", input.value);
        chip.textContent = input.value;
        input.before(chip);
        input.value = "";
      });
    popup.querySelector("#send")!.addEventListener("click", () => {
      assert.ok(
        mailEditor.modelText(body).trim(),
        "host app body must be saved before Send",
      );
      if (recipientModel) {
        assert.equal(recipientModel.commits(), 1);
        assert.equal(recipientModel.enters(), 1);
        assert.deepEqual(recipientModel.addresses(), letter(opened).to);
      }
      clicks++;
      onSend();
    });
    document.body.append(popup);
  });
  const sentText = provider === "gmail" ? "Message sent" : "Письмо отправлено";
  const letter = (number: number): Letter => ({
    companyId: `company-${number}`,
    companyName: `Компания ${number}`,
    to: [`company-${number}@example.invalid`],
    subject: `Обращение ${number}`,
    body: `Текст обращения ${number}\n\nСледующий абзац.`,
    missing: [],
    actions: [],
  });
  return {
    dom,
    popup,
    status,
    sentText,
    opened: () => opened,
    clicks: () => clicks,
    async prepare(number: number) {
      return fillLetter(
        currentMailContext()!,
        letter(number),
        new AbortController().signal,
      );
    },
    onSend(callback: () => void) {
      onSend = callback;
    },
    removeEditor() {
      if (provider === "gmail") popup.remove();
      else popup.replaceChildren();
    },
    async send(prepared: Awaited<ReturnType<typeof fillLetter>>) {
      const abort = new AbortController();
      const timer = setTimeout(() => abort.abort(), 600);
      try {
        await sendLetter(prepared, abort.signal, () => {});
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

for (const provider of ["gmail", "yandex"] as const) {
  for (const replacement of ["children", "text-node"] as const) {
    test(`${provider}: three sends in one document reuse the status container (${replacement})`, async () => {
      const f = fixture(provider);
      try {
        f.onSend(() => {
          if (replacement === "text-node" && f.status.firstChild)
            f.status.firstChild.nodeValue = f.sentText;
          else f.status.textContent = f.sentText;
          f.removeEditor();
        });
        for (let index = 1; index <= 3; index++) {
          const prepared = await f.prepare(index);
          assert.match(
            editorText(prepared.body),
            new RegExp(`обращения ${index}`),
          );
          await f.send(prepared);
          assert.equal(prepared.body.isConnected, false);
        }
        assert.equal(f.opened(), 3);
        assert.equal(f.clicks(), 3);
      } finally {
        f.dom.window.close();
      }
    });
  }

  for (const staleChange of ["none", "link"] as const) {
    test(`${provider}: the previous send acknowledgement cannot confirm the next send (${staleChange})`, async () => {
      const f = fixture(provider);
      try {
        f.onSend(() => {
          const phrase = document.createElement("span");
          phrase.textContent = f.sentText;
          const link = document.createElement("a");
          link.textContent = " Undo";
          f.status.replaceChildren(phrase, link);
          f.removeEditor();
        });
        await f.send(await f.prepare(1));
        f.onSend(() => {
          // An old toast may animate/change its links while the next editor closes.
          if (staleChange === "link")
            f.status.querySelector("a")!.textContent = " View message";
          f.removeEditor();
        });
        await assert.rejects(f.send(await f.prepare(2)), SendUncertainError);
        assert.equal(f.opened(), 2);
        assert.equal(f.clicks(), 2);
      } finally {
        f.dom.window.close();
      }
    });
  }
}

test("Yandex reuses its retained popup for three editors and three new success screens", async () => {
  const f = fixture("yandex");
  try {
    f.onSend(() => {
      const success = document.createElement("div");
      success.className = "ComposeDoneScreen";
      const title = document.createElement("h2");
      title.className = "ComposeDoneScreen-Title";
      title.textContent = f.sentText;
      success.append(title);
      f.popup.replaceChildren(success);
    });
    const bodies = [];
    for (let index = 1; index <= 3; index++) {
      const prepared = await f.prepare(index);
      assert.equal(prepared.root, f.popup);
      bodies.push(prepared.body);
      await f.send(prepared);
      assert.equal(f.popup.isConnected, true);
      assert.equal(prepared.body.isConnected, false);
      assert.equal(f.popup.querySelectorAll(".ComposeDoneScreen").length, 1);
    }
    assert.equal(
      new Set(bodies).size,
      3,
      "each completed editor must be replaced",
    );
    assert.equal(f.clicks(), 3);
  } finally {
    f.dom.window.close();
  }
});
