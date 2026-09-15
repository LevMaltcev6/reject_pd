import { test } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { installMailEditorFixture, editorText } from "./mail-editor-fixture";
import {
  fillLetter,
  identifyAccount,
  currentMailContext,
} from "../src/adapters";
import type { Account, Letter } from "../src/types";
import { EditorError, type EditorErrorCode } from "../src/editor-errors";

const message: Letter = {
  companyId: "test",
  companyName: "Тест",
  to: ["first@example.org", "second@example.org"],
  subject: "Проверка кириллицы",
  body: "Первая строка\n\nВторая строка",
  missing: [],
  actions: [],
};
function fixture(provider: "gmail" | "yandex", existing = false) {
  const dom = new JSDOM("<!doctype html><body></body>", {
    url:
      provider === "gmail"
        ? "https://mail.google.com/mail/u/1/"
        : "https://mail.yandex.ru/",
  });
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
  ] as const)
    Object.defineProperty(globalThis, key, {
      configurable: true,
      writable: true,
      value: key === "getComputedStyle" ? w.getComputedStyle.bind(w) : w[key],
    });
  w.HTMLElement.prototype.getClientRects = function () {
    return [{ width: 100, height: 30 }] as unknown as DOMRectList;
  };
  w.document.body.innerHTML =
    provider === "gmail"
      ? '<a aria-label="Google Account: Test (me@example.org)"></a>'
      : '<span class="user-account__name">me@example.org</span>';
  let sent = 0;
  const create = () => {
    const wrap = w.document.createElement("div");
    if (provider === "gmail") wrap.setAttribute("role", "dialog");
    else wrap.className = "composeReact";
    wrap.innerHTML =
      provider === "gmail"
        ? '<input name="to"><input name="subjectbox"><div role="textbox" aria-label="Message Body" contenteditable="true"></div><button id="send">Send</button>'
        : '<div class="composeYabbles"><input name="to"></div><input name="subject"><div class="composeReact-MBody"><div contenteditable="true"></div></div><button id="send">Отправить</button>';
    mailEditor.register(wrap.querySelector<HTMLElement>("[contenteditable]")!);
    wrap.querySelector("#send")!.addEventListener("click", () => sent++);
    const input = wrap.querySelector<HTMLInputElement>('input[name="to"]')!;
    const commit = () => {
      const addresses =
        provider === "gmail"
          ? [input.value]
          : input.value.split(/[,;]/).map((value) => value.trim());
      for (const address of addresses.filter(Boolean)) {
        const chip = w.document.createElement("span");
        if (provider === "gmail") chip.setAttribute("email", address);
        else chip.className = "composeYabble";
        chip.textContent = address;
        input.before(chip);
      }
      input.value = "";
    };
    if (provider === "gmail")
      input.addEventListener("keydown", (e) => {
        if (e.key === "Enter") commit();
      });
    else input.addEventListener("blur", commit);
    w.document.body.append(wrap);
  };
  const button = w.document.createElement("button");
  button.textContent = "Написать";
  button.onclick = create;
  w.document.body.append(button);
  if (existing) create();
  return {
    dom,
    create,
    mailEditor,
    sent: () => sent,
    account: identifyAccount()!,
  };
}
for (const provider of ["gmail", "yandex"] as const) {
  test(`${provider}: fills two recipients and body without ever clicking Send`, async () => {
    const f = fixture(provider);
    await fillLetter(f.account, message, new AbortController().signal);
    assert.equal(f.sent(), 0);
    assert.equal(
      editorText(f.dom.window.document.querySelector("[contenteditable]")!),
      message.body,
    );
    f.dom.window.close();
  });
  test(`${provider}: pre-existing editor is untouched`, async () => {
    const f = fixture(provider, true);
    const body = document.querySelector("[contenteditable]")!;
    body.textContent = "Мои правки";
    await assert.rejects(
      fillLetter(f.account, message, new AbortController().signal),
      /уже открыт/,
    );
    assert.equal(body.textContent, "Мои правки");
    assert.equal(f.sent(), 0);
    f.dom.window.close();
  });
}
test("account recognition rejects ambiguity and message-body email lookalikes", () => {
  const f = fixture("gmail");
  document.body.insertAdjacentHTML("beforeend", "<p>other@example.org</p>");
  assert.equal(identifyAccount()?.email, "me@example.org");
  document
    .querySelector("a")!
    .setAttribute(
      "aria-label",
      "Google Account: me@example.org other@example.org",
    );
  assert.equal(identifyAccount(), null);
  f.dom.window.close();
});
test("cancellation is checked before touching editor", async () => {
  const f = fixture("gmail");
  await assert.rejects(
    fillLetter(f.account, message, new AbortController().signal, () => false),
    /отменено/,
  );
  assert.equal(document.querySelector("[contenteditable]"), null);
  f.dom.window.close();
});
test("account change after opening prevents filling", async () => {
  const f = fixture("gmail");
  document
    .querySelector("button")!
    .addEventListener("click", () =>
      document
        .querySelector("a")!
        .setAttribute("aria-label", "Google Account: another@example.org"),
    );
  await assert.rejects(
    fillLetter(f.account, message, new AbortController().signal),
    /Страница почты изменилась/,
  );
  assert.equal(document.querySelector("[contenteditable]")?.textContent, "");
  f.dom.window.close();
});

test("Yandex session fills a draft with no profile elements at all", async () => {
  const f = fixture("yandex");
  document.querySelector(".user-account__name")!.remove();
  const context = currentMailContext()!;
  assert.equal(context.useCurrentSession, true);
  await fillLetter(context, message, new AbortController().signal);
  assert.equal(
    editorText(document.querySelector("[contenteditable]")!),
    message.body,
  );
  assert.equal(f.sent(), 0);
  f.dom.window.close();
});
test("Yandex session ignores contradictory profile data but still preserves existing drafts", async () => {
  const f = fixture("yandex", true);
  document.body.insertAdjacentHTML(
    "afterbegin",
    '<span class="user-account__name">another@example.org</span>',
  );
  assert.equal(identifyAccount(), null);
  await assert.rejects(
    fillLetter(currentMailContext()!, message, new AbortController().signal),
    /уже открыт/,
  );
  assert.equal(f.sent(), 0);
  f.dom.window.close();
});
test("Yandex session without a ready mail editor does not write anything", async () => {
  const f = fixture("yandex");
  document.body.replaceChildren();
  const signal = AbortSignal.timeout(100);
  await assert.rejects(fillLetter(currentMailContext()!, message, signal));
  assert.equal(document.querySelector("[contenteditable]"), null);
  assert.equal(f.sent(), 0);
  f.dom.window.close();
});
test("typed recipient which was not committed is not treated as successful", async () => {
  const f = fixture("gmail");
  document.querySelector("button")!.addEventListener("click", () => {
    const input = document.querySelector('input[name="to"]')!;
    input.replaceWith(input.cloneNode());
  });
  const abort = new AbortController();
  setTimeout(() => abort.abort(), 200);
  await assert.rejects(fillLetter(f.account, message, abort.signal));
  assert.equal(f.sent(), 0);
  f.dom.window.close();
});

for (const field of ["recipients", "subject", "body"] as const) {
  test(`Yandex reports the exact ${field} mismatch when the editor changes the entered value`, async () => {
    const f = fixture("yandex");
    try {
      document.querySelector("button")!.addEventListener("click", () => {
        const body = document.querySelector("[contenteditable]")!;
        body.addEventListener("input", () => {
          if (field === "recipients") {
            document.querySelector(".composeYabble")!.textContent =
              "wrong@example.org";
          } else if (field === "subject") {
            document.querySelector<HTMLInputElement>(
              'input[name="subject"]',
            )!.value = "Другая тема";
          } else {
            body.textContent = "Редактор сбросил текст";
          }
        });
      });
      const code: EditorErrorCode = `${field}_mismatch`;
      await assert.rejects(
        fillLetter(
          currentMailContext()!,
          message,
          new AbortController().signal,
        ),
        (error: unknown) => error instanceof EditorError && error.code === code,
      );
      assert.equal(f.sent(), 0);
    } finally {
      f.dom.window.close();
    }
  });
}

for (const insertMode of ["native", "fallback"] as const) {
  test(`Yandex x-bubbles commits one complete batch as two recipients (${insertMode})`, async () => {
    const f = fixture("yandex");
    try {
      let to: HTMLElement;
      const committed: string[] = [];
      document.querySelector("button")!.addEventListener("click", () => {
        const oldRow = document.querySelector(".composeYabbles")!;
        const row = document.createElement("div");
        row.className = "ComposeRecipients-ToField tst-field-to";
        row.innerHTML =
          '<label for="test-to">To</label><div class="ComposeYabblesField" role="combobox"><div id="test-to" contenteditable="true" is="x-bubbles" class="composeYabbles" aria-label="To" role="textbox"></div></div>';
        to = row.querySelector<HTMLElement>("[contenteditable]")!;
        // Observed Yandex behavior: synthetic Enter leaves plain text; moving
        // focus to Subject turns the address into a committed bubble.
        to.addEventListener("blur", () => {
          const pending = [...to.childNodes].filter(
            (node) => node.nodeType === 3,
          );
          const addresses = pending
            .map((node) => node.textContent)
            .join("")
            .split(/[,;]/)
            .map((value) => value.trim())
            .filter(Boolean);
          pending.forEach((node) => node.remove());
          for (const address of addresses) {
            committed.push(address);
            const chip = document.createElement("span");
            chip.className = "js-yabble yabble-compose";
            chip.setAttribute("contenteditable", "false");
            chip.setAttribute("data-email", address);
            chip.textContent = address;
            to.append(chip);
          }
        });
        oldRow.replaceWith(row);
        const cc = document.createElement("input");
        cc.name = "cc";
        cc.setAttribute("aria-label", "Cc");
        row.after(cc);
      });
      if (insertMode === "fallback") document.execCommand = () => false;
      if (insertMode === "native") {
        document.execCommand = (command, _showUI, value) => {
          assert.equal(command, "insertText");
          const selection = document.getSelection()!;
          const range = selection.getRangeAt(0);
          assert.ok(to.contains(range.commonAncestorContainer));
          assert.equal(range.collapsed, true);
          range.insertNode(document.createTextNode(value!));
          range.collapse(false);
          to.dispatchEvent(
            new InputEvent("input", {
              bubbles: true,
              inputType: "insertText",
              data: value,
            }),
          );
          return true;
        };
      }
      await fillLetter(
        currentMailContext()!,
        message,
        new AbortController().signal,
      );
      assert.deepEqual(committed, message.to);
      assert.equal(to!.querySelectorAll("[data-email]").length, 2);
      assert.equal(
        document.querySelector<HTMLInputElement>('input[name="cc"]')!.value,
        "",
      );
      assert.equal(
        editorText(
          document.querySelector(".composeReact-MBody [contenteditable]")!,
        ),
        message.body,
      );
      assert.equal(f.sent(), 0);
    } finally {
      f.dom.window.close();
    }
  });
}

test("Yandex waits for the recipient field to mount after the body", async () => {
  const f = fixture("yandex");
  try {
    document.querySelector("button")!.addEventListener("click", () => {
      const row = document.querySelector(".composeYabbles")!;
      const parent = row.parentElement!;
      row.remove();
      setTimeout(() => parent.prepend(row), 200);
    });
    await fillLetter(
      currentMailContext()!,
      message,
      new AbortController().signal,
    );
    assert.equal(f.sent(), 0);
    assert.equal(
      editorText(document.querySelector("[contenteditable]")!),
      message.body,
    );
  } finally {
    f.dom.window.close();
  }
});

test("Yandex commits both recipient addresses to the saved model in one input/blur transaction", async () => {
  const f = fixture("yandex");
  let commits = 0;
  let savedRecipients: string[] = [];
  const inserted: string[] = [];
  document.querySelector("button")!.addEventListener("click", () => {
    const row = document.createElement("div");
    row.className = "ComposeRecipients-ToField tst-field-to";
    row.innerHTML =
      '<label for="batch-to">To</label><div class="ComposeYabblesField"><div id="batch-to" contenteditable="true" is="x-bubbles" class="composeYabbles" aria-label="To" role="textbox" tabindex="0"></div></div>';
    const to = row.querySelector<HTMLElement>("[contenteditable]")!;
    to.addEventListener("input", (event) =>
      inserted.push((event as InputEvent).data || ""),
    );
    to.addEventListener("blur", () => {
      const raw = [...to.childNodes].filter((node) => node.nodeType === 3);
      const addresses = raw
        .map((node) => node.textContent)
        .join("")
        .split(/[,;]/)
        .map((value) => value.trim())
        .filter(Boolean);
      if (!addresses.length) return;
      raw.forEach((node) => node.remove());
      commits++;
      // Reproduce the observed saved-draft boundary: repeated programmatic
      // per-address commits paint both chips but only the first batch persists.
      // This model is independent from the DOM that the adapter reads.
      if (commits === 1) savedRecipients = [...addresses];
      for (const address of addresses) {
        const chip = document.createElement("span");
        chip.className = "js-yabble yabble-compose";
        chip.setAttribute("data-email", address);
        chip.setAttribute("bubble", "");
        chip.setAttribute("contenteditable", "false");
        chip.textContent = address;
        to.append(chip);
      }
    });
    document.querySelector(".composeYabbles")!.replaceWith(row);
  });
  try {
    const prepared = await fillLetter(
      currentMailContext()!,
      message,
      new AbortController().signal,
    );
    prepared.verify();
    const reopenedRecipients = structuredClone(savedRecipients);
    assert.deepEqual(
      reopenedRecipients,
      message.to,
      "saved/reopened draft must retain both To addresses, not just two visible chips",
    );
    assert.deepEqual(inserted, [message.to.join(", ")]);
    assert.equal(commits, 1);
    assert.equal(f.sent(), 0);
  } finally {
    f.dom.window.close();
  }
});

function delayedRecipientFixture(
  options: {
    ignoreFirstBlur?: boolean;
    afterFirstBlur?: (to: HTMLElement) => void;
    partial?: boolean;
    finishPartial?: boolean;
  } = {},
) {
  const f = fixture("yandex");
  let inputs = 0;
  let blurs = 0;
  let enters = 0;
  let readyAtFirstBlur = false;
  const saved: string[] = [];
  document.querySelector("button")!.addEventListener("click", () => {
    const row = document.createElement("div");
    row.className = "ComposeRecipients-ToField";
    row.innerHTML =
      '<div class="composeYabbles" contenteditable="true" aria-label="To" tabindex="0"></div>';
    const to = row.firstElementChild as HTMLElement;
    document.querySelector(".composeYabbles")!.replaceWith(row);
    let inputReady = false;
    to.addEventListener("input", () => {
      inputs++;
      setTimeout(() => {
        inputReady = true;
      }, 0);
    });
    to.addEventListener("keydown", (event) => {
      if (event.key === "Enter") enters++;
    });
    const addChip = (address: string) => {
      saved.push(address);
      const chip = document.createElement("span");
      chip.className = "js-yabble yabble-compose";
      chip.setAttribute("contenteditable", "false");
      chip.setAttribute("data-email", address);
      chip.textContent = address;
      to.append(chip);
    };
    to.addEventListener("blur", () => {
      blurs++;
      if (blurs === 1) {
        readyAtFirstBlur = inputReady;
        options.afterFirstBlur?.(to);
        if (options.ignoreFirstBlur) return;
      }
      if (!inputReady) return;
      const raw = [...to.childNodes].filter((node) => node.nodeType === 3);
      const addresses = raw
        .map((node) => node.textContent || "")
        .join("")
        .split(",")
        .map((address) => address.trim())
        .filter(Boolean);
      raw.forEach((node) => node.remove());
      if (options.partial && addresses.length > 1) {
        addChip(addresses[0]);
        const remaining = document.createTextNode(
          addresses.slice(1).join(", "),
        );
        to.append(remaining);
        if (options.finishPartial)
          setTimeout(() => {
            remaining.remove();
            addresses.slice(1).forEach(addChip);
          }, 180);
      } else addresses.forEach(addChip);
    });
  });
  return {
    ...f,
    state: () => ({
      inputs,
      blurs,
      enters,
      readyAtFirstBlur,
      saved: [...saved],
    }),
  };
}

test("Yandex lets the input model process its batch before the first blur", async () => {
  const f = delayedRecipientFixture();
  try {
    await fillLetter(
      currentMailContext()!,
      message,
      new AbortController().signal,
    );
    assert.deepEqual(f.state(), {
      inputs: 1,
      blurs: 1,
      enters: 1,
      readyAtFirstBlur: true,
      saved: message.to,
    });
    assert.equal(f.sent(), 0);
  } finally {
    f.dom.window.close();
  }
});

test("Yandex retries an ignored blur without inserting the full recipient batch again", async () => {
  const f = delayedRecipientFixture({ ignoreFirstBlur: true });
  try {
    const prepared = await fillLetter(
      currentMailContext()!,
      message,
      new AbortController().signal,
    );
    prepared.verify();
    assert.deepEqual(f.state(), {
      inputs: 1,
      blurs: 2,
      enters: 1,
      readyAtFirstBlur: true,
      saved: message.to,
    });
    assert.equal(f.sent(), 0);
    assert.equal(
      editorText(
        document.querySelector(".composeReact-MBody [contenteditable]")!,
      ),
      message.body,
    );
  } finally {
    f.dom.window.close();
  }
});

for (const edit of [
  "recipient",
  "subject",
  "body",
  "copy",
  "replace",
] as const) {
  test(`Yandex does not retry a pending recipient after a user's ${edit} edit`, async () => {
    const f = delayedRecipientFixture({
      ignoreFirstBlur: true,
      afterFirstBlur(to) {
        setTimeout(() => {
          if (edit === "recipient") to.textContent = "my-edit@example.org";
          if (edit === "subject")
            document.querySelector<HTMLInputElement>(
              'input[name="subject"]',
            )!.value = "Моя тема";
          if (edit === "body")
            document.querySelector(
              ".composeReact-MBody [contenteditable]",
            )!.textContent = "Мой текст";
          if (edit === "copy") {
            const input = document.createElement("input");
            input.name = "cc";
            input.value = "my-copy@example.org";
            to.parentElement!.after(input);
          }
          if (edit === "replace") to.replaceWith(to.cloneNode(true));
        }, 0);
      },
    });
    try {
      await assert.rejects(
        fillLetter(
          currentMailContext()!,
          message,
          new AbortController().signal,
        ),
        (error: unknown) => error instanceof EditorError,
      );
      assert.equal(f.state().inputs, 1);
      assert.equal(f.state().blurs, 1);
      assert.deepEqual(f.state().saved, []);
      assert.equal(f.sent(), 0);
    } finally {
      f.dom.window.close();
    }
  });
}

test("Yandex cancellation during an ignored blur prevents another focus/blur", async () => {
  const abort = new AbortController();
  const f = delayedRecipientFixture({
    ignoreFirstBlur: true,
    afterFirstBlur() {
      abort.abort();
    },
  });
  try {
    await assert.rejects(
      fillLetter(currentMailContext()!, message, abort.signal),
      (error: unknown) =>
        error instanceof DOMException && error.name === "AbortError",
    );
    assert.equal(f.state().inputs, 1);
    assert.equal(f.state().blurs, 1);
    assert.deepEqual(f.state().saved, []);
    assert.equal(
      document.querySelector<HTMLInputElement>('input[name="subject"]')!.value,
      "",
    );
    assert.equal(f.sent(), 0);
  } finally {
    f.dom.window.close();
  }
});

test("Yandex waits for a partly painted batch without committing it a second time", async () => {
  const f = delayedRecipientFixture({ partial: true, finishPartial: true });
  try {
    const prepared = await fillLetter(
      currentMailContext()!,
      message,
      new AbortController().signal,
    );
    prepared.verify();
    assert.equal(f.state().inputs, 1);
    assert.equal(f.state().blurs, 1);
    assert.deepEqual(f.state().saved, message.to);
    assert.equal(f.sent(), 0);
  } finally {
    f.dom.window.close();
  }
});

test("Yandex never retries an incomplete batch with an existing recipient chip", async () => {
  const f = delayedRecipientFixture({ partial: true });
  try {
    await assert.rejects(
      fillLetter(currentMailContext()!, message, AbortSignal.timeout(400)),
    );
    assert.equal(f.state().inputs, 1);
    assert.equal(f.state().blurs, 1);
    assert.deepEqual(f.state().saved, [message.to[0]]);
    assert.equal(f.sent(), 0);
  } finally {
    f.dom.window.close();
  }
});
