import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";
import {
  installMailEditorFixture,
  installYandexRecipientFixture,
  editorText,
} from "./mail-editor-fixture";

const bundle = readFileSync(
  new URL("../dist/return-pd.user.js", import.meta.url),
  "utf8",
);
const PREFIX = "return-pd:job:";
const PROFILE_KEY = "return-pd:profile-v1";
const tick = () => new Promise((resolve) => setTimeout(resolve, 10));
async function until(check: () => boolean, message: string) {
  for (let attempt = 0; attempt < 500; attempt++) {
    if (check()) return;
    await tick();
  }
  assert.ok(check(), message);
}

interface SentMessage {
  to: string[];
  subject: string;
  body: string;
}

/** Real userscript UI, adapter and sending code; only the host mail UI is simulated. */
function page(
  values = new Map<string, unknown>(),
  options: { acknowledge?: boolean; lockAvailable?: boolean } = {},
) {
  const dom = new JSDOM(
    '<!doctype html><body><button class="mail-ComposeButton">Compose</button></body>',
    {
      url: "https://mail.yandex.ru/?uid=123456#/inbox",
      runScripts: "outside-only",
      pretendToBeVisual: true,
    },
  );
  const w = dom.window;
  const mailEditor = installMailEditorFixture(w, "yandex", false);
  const sent: SentMessage[] = [];
  const acknowledge = () => {
    const status = w.document.createElement("div");
    status.setAttribute("role", "status");
    status.textContent = "Message sent";
    w.document.body.append(status);
  };
  let composeCount = 0;
  let maxEditors = 0;
  let confirmations = 0;
  let openedTabs = 0;
  let closed = false;
  const forbiddenOpen = () => {
    openedTabs++;
    throw new Error("Opening another tab is forbidden in this test");
  };
  Object.assign(w, {
    structuredClone,
    GM_listValues: () => [...values.keys()],
    GM_getValue: (key: string) => structuredClone(values.get(key)),
    GM_setValue: (key: string, value: unknown) =>
      values.set(key, structuredClone(value)),
    GM_deleteValue: (key: string) => values.delete(key),
    GM_registerMenuCommand: () => {},
    GM_setClipboard: () => {},
    confirm: () => {
      confirmations++;
      return false;
    },
    GM_openInTab: forbiddenOpen,
    open: forbiddenOpen,
    fetch: () => {
      throw new Error("The userscript must not transmit data through fetch");
    },
  });
  w.HTMLElement.prototype.getClientRects = function () {
    return [{ width: 100, height: 30 }] as unknown as DOMRectList;
  };
  Object.defineProperty(w.navigator, "locks", {
    value: {
      request: async (
        _name: string,
        _options: unknown,
        callback: (lock: object | null) => unknown,
      ) => callback(options.lockAvailable === false ? null : {}),
    },
  });
  w.document
    .querySelector(".mail-ComposeButton")!
    .addEventListener("click", () => {
      composeCount++;
      const editor = w.document.createElement("div");
      editor.className = "composeReact";
      editor.innerHTML = `
      <div class="ComposeRecipients-ToField">
        <label for="to-${composeCount}">To</label>
        <div id="to-${composeCount}" class="composeYabbles" contenteditable="true" role="textbox" aria-label="To" tabindex="0"></div>
      </div>
      <input name="subject">
      <div class="composeReact-MBody"><div contenteditable="true" tabindex="0"></div></div>
      <div class="ComposeControlPanel-SendButton"><button>Send</button></div>`;
      const body = editor.querySelector<HTMLElement>(
        ".composeReact-MBody [contenteditable]",
      )!;
      mailEditor.register(body);
      const recipient = editor.querySelector<HTMLElement>(".composeYabbles")!;
      const recipientModel = installYandexRecipientFixture(w, recipient);
      editor.querySelector("button")!.addEventListener("click", () => {
        assert.ok(
          mailEditor.modelText(body).trim(),
          "host app body must be saved before Send",
        );
        assert.equal(
          recipientModel.commits(),
          1,
          "one paste/focusout must commit every recipient",
        );
        assert.equal(recipientModel.enters(), 1);
        sent.push({
          to: recipientModel.addresses(),
          subject: editor.querySelector<HTMLInputElement>(
            'input[name="subject"]',
          )!.value,
          body: mailEditor.modelText(body),
        });
        editor.remove();
        if (options.acknowledge !== false) {
          // Every send produces a new toast, even when its text is unchanged.
          acknowledge();
        }
      });
      w.document.body.append(editor);
      maxEditors = Math.max(
        maxEditors,
        w.document.querySelectorAll(".composeReact").length,
      );
    });
  w.eval(bundle);
  return {
    w,
    sent,
    acknowledge,
    values,
    get confirmations() {
      return confirmations;
    },
    get composeCount() {
      return composeCount;
    },
    get maxEditors() {
      return maxEditors;
    },
    get openedTabs() {
      return openedTabs;
    },
    async open() {
      const launcher = w.document.getElementById("return-pd-launcher");
      assert.ok(launcher);
      launcher.shadowRoot!.querySelector("button")!.click();
      let root: ShadowRoot | null = null;
      await until(() => {
        root =
          w.document.querySelector("iframe")?.contentDocument?.body
            .firstElementChild?.shadowRoot || null;
        return (
          !!root?.querySelector('input[name="fio"]') &&
          !(root.querySelector(".overlay") as HTMLElement).hidden
        );
      }, "form must become ready");
      return root!;
    },
    input(root: ShadowRoot, name: string, value: string) {
      const input = root.querySelector<HTMLInputElement>(
        `input[name="${name}"]`,
      );
      assert.ok(input);
      input.value = value;
      input.dispatchEvent(new w.Event("input", { bubbles: true }));
    },
    delivery(root: ShadowRoot, mode: "send" | "draft") {
      const select = root.querySelector<HTMLSelectElement>(
        'select[name="deliveryMode"]',
      );
      assert.ok(select);
      select.value = mode;
      select.dispatchEvent(new w.Event("change", { bubbles: true }));
    },
    removeDraft() {
      const editor = w.document.querySelector(".composeReact");
      assert.ok(
        editor,
        "a prepared draft must exist before the user closes it",
      );
      editor.remove();
    },
    close() {
      if (closed) return;
      closed = true;
      w.dispatchEvent(new w.Event("pagehide"));
      dom.window.close();
    },
  };
}

function control(root: ParentNode, name: string) {
  const found = [...root.querySelectorAll("button")].find(
    (button) => button.textContent === name,
  );
  assert.ok(found, `${name} button must exist`);
  return found;
}
function selectCompany(root: ShadowRoot, name: string) {
  const checkbox = root.querySelector<HTMLInputElement>(
    `input[aria-label="Выбрать ${name}"]`,
  );
  assert.ok(checkbox, `${name} selection must exist`);
  checkbox.click();
}
function results(root: ShadowRoot) {
  return [...root.querySelectorAll<HTMLElement>(".results .result")];
}
function dock(root: ShadowRoot) {
  const dock = root.querySelector<HTMLElement>(".queue-dock");
  assert.ok(dock, "compact progress dock must exist");
  assert.equal(
    dock.hidden,
    false,
    "progress must remain visible above the mailbox",
  );
  return dock;
}
function fillProfile(p: ReturnType<typeof page>, root: ShadowRoot) {
  p.input(root, "fio", "Тест Проверки Скрипта");
  p.input(root, "email", "reply@example.invalid");
}
function selectTwo(root: ShadowRoot) {
  selectCompany(root, "МТС");
  selectCompany(root, "Купер");
}

// These are offline DOM fixtures: no actual email account or network is used.
test("one explicit launch sends all selected companies serially in the current document without opening tabs", async (t) => {
  const p = page();
  t.after(() => p.close());
  const originalUrl = p.w.location.href;
  const originalDocument = p.w.document;
  const root = await p.open();
  assert.equal(
    root.querySelector<HTMLSelectElement>('select[name="deliveryMode"]')!.value,
    "send",
  );
  assert.equal(control(root, "Отправить 0 писем").disabled, true);
  fillProfile(p, root);
  selectTwo(root);
  await tick();
  assert.equal(p.composeCount, 0);
  assert.equal(
    p.sent.length,
    0,
    "typing and selection must never start sending",
  );
  control(root, "Отправить 2 писем").click();
  await until(
    () =>
      results(root).filter(
        (row) => row.querySelector(".badge")?.textContent === "Отправлено",
      ).length === 2,
    "both messages must receive provider acknowledgement",
  );
  assert.equal(p.composeCount, 2);
  assert.equal(
    p.maxEditors,
    1,
    "the next editor must wait for the previous send to finish",
  );
  assert.equal(p.sent.length, 2);
  assert.equal(p.openedTabs, 0);
  assert.equal(p.confirmations, 0, "launch must not add a confirmation dialog");
  assert.equal(p.w.document, originalDocument);
  assert.equal(p.w.location.href, originalUrl);
  assert.ok(
    p.sent.every((letter) => letter.subject.includes("Тест Проверки Скрипта")),
  );
  assert.ok(
    p.sent.every(
      (letter) =>
        letter.body.includes("отзываю") &&
        letter.body.includes("reply@example.invalid"),
    ),
  );
  assert.deepEqual(
    p.sent.map((letter) => letter.to.length).sort(),
    [1, 2],
    "two addresses of one company must stay in one message",
  );
  assert.match(
    root.querySelector(".progress")!.textContent!,
    /Отправлено 2 из 2/,
  );
  assert.equal((root.querySelector(".overlay") as HTMLElement).hidden, true);
  assert.match(dock(root).textContent!, /Отправлено 2 из 2/);
  assert.equal(
    [...p.values.keys()].some((key) => key.startsWith(PREFIX)),
    false,
  );
});

test("launch collapses the modal to a stoppable dock and reopening does not remount inputs or repeat sends", async (t) => {
  const p = page();
  t.after(() => p.close());
  const root = await p.open();
  fillProfile(p, root);
  selectTwo(root);
  const fio = root.querySelector<HTMLInputElement>('input[name="fio"]')!;
  fio.setSelectionRange(3, 8);
  control(root, "Отправить 2 писем").click();
  await until(
    () => p.composeCount === 1,
    "first Compose must open in the mailbox",
  );
  assert.equal((root.querySelector(".overlay") as HTMLElement).hidden, true);
  const compact = dock(root);
  assert.equal(control(compact, "Остановить").disabled, false);
  const frame = p.w.document.querySelector("iframe")!;
  assert.notEqual(frame.style.width, "100%");
  assert.equal(frame.style.height, "192px");
  control(compact, "Открыть панель").click();
  assert.equal((root.querySelector(".overlay") as HTMLElement).hidden, false);
  assert.equal(root.querySelector('input[name="fio"]'), fio);
  assert.equal(fio.value, "Тест Проверки Скрипта");
  assert.equal(fio.selectionStart, 3);
  assert.equal(fio.selectionEnd, 8);
  assert.equal(p.composeCount, 1);
  assert.equal(control(root, "Отправить 2 писем").disabled, true);
  await until(
    () => p.sent.length === 2,
    "reopening must let the original queue finish",
  );
  assert.equal(p.composeCount, 2);
  assert.equal(p.openedTabs, 0);
});

test("draft mode prepares one draft and pauses until the user closes it and continues", async (t) => {
  const p = page();
  t.after(() => p.close());
  const root = await p.open();
  fillProfile(p, root);
  p.delivery(root, "draft");
  selectTwo(root);
  control(root, "Подготовить 2 черновиков").click();
  await until(
    () =>
      results(root).some(
        (row) => row.querySelector(".badge")?.textContent === "Поля заполнены",
      ),
    "the first draft must finish filling and pause the queue",
  );
  assert.equal(p.composeCount, 1);
  assert.equal(p.sent.length, 0);
  assert.equal(
    results(root)[1].querySelector(".badge")!.textContent,
    "В очереди",
  );
  assert.equal(control(dock(root), "Остановить").disabled, true);
  const firstDraft = p.w.document.querySelector(".composeReact")!;
  const firstText = firstDraft.textContent;
  await new Promise((resolve) => setTimeout(resolve, 180));
  assert.equal(
    p.composeCount,
    1,
    "draft mode may not auto-open the next editor",
  );
  assert.equal(firstDraft.textContent, firstText);
  p.removeDraft();
  control(root, "Продолжить очередь").click();
  await until(
    () =>
      results(root).filter(
        (row) => row.querySelector(".badge")?.textContent === "Поля заполнены",
      ).length === 2,
    "explicit Continue must prepare the remaining company",
  );
  assert.equal(p.composeCount, 2);
  assert.equal(p.maxEditors, 1);
  assert.equal(p.sent.length, 0);
  assert.equal(p.openedTabs, 0);
  assert.match(
    root.querySelector(".progress")!.textContent!,
    /Подготовлено 2 из 2/,
  );
});

test("stopping before Send preserves the current draft and does not advance or retry", async (t) => {
  const p = page();
  t.after(() => p.close());
  const root = await p.open();
  fillProfile(p, root);
  selectTwo(root);
  control(root, "Отправить 2 писем").click();
  await until(() => p.composeCount === 1, "a draft must open before Stop");
  control(dock(root), "Остановить").click();
  await until(
    () => results(root)[0]?.querySelector(".badge")?.textContent === "Ошибка",
    "stopping before Send must resolve without claiming success",
  );
  assert.ok(
    dock(root).textContent!.includes(
      results(root)[0].querySelector(".error")!.textContent!,
    ),
    "the pause reason must be visible without opening the full panel",
  );
  assert.equal(p.sent.length, 0);
  assert.equal(p.composeCount, 1);
  assert.ok(
    p.w.document.querySelector(".composeReact"),
    "the user's draft must remain untouched",
  );
  assert.equal(
    results(root)[1].querySelector(".badge")!.textContent,
    "В очереди",
  );
  assert.equal(
    p.confirmations,
    0,
    "Stop must never invoke the explicit retry flow",
  );
  await tick();
  assert.equal(p.sent.length, 0);
  assert.equal(p.openedTabs, 0);
});

test("an unacknowledged send remains uncertain after stopping and is never automatically repeated", async (t) => {
  const p = page(new Map(), { acknowledge: false });
  t.after(() => p.close());
  const root = await p.open();
  fillProfile(p, root);
  selectTwo(root);
  control(root, "Отправить 2 писем").click();
  await until(() => p.sent.length === 1, "first Send must be clicked");
  control(dock(root), "Остановить").click();
  await until(
    () =>
      results(root)[0]?.querySelector(".badge")?.textContent ===
      "Отправка не подтверждена",
    "missing acknowledgement after a click must remain uncertain",
  );
  assert.equal(p.composeCount, 1);
  assert.equal(
    results(root)[1].querySelector(".badge")!.textContent,
    "В очереди",
  );
  assert.equal(
    [...results(root)[0].querySelectorAll("button")].some((button) =>
      /Повторить/.test(button.textContent!),
    ),
    false,
  );
  assert.doesNotMatch(
    root.querySelector(".progress")!.textContent!,
    /Отправлено [12] из 2/,
  );
  await tick();
  assert.equal(p.sent.length, 1);
  assert.equal(p.openedTabs, 0);
});

test("a busy mailbox lock keeps the form open and does not create any editor", async (t) => {
  const p = page(new Map(), { lockAvailable: false });
  t.after(() => p.close());
  const root = await p.open();
  fillProfile(p, root);
  selectCompany(root, "МТС");
  control(root, "Отправить 1 писем").click();
  await until(
    () => !(root.querySelector(".error") as HTMLElement).hidden,
    "lock conflict must be explained in the form",
  );
  assert.equal((root.querySelector(".overlay") as HTMLElement).hidden, false);
  assert.equal(p.composeCount, 0);
  assert.equal(p.sent.length, 0);
  assert.equal(p.openedTabs, 0);
});

test("reopening and reloading restore the profile without resuming or starting a mailing", async (t) => {
  const values = new Map<string, unknown>([
    [
      PROFILE_KEY,
      { fio: "Тест Проверки Скрипта", email: "reply@example.invalid" },
    ],
  ]);
  const first = page(values);
  t.after(() => first.close());
  const root = await first.open();
  selectCompany(root, "МТС");
  control(root, "Отправить 1 писем").click();
  await until(
    () =>
      results(root)[0]?.querySelector(".badge")?.textContent === "Отправлено",
    "first explicit mailing must finish",
  );
  control(dock(root), "Открыть панель").click();
  control(root, "Закрыть").click();
  assert.equal(await first.open(), root);
  assert.equal(
    first.sent.length,
    1,
    "reopening a completed panel must not repeat its mailing",
  );
  first.close();
  const reloaded = page(values);
  t.after(() => reloaded.close());
  const restored = await reloaded.open();
  assert.equal(
    restored.querySelector<HTMLInputElement>('input[name="fio"]')!.value,
    "Тест Проверки Скрипта",
  );
  assert.equal(
    restored.querySelector<HTMLInputElement>('input[name="email"]')!.value,
    "reply@example.invalid",
  );
  assert.equal(
    [
      ...restored.querySelectorAll<HTMLInputElement>('input[type="checkbox"]'),
    ].some((input) => input.checked),
    false,
  );
  assert.equal(control(restored, "Отправить 0 писем").disabled, true);
  await tick();
  assert.equal(reloaded.composeCount, 0);
  assert.equal(reloaded.sent.length, 0);
  assert.equal(reloaded.openedTabs, 0);
});

test("reloading during acknowledgement never resumes the in-flight message or remaining companies", async (t) => {
  const values = new Map<string, unknown>();
  const first = page(values, { acknowledge: false });
  t.after(() => first.close());
  const root = await first.open();
  fillProfile(first, root);
  selectTwo(root);
  control(root, "Отправить 2 писем").click();
  await until(
    () => first.sent.length === 1,
    "a send click must precede the simulated reload",
  );
  first.close();

  const reloaded = page(values);
  t.after(() => reloaded.close());
  const restored = await reloaded.open();
  assert.equal(
    restored.querySelector<HTMLInputElement>('input[name="fio"]')!.value,
    "Тест Проверки Скрипта",
  );
  assert.equal(control(restored, "Отправить 0 писем").disabled, true);
  assert.equal(results(restored).length, 0);
  await new Promise((resolve) => setTimeout(resolve, 180));
  assert.equal(
    first.sent.length,
    1,
    "the closed page may not click Send again",
  );
  assert.equal(reloaded.composeCount, 0);
  assert.equal(reloaded.sent.length, 0);
  assert.equal(reloaded.openedTabs, 0);
  assert.equal(
    [...values.keys()].some((key) => key.startsWith(PREFIX)),
    false,
  );
  const receiptValues = [...values].filter(([key]) =>
    key.startsWith("return-pd:receipt:"),
  );
  assert.equal(receiptValues.length, 1);
  assert.deepEqual(
    Object.keys(receiptValues[0][1] as object).sort(),
    ["expires", "id", "state"],
    "an interrupted attempt keeps only an opaque receipt, without letter or account data",
  );
});

test("50-company progress names the acknowledgement being awaited and renders full results only on demand", async (t) => {
  const p = page(new Map(), { acknowledge: false });
  t.after(() => p.close());
  const root = await p.open();
  fillProfile(p, root);
  control(root, "Выбрать все").click();
  control(root, "Отправить 50 писем").click();
  await until(
    () => p.sent.length === 1,
    "first Send must be waiting for acknowledgement",
  );
  assert.equal(results(root).length, 50);
  assert.equal(
    root.querySelectorAll(".results pre").length,
    0,
    "collapsed results must not build 50 full letters during the send callback",
  );
  assert.match(dock(root).textContent!, /Отправлено 0 из 50/);
  assert.match(dock(root).textContent!, /МТС: ждём подтверждения почты/);
  const firstRow = results(root)[0];
  control(dock(root), "Открыть панель").click();
  const details = firstRow.querySelector("details")!;
  details.open = true;
  await until(
    () => !!details.querySelector("pre"),
    "expanded result must load its letter",
  );
  const body = details.querySelector("pre")!;
  assert.match(body.textContent!, /отзываю/);
  assert.equal(root.querySelectorAll(".results pre").length, 1);
  p.acknowledge();
  await until(
    () => p.sent.length === 2,
    "second company must reach Send after the first acknowledgement",
  );
  assert.equal(
    results(root)[0],
    firstRow,
    "progress changes must preserve the result row",
  );
  assert.equal(firstRow.querySelector("details"), details);
  assert.equal(
    details.open,
    true,
    "reading a result may not be interrupted by queue updates",
  );
  assert.equal(details.querySelector("pre"), body);
  assert.equal(root.querySelectorAll(".results pre").length, 1);
  control(root, "Закрыть").click();
  assert.match(dock(root).textContent!, /Отправлено 1 из 50/);
  assert.match(
    dock(root).textContent!,
    /МТС: отправлено\. ОККО: ждём подтверждения почты/,
  );
  control(dock(root), "Остановить").click();
  await until(
    () =>
      results(root)[1].querySelector(".badge")!.textContent ===
      "Отправка не подтверждена",
    "stopping an unacknowledged send must expose the terminal reason",
  );
  assert.match(dock(root).textContent!, /ОККО: подтверждение не получено/);
  assert.match(dock(root).textContent!, /Очередь приостановлена/);
  assert.match(dock(root).textContent!, /Проверьте «Отправленные»/);
  assert.match(dock(root).textContent!, /продолжение — в панели/);
  assert.doesNotMatch(
    dock(root).textContent!,
    /ждём подтверждения|Отправляется/,
  );
  assert.equal(control(dock(root), "Остановить").disabled, true);
  control(dock(root), "Открыть панель").click();
  assert.equal(control(root, "Продолжить очередь").hidden, false);
  assert.equal(
    p.sent.length,
    2,
    "opening the explanation must not resume or repeat any company",
  );
  assert.equal(p.openedTabs, 0);
});

test("continuing from an uncertain result keeps the correct total and does not retry the uncertain company", async (t) => {
  const p = page(new Map(), { acknowledge: false });
  t.after(() => p.close());
  const root = await p.open();
  fillProfile(p, root);
  for (const name of ["МТС", "ОККО", "Купер"]) selectCompany(root, name);
  control(root, "Отправить 3 писем").click();
  await until(() => p.sent.length === 1, "first send");
  p.acknowledge();
  await until(() => p.sent.length === 2, "second send");
  control(dock(root), "Остановить").click();
  await until(
    () =>
      results(root)[1].querySelector(".badge")!.textContent ===
      "Отправка не подтверждена",
    "second send must be uncertain",
  );
  control(dock(root), "Открыть панель").click();
  control(root, "Продолжить очередь").click();
  await until(
    () => p.sent.length === 3,
    "only the remaining third company must send",
  );
  p.acknowledge();
  await until(
    () =>
      results(root)[2].querySelector(".badge")!.textContent === "Отправлено",
    "third company must be confirmed",
  );
  assert.match(dock(root).textContent!, /Отправлено 2 из 3/);
  assert.match(dock(root).textContent!, /ОККО: подтверждение не получено/);
  assert.match(dock(root).textContent!, /Проверьте «Отправленные»/);
  assert.doesNotMatch(
    dock(root).textContent!,
    /ждём подтверждения|продолжение — в панели/,
  );
  assert.equal(p.sent.length, 3);
  assert.equal(p.composeCount, 3);
  assert.equal(p.openedTabs, 0);
});

function priorYandexNotice(p: ReturnType<typeof page>) {
  const statusline = p.w.document.createElement("div");
  statusline.setAttribute("role", "alert");
  statusline.dataset.testid = "statusline_root_container";
  statusline.innerHTML =
    '<div class="qa-StatuslineRoot"><div data-testid="statusline_item_container"><div name="MessageSent"><span>Message sent</span></div></div></div>';
  p.w.document.body.append(statusline);
  return statusline;
}

for (const action of ["release", "stop"] as const) {
  test(`waiting for Yandex's previous notification is visible and cancellable before Send (${action})`, async (t) => {
    const p = page();
    t.after(() => p.close());
    const root = await p.open();
    fillProfile(p, root);
    selectTwo(root);
    const oldNotice = priorYandexNotice(p);
    control(root, "Отправить 2 писем").click();
    await until(
      () =>
        results(root)[0]?.querySelector(".badge")?.textContent ===
        "Ждём готовности Яндекса к следующей отправке",
      "the pre-send wait must have its own UI state",
    );
    const compact = dock(root);
    assert.match(
      compact.textContent!,
      /МТС · Ждём готовности Яндекса к следующей отправке/,
    );
    assert.match(compact.textContent!, /Отправлено 0 из 2/);
    assert.doesNotMatch(compact.textContent!, /ждём подтверждения почты/);
    assert.equal(control(compact, "Остановить").disabled, false);
    assert.equal(p.sent.length, 0, "waiting is before any Send click");
    assert.equal(
      [...p.values.keys()].some((key) => key.startsWith("return-pd:receipt:")),
      false,
      "waiting must not record a send attempt",
    );
    if (action === "release") {
      oldNotice
        .querySelector('[data-testid="statusline_item_container"]')!
        .remove();
      await until(
        () =>
          results(root).every(
            (row) => row.querySelector(".badge")?.textContent === "Отправлено",
          ),
        "the original queue must continue when the prior notification expires",
      );
      assert.equal(p.sent.length, 2);
      assert.equal(p.composeCount, 2);
      assert.match(dock(root).textContent!, /Отправлено 2 из 2/);
      assert.doesNotMatch(
        dock(root).textContent!,
        /Ждём готовности|ждём подтверждения/,
      );
    } else {
      control(compact, "Остановить").click();
      await until(
        () =>
          results(root)[0]?.querySelector(".badge")?.textContent === "Ошибка",
        "stopping the wait must finish without an uncertain send",
      );
      assert.equal(p.sent.length, 0);
      assert.equal(p.composeCount, 1);
      assert.equal(
        results(root)[1].querySelector(".badge")!.textContent,
        "В очереди",
      );
      assert.equal(control(dock(root), "Остановить").disabled, true);
      assert.equal(
        [...p.values.keys()].some((key) =>
          key.startsWith("return-pd:receipt:"),
        ),
        false,
      );
    }
    assert.equal(p.openedTabs, 0);
  });
}
