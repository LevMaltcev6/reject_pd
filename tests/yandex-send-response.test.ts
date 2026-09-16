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
