import { test } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { installMailEditorFixture, editorText } from "./mail-editor-fixture";
import { EditorError, workerErrorMessage } from "../src/editor-errors";
import { waitFor } from "../src/adapters";
import { CurrentTabTransport } from "../src/transport";
import { PREFIX, type Job } from "../src/queue";

const privateText =
  "Иванов Иван, secret-person@example.org, паспорт 1234 567890";

function workerFixture() {
  const id = crypto.randomUUID();
  const key = PREFIX + id;
  const dom = new JSDOM("<!doctype html><body></body>", {
    url: `https://mail.yandex.ru/?pd_task=${id}`,
  });
  const w = dom.window;
  const mailEditor = installMailEditorFixture(w, "yandex");
  const originals = new Map<string, PropertyDescriptor | undefined>();
  const expose = (name: string, value: unknown) => {
    originals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, {
      configurable: true,
      writable: true,
      value,
    });
  };
  for (const name of [
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
    expose(name, w[name]);
  expose("getComputedStyle", w.getComputedStyle.bind(w));
  w.HTMLElement.prototype.getClientRects = function () {
    return [{ width: 100, height: 30 }] as unknown as DOMRectList;
  };
  const shadows: ShadowRoot[] = [];
  const attachShadow = w.Element.prototype.attachShadow;
  w.Element.prototype.attachShadow = function (options: ShadowRootInit) {
    const root = attachShadow.call(this, options);
    shadows.push(root);
    return root;
  };
  Object.defineProperty(w.navigator, "locks", {
    value: {
      request: async (
        _name: string,
        _options: unknown,
        callback: (lock: object) => Promise<void>,
      ) => callback({}),
    },
  });
  const job: Job = {
    id,
    owner: crypto.randomUUID(),
    created: Date.now(),
    expires: Date.now() + 60_000,
    state: "waiting",
    account: {
      provider: "yandex",
      email: "",
      baseUrl: "https://mail.yandex.ru/",
      useCurrentSession: true,
    },
    letter: {
      companyId: "test",
      companyName: "Тест",
      to: ["recipient@example.org"],
      subject: "Обращение",
      body: privateText,
      missing: [],
      actions: [],
    },
  };
  const values = new Map<string, unknown>([[key, job]]);
  expose("GM_getValue", (name: string) => values.get(name));
  expose("GM_setValue", (name: string, value: unknown) =>
    values.set(name, structuredClone(value)),
  );
  expose("GM_deleteValue", (name: string) => values.delete(name));
  expose("GM_listValues", () => [...values.keys()]);
  return {
    dom,
    shadows,
    mailEditor,
    job,
    result: () => values.get(key) as Job,
    cleanup() {
      dom.window.close();
      for (const [name, descriptor] of originals) {
        if (descriptor) Object.defineProperty(globalThis, name, descriptor);
        else Reflect.deleteProperty(globalThis, name);
      }
    },
  };
}

test("Yandex current-tab transport reports a missing subject without an account accusation", async (t) => {
  const f = workerFixture();
  t.after(() => f.cleanup());
  const doc = f.dom.window.document;
  let sent = 0;
  const compose = doc.createElement("button");
  compose.textContent = "Написать";
  compose.addEventListener("click", () => {
    const editor = doc.createElement("div");
    editor.className = "composeReact";
    editor.innerHTML =
      '<div class="composeYabbles"><input name="to"></div><div class="composeReact-MBody"><div contenteditable="true"></div></div><button>Отправить</button>';
    f.mailEditor.register(
      editor.querySelector<HTMLElement>("[contenteditable]")!,
    );
    editor.querySelector("button")!.addEventListener("click", () => sent++);
    doc.body.append(editor);
  });
  doc.body.append(compose);

  await assert.rejects(
    new CurrentTabTransport(f.job.account).prepare(
      f.job.letter,
      new AbortController().signal,
    ),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal(
        error.message,
        workerErrorMessage(
          new EditorError("subject_missing"),
          new AbortController().signal,
        ),
      );
      assert.match(error.message, /тем/i);
      assert.doesNotMatch(
        error.message,
        /Аккаунт или поля|аватар|secret-person|1234 567890/,
      );
      return true;
    },
  );
  assert.equal(sent, 0);
  assert.equal(doc.querySelector("[contenteditable]")!.textContent, "");
  assert.equal(
    f.result().state,
    "waiting",
    "legacy storage is not touched by local preparation",
  );
});

test("current-tab transport redacts unknown DOM exceptions and does not persist an error payload", async (t) => {
  const f = workerFixture();
  t.after(() => f.cleanup());
  const failure = new Error(privateText);
  f.dom.window.document.querySelectorAll = () => {
    throw failure;
  };

  await assert.rejects(
    new CurrentTabTransport(f.job.account).prepare(
      f.job.letter,
      new AbortController().signal,
    ),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal(
        error.message,
        workerErrorMessage(failure, new AbortController().signal),
      );
      assert.doesNotMatch(
        error.message,
        /Иванов|secret-person|1234 567890|Аккаунт или поля/,
      );
      return true;
    },
  );
  assert.equal(f.result().state, "waiting");
  assert.equal(f.result().error, undefined);
});

test("cancelled preparation uses the static cancellation message and hides the abort reason", () => {
  const controller = new AbortController();
  controller.abort(new Error(privateText));
  const message = workerErrorMessage(
    controller.signal.reason,
    controller.signal,
  );
  assert.equal(
    message,
    workerErrorMessage(
      new EditorError("cancelled"),
      new AbortController().signal,
    ),
  );
  assert.match(message, /останов|отмен/i);
  assert.doesNotMatch(
    message,
    /Иванов|secret-person|1234 567890|Аккаунт или поля/,
  );
});

test("editor wait timeout retains the failing stage instead of a generic interface error", async () => {
  const signal = new AbortController().signal;
  await assert.rejects(
    waitFor(() => null, signal, 1, "compose_button_missing"),
    (error: unknown) => {
      assert.ok(error instanceof EditorError);
      assert.equal(error.code, "compose_button_missing");
      assert.match(workerErrorMessage(error, signal), /Написать/);
      return true;
    },
  );
});

test("typed editor errors are rendered from the static catalog, never a replaced error message", () => {
  const error = new EditorError("subject_missing");
  error.message = privateText;
  const message = workerErrorMessage(error, new AbortController().signal);
  assert.match(message, /тем/i);
  assert.doesNotMatch(message, /Иванов|secret-person|1234 567890/);
});
