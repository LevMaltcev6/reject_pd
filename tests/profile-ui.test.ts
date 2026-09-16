import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";

const bundle = readFileSync(
  new URL("../dist/return-pd.user.js", import.meta.url),
  "utf8",
);
const PROFILE_KEY = "return-pd:profile-v1";
const tick = () => new Promise((resolve) => setTimeout(resolve, 10));
async function until(check: () => boolean, message: string) {
  for (let attempt = 0; attempt < 200; attempt++) {
    if (check()) return;
    await tick();
  }
  assert.ok(check(), message);
}
const dateValue = (time: number) => {
  const date = new Date(time);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
};

function page(
  values = new Map<string, unknown>(),
  options: {
    now?: number;
    failWrites?: boolean;
    manualIntervals?: boolean;
  } = {},
) {
  const dom = new JSDOM("<!doctype html><body></body>", {
    url: "https://mail.yandex.ru/",
    runScripts: "outside-only",
    pretendToBeVisual: true,
  });
  const w = dom.window;
  let clock = options.now ?? Date.now();
  if (options.now !== undefined) {
    w.Date = class extends Date {
      constructor(value?: string | number) {
        super(value === undefined ? clock : value);
      }
      static now() {
        return clock;
      }
    } as DateConstructor;
  }
  const intervals = new Map<number, () => void>();
  if (options.manualIntervals) {
    let timerId = 0;
    w.setInterval = (
      handler: TimerHandler,
      _delay?: number,
      ...args: unknown[]
    ) => {
      assert.equal(typeof handler, "function");
      const id = ++timerId;
      intervals.set(id, () =>
        (handler as (...args: unknown[]) => void)(...args),
      );
      return id;
    };
    w.clearInterval = (id: number | undefined) => {
      if (id !== undefined) intervals.delete(id);
    };
  }
  const writes: { key: string; value: unknown }[] = [];
  Object.assign(w, {
    structuredClone,
    GM_listValues: () => [...values.keys()],
    GM_getValue: (key: string) => structuredClone(values.get(key)),
    GM_setValue: (key: string, value: unknown) => {
      if (options.failWrites)
        throw new Error(
          "PRIVATE_STORAGE_ERROR passport 1234 567890 private@example.invalid",
        );
      writes.push({ key, value: structuredClone(value) });
      values.set(key, structuredClone(value));
    },
    GM_deleteValue: (key: string) => values.delete(key),
    GM_registerMenuCommand: () => {},
    GM_setClipboard: () => {},
    GM_openInTab: () => {
      assert.fail("Editing a personal profile must not open a mail task");
    },
  });
  Object.defineProperty(w.navigator, "locks", {
    value: {
      request: async (
        _name: string,
        _options: unknown,
        callback: (lock: object) => unknown,
      ) => callback({}),
    },
  });
  w.eval(bundle);
  return {
    dom,
    w,
    writes,
    values,
    setTime(value: number) {
      clock = value;
    },
    fireIntervals() {
      for (const callback of [...intervals.values()]) callback();
    },
    async open() {
      const launcher = w.document.getElementById("return-pd-launcher");
      assert.ok(launcher, "built script must mount its launcher");
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
      }, "personal data form must become ready");
      return root!;
    },
    input(root: ShadowRoot, name: string, value: string) {
      const input = root.querySelector<HTMLInputElement>(
        `input[name="${name}"]`,
      );
      assert.ok(input, `${name} input must exist`);
      input.value = value;
      input.dispatchEvent(new w.Event("input", { bubbles: true }));
      return input;
    },
    close() {
      w.dispatchEvent(new w.Event("pagehide"));
      dom.window.close();
    },
  };
}

function control(root: ShadowRoot, name: string) {
  const found = [...root.querySelectorAll("button")].find(
    (button) => button.textContent === name,
  );
  assert.ok(found, `${name} button must exist`);
  return found;
}

const personal = {
  fio: " Иванов Иван Иванович ",
  email: "reply@example.invalid",
};
function assertPersonal(root: ShadowRoot, expected: Record<string, string>) {
  for (const [name, value] of Object.entries(expected)) {
    assert.equal(
      root.querySelector<HTMLInputElement>(`input[name="${name}"]`)!.value,
      value,
      `${name} must restore`,
    );
  }
}

test("built profile UI restores all entered fields after closing, reopening and a browser page reload", async (t) => {
  const values = new Map<string, unknown>();
  const first = page(values);
  t.after(() => first.close());
  const root = await first.open();
  for (const [name, value] of Object.entries(personal))
    first.input(root, name, value);
  await until(
    () => JSON.stringify(values.get(PROFILE_KEY)).includes(personal.email),
    "profile input must be saved before closing the panel",
  );
  const writesBeforeClose = first.writes.length;
  control(root, "Закрыть").click();
  assert.equal(await first.open(), root);
  assertPersonal(root, personal);
  assert.equal(
    first.writes.length,
    writesBeforeClose,
    "reopening does not resave the profile",
  );
  first.close();
  assert.equal(
    first.writes.length,
    writesBeforeClose,
    "page disposal does not resave stale profile values",
  );

  const reloaded = page(values);
  t.after(() => reloaded.close());
  assertPersonal(await reloaded.open(), personal);
  assert.equal(
    reloaded.writes.length,
    0,
    "loading saved fields must not rewrite storage",
  );
});

test("built UI persists partial edits and explicit deletions without requiring a valid complete profile", async (t) => {
  const values = new Map<string, unknown>();
  const first = page(values);
  t.after(() => first.close());
  const root = await first.open();
  first.input(root, "fio", "Иванов Иван");
  first.input(root, "email", personal.email);
  await until(
    () => JSON.stringify(values.get(PROFILE_KEY)).includes(personal.email),
    "initial profile must save",
  );
  first.input(root, "fio", "Ива");
  first.input(root, "email", "");
  await until(() => {
    const saved = JSON.stringify(values.get(PROFILE_KEY));
    return saved.includes("Ива") && !saved.includes(personal.email);
  }, "deletions must replace previously stored fields");
  first.close();

  const reloaded = page(values);
  t.after(() => reloaded.close());
  assertPersonal(await reloaded.open(), { fio: "Ива", email: "" });
});

test("updated company requisites replace stale saved details while custom recipients survive editing and reload", async (t) => {
  const catalogKey = "return-pd:catalog-v1";
  const companyId = "5a282799e3e5";
  const customEmail = "saved-recipient@example.invalid";
  const editedEmail = "edited-recipient@example.invalid";
  const values = new Map<string, unknown>([
    [PROFILE_KEY, personal],
    [
      catalogKey,
      {
        [companyId]: {
          legalName: "STALE_LEGAL_NAME",
          inn: "",
          ogrn: "1111111111111",
          emails: [customEmail],
        },
      },
    ],
  ]);
  const recipientInput = (root: ShadowRoot) => {
    const card = [...root.querySelectorAll("details")].find(
      (details) =>
        details.querySelector("summary")?.textContent ===
        "Адреса и примечания компании",
    );
    assert.ok(card, "company recipient editor must remain available");
    const input = card.querySelector("input");
    assert.ok(input);
    return input;
  };
  const assertFreshRequisites = (root: ShadowRoot, recipient: string) => {
    const body = root.querySelector("pre")?.textContent || "";
    assert.match(body, /ПАО «МТС»/);
    assert.match(body, /ИНН организации: 7740000076/);
    assert.match(body, /ОГРН организации: 1027700149124/);
    assert.doesNotMatch(body, /STALE_LEGAL_NAME|1111111111111/);
    assert.equal(recipientInput(root).value, recipient);
    assert.equal(
      root.querySelector(".preview-title")?.nextElementSibling?.textContent,
      `Кому: ${recipient}`,
    );
    const fieldLabels = [...root.querySelectorAll("label")]
      .map((label) => label.firstChild?.textContent || "")
      .join("\n");
    assert.doesNotMatch(
      fieldLabels,
      /Юридическое наименование|ИНН организации|ОГРН организации/,
      "imported company requisites must not reintroduce removed form fields",
    );
  };

  const first = page(values);
  t.after(() => first.close());
  const root = await first.open();
  assertFreshRequisites(root, customEmail);

  const input = recipientInput(root);
  input.value = editedEmail;
  input.dispatchEvent(new first.w.Event("input", { bubbles: true }));
  await until(
    () =>
      root.querySelector(".preview-title")?.nextElementSibling?.textContent ===
      `Кому: ${editedEmail}`,
    "recipient changes must reach the letter preview",
  );
  const saved = values.get(catalogKey) as Record<
    string,
    Record<string, unknown>
  >;
  assert.deepEqual(saved[companyId].emails, [editedEmail]);
  for (const entry of Object.values(saved)) {
    for (const key of ["legalName", "inn", "ogrn"]) {
      assert.equal(
        Object.hasOwn(entry, key),
        false,
        `${key} must not be persisted alongside recipient overrides`,
      );
    }
  }
  assertFreshRequisites(root, editedEmail);
  first.close();

  const reloaded = page(values);
  t.after(() => reloaded.close());
  assertFreshRequisites(await reloaded.open(), editedEmail);
});

test("persistent profile excludes date, selected companies, templates and letter session data", async (t) => {
  const values = new Map<string, unknown>();
  const firstDate = new Date(2030, 0, 2, 12).getTime();
  const nextDate = new Date(2030, 0, 3, 12).getTime();
  const first = page(values, { now: firstDate });
  t.after(() => first.close());
  const root = await first.open();
  first.input(root, "fio", personal.fio);
  first.input(root, "email", personal.email);
  first.input(root, "date", "1999-12-31");
  root.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click();
  const editor = [...root.querySelectorAll("details")].find(
    (details) =>
      details.querySelector("summary")?.textContent ===
      "Изменить тему и текст шаблона",
  )!;
  assert.ok(editor);
  const subject = editor.querySelector("input")!;
  const body = editor.querySelector("textarea")!;
  const originalBody = body.value;
  const originalSubject = subject.value;
  subject.value = "SESSION_SUBJECT_ONLY";
  subject.dispatchEvent(new first.w.Event("input", { bubbles: true }));
  body.value = "SESSION_LETTER_BODY_ONLY {{ФИО}}";
  body.dispatchEvent(new first.w.Event("input", { bubbles: true }));
  const interaction = root.querySelector<HTMLTextAreaElement>(
    "textarea[placeholder]",
  )!;
  interaction.value = "SESSION_INTERACTION_ONLY";
  interaction.dispatchEvent(new first.w.Event("input", { bubbles: true }));
  await until(() => values.has(PROFILE_KEY), "profile must be stored");
  assert.deepEqual([...values.keys()], [PROFILE_KEY]);
  assert.doesNotMatch(
    JSON.stringify(values.get(PROFILE_KEY)),
    /1999-12-31|SESSION_|"date"|"selected"|"template"|"letter"|"job"/,
  );
  first.close();

  const reloaded = page(values, { now: nextDate });
  t.after(() => reloaded.close());
  const newRoot = await reloaded.open();
  assertPersonal(newRoot, {
    fio: personal.fio,
    email: personal.email,
    date: dateValue(nextDate),
  });
  assert.equal(
    [
      ...newRoot.querySelectorAll<HTMLInputElement>('input[type="checkbox"]'),
    ].some((checkbox) => checkbox.checked),
    false,
  );
  const newEditor = [...newRoot.querySelectorAll("details")].find(
    (details) =>
      details.querySelector("summary")?.textContent ===
      "Изменить тему и текст шаблона",
  )!;
  assert.equal(newEditor.querySelector("input")!.value, originalSubject);
  assert.equal(newEditor.querySelector("textarea")!.value, originalBody);
  assert.equal(
    newRoot.querySelector<HTMLTextAreaElement>("textarea[placeholder]")!.value,
    "",
  );
});

test("Clear data removes the saved profile and a fresh page cannot restore it", async (t) => {
  const values = new Map<string, unknown>();
  const first = page(values);
  t.after(() => first.close());
  const root = await first.open();
  for (const [name, value] of Object.entries(personal))
    first.input(root, name, value);
  await until(
    () => values.has(PROFILE_KEY),
    "profile must save before clearing",
  );
  control(root, "Очистить данные").click();
  assert.equal(values.has(PROFILE_KEY), false);
  const empty = Object.fromEntries(
    Object.keys(personal).map((name) => [name, ""]),
  );
  assertPersonal(root, empty);
  control(root, "Закрыть").click();
  await first.open();
  assert.equal(
    values.has(PROFILE_KEY),
    false,
    "reopening must not recreate a deleted profile",
  );
  first.close();

  const reloaded = page(values);
  t.after(() => reloaded.close());
  assertPersonal(await reloaded.open(), empty);
  assert.equal(values.has(PROFILE_KEY), false);
});

test("storage failures show a static status while preserving field node, edit, focus and caret", async (t) => {
  const first = page(new Map(), { failWrites: true });
  t.after(() => first.close());
  const root = await first.open();
  const input = root.querySelector<HTMLInputElement>('input[name="fio"]')!;
  input.focus();
  input.value = "Иванов Иван";
  input.setSelectionRange(3, 6);
  input.dispatchEvent(new first.w.Event("input", { bubbles: true }));
  await until(
    () =>
      /не удалось|не сохран|ошиб/i.test(
        root.querySelector('[data-role="profile-storage-status"]')
          ?.textContent || "",
      ),
    "autosave failure must be visible",
  );
  const status = root.querySelector('[data-role="profile-storage-status"]')!;
  assert.doesNotMatch(
    status.textContent!,
    /PRIVATE_STORAGE_ERROR|1234 567890|private@example|Иванов/,
  );
  assert.equal(root.querySelector('input[name="fio"]'), input);
  assert.equal(input.isConnected, true);
  assert.equal(input.value, "Иванов Иван");
  assert.equal(root.activeElement, input);
  assert.equal(input.selectionStart, 3);
  assert.equal(input.selectionEnd, 6);
  assert.equal(first.values.has(PROFILE_KEY), false);
  // Include the debounced preview update, which previously disrupted editing.
  await new Promise((resolve) => setTimeout(resolve, 180));
  assert.equal(root.querySelector('input[name="fio"]'), input);
  assert.equal(root.activeElement, input);
  assert.equal(input.selectionStart, 3);
  assert.equal(input.selectionEnd, 6);
});

test("automatic job expiry clears temporary work while preserving saved profile and catalog", async (t) => {
  const values = new Map<string, unknown>();
  const firstTime = new Date(2030, 0, 2, 12).getTime();
  const first = page(values, { now: firstTime, manualIntervals: true });
  t.after(() => first.close());
  const root = await first.open();
  first.input(root, "fio", personal.fio);
  first.input(root, "email", personal.email);
  const companyCard = [...root.querySelectorAll("details")].find(
    (details) =>
      details.querySelector("summary")?.textContent ===
      "Адреса и примечания компании",
  )!;
  const companyName = companyCard.querySelector("input")!;
  companyName.value = "saved-catalog@example.org";
  companyName.dispatchEvent(new first.w.Event("input", { bubbles: true }));
  const savedProfile = structuredClone(values.get(PROFILE_KEY));
  const catalogKey = "return-pd:catalog-v1";
  const savedCatalog = structuredClone(values.get(catalogKey));
  assert.ok(savedProfile);
  assert.ok(savedCatalog);
  const temporaryKey = "return-pd:job:temporary-expired";
  values.set(temporaryKey, {
    expires: firstTime + 1000,
    letter: "TEMPORARY_ONLY",
  });
  const foreignKey = "return-pd:job:active-other-tab";
  const foreignCreated = firstTime + 24 * 60 * 60 * 1000 - 1000;
  first.setTime(foreignCreated);
  const foreignJob = {
    owner: "other-tab",
    state: "claimed",
    created: foreignCreated,
    expires: foreignCreated + 24 * 60 * 60 * 1000,
    letter: "OTHER_TAB_STILL_PREPARING",
  };
  values.set(foreignKey, structuredClone(foreignJob));
  root.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click();

  first.setTime(firstTime + 24 * 60 * 60 * 1000 + 1);
  first.fireIntervals();
  assert.deepEqual(values.get(PROFILE_KEY), savedProfile);
  assert.deepEqual(values.get(catalogKey), savedCatalog);
  assert.equal(values.has(temporaryKey), false);
  assert.deepEqual(
    values.get(foreignKey),
    foreignJob,
    "one panel's expiry must not cancel another tab's active job",
  );
  assertPersonal(root, {
    fio: personal.fio,
    email: personal.email,
  });
  assert.equal(
    [...root.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')].some(
      (checkbox) => checkbox.checked,
    ),
    false,
  );
  first.close();

  const reloaded = page(values, { now: firstTime + 24 * 60 * 60 * 1000 });
  t.after(() => reloaded.close());
  const newRoot = await reloaded.open();
  assertPersonal(newRoot, {
    fio: personal.fio,
    email: personal.email,
  });
  assert.deepEqual(values.get(catalogKey), savedCatalog);
  assert.deepEqual(values.get(foreignKey), foreignJob);
});

test("composed text is saved on compositionend without persisting an intermediate composition", async (t) => {
  const first = page();
  t.after(() => first.close());
  const root = await first.open();
  const input = first.input(root, "fio", "Иван");
  const beforeComposition = structuredClone(first.values.get(PROFILE_KEY));
  input.value = "Иван П";
  input.dispatchEvent(
    new first.w.InputEvent("input", { bubbles: true, isComposing: true }),
  );
  assert.deepEqual(first.values.get(PROFILE_KEY), beforeComposition);
  input.value = "Иван Петров";
  input.dispatchEvent(
    new first.w.CompositionEvent("compositionend", { bubbles: true }),
  );
  await until(
    () => JSON.stringify(first.values.get(PROFILE_KEY)).includes("Иван Петров"),
    "finished composition must save",
  );
  assert.equal(root.querySelector('input[name="fio"]'), input);
});

test("removed personal fields are absent and legacy saved values never enter preview", async (t) => {
  const legacy = {
    inn: "LEGACY_INN",
    phone: "LEGACY_PHONE",
    series: "LEGACY_SERIES",
    number: "LEGACY_NUMBER",
    issuer: "LEGACY_ISSUER",
    city: "LEGACY_CITY",
    issued: "2000-01-01",
  };
  const values = new Map<string, unknown>([
    [PROFILE_KEY, { ...personal, ...legacy }],
  ]);
  const current = page(values);
  t.after(() => current.close());
  const root = await current.open();
  assertPersonal(root, personal);
  for (const key of Object.keys(legacy)) {
    assert.equal(root.querySelector(`input[name="${key}"]`), null);
  }
  root.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click();
  await until(
    () => (root.textContent || "").includes("ОТЗЫВ СОГЛАСИЯ"),
    "preview must render",
  );
  for (const value of Object.values(legacy)) {
    assert.ok(
      !(root.textContent || "").includes(value),
      `legacy value ${value} must not enter preview`,
    );
  }
  assert.ok(!(root.textContent || "").includes("Серия паспорта"));
});
