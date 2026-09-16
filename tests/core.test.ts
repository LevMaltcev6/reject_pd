import { test } from "node:test";
import assert from "node:assert/strict";
import data from "../src/generated/data.json";
import { makeLetter, substitute } from "../src/letters";
import {
  Queue,
  AttemptedError,
  cleanExpired,
  PREFIX,
  type Store,
} from "../src/queue";
import type { Company, Profile } from "../src/types";

const profile: Profile = {
  fio: "Иванов Иван Иванович",
  email: "ivan@example.org",
  inn: "123456789012",
  phone: "+79990000000",
  series: "1234",
  number: "567890",
  issuer: "Тестовый орган",
  city: "Москва",
  issued: "2020-01-02",
  date: "2026-09-14",
};
const company: Company = {
  ...data.companies[0],
  legalName: "ООО Тест",
  inn: "1234567890",
  ogrn: "1234567890123",
};
const letter = () =>
  makeLetter(company, profile, "withdrawal", data.templates.withdrawal);
test("source catalog has 50 companies, 53 distinct addresses and preserved statuses", () => {
  assert.equal(data.companies.length, 50);
  const emails = data.companies.flatMap((c) => c.emails);
  assert.equal(emails.length, 53);
  assert.equal(new Set(emails.map((e) => e.toLowerCase())).size, 53);
  assert.equal(data.companies.filter((c) => c.emails.length === 2).length, 3);
  assert.equal(
    data.companies.filter((c) => c.sourceStatus === "Ответ получен, ПД удалены")
      .length,
    22,
  );
  assert.equal(data.companies.filter((c) => c.special).length, 2);
  for (const company of data.companies) {
    assert.ok(company.legalName);
    assert.match(company.inn, /^\d{10}$/);
    assert.match(company.ogrn, /^\d{13}$/);
  }
  const mts = data.companies.find((c) => c.name === "МТС")!;
  assert.equal(mts.id, "5a282799e3e5");
  assert.equal(mts.legalName, "ПАО «МТС»");
  assert.equal(mts.inn, "7740000076");
  assert.equal(mts.ogrn, "1027700149124");
  assert.equal(
    data.companies.find((c) => c.legalName === "ПАО «БАНК УРАЛСИБ»")!.inn,
    "0274062111",
  );
});
test("both Word templates retain every numbered item and normalize placeholders", () => {
  assert.equal(data.templates.withdrawal.body.match(/^\d+\. /gm)?.length, 4);
  assert.equal(data.templates.inquiry.body.match(/^\d+\. /gm)?.length, 12);
  assert.doesNotMatch(data.templates.withdrawal.body, /образцу, приложенному/);
  assert.match(data.templates.withdrawal.body, /Хантфлоу/);
  assert.doesNotMatch(data.templates.inquiry.body, /НАИМЕНОВАНИЕ|Я, ФИО/);
});
test("letter includes separate passport series and number, dates and legal name", () => {
  const l = letter();
  assert.match(l.body, /серия 1234, № 567890/);
  assert.match(l.body, /ООО Тест/);
  assert.match(l.body, /14.09.2026/);
  assert.equal(l.missing.length, 0);
  assert.equal(l.to.length, 1);
  assert.doesNotMatch(l.body, /\{\{|\[[^\]]+\]|_{3,}/);
});
test("missing optional values are reported without empty placeholders", () => {
  const p = {
    ...profile,
    inn: "",
    series: "",
    number: "",
    issuer: "",
    city: "",
    issued: "",
    phone: "",
  };
  const l = makeLetter(data.companies[0], p, "inquiry", data.templates.inquiry);
  assert.equal(l.missing.length, 1);
  assert.doesNotMatch(l.body, /Паспорт:|Телефон:|\[|\{\{/);
  assert.ok(l.actions.some((a) => a.includes("не подписан")));
});
test("inquiry adds company-specific context and never withdrawal instructions", () => {
  const c = data.companies.find((c) => c.special === "pdf")!;
  const l = makeLetter(
    c,
    profile,
    "inquiry",
    data.templates.inquiry,
    "Отклик на вакансию 01.09.2026",
  );
  assert.match(l.body, /Отклик на вакансию/);
  assert.doesNotMatch(l.body, /В пункте 11/);
  assert.ok(!l.actions.some((a) => a.includes("PDF")));
});
test("withdrawal inserts Sber Mobile instructions and PDF action; Kontur requires signature", () => {
  const s = makeLetter(
    data.companies.find((c) => c.special === "pdf")!,
    profile,
    "withdrawal",
    data.templates.withdrawal,
  );
  assert.match(s.body, /В пункте 11/);
  assert.match(s.body, /Прошу рассмотреть моё обращение в электронном виде/);
  assert.ok(s.actions.some((a) => a.includes("PDF")));
  const k = makeLetter(
    data.companies.find((c) => c.special === "signature")!,
    profile,
    "withdrawal",
    data.templates.withdrawal,
  );
  assert.ok(k.actions.some((a) => a.includes("от руки")));
});
test("invalid data and unknown template variables block preparation", () => {
  assert.throws(() => substitute("{{Номер}}", {}), /Неизвестная/);
  assert.throws(
    () =>
      makeLetter(
        company,
        { ...profile, email: "x" },
        "withdrawal",
        data.templates.withdrawal,
      ),
    /email/,
  );
  assert.throws(
    () =>
      makeLetter(
        { ...company, emails: ["x@y"] },
        profile,
        "withdrawal",
        data.templates.withdrawal,
      ),
    /адреса/,
  );
  assert.throws(
    () =>
      makeLetter(company, profile, "withdrawal", {
        subject: "a\nb",
        body: "test",
      }),
    /одной строкой/,
  );
});
test("edited long Cyrillic template and two recipients survive intact", () => {
  const c = data.companies.find((c) => c.emails.length === 2)!;
  const body = "Данные ".repeat(10000) + "{{ФИО}}";
  const l = makeLetter(c, profile, "withdrawal", {
    subject: "Обращение {{ФИО}}",
    body,
  });
  assert.equal(l.to.length, 2);
  assert.ok(l.body.includes("Данные ".repeat(10000)));
  assert.equal(l.subject, "Обращение " + profile.fio);
});
test("queue handles 50 companies serially, without repeating completed letters", async () => {
  let active = 0,
    max = 0,
    calls = 0;
  const q = new Queue(
    Array.from({ length: 50 }, letter),
    {
      async prepare() {
        active++;
        max = Math.max(max, active);
        await Promise.resolve();
        active--;
        calls++;
      },
    },
    () => {},
  );
  await q.run();
  await q.run(true);
  assert.equal(max, 1);
  assert.equal(calls, 50);
  assert.ok(q.items.every((i) => i.status === "manual"));
});
test("stop leaves unopened entries queued; explicit resume proceeds", async () => {
  let calls = 0;
  const q = new Queue(
    [letter(), letter(), letter()],
    {
      async prepare() {
        calls++;
        if (calls === 1) q.stop();
      },
    },
    () => {},
  );
  await q.run();
  assert.equal(calls, 1);
  assert.equal(q.items[1].status, "queued");
  await q.run();
  assert.equal(calls, 3);
});
test("uncertain draft pauses queue and is never retried automatically", async () => {
  let calls = 0;
  const q = new Queue(
    [letter(), letter()],
    {
      async prepare() {
        calls++;
        if (calls === 1) throw new AttemptedError("partial draft");
      },
    },
    () => {},
  );
  await q.run();
  assert.equal(calls, 1);
  assert.equal(q.items[0].attempted, true);
  await q.run(true);
  assert.equal(calls, 2);
  assert.equal(q.items[0].status, "error");
  assert.equal(q.items[1].status, "manual");
});
test("pre-open failure can be retried without repeating completed entries", async () => {
  let calls = 0;
  const q = new Queue(
    [letter(), letter()],
    {
      async prepare() {
        if (++calls === 1) throw new Error("blocked");
      },
    },
    () => {},
  );
  await q.run();
  await q.run(true);
  assert.equal(calls, 3);
  assert.ok(q.items.every((i) => i.status === "manual"));
});
test("TTL removes expired or invalid jobs, preserves settings and active work", () => {
  const map = new Map<string, unknown>([
    [PREFIX + "old", { expires: 10 }],
    [PREFIX + "bad", {}],
    [PREFIX + "live", { expires: 100 }],
    ["catalog", {}],
  ]);
  const s: Store = {
    get: <T>(k: string) => map.get(k) as T,
    set: (k, v) => {
      map.set(k, v);
    },
    delete: (k) => {
      map.delete(k);
    },
    keys: () => [...map.keys()],
  };
  cleanExpired(s, 50);
  assert.deepEqual([...map.keys()], [PREFIX + "live", "catalog"]);
});
