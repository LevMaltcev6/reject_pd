import { test } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import type { PreparedLetter } from "../src/adapters";
import {
  SendError,
  SendRejectedError,
  SendUncertainError,
  sendLetter,
} from "../src/send-letter";

function fixture(reply: unknown, requestBody?: string) {
  const dom = new JSDOM(
    '<div class="composeReact"><div contenteditable="true">Текст письма</div><button>Отправить</button></div>',
    { url: "https://mail.yandex.ru/?uid=account-1" },
  );
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
  const root = w.document.querySelector<HTMLElement>(".composeReact")!;
  const prepared: PreparedLetter = {
    root,
    body: root.querySelector<HTMLElement>("[contenteditable]")!,
    provider: "yandex",
    assertActive() {},
  };
  let requests = 0;
  let received: unknown;
  let pageRead: Promise<void> = Promise.resolve();
  const originalFetch: typeof fetch = async () => {
    requests++;
    return Response.json(reply);
  };
  w.fetch = originalFetch;
  root.querySelector("button")!.addEventListener("click", () => {
    // Simulate only the mail provider's HTTP response. This tests error reporting,
    // not the underlying cause of a real Yandex rejection.
    pageRead = w
      .fetch("/web-api/do-send/liza1?_send=true", {
        method: "POST",
        body: requestBody,
      })
      .then(async (response) => {
        received = await response.json();
        if ((reply as { status?: string }).status === "ok") {
          const notice = w.document.createElement("div");
          notice.setAttribute("role", "status");
          notice.textContent = "Письмо отправлено";
          w.document.body.append(notice);
          root.remove();
        }
      });
  });
  return {
    dom,
    prepared,
    originalFetch,
    requests: () => requests,
    received: () => received,
    async send() {
      const abort = new AbortController();
      // A recognized refusal must finish well before the 20-second timeout.
      const timeout = setTimeout(() => abort.abort(), 1000);
      try {
        await sendLetter(prepared, abort.signal, () => {});
      } finally {
        clearTimeout(timeout);
        await pageRead;
      }
    },
  };
}

test("Yandex illegal_params is surfaced immediately and leaves its response readable by the page", async () => {
  const reply = { status: "error", message: "illegal_params" };
  const f = fixture(reply);
  try {
    await assert.rejects(f.send(), (error: unknown) => {
      assert.ok(error instanceof SendRejectedError);
      assert.equal(error.code, "illegal_params");
      assert.match(error.message, /Некоторые поля не заполнены/);
      assert.match(error.message, /illegal_params/);
      assert.doesNotMatch(error.message, /подтверждение не получено/);
      return true;
    });
    assert.deepEqual(f.received(), reply);
    assert.equal(f.dom.window.fetch, f.originalFetch);
    assert.equal(f.requests(), 1);
    await assert.rejects(
      f.send(),
      (error: unknown) =>
        error instanceof SendError && error.code === "already_attempted",
    );
    assert.equal(f.requests(), 1);
  } finally {
    f.dom.window.close();
  }
});

test("sender authentication refusal shows the actual request sender and account mismatches", async () => {
  const f = fixture(
    {
      status: "error",
      error: "illegal_params",
      message: "failed to auth sender",
    },
    new URLSearchParams({
      from_mailbox: "actual-sender@yandex.ru",
      send_type: "native",
      _uid: "account-2",
      _mailboxUid: "mailbox-1",
      mailboxUid: "mailbox-2",
      message: "Направить ответ на почту: reply-address@gmail.com",
      _ckey: "secret-token",
    }).toString(),
  );
  try {
    await assert.rejects(f.send(), (error: unknown) => {
      assert.ok(error instanceof SendRejectedError);
      assert.equal(error.code, "illegal_params");
      assert.match(error.message, /failed to auth sender/);
      assert.match(
        error.message,
        /Адрес отправителя в запросе: «actual-sender@yandex.ru»/,
      );
      assert.match(error.message, /Тип отправителя: «native»/);
      assert.match(error.message, /Аккаунт в запросе \(_uid\) не совпадает/);
      assert.match(
        error.message,
        /Параметры ящика _mailboxUid и mailboxUid не совпадают/,
      );
      assert.doesNotMatch(
        error.message,
        /reply-address|secret-token|account-2|mailbox-2/,
      );
      return true;
    });
    assert.equal(f.requests(), 1);
    assert.equal(f.dom.window.fetch, f.originalFetch);
  } finally {
    f.dom.window.close();
  }
});

test("sender diagnostics distinguish an empty sender from an absent sender type", async () => {
  const f = fixture(
    {
      status: "error",
      error: "illegal_params",
      message: "failed to auth sender",
    },
    "from_mailbox=&_uid=account-1",
  );
  try {
    await assert.rejects(f.send(), (error: unknown) => {
      assert.ok(error instanceof SendRejectedError);
      assert.match(error.message, /Адрес отправителя в запросе: пустой/);
      assert.match(error.message, /Тип отправителя: не передан/);
      assert.doesNotMatch(error.message, /не совпада/);
      return true;
    });
  } finally {
    f.dom.window.close();
  }
});

test("Yandex unknown server reason survives without being replaced by uncertainty", async () => {
  const f = fixture({
    status: "error",
    message: "Отправка с выбранного адреса временно недоступна",
  });
  try {
    await assert.rejects(
      f.send(),
      (error: unknown) =>
        error instanceof SendRejectedError &&
        error.message.includes(
          "Отправка с выбранного адреса временно недоступна",
        ),
    );
  } finally {
    f.dom.window.close();
  }
});

test("Yandex successful response still requires and accepts its normal UI acknowledgement", async () => {
  const f = fixture({ status: "ok" });
  try {
    await f.send();
    assert.equal(f.requests(), 1);
    assert.equal(f.dom.window.fetch, f.originalFetch);
  } finally {
    f.dom.window.close();
  }
});

test("no explicit response error retains uncertainty and restores the fetch hook", async () => {
  const f = fixture({ unrelated: "not an acknowledgement" });
  try {
    await assert.rejects(f.send(), SendUncertainError);
    assert.equal(f.dom.window.fetch, f.originalFetch);
  } finally {
    f.dom.window.close();
  }
});
