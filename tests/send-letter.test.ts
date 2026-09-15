import { test } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import {
  installMailEditorFixture,
  installYandexRecipientFixture,
  editorText,
} from "./mail-editor-fixture";
import { currentMailContext, fillLetter } from "../src/adapters";
import { EditorError } from "../src/editor-errors";
import { SendError, SendUncertainError, sendLetter } from "../src/send-letter";
import type { Letter } from "../src/types";

const letter: Letter = {
  companyId: "test",
  companyName: "Компания",
  to: ["first@example.invalid", "second@example.invalid"],
  subject: "Тема с кириллицей",
  body: "Первая строка\n\nТекст обращения",
  missing: [],
  actions: [],
};

async function fixture(provider: "gmail" | "yandex") {
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
  document.body.innerHTML =
    '<a aria-label="Google Account: Test (me@example.invalid)"></a><button id="compose">Написать</button><button id="unrelated-send">Send</button>';
  let clicked = 0;
  let unrelated = 0;
  let live = true;
  document
    .querySelector("#unrelated-send")!
    .addEventListener("click", () => unrelated++);
  document.querySelector("#compose")!.addEventListener("click", () => {
    const root = document.createElement("div");
    if (provider === "gmail") root.setAttribute("role", "dialog");
    else root.className = "composeReact";
    root.innerHTML =
      provider === "gmail"
        ? '<div class="recipient-row"><input name="to"></div><input name="subjectbox"><div contenteditable="true" role="textbox" aria-label="Message Body"></div><div role="button" id="send" data-tooltip="Send (⌘Enter)">Send</div><button aria-haspopup="menu">Send</button>'
        : '<div class="ComposeRecipients-ToField"><input name="to"></div><input name="subject"><div class="composeReact-MBody"><div contenteditable="true"></div></div><div class="ComposeControlPanel-SendButton qa-Compose-SendButton"><button id="send" aria-disabled="false">Отправить</button></div><div class="ComposeControlPanel-DelayedSendingButton"><button>Send</button></div>';
    const body = root.querySelector<HTMLElement>("[contenteditable]")!;
    mailEditor.register(body);
    const input = root.querySelector<HTMLInputElement>('input[name="to"]')!;
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
    root.querySelector("#send")!.addEventListener("click", () => {
      assert.ok(
        mailEditor.modelText(body).trim(),
        "host app body must be saved before Send",
      );
      if (recipientModel) {
        assert.equal(
          recipientModel.commits(),
          1,
          "Yandex needs one complete recipient commit",
        );
        assert.equal(recipientModel.enters(), 1);
        assert.deepEqual(
          recipientModel.addresses(),
          letter.to,
          "Send must use the complete saved recipient model",
        );
      }
      clicked++;
    });
    document.body.append(root);
  });
  const prepared = await fillLetter(
    currentMailContext()!,
    letter,
    new AbortController().signal,
    () => live,
  );
  const button = prepared.root.querySelector<HTMLElement>("#send")!;
  const subject = prepared.root.querySelector<HTMLInputElement>(
    'input[name="subjectbox"], input[name="subject"]',
  )!;
  const notice = (
    text = provider === "gmail"
      ? "Message sent. Undo View message"
      : "Письмо отправлено. Отменить",
  ) => {
    const node = document.createElement("div");
    node.setAttribute("role", "alert");
    node.textContent = text;
    document.body.append(node);
    return node;
  };
  const success = () =>
    button.addEventListener("click", () => {
      notice();
      prepared.root.remove();
    });
  return {
    dom,
    prepared,
    button,
    subject,
    notice,
    success,
    clicked: () => clicked,
    unrelated: () => unrelated,
    deactivate: () => {
      live = false;
    },
  };
}

for (const provider of ["gmail", "yandex"] as const) {
  test(`${provider}: sends exactly once in the prepared editor after the durable claim`, async () => {
    const f = await fixture(provider);
    try {
      f.notice(); // An old unrelated acknowledgement must not be sufficient.
      f.success();
      const before = {
        body: f.prepared.body.textContent,
        subject: f.subject.value,
      };
      const order: string[] = [];
      f.button.addEventListener("click", () => order.push("click"));
      await sendLetter(f.prepared, new AbortController().signal, () =>
        order.push("claim"),
      );
      assert.deepEqual(order, ["claim", "click"]);
      assert.equal(f.clicked(), 1);
      assert.equal(f.unrelated(), 0);
      assert.equal(f.prepared.body.textContent, before.body);
      assert.equal(f.subject.value, before.subject);
      await assert.rejects(
        sendLetter(f.prepared, new AbortController().signal, () =>
          assert.fail("must not reclaim"),
        ),
        (error: unknown) =>
          error instanceof SendError && error.code === "already_attempted",
      );
      assert.equal(f.clicked(), 1);
    } finally {
      f.dom.window.close();
    }
  });

  for (const change of [
    "recipients",
    "cc",
    "bcc",
    "subject",
    "body",
    "job",
  ] as const) {
    test(`${provider}: changed ${change} prevents sending`, async () => {
      const f = await fixture(provider);
      try {
        if (change === "recipients") {
          const chip = f.prepared.root.querySelector(
            "[email], .composeYabble",
          )!;
          chip.removeAttribute("email");
          chip.removeAttribute("data-email");
          chip.textContent = "unintended@example.invalid";
          if (provider === "gmail")
            chip.setAttribute("email", chip.textContent);
        } else if (change === "cc" || change === "bcc") {
          // Even a duplicate of an expected To address may not move to CC/BCC.
          const copy = document.createElement("input");
          copy.name = change;
          copy.value = letter.to[0];
          f.prepared.root.append(copy);
        } else if (change === "subject") f.subject.value += " изменена";
        else if (change === "body") f.prepared.body.textContent += " изменено";
        else f.deactivate();
        await assert.rejects(
          sendLetter(f.prepared, new AbortController().signal, () =>
            assert.fail("claim must not run"),
          ),
          EditorError,
        );
        assert.equal(f.clicked(), 0);
      } finally {
        f.dom.window.close();
      }
    });
  }

  for (const condition of [
    "stale",
    "unrelated",
    "disappearance_only",
    "success_without_disappearance",
  ] as const) {
    test(`${provider}: ${condition} cannot confirm sending`, async () => {
      const f = await fixture(provider);
      try {
        if (condition === "stale") f.notice();
        f.button.addEventListener("click", () => {
          if (condition === "unrelated") f.notice("Draft saved");
          if (condition === "success_without_disappearance") f.notice();
          else f.prepared.root.remove();
        });
        const abort = new AbortController();
        setTimeout(() => abort.abort(), 200);
        await assert.rejects(
          sendLetter(f.prepared, abort.signal, () => {}),
          SendUncertainError,
        );
        assert.equal(f.clicked(), 1);
      } finally {
        f.dom.window.close();
      }
    });
  }
}

test("an updated provider status can acknowledge send and a hidden editor counts as closed", async () => {
  const f = await fixture("yandex");
  try {
    const status = f.notice("Черновик сохранён");
    f.button.addEventListener("click", () => {
      status.textContent = "Письмо отправлено";
      f.prepared.root.hidden = true;
    });
    await sendLetter(f.prepared, new AbortController().signal, () => {});
    assert.equal(f.clicked(), 1);
  } finally {
    f.dom.window.close();
  }
});

test("waits for the send button to become enabled and rechecks letter edits", async () => {
  const f = await fixture("yandex");
  try {
    f.button.setAttribute("aria-disabled", "true");
    setTimeout(() => {
      f.subject.value = "Changed during readiness wait";
      f.button.setAttribute("aria-disabled", "false");
    }, 30);
    await assert.rejects(
      sendLetter(f.prepared, new AbortController().signal, () =>
        assert.fail("no claim"),
      ),
      (error: unknown) =>
        error instanceof EditorError && error.code === "subject_mismatch",
    );
    assert.equal(f.clicked(), 0);
  } finally {
    f.dom.window.close();
  }
});

test("two Send controls in the same editor are rejected", async () => {
  const f = await fixture("gmail");
  try {
    const extra = document.createElement("button");
    extra.textContent = "Отправить";
    f.prepared.root.append(extra);
    await assert.rejects(
      sendLetter(f.prepared, new AbortController().signal, () =>
        assert.fail("no claim"),
      ),
      (error: unknown) =>
        error instanceof SendError && error.code === "button_ambiguous",
    );
    assert.equal(f.clicked(), 0);
  } finally {
    f.dom.window.close();
  }
});

test("cancellation before the claim never clicks Send", async () => {
  const f = await fixture("gmail");
  try {
    const abort = new AbortController();
    abort.abort();
    await assert.rejects(
      sendLetter(f.prepared, abort.signal, () => assert.fail("no claim")),
      (error: unknown) =>
        error instanceof SendError && error.code === "cancelled",
    );
    assert.equal(f.clicked(), 0);
  } finally {
    f.dom.window.close();
  }
});

test("cancellation after clicking is uncertain and cannot be retried", async () => {
  const f = await fixture("yandex");
  try {
    const abort = new AbortController();
    f.button.addEventListener("click", () => abort.abort());
    await assert.rejects(
      sendLetter(f.prepared, abort.signal, () => {}),
      SendUncertainError,
    );
    await assert.rejects(
      sendLetter(f.prepared, new AbortController().signal, () =>
        assert.fail("no retry"),
      ),
      (error: unknown) =>
        error instanceof SendError && error.code === "already_attempted",
    );
    assert.equal(f.clicked(), 1);
  } finally {
    f.dom.window.close();
  }
});

test("a throwing durable claim or native click never exposes raw exception data", async () => {
  for (const failure of ["claim", "click"] as const) {
    const f = await fixture("gmail");
    try {
      if (failure === "click")
        f.button.click = () => {
          throw new Error("private email content");
        };
      await assert.rejects(
        sendLetter(f.prepared, new AbortController().signal, () => {
          if (failure === "claim") throw new Error("private email content");
        }),
        (error: unknown) =>
          error instanceof SendUncertainError &&
          !error.message.includes("private"),
      );
    } finally {
      f.dom.window.close();
    }
  }
});

test("Gmail account changes after preparation block sending", async () => {
  const f = await fixture("gmail");
  try {
    document
      .querySelector("a")!
      .setAttribute("aria-label", "Google Account: other@example.invalid");
    await assert.rejects(
      sendLetter(f.prepared, new AbortController().signal, () =>
        assert.fail("no claim"),
      ),
      (error: unknown) =>
        error instanceof EditorError && error.code === "context_unavailable",
    );
    assert.equal(f.clicked(), 0);
  } finally {
    f.dom.window.close();
  }
});

test("an uncommitted recipient added after preparation is not sent", async () => {
  const f = await fixture("gmail");
  try {
    f.prepared.root.querySelector<HTMLInputElement>('input[name="to"]')!.value =
      "unexpected@example.invalid";
    await assert.rejects(
      sendLetter(f.prepared, new AbortController().signal, () =>
        assert.fail("no claim"),
      ),
      (error: unknown) =>
        error instanceof EditorError && error.code === "recipient_unconfirmed",
    );
    assert.equal(f.clicked(), 0);
  } finally {
    f.dom.window.close();
  }
});

for (const message of [
  "Message sent",
  "Your message has been sent",
  "Ваше письмо успешно отправлено",
]) {
  test(`Yandex acknowledges retained popup with new success screen: ${message}`, async () => {
    const f = await fixture("yandex");
    try {
      f.button.addEventListener("click", () => {
        f.prepared.root.replaceChildren();
        const success = document.createElement("div");
        success.className = "ComposeDoneScreen";
        const title = document.createElement("h2");
        title.className = "ComposeDoneScreen-Title";
        title.textContent = message;
        success.append(title);
        f.prepared.root.append(success);
      });
      await sendLetter(f.prepared, new AbortController().signal, () => {});
      assert.equal(f.prepared.root.isConnected, true);
      assert.equal(f.prepared.body.isConnected, false);
      assert.equal(f.clicked(), 1);
    } finally {
      f.dom.window.close();
    }
  });
}

test("cancellation raised during the durable claim skips the click but reports uncertainty", async () => {
  const f = await fixture("gmail");
  try {
    const abort = new AbortController();
    await assert.rejects(
      sendLetter(f.prepared, abort.signal, () => abort.abort()),
      SendUncertainError,
    );
    assert.equal(f.clicked(), 0);
  } finally {
    f.dom.window.close();
  }
});

test("a newly inserted success phrase inside the email body cannot confirm sending", async () => {
  const f = await fixture("gmail");
  try {
    f.button.addEventListener("click", () => {
      const fake = document.createElement("div");
      fake.setAttribute("role", "alert");
      fake.textContent = "Message sent";
      f.prepared.body.append(fake);
      setTimeout(() => f.prepared.root.remove(), 30);
    });
    const abort = new AbortController();
    setTimeout(() => abort.abort(), 200);
    await assert.rejects(
      sendLetter(f.prepared, abort.signal, () => {}),
      SendUncertainError,
    );
    assert.equal(f.clicked(), 1);
  } finally {
    f.dom.window.close();
  }
});

for (const provider of ["gmail", "yandex"] as const) {
  test(`${provider}: committed CC duplicating To still blocks sending`, async () => {
    const f = await fixture(provider);
    try {
      const row = document.createElement(provider === "gmail" ? "tr" : "div");
      if (provider === "gmail")
        row.innerHTML =
          '<td><span email="first@example.invalid">Recipient</span><input name="cc"></td>';
      else {
        row.className = "ComposeRecipients-CcField";
        row.innerHTML =
          '<span class="js-yabble" data-email="first@example.invalid">Recipient</span><input name="cc">';
      }
      f.prepared.root.append(row);
      await assert.rejects(
        sendLetter(f.prepared, new AbortController().signal, () =>
          assert.fail("no claim"),
        ),
        (error: unknown) =>
          error instanceof EditorError && error.code === "recipients_mismatch",
      );
      assert.equal(f.clicked(), 0);
    } finally {
      f.dom.window.close();
    }
  });
}

test("Gmail hidden committed To values do not look like pending edits", async () => {
  const f = await fixture("gmail");
  try {
    const hidden = document.createElement("input");
    hidden.type = "hidden";
    hidden.name = "to";
    hidden.value = letter.to[0];
    f.prepared.root.append(hidden);
    f.success();
    await sendLetter(f.prepared, new AbortController().signal, () => {});
    assert.equal(f.clicked(), 1);
  } finally {
    f.dom.window.close();
  }
});

for (const label of ["Cc", "Bcc", "Копия", "Скрытая копия"]) {
  for (const change of ["moved", "duplicated"] as const) {
    test(`Yandex label-only ${label} with ${change} To recipient blocks sending`, async () => {
      const f = await fixture("yandex");
      try {
        const row = document.createElement("div");
        row.innerHTML = `<label for="copy-field">${label}</label><div id="copy-field" class="composeYabbles" contenteditable="true"></div>`;
        const copy = row.querySelector("[contenteditable]")!;
        const chip = f.prepared.root.querySelector(".composeYabble")!;
        copy.append(change === "moved" ? chip : chip.cloneNode(true));
        f.prepared.root.append(row);
        await assert.rejects(
          sendLetter(f.prepared, new AbortController().signal, () =>
            assert.fail("no claim"),
          ),
          (error: unknown) =>
            error instanceof EditorError &&
            error.code === "recipients_mismatch",
        );
        assert.equal(f.clicked(), 0);
      } finally {
        f.dom.window.close();
      }
    });
  }
}

test("Yandex hidden aria-labelledby copy widget with sibling committed chip blocks sending", async () => {
  const f = await fixture("yandex");
  try {
    const row = document.createElement("div");
    row.hidden = true;
    row.innerHTML =
      '<span id="copy-label">Cc</span><div class="copy-widget"><input aria-labelledby="copy-label"></div>';
    row
      .querySelector(".copy-widget")!
      .prepend(
        f.prepared.root.querySelector(".composeYabble")!.cloneNode(true),
      );
    f.prepared.root.append(row);
    await assert.rejects(
      sendLetter(f.prepared, new AbortController().signal, () =>
        assert.fail("no claim"),
      ),
      (error: unknown) =>
        error instanceof EditorError && error.code === "recipients_mismatch",
    );
    assert.equal(f.clicked(), 0);
  } finally {
    f.dom.window.close();
  }
});

test("Yandex empty semantic copy input does not mix in sibling To widgets", async () => {
  const f = await fixture("yandex");
  try {
    // The original To fixture keeps committed chips as siblings of its input.
    const row = document.createElement("div");
    row.innerHTML =
      '<label for="copy-input">Cc</label><div><input id="copy-input"></div>';
    f.prepared.root.querySelector(".ComposeRecipients-ToField")!.after(row);
    f.success();
    await sendLetter(f.prepared, new AbortController().signal, () => {});
    assert.equal(f.clicked(), 1);
  } finally {
    f.dom.window.close();
  }
});
