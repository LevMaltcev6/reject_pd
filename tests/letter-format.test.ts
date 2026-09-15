import { test } from "node:test";
import assert from "node:assert/strict";
import data from "../src/generated/data.json";
import { makeLetter } from "../src/letters";
import type { Company, Mode, Profile } from "../src/types";

const sparseProfile: Profile = {
  fio: "Тест Проверки Скрипта",
  email: "reply@example.invalid",
  inn: "",
  phone: "",
  series: "",
  number: "",
  issuer: "",
  city: "",
  issued: "",
  date: "2026-09-15",
};
const fullProfile: Profile = {
  ...sparseProfile,
  inn: "123456789012",
  phone: "+79991234567",
  series: "1234",
  number: "567890",
  issuer: "Тестовое подразделение",
  city: "Москва",
  issued: "2020-01-02",
};
const sparseCompany: Company = {
  id: "test-company",
  name: "МТС",
  emails: ["privacy@example.invalid"],
  sourceStatus: "",
  notes: "",
  special: null,
  withdrawalExtra: "",
};
const fullCompany: Company = {
  ...sparseCompany,
  legalName: "ПАО Тестовая Компания",
  inn: "1234567890",
  ogrn: "1234567890123",
};

for (const mode of ["withdrawal", "inquiry"] satisfies Mode[]) {
  for (const details of ["sparse", "full"] as const) {
    test(`${mode} with ${details} details starts with the document title and omits automatic postal header lines`, () => {
      const profile = details === "full" ? fullProfile : sparseProfile;
      const company = details === "full" ? fullCompany : sparseCompany;
      const letter = makeLetter(
        company,
        profile,
        mode,
        data.templates[mode],
        "Отклик на вакансию 01.09.2026",
      );
      const companyName = company.legalName || company.name;
      const expectedTitle =
        mode === "withdrawal"
          ? "ОТЗЫВ СОГЛАСИЯ\nна обработку персональных данных"
          : "ЗАПРОС\nна предоставление информации, касающейся обработки персональных данных";

      assert.ok(letter.body.startsWith(expectedTitle + "\n\n"));
      const lines = letter.body.split("\n").map((line) => line.trim());
      assert.ok(!lines.includes(company.name));
      assert.ok(!lines.includes(companyName));
      assert.ok(!lines.includes(`от ${profile.fio}`));
      assert.doesNotMatch(letter.body, /^от\s+/m);
      assert.doesNotMatch(letter.body, /^e-mail\s*:/im);

      // These are meaningful parts of the supplied document, not header duplicates.
      assert.ok(letter.body.includes(`Я, ${profile.fio}`));
      assert.ok(
        letter.body.includes(
          mode === "withdrawal"
            ? `предоставленные ${companyName}`
            : `прошу ${companyName}`,
        ),
      );
      assert.ok(
        letter.body.includes(
          mode === "withdrawal"
            ? `Направить ответ на почту: ${profile.email}`
            : `по адресу электронной почты:  ${profile.email}`,
        ),
      );
      assert.equal(letter.body.split(profile.email).length - 1, 1);
      assert.ok(letter.body.endsWith(`15.09.2026\n${profile.fio}`));
      assert.equal(
        letter.subject,
        `${mode === "withdrawal" ? "Отзыв согласия на обработку персональных данных" : "Запрос информации об обработке персональных данных"} — ${profile.fio}`,
      );
      assert.deepEqual(letter.to, company.emails);

      if (details === "full") {
        assert.match(letter.body, /Паспорт: серия 1234, № 567890/);
        assert.ok(letter.body.includes(profile.issuer));
        assert.ok(letter.body.includes(profile.city));
        assert.ok(letter.body.includes(profile.issued));
        assert.ok(letter.body.includes(profile.inn));
        assert.ok(letter.body.includes(profile.phone));
        assert.equal(letter.missing.length, 0);
      } else {
        assert.doesNotMatch(letter.body, /Паспорт:|Телефон:/);
        assert.ok(letter.missing.includes("Серия паспорта"));
        assert.ok(letter.missing.includes("Номер паспорта"));
        assert.doesNotMatch(letter.body, /\{\{|\[[^\]]+\]/);
      }
    });
  }
}

test("formatting change preserves the user's edited template prose and substitutions", () => {
  const letter = makeLetter(sparseCompany, sparseProfile, "withdrawal", {
    subject: "Обращение {{ФИО}}",
    body: "Добрый день, {{Компания}}!\n\nЯ, {{ФИО}}, прошу отозвать согласие.\nОтвет ожидаю на {{Email}}.",
  });
  assert.ok(
    letter.body.includes(
      "Добрый день, МТС!\n\nЯ, Тест Проверки Скрипта, прошу отозвать согласие.\nОтвет ожидаю на reply@example.invalid.",
    ),
  );
  assert.doesNotMatch(letter.body, /^e-mail\s*:|^от\s+/im);
});
