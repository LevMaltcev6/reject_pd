import { test } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { MailBodyError, writeMailBody } from "../src/mail-body";

const expected =
  "Я, Тест Проверки Скрипта, отзываю согласие.\n\n1. Удалить <данные> & ответить.\n2. Написать на reply@example.invalid.";
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
function fixture(
  options: {
    dataTransform?: (html: string) => string;
    domTransform?: (html: string) => string;
    neverReady?: boolean;
    callbackDelay?: number;
  } = {},
) {
  const dom = new JSDOM(
    '<!doctype html><body><div class="cke_wysiwyg_div" contenteditable="true"></div></body>',
    { url: "https://mail.yandex.ru/", pretendToBeVisual: true },
  );
  const w = dom.window;
  const body = w.document.querySelector<HTMLElement>("[contenteditable]")!;
  let editorData = "";
  let appData = "";
  let writes = 0;
  let changes = 0;
  const events: string[] = [];
  const instance = {
    status: "ready",
    readOnly: false,
    editable: () => ({ $: body }),
    setData(html: string, optionsForSet: { callback: () => void }) {
      writes++;
      events.push("setData");
      if (options.neverReady) return;
      setTimeout(() => {
        editorData = options.dataTransform?.(html) ?? html;
        body.innerHTML = options.domTransform?.(html) ?? html;
        events.push("dataReady");
        optionsForSet.callback();
      }, options.callbackDelay ?? 20);
    },
    getData() {
      return editorData;
    },
    fire(event: string) {
      if (event === "change") {
        events.push("change");
        changes++;
        // The mail application serializes the CKEditor event, never the DOM.
        appData = editorData;
      }
    },
  };
  const registry = { main: instance };
  Object.assign(w, { CKEDITOR: { instances: registry } });
  return {
    dom,
    w,
    body,
    instance,
    registry,
    events,
    get writes() {
      return writes;
    },
    get changes() {
      return changes;
    },
    get appData() {
      return appData;
    },
    changeStored(html: string) {
      editorData = html;
    },
    close() {
      w.close();
    },
  };
}
function code(expectedCode: MailBodyError["code"]) {
  return (error: unknown) =>
    error instanceof MailBodyError && error.code === expectedCode;
}
function serializedText(html: string) {
  const parsed = new JSDOM(html);
  const body = parsed.window.document.body;
  const value = body.textContent!.replace(/\u00a0/g, " ");
  const breaks = body.querySelectorAll("br").length;
  parsed.window.close();
  return { value, breaks };
}

test("controlled CKEditor fixture reproduces visible full text but an empty application body with the old DOM-only write", async (t) => {
  const f = fixture();
  t.after(() => f.close());
  f.body.replaceChildren(f.w.document.createTextNode(expected));
  f.body.dispatchEvent(
    new f.w.InputEvent("input", {
      bubbles: true,
      inputType: "insertText",
      data: expected,
    }),
  );
  f.body.dispatchEvent(new f.w.Event("change", { bubbles: true }));
  assert.equal(f.body.textContent, expected);
  assert.equal(f.instance.getData(), "");
  assert.equal(
    f.appData,
    "",
    "the visible DOM is not the body the mail application sends",
  );
  assert.equal(f.changes, 0);
});

test("CKEditor write waits for dataReady, notifies the application and verifies serialized text", async (t) => {
  const f = fixture();
  t.after(() => f.close());
  const result = await writeMailBody(
    f.body,
    expected,
    new AbortController().signal,
  );
  assert.deepEqual(f.events, ["setData", "dataReady", "change"]);
  assert.equal(f.writes, 1);
  assert.equal(f.changes, 1);
  assert.equal(f.appData, f.instance.getData());
  assert.deepEqual(serializedText(f.appData), {
    value: expected.replace(/\n/g, ""),
    breaks: 3,
  });
  assert.equal(
    f.body.querySelector("данные"),
    null,
    "user text must be escaped as text, never injected as markup",
  );
  assert.match(f.appData, /&lt;данные&gt;/);
  assert.match(
    f.appData,
    /Тест Проверки Скрипта/,
    "ordinary word spaces must stay breakable so the letter wraps",
  );
  result.verify();
});

for (const failure of ["data", "dom"] as const) {
  test(`CKEditor rejects ${failure} truncation even when the other representation contains the whole letter`, async (t) => {
    const f = fixture(
      failure === "data"
        ? { dataTransform: () => "<p></p>" }
        : { domTransform: () => "<p></p>" },
    );
    t.after(() => f.close());
    await assert.rejects(
      writeMailBody(f.body, expected, new AbortController().signal),
      code("mismatch"),
    );
  });
}

for (const changed of ["serialized", "visible"] as const) {
  test(`the retained checkpoint rejects later changes to the ${changed} body before sending`, async (t) => {
    const f = fixture();
    t.after(() => f.close());
    const result = await writeMailBody(
      f.body,
      expected,
      new AbortController().signal,
    );
    if (changed === "serialized") f.changeStored("<p>Другой текст</p>");
    else f.body.textContent = "Другой текст";
    assert.throws(() => result.verify(), code("mismatch"));
  });
}

test("CKEditor serialization may use paragraphs, br and formatting whitespace without losing text boundaries", async (t) => {
  const format = () =>
    "<p>Первая строка</p>\n<p>Вторая строка<br />\nТретья строка</p>\n";
  const f = fixture({ dataTransform: format, domTransform: format });
  t.after(() => f.close());
  const checkpoint = await writeMailBody(
    f.body,
    "Первая строка\n\nВторая строка\nТретья строка",
    new AbortController().signal,
  );
  checkpoint.verify();
});

test("long Cyrillic text, HTML-sensitive characters, indentation and multiple blank lines survive the editor serializer", async (t) => {
  const f = fixture();
  t.after(() => f.close());
  const text = `  Начало <&> "кавычки"\n\n\n${"Длинный абзац с кириллицей и emoji ✅. ".repeat(300)}\n    Последняя строка`;
  const checkpoint = await writeMailBody(
    f.body,
    text,
    new AbortController().signal,
  );
  checkpoint.verify();
  const snapshot = serializedText(f.appData);
  assert.equal(snapshot.value, text.replace(/\n/g, ""));
  assert.equal(snapshot.breaks, 4);
  assert.equal(f.changes, 1);
});

test("only the instance associated with the exact editable element can be changed", async (t) => {
  const f = fixture();
  t.after(() => f.close());
  const unrelated = f.w.document.createElement("div");
  let unrelatedWrites = 0;
  Object.assign(f.registry, {
    unrelated: {
      ...f.instance,
      editable: () => ({ $: unrelated }),
      setData: () => {
        unrelatedWrites++;
      },
    },
  });
  await writeMailBody(f.body, expected, new AbortController().signal);
  assert.equal(unrelatedWrites, 0);
  assert.equal(f.writes, 1);
});

test("duplicate instances for the same editable are rejected before any write", async (t) => {
  const f = fixture();
  t.after(() => f.close());
  Object.assign(f.registry, { duplicate: { ...f.instance } });
  await assert.rejects(
    writeMailBody(f.body, expected, new AbortController().signal),
    code("unavailable"),
  );
  assert.equal(f.writes, 0);
  assert.equal(f.changes, 0);
});

test("a managed editor without its API never falls back to painting the DOM", async (t) => {
  const f = fixture();
  t.after(() => f.close());
  Object.assign(f.w, { CKEDITOR: undefined });
  let nativeWrites = 0;
  f.w.document.execCommand = () => {
    nativeWrites++;
    return true;
  };
  const abort = new AbortController();
  setTimeout(() => abort.abort(), 20);
  await assert.rejects(
    writeMailBody(f.body, expected, abort.signal),
    code("cancelled"),
  );
  assert.equal(f.body.textContent, "");
  assert.equal(nativeWrites, 0);
});

test("a loading managed editor is awaited before data replacement", async (t) => {
  const f = fixture();
  t.after(() => f.close());
  f.instance.status = "loaded";
  setTimeout(() => {
    f.instance.status = "ready";
  }, 20);
  await writeMailBody(f.body, expected, new AbortController().signal);
  assert.equal(f.writes, 1);
  assert.equal(f.changes, 1);
});

test("cancelling before dataReady never sends a change notification with stale or partial data", async (t) => {
  const f = fixture({ callbackDelay: 80 });
  t.after(() => f.close());
  const abort = new AbortController();
  setTimeout(() => abort.abort(), 20);
  await assert.rejects(
    writeMailBody(f.body, expected, abort.signal),
    code("cancelled"),
  );
  await delay(90);
  assert.equal(f.changes, 0);
  assert.equal(f.appData, "");
});

test("a missing setData callback is not considered a completed write", async (t) => {
  const f = fixture({ neverReady: true });
  t.after(() => f.close());
  const abort = new AbortController();
  setTimeout(() => abort.abort(), 20);
  await assert.rejects(
    writeMailBody(f.body, expected, abort.signal),
    code("cancelled"),
  );
  assert.equal(f.changes, 0);
  assert.equal(f.appData, "");
});

test("editor exceptions return static messages without account or letter contents", async (t) => {
  const f = fixture();
  t.after(() => f.close());
  f.instance.setData = () => {
    throw new Error(expected);
  };
  await assert.rejects(
    writeMailBody(f.body, expected, new AbortController().signal),
    (error: unknown) => {
      assert.ok(error instanceof MailBodyError);
      assert.equal(error.code, "write_failed");
      assert.doesNotMatch(error.message, /reply@example|отзываю согласие/);
      return true;
    },
  );
  assert.equal(f.changes, 0);
});

function gmail() {
  const dom = new JSDOM(
    '<!doctype html><body><div contenteditable="true" tabindex="0"></div></body>',
    { url: "https://mail.google.com/mail/u/0/", pretendToBeVisual: true },
  );
  const body =
    dom.window.document.querySelector<HTMLElement>("[contenteditable]")!;
  return { dom, body };
}

test("generic editor uses the selected native editing transaction and its model receives the input", async (t) => {
  const { dom, body } = gmail();
  t.after(() => dom.window.close());
  let model = "";
  let calls = 0;
  body.addEventListener("input", () => {
    model = body.textContent || "";
  });
  dom.window.document.execCommand = (command, _ui, text) => {
    calls++;
    assert.equal(command, "insertText");
    const selection = dom.window.document.getSelection()!;
    assert.equal(selection.rangeCount, 1);
    const range = selection.getRangeAt(0);
    assert.equal(range.commonAncestorContainer, body);
    range.deleteContents();
    range.insertNode(dom.window.document.createTextNode(text!));
    body.dispatchEvent(
      new dom.window.InputEvent("input", {
        bubbles: true,
        inputType: "insertText",
        data: text,
      }),
    );
    return true;
  };
  const checkpoint = await writeMailBody(
    body,
    expected,
    new AbortController().signal,
  );
  assert.equal(calls, 1);
  assert.equal(model, expected);
  checkpoint.verify();
});

for (const outcome of ["missing", "false", "no-change"] as const) {
  test(`generic editor ${outcome} native insertion never silently falls back to direct DOM replacement`, async (t) => {
    const { dom, body } = gmail();
    t.after(() => dom.window.close());
    if (outcome !== "missing")
      dom.window.document.execCommand = () => outcome === "no-change";
    await assert.rejects(
      writeMailBody(body, expected, new AbortController().signal),
      code(
        outcome === "missing"
          ? "unavailable"
          : outcome === "false"
            ? "write_failed"
            : "mismatch",
      ),
    );
    assert.equal(body.textContent, "");
  });
}
