import { test } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import {
  installMailEditorFixture,
  installYandexRecipientFixture,
  editorText,
} from "./mail-editor-fixture";
import { CurrentTabTransport, runWorker } from "../src/transport";
import {
  PREFIX,
  RECEIPT_PREFIX,
  AttemptedError,
  UncertainError,
  Queue,
  cleanExpired,
  type SendReceipt,
} from "../src/queue";
import type { Account, Letter } from "../src/types";
import { currentMailContext } from "../src/adapters";

const account: Account = {
  provider: "gmail",
  email: "me@example.org",
  baseUrl: "https://mail.google.com/mail/u/1/",
};
const letter: Letter = {
  companyId: "a",
  companyName: "A",
  to: ["recipient@example.org"],
  subject: "Subject",
  body: "Sensitive content",
  missing: [],
  actions: [],
};

function fixture(provider: "gmail" | "yandex" = "gmail") {
  const url =
    provider === "gmail"
      ? account.baseUrl + "#inbox"
      : "https://mail.yandex.ru/?uid=12345#tabs/relevant";
  const dom = new JSDOM('<a aria-label="Google Account: me@example.org"></a>', {
    url,
  });
  for (const key of [
    "document",
    "location",
    "history",
    "navigator",
    "HTMLElement",
    "HTMLInputElement",
    "HTMLTextAreaElement",
    "Event",
    "InputEvent",
    "KeyboardEvent",
  ] as const)
    Object.defineProperty(globalThis, key, {
      configurable: true,
      value: dom.window[key],
    });
  Object.defineProperty(globalThis, "getComputedStyle", {
    configurable: true,
    value: dom.window.getComputedStyle.bind(dom.window),
  });
  dom.window.HTMLElement.prototype.getClientRects = function () {
    return [{ width: 100, height: 30 }] as unknown as DOMRectList;
  };
  const mailEditor = installMailEditorFixture(dom.window, provider);
  const values = new Map<string, unknown>();
  const writes: unknown[] = [];
  let openedTabs = 0;
  Object.assign(globalThis, {
    GM_getValue: (key: string) => values.get(key),
    GM_setValue: (key: string, value: unknown) => {
      writes.push(structuredClone(value));
      values.set(key, structuredClone(value));
    },
    GM_deleteValue: (key: string) => values.delete(key),
    GM_listValues: () => [...values.keys()],
    GM_openInTab: () => {
      openedTabs++;
      throw new Error("New tabs are forbidden");
    },
  });
  dom.window.open = () => {
    openedTabs++;
    throw new Error("New tabs are forbidden");
  };
  const sends: { to: string[]; subject: string; body: string }[] = [];
  const receiptsAtClick: unknown[][] = [];
  let composes = 0;
  const compose = document.createElement("button");
  compose.textContent = "Compose";
  compose.onclick = () => {
    composes++;
    assert.equal(document.querySelectorAll("[data-test-editor]").length, 0);
    const root = document.createElement("div");
    root.dataset.testEditor = "true";
    root.setAttribute("role", "dialog");
    root.className = provider === "yandex" ? "composeReact" : "";
    root.innerHTML =
      provider === "gmail"
        ? '<input name="to"><input name="subjectbox"><div role="textbox" aria-label="Message Body" contenteditable="true"></div><button>Send</button>'
        : '<div class="ComposeRecipients-ToField"><input name="to" aria-label="To"></div><input name="subject"><div class="cke_wysiwyg_div" contenteditable="true"></div><button>Send</button>';
    const body = root.querySelector<HTMLElement>('[contenteditable="true"]')!;
    mailEditor.register(body);
    const to = root.querySelector<HTMLInputElement>('input[name="to"]')!;
    const recipientModel =
      provider === "yandex"
        ? installYandexRecipientFixture(dom.window, to)
        : undefined;
    if (provider === "gmail")
      to.addEventListener("keydown", (event) => {
        if (event.key !== "Enter") return;
        const chip = document.createElement("span");
        chip.setAttribute("email", to.value);
        chip.className = "js-yabble";
        chip.textContent = to.value;
        to.before(chip);
        to.value = "";
      });
    root.querySelector("button")!.onclick = () => {
      assert.ok(
        mailEditor.modelText(body).trim(),
        "host app body model must be saved before Send",
      );
      if (recipientModel) {
        assert.equal(
          recipientModel.commits(),
          1,
          "Yandex must commit the complete recipient list in one focusout",
        );
        assert.equal(recipientModel.enters(), 1);
      }
      sends.push({
        to: recipientModel
          ? recipientModel.addresses()
          : [...root.querySelectorAll("[email], [data-email]")].map(
              (chip) =>
                chip.getAttribute("email") || chip.getAttribute("data-email")!,
            ),
        subject: root.querySelector<HTMLInputElement>(
          provider === "gmail" ? '[name="subjectbox"]' : '[name="subject"]',
        )!.value,
        body: mailEditor.modelText(body),
      });
      receiptsAtClick.push(
        [...values.values()].map((value) => structuredClone(value)),
      );
      root.remove();
      const alert = document.createElement("div");
      alert.setAttribute("role", "alert");
      alert.textContent = "Message sent";
      document.body.append(alert);
    };
    document.body.append(root);
  };
  document.body.append(compose);
  return {
    dom,
    values,
    writes,
    sends,
    receiptsAtClick,
    compose,
    account: currentMailContext()!,
    url,
    openedTabs: () => openedTabs,
    composes: () => composes,
  };
}

for (const provider of ["gmail", "yandex"] as const) {
  test(`${provider}: two letters send serially in the same document with no URL or payload storage`, async () => {
    const f = fixture(provider);
    const next = {
      ...letter,
      companyId: "b",
      to: ["one@example.org", "two@example.org"],
      subject: "Следующее обращение",
      body: "Кириллица\n\nОтдельное письмо",
    };
    const transport = new CurrentTabTransport(f.account);
    const stages: string[] = [];
    const queue = new Queue([letter, next], transport, () => {
      if (queue.items.some((item) => item.status === "sending"))
        stages.push("sending");
    });
    await queue.run();
    await queue.run(true);
    assert.deepEqual(
      queue.items.map((item) => item.status),
      ["sent", "sent"],
    );
    assert.deepEqual(
      f.sends,
      [letter, next].map(({ to, subject, body }) => ({ to, subject, body })),
    );
    assert.equal(f.composes(), 2);
    assert.equal(f.openedTabs(), 0);
    assert.equal(location.href, f.url);
    assert.equal(stages.length, 2);
    assert.equal(f.values.size, 2);
    assert.ok(
      [...f.values.keys()].every((key) => key.startsWith(RECEIPT_PREFIX)),
    );
    assert.ok(
      f.receiptsAtClick.every((receipts) =>
        receipts.some(
          (receipt) => (receipt as SendReceipt).state === "sending",
        ),
      ),
    );
    for (const value of f.writes) {
      assert.deepEqual(Object.keys(value as object).sort(), [
        "expires",
        "id",
        "state",
      ]);
      assert.doesNotMatch(
        JSON.stringify(value),
        /Sensitive|recipient|example|Кириллица/,
      );
    }
    transport.clear();
    assert.equal(f.values.size, 2);
    assert.equal(await runWorker(), false);
    assert.equal(f.sends.length, 2);
    f.dom.window.close();
  });
}

test("draft mode leaves the editor intact, never sends, and rejects replacing it", async () => {
  const f = fixture();
  const transport = new CurrentTabTransport(account, "draft");
  assert.equal(
    await transport.prepare(letter, new AbortController().signal),
    undefined,
  );
  const body = document.querySelector('[contenteditable="true"]')!;
  body.textContent = "User correction";
  transport.clear();
  await assert.rejects(
    transport.prepare(letter, new AbortController().signal),
    (error: unknown) => {
      assert.ok(error instanceof Error && !(error instanceof AttemptedError));
      assert.match(error.message, /уже открыт редактор/);
      return true;
    },
  );
  assert.equal(body.textContent, "User correction");
  assert.equal(f.composes(), 1);
  assert.equal(f.sends.length, 0);
  assert.equal(f.values.size, 0);
  assert.equal(location.href, f.url);
  f.dom.window.close();
});

for (const cancellation of ["clear", "signal", "pagehide"] as const) {
  test(`${cancellation} during fill prevents Send and leaves only the existing draft`, async () => {
    const f = fixture();
    const transport = new CurrentTabTransport(account);
    const controller = new AbortController();
    f.compose.addEventListener("click", () => {
      document
        .querySelector('[contenteditable="true"]')!
        .addEventListener("input", () => {
          if (cancellation === "clear") transport.clear();
          if (cancellation === "signal") controller.abort();
          if (cancellation === "pagehide")
            f.dom.window.dispatchEvent(new f.dom.window.Event("pagehide"));
        });
    });
    await assert.rejects(
      transport.prepare(letter, controller.signal),
      (error: unknown) => {
        assert.ok(
          error instanceof AttemptedError && !(error instanceof UncertainError),
        );
        assert.match(error.message, /отменено/);
        return true;
      },
    );
    assert.equal(f.sends.length, 0);
    assert.equal(f.values.size, 0);
    assert.equal(
      editorText(document.querySelector('[contenteditable="true"]')!),
      letter.body,
    );
    f.dom.window.close();
  });
}

test("a cancellation at the durable claim cancels the click and cannot become retryable", async () => {
  const f = fixture();
  const transport = new CurrentTabTransport(account);
  await assert.rejects(
    transport.prepare(letter, new AbortController().signal, () =>
      transport.clear(),
    ),
    UncertainError,
  );
  assert.equal(f.sends.length, 0);
  assert.equal(([...f.values.values()][0] as SendReceipt).state, "uncertain");
  f.dom.window.close();
});

test("pre-aborted signal never opens Compose", async () => {
  const f = fixture();
  const controller = new AbortController();
  controller.abort(new Error("private@example.org Sensitive abort reason"));
  await assert.rejects(
    new CurrentTabTransport(account).prepare(letter, controller.signal),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.doesNotMatch(error.message, /private|Sensitive/);
      return true;
    },
  );
  assert.equal(f.composes(), 0);
  assert.equal(f.values.size, 0);
  f.dom.window.close();
});

test("a second concurrent preparation cannot open a second editor", async () => {
  const f = fixture();
  const transport = new CurrentTabTransport(account);
  const pending = transport.prepare(letter, new AbortController().signal);
  await assert.rejects(
    transport.prepare(letter, new AbortController().signal),
    /Предыдущее письмо/,
  );
  assert.equal(await pending, "sent");
  assert.equal(f.composes(), 1);
  assert.equal(f.sends.length, 1);
  f.dom.window.close();
});

for (const failure of [
  "claim",
  "acknowledgment",
  "cancel-after-click",
] as const) {
  test(`${failure} yields static uncertainty and never retries a clicked editor`, async () => {
    const f = fixture();
    const controller = new AbortController();
    const originalSet = globalThis.GM_setValue;
    Object.assign(globalThis, {
      GM_setValue: (key: string, value: SendReceipt) => {
        if (
          (failure === "claim" && value.state === "sending") ||
          (failure === "acknowledgment" && value.state === "sent")
        )
          throw new Error("private@example.org Sensitive native failure");
        originalSet(key, value);
      },
    });
    if (failure === "cancel-after-click")
      f.compose.addEventListener("click", () => {
        document
          .querySelector("[data-test-editor] button")!
          .addEventListener("click", () => controller.abort());
      });
    const transport = new CurrentTabTransport(account);
    await assert.rejects(
      transport.prepare(letter, controller.signal),
      (error: unknown) => {
        assert.ok(error instanceof UncertainError);
        assert.doesNotMatch(
          error.message,
          /private|Sensitive|Ничего не отправлено/,
        );
        return true;
      },
    );
    assert.equal(f.sends.length, failure === "claim" ? 0 : 1);
    assert.equal(([...f.values.values()][0] as SendReceipt).state, "uncertain");
    transport.clear();
    assert.equal(await runWorker(), false);
    assert.equal(f.composes(), 1);
    f.dom.window.close();
  });
}

test("an account context failure does not touch the current page and can be retried", async () => {
  const f = fixture();
  await assert.rejects(
    new CurrentTabTransport({ ...account, email: "other@example.org" }).prepare(
      letter,
      new AbortController().signal,
    ),
    (error: unknown) => {
      assert.ok(error instanceof Error && !(error instanceof AttemptedError));
      assert.doesNotMatch(error.message, /other@example/);
      return true;
    },
  );
  assert.equal(f.composes(), 0);
  assert.equal(f.values.size, 0);
  f.dom.window.close();
});

test("an unexpected Gmail identity read failure stays static before Compose", async () => {
  const f = fixture();
  document.querySelectorAll = () => {
    throw new Error("private@example.org Sensitive identity error");
  };
  await assert.rejects(
    new CurrentTabTransport(account).prepare(
      letter,
      new AbortController().signal,
    ),
    (error: unknown) => {
      assert.ok(error instanceof Error && !(error instanceof AttemptedError));
      assert.doesNotMatch(error.message, /private|Sensitive/);
      return true;
    },
  );
  assert.equal(f.composes(), 0);
  assert.equal(f.values.size, 0);
  f.dom.window.close();
});

for (const state of [
  "waiting",
  "claimed",
  "sending",
  "done",
  "uncertain",
] as const) {
  test(`legacy ${state} URL only removes its obsolete job and cannot fill or send`, async () => {
    const f = fixture();
    const id = crypto.randomUUID();
    f.values.set(PREFIX + id, {
      id,
      state,
      account,
      letter,
      deliveryMode: "send",
      expires: Date.now() + 10000,
    });
    f.values.set(RECEIPT_PREFIX + id, {
      id,
      state: "sending",
      expires: Date.now() + 10000,
    });
    history.replaceState(
      { retained: true },
      "",
      account.baseUrl + "?keep=yes&pd_task=" + id + "#inbox",
    );
    assert.equal(await runWorker(), true);
    assert.equal(f.values.has(PREFIX + id), false);
    assert.equal(f.values.has(RECEIPT_PREFIX + id), true);
    assert.equal(location.href, account.baseUrl + "?keep=yes#inbox");
    assert.deepEqual(history.state, { retained: true });
    assert.equal(f.composes(), 0);
    assert.equal(f.sends.length, 0);
    assert.equal(f.openedTabs(), 0);
    assert.equal(await runWorker(), false);
    f.dom.window.close();
  });
}

test("a malformed legacy URL is stripped without interpreting its value as a storage key", async () => {
  const f = fixture();
  f.values.set(PREFIX + "invalid", { letter });
  history.replaceState(null, "", account.baseUrl + "?pd_task=invalid");
  assert.equal(await runWorker(), true);
  assert.equal(location.search, "");
  assert.equal(f.values.has(PREFIX + "invalid"), true);
  assert.equal(f.composes(), 0);
  f.dom.window.close();
});

test("receipt TTL expires attempt markers while preserving the personal form", () => {
  const f = fixture();
  f.values.set(RECEIPT_PREFIX + "expired", { expires: 5, state: "sent" });
  f.values.set(RECEIPT_PREFIX + "live", { expires: 100, state: "sending" });
  f.values.set(PREFIX + "expired", { expires: 5 });
  f.values.set("return-pd:profile-v1", { fio: "Локальная форма" });
  cleanExpired(
    {
      get: <T>(key: string) => f.values.get(key) as T,
      set: (key, value) => {
        f.values.set(key, value);
      },
      delete: (key) => {
        f.values.delete(key);
      },
      keys: () => [...f.values.keys()],
    },
    10,
  );
  assert.deepEqual(
    [...f.values.keys()].sort(),
    ["return-pd:profile-v1", RECEIPT_PREFIX + "live"].sort(),
  );
  f.dom.window.close();
});

test("a throwing progress renderer does not cancel a durable send claim or the next send", async () => {
  const f = fixture();
  const transport = new CurrentTabTransport(account);
  const progress = () => {
    throw new Error("private renderer@example.org");
  };
  assert.equal(
    await transport.prepare(letter, new AbortController().signal, progress),
    "sent",
  );
  assert.equal(
    await transport.prepare(
      { ...letter, companyId: "next" },
      new AbortController().signal,
      progress,
    ),
    "sent",
  );
  assert.equal(f.sends.length, 2);
  assert.equal(f.composes(), 2);
  assert.equal(f.openedTabs(), 0);
  assert.ok(
    [...f.values.values()].every(
      (value) => (value as SendReceipt).state === "sent",
    ),
  );
  f.dom.window.close();
});

test("an abort from a failing progress renderer still cancels the claimed click", async () => {
  const f = fixture();
  const transport = new CurrentTabTransport(account);
  const controller = new AbortController();
  await assert.rejects(
    transport.prepare(letter, controller.signal, () => {
      controller.abort();
      throw new Error("private renderer@example.org");
    }),
    UncertainError,
  );
  assert.equal(f.sends.length, 0);
  assert.equal(([...f.values.values()][0] as SendReceipt).state, "uncertain");
  f.dom.window.close();
});
