import type { Company, Letter, Mode, Profile, Template } from "./types";
export const validEmail = (s: string) =>
  /^[^\s@,;<>]+@[^\s@,;<>]+\.[^\s@,;<>]+$/.test(s);
export function validateProfile(p: Profile) {
  if (!p.fio.trim() || /[\r\n]/.test(p.fio))
    throw new Error("Введите ФИО одной строкой.");
  if (!validEmail(p.email.trim()))
    throw new Error("Введите корректный email для ответа.");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(p.date))
    throw new Error("Укажите дату обращения.");
}
export function substitute(text: string, values: Record<string, string>) {
  const result = text.replace(/\{\{([^{}]+)\}\}/g, (_, key: string) => {
    if (!(key in values)) throw new Error(`Неизвестная подстановка: ${key}`);
    return values[key];
  });
  if (/\{\{|\}\}|\[[^\]]+\]|_{3,}/.test(result))
    throw new Error("В шаблоне остались незаполненные обозначения.");
  return result;
}
export function makeLetter(
  c: Company,
  p: Profile,
  mode: Mode,
  t: Template,
  interaction = "",
): Letter {
  validateProfile(p);
  if (!c.emails.length || c.emails.some((e) => !validEmail(e)))
    throw new Error(`Проверьте адреса: ${c.name}`);
  const values = {
    ФИО: p.fio.trim(),
    Компания: c.legalName?.trim() || c.name,
    Email: p.email.trim(),
    Дата: p.date,
  };
  const missing: string[] = [];
  if (!c.legalName?.trim())
    missing.push("Юридическое наименование организации");
  if (!c.inn?.trim()) missing.push("ИНН организации");
  if (!c.ogrn?.trim()) missing.push("ОГРН организации");
  if (mode === "inquiry" && !interaction.trim())
    missing.push("Сведения о взаимодействии / обработке данных");
  // Email already has sender/recipient fields. Keep optional identification
  // details, but do not prepend the Word template's postal address header.
  const requisites = [
    [
      c.inn && `ИНН организации: ${c.inn}`,
      c.ogrn && `ОГРН организации: ${c.ogrn}`,
    ]
      .filter(Boolean)
      .join(", "),
  ];
  if (p.inn.trim()) requisites.push(`ИНН заявителя: ${p.inn.trim()}`);
  const passport = [
    p.series && `серия ${p.series}`,
    p.number && `№ ${p.number}`,
    p.issuer && `выдан ${p.issuer}`,
    p.city,
    p.issued,
  ]
    .filter(Boolean)
    .join(", ");
  if (passport) requisites.push(`Паспорт: ${passport}`);
  if (p.phone.trim()) requisites.push(`Телефон: ${p.phone.trim()}`);
  const title =
    mode === "withdrawal"
      ? "ОТЗЫВ СОГЛАСИЯ\nна обработку персональных данных"
      : "ЗАПРОС\nна предоставление информации, касающейся обработки персональных данных";
  const actions = [
    "Подпись не добавлена: при необходимости подпишите обращение и приложите документ вручную.",
  ];
  if (mode === "inquiry")
    actions[0] =
      "Запрос не подписан. Подготовьте и подпишите документ вручную; ФИО в письме не является электронной подписью.";
  if (mode === "withdrawal" && c.special === "pdf")
    actions.push(
      "Приложите PDF с отзывом согласия (примечание из исходной базы).",
    );
  if (mode === "withdrawal" && c.special === "signature") actions.push(c.notes);
  const body = [
    title,
    requisites.filter(Boolean).join("\n"),
    mode === "inquiry" && interaction.trim()
      ? `Сведения о взаимодействии / обработке данных: ${interaction.trim()}`
      : "",
    substitute(t.body, values),
    mode === "withdrawal" ? c.withdrawalExtra : "",
    `${p.date.split("-").reverse().join(".")}\n${values["ФИО"]}`,
  ]
    .filter(Boolean)
    .join("\n\n");
  const subject = substitute(t.subject, values).trim();
  if (!subject || /[\r\n]/.test(subject) || !t.body.trim())
    throw new Error(
      "Тема должна быть одной строкой, текст не должен быть пустым.",
    );
  return {
    companyId: c.id,
    companyName: c.name,
    to: [...new Set(c.emails)],
    subject,
    body,
    missing,
    actions,
  };
}
