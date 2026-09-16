import { test } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { observeYandexSendResponse } from "../src/yandex-send-response";

const sendUrl = "/web-api/do-send/liza1?_send=true";
const sendOptions = { method: "POST", body: "private letter" };
const settled = () => new Promise<void>((resolve) => setTimeout(resolve, 20));
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

function fixture(fetch: typeof globalThis.fetch) {
  const dom = new JSDOM("<!doctype html><body></body>", {
    url: "https://mail.yandex.ru/",
  });
  const page = dom.window as unknown as Window;
  Object.defineProperty(page, "fetch", {
    value: fetch,
    configurable: true,
    writable: true,
  });
  return {
    page,
    window: dom.window,
    observer: observeYandexSendResponse(page.document),
    close: () => dom.window.close(),
  };
}

test("observes the real error fields while preserving fetch arguments, receiver, promise and original body", async (t) => {
  const response = json({
    status: "error",
    message: "illegal_params",
    send: "private body",
    to: "private@example.invalid",
    _ckey: "private credential",
  });
  const result = Promise.resolve(response);
  let receiver: unknown;
  let actualArgs: unknown[] = [];
  const original: typeof fetch = function (this: unknown, ...args) {
    receiver = this;
    actualArgs = args;
    return result;
  };
  const f = fixture(original);
  t.after(f.close);
  assert.equal(f.page.fetch, original);
  f.observer.start();
  assert.equal(f.page.fetch(sendUrl, sendOptions), result);
  assert.equal(receiver, f.page);
  assert.equal(actualArgs[0], sendUrl);
  assert.equal(actualArgs[1], sendOptions);
  await settled();
  assert.equal(response.bodyUsed, false);
  assert.deepEqual(f.observer.getFailure(), {
    code: "illegal_params",
    message: "illegal_params",
  });
  assert.equal((await response.json()).send, "private body");
  f.observer.stop();
  assert.equal(f.page.fetch, original);
  assert.equal(f.observer.getFailure(), undefined);
});

test("ignores drafts, other endpoints/origins and reads only the first matching send", async (t) => {
  let request = 0;
  const f = fixture(() =>
    Promise.resolve(json({ status: "error", message: `failure_${++request}` })),
  );
  t.after(f.close);
  f.observer.start();
  await f.page.fetch("/web-api/do-send/liza1?_save=true", sendOptions);
  await f.page.fetch(
    "/web-api/do-send/liza1?_send=true&_save=true",
    sendOptions,
  );
  await f.page.fetch("https://other.example/do-send?_send=true", sendOptions);
  await f.page.fetch("/web-api/not-do-send?_send=true", sendOptions);
  await f.page.fetch(sendUrl);
  await settled();
  assert.equal(f.observer.getFailure(), undefined);
  await f.page.fetch(sendUrl, sendOptions);
  await f.page.fetch(sendUrl, sendOptions);
  await settled();
  assert.equal(f.observer.getFailure()?.code, "failure_6");
  f.observer.stop();
});

test("supports Request inputs and preserves their body without reading it", async (t) => {
  const f = fixture(() =>
    Promise.resolve(json({ status: "error", message: "no_recipients" })),
  );
  t.after(f.close);
  const request = new Request(`https://mail.yandex.ru${sendUrl}`, sendOptions);
  f.observer.start();
  await f.page.fetch(request);
  await settled();
  assert.equal(request.bodyUsed, false);
  assert.equal(f.observer.getFailure()?.code, "no_recipients");
  f.observer.stop();
});

test("accepts successful and limited responses, including delayed/undo acknowledgements", async (t) => {
  for (const body of [
    { status: "ok" },
    { status: "error", limited: { recipient: [{ login: "private" }] } },
    { status: "error", message: "undo_message_saved" },
    { status: "delayed_message_saved" },
    { status: "ok", error: "undo_paused" },
  ]) {
    const f = fixture(() => Promise.resolve(json(body)));
    t.after(f.close);
    f.observer.start();
    await f.page.fetch(sendUrl, sendOptions);
    await settled();
    assert.equal(f.observer.getFailure(), undefined);
    f.observer.stop();
  }
});

test("retains explicit current and older error shapes and bounded server messages", async (t) => {
  for (const [body, expected] of [
    [
      { status: "ok", error: "illegal_params" },
      { code: "illegal_params", message: "illegal_params" },
    ],
    [
      {
        status: "error",
        error: "illegal_params",
        message: "Некорректный параметр отправителя",
      },
      { code: "illegal_params", message: "Некорректный параметр отправителя" },
    ],
    [
      {
        status: "error",
        error: { code: "incorrect_to", message: "Invalid recipient" },
      },
      { code: "incorrect_to", message: "Invalid recipient" },
    ],
    [
      { status: "error", limited: {}, error: "captcha_request" },
      { code: "captcha_request", message: "captcha_request" },
    ],
    [
      {
        status: "error",
        message: "New server reason\u0000\n" + "x".repeat(600),
      },
      {
        code: "error",
        message: ("New server reason " + "x".repeat(600)).slice(0, 512),
      },
    ],
  ] as const) {
    const f = fixture(() => Promise.resolve(json(body)));
    t.after(f.close);
    f.observer.start();
    await f.page.fetch(sendUrl, sendOptions);
    await settled();
    assert.deepEqual(f.observer.getFailure(), expected);
    f.observer.stop();
  }
});

test("HTTP failures retain structured reasons or status only without inventing a network rejection", async (t) => {
  for (const [response, expected] of [
    [
      json({ status: "error", message: "no_auth" }, 403),
      { code: "no_auth", message: "no_auth", httpStatus: 403 },
    ],
    [
      new Response("upstream unavailable", { status: 502 }),
      { httpStatus: 502 },
    ],
    [new Response("malformed successful response"), undefined],
    [Response.error(), undefined],
  ] as const) {
    const f = fixture(() => Promise.resolve(response));
    t.after(f.close);
    f.observer.start();
    await f.page.fetch(sendUrl, sendOptions);
    await settled();
    assert.deepEqual(f.observer.getFailure(), expected);
    f.observer.stop();
  }
  const rejection = new TypeError("network failed");
  const f = fixture(() => Promise.reject(rejection));
  t.after(f.close);
  f.observer.start();
  await assert.rejects(
    f.page.fetch(sendUrl, sendOptions),
    (e) => e === rejection,
  );
  await settled();
  assert.equal(f.observer.getFailure(), undefined);
  f.observer.stop();
});

test("stopping ignores an in-flight result, including after starting a new observation", async (t) => {
  let finish!: (response: Response) => void;
  const pending = new Promise<Response>((resolve) => {
    finish = resolve;
  });
  let calls = 0;
  const f = fixture(() =>
    ++calls === 1 ? pending : Promise.resolve(json({ status: "ok" })),
  );
  t.after(f.close);
  f.observer.start();
  const result = f.page.fetch(sendUrl, sendOptions);
  f.observer.stop();
  f.observer.start();
  finish(json({ status: "error", message: "illegal_params" }));
  await result;
  await f.page.fetch(sendUrl, sendOptions);
  await settled();
  assert.equal(f.observer.getFailure(), undefined);
  f.observer.stop();
});

test("installation and cleanup preserve foreign hooks and tolerate locked APIs", async (t) => {
  const original = () => Promise.resolve(json({ status: "ok" }));
  const f = fixture(original);
  t.after(f.close);
  f.observer.start();
  const wrapped = f.page.fetch;
  f.observer.start();
  assert.equal(f.page.fetch, wrapped);
  const later: typeof fetch = (...args) => wrapped(...args);
  f.page.fetch = later;
  f.observer.stop();
  assert.equal(f.page.fetch, later);
  await f.page.fetch(sendUrl, sendOptions);
  await settled();
  assert.equal(f.observer.getFailure(), undefined);
  Object.defineProperty(f.page, "fetch", {
    value: original,
    writable: false,
    configurable: false,
  });
  assert.doesNotThrow(() => f.observer.start());
  assert.equal(f.page.fetch, original);
  assert.doesNotThrow(() => f.observer.stop());
});

test("preserves synchronous exceptions from a page fetch implementation", (t) => {
  const error = new Error("page hook failed");
  const f = fixture(() => {
    throw error;
  });
  t.after(f.close);
  f.observer.start();
  assert.throws(
    () => f.page.fetch(sendUrl, sendOptions),
    (e) => e === error,
  );
  assert.equal(f.observer.getFailure(), undefined);
  f.observer.stop();
});

test("uses the page's unsafeWindow API when the userscript window has a different fetch", async (t) => {
  const page = fixture(() =>
    Promise.resolve(json({ status: "error", message: "illegal_params" })),
  );
  const isolated = fixture(() => Promise.resolve(json({ status: "ok" })));
  t.after(page.close);
  t.after(isolated.close);
  const descriptor = Object.getOwnPropertyDescriptor(
    globalThis,
    "unsafeWindow",
  );
  Object.defineProperty(globalThis, "unsafeWindow", {
    configurable: true,
    value: page.page,
  });
  t.after(() => {
    if (descriptor)
      Object.defineProperty(globalThis, "unsafeWindow", descriptor);
    else Reflect.deleteProperty(globalThis, "unsafeWindow");
  });
  isolated.observer.start();
  await page.page.fetch(sendUrl, sendOptions);
  await settled();
  assert.equal(isolated.observer.getFailure()?.code, "illegal_params");
  isolated.observer.stop();
});

test("sender authentication errors retain only bounded sender fields and identifier comparisons", async (t) => {
  const response = json({
    status: "error",
    error: "illegal_params",
    message: "failed to auth sender",
  });
  let actualOptions: RequestInit | undefined;
  const f = fixture((_input, options) => {
    actualOptions = options;
    return Promise.resolve(response);
  });
  t.after(f.close);
  f.page.history.replaceState(null, "", "/?uid=account-identifier");
  const body = new URLSearchParams({
    from_mailbox: " sender@example.invalid ",
    send_type: " collector-ext ",
    _uid: "account-identifier",
    _mailboxUid: "shared-mailbox-identifier",
    mailboxUid: "shared-mailbox-identifier",
    _ckey: "private-credential",
    from_name: "Private Sender Name",
    to: "private-recipient@example.invalid",
    subj: "Private subject",
    send: "Private letter text",
  }).toString();
  const options = { method: "POST", body };
  f.observer.start();
  await f.page.fetch(sendUrl, options);
  await settled();
  assert.equal(actualOptions, options);
  assert.equal(actualOptions?.body, body);
  assert.equal(response.bodyUsed, false);
  assert.deepEqual(f.observer.getFailure(), {
    code: "illegal_params",
    message: "failed to auth sender",
    sender: {
      fromMailbox: "sender@example.invalid",
      sendType: "collector-ext",
      uidMatchesPage: true,
      mailboxUidFieldsMatch: true,
    },
  });
  const failure = f.observer.getFailure()!;
  failure.sender!.fromMailbox = "changed@example.invalid";
  assert.equal(
    f.observer.getFailure()?.sender?.fromMailbox,
    "sender@example.invalid",
  );
  assert.doesNotMatch(
    JSON.stringify(f.observer.getFailure()),
    /private|identifier/i,
  );
  f.observer.stop();
  assert.equal(f.observer.getFailure(), undefined);
});

test("sender diagnostics preserve URLSearchParams and report identifier mismatches without their values", async (t) => {
  const f = fixture(() =>
    Promise.resolve(
      json({
        status: "error",
        error: { code: "illegal_params", message: "failed to auth sender" },
      }),
    ),
  );
  t.after(f.close);
  f.page.history.replaceState(null, "", "/?uid=page-account");
  // A different realm's URLSearchParams is also a supported form body.
  const body = new f.window.URLSearchParams({
    from_mailbox: "a".repeat(300),
    send_type: "x".repeat(100),
    _uid: "request-account",
    _mailboxUid: "first-mailbox",
    mailboxUid: "second-mailbox",
  });
  const original = body.toString();
  f.observer.start();
  await f.page.fetch(sendUrl, { method: "POST", body });
  await settled();
  assert.equal(body.toString(), original);
  assert.deepEqual(f.observer.getFailure()?.sender, {
    fromMailbox: "a".repeat(256),
    sendType: "x".repeat(64),
    uidMatchesPage: false,
    mailboxUidFieldsMatch: false,
  });
  f.observer.stop();
});

test("missing sender values remain distinct and absent identifiers produce no comparison", async (t) => {
  const f = fixture(() =>
    Promise.resolve(
      json({
        status: "illegal_params",
        message: "failed to auth sender",
      }),
    ),
  );
  t.after(f.close);
  f.observer.start();
  await f.page.fetch(sendUrl, {
    method: "POST",
    body: "send_type=&_uid=request-account",
  });
  await settled();
  assert.deepEqual(f.observer.getFailure()?.sender, {
    fromMailbox: null,
    sendType: "",
  });
  f.observer.stop();
});

test("success and unrelated failures never expose extracted sender diagnostics", async (t) => {
  for (const response of [
    { status: "ok" },
    { status: "error", message: "illegal_params" },
    { status: "ok", error: "incorrect_to" },
    { status: "error", message: "undo_message_saved" },
  ]) {
    const f = fixture(() => Promise.resolve(json(response)));
    t.after(f.close);
    f.observer.start();
    await f.page.fetch(sendUrl, {
      method: "POST",
      body: "from_mailbox=sender%40example.invalid&send_type=native",
    });
    await settled();
    assert.equal(f.observer.getFailure()?.sender, undefined);
    assert.doesNotMatch(
      JSON.stringify(f.observer.getFailure()) || "",
      /sender@example/,
    );
    f.observer.stop();
  }
});

test("unknown body formats and Request bodies are not consumed for sender diagnostics", async (t) => {
  const reply = () =>
    Promise.resolve(
      json({
        status: "illegal_params",
        message: "failed to auth sender",
      }),
    );
  const form = new FormData();
  form.set("from_mailbox", "sender@example.invalid");
  for (const body of [
    form,
    new Blob(["from_mailbox=sender%40example.invalid"]),
    JSON.stringify({ from_mailbox: "sender@example.invalid" }),
  ]) {
    const f = fixture(reply);
    t.after(f.close);
    f.observer.start();
    await f.page.fetch(sendUrl, { method: "POST", body });
    await settled();
    assert.equal(f.observer.getFailure()?.sender, undefined);
    f.observer.stop();
  }
  const f = fixture(reply);
  t.after(f.close);
  const request = new Request(`https://mail.yandex.ru${sendUrl}`, {
    method: "POST",
    body: "from_mailbox=sender%40example.invalid&send_type=native",
  });
  f.observer.start();
  await f.page.fetch(request);
  await settled();
  assert.equal(request.bodyUsed, false);
  assert.equal(f.observer.getFailure()?.sender, undefined);
  f.observer.stop();
});
