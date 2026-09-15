import data from "./generated/data.json";
import { makeLetter } from "./letters";
import { currentMailContext } from "./adapters";
import { Queue, TTL, PREFIX } from "./queue";
import { CurrentTabTransport, store } from "./transport";
import type { Company, DeliveryMode, Mode, Profile, Template } from "./types";
import { createSurface } from "./ui-surface";
import { yandexDiagnostics } from "./yandex-account";
import { createLauncher } from "./launcher";
import {
  PROFILE_KEY,
  isSavedProfileField,
  readProfile,
  saveProfileField,
} from "./profile-storage";

const SETTINGS = "return-pd:catalog-v1";
const labels: Record<string, string> = {
  queued: "В очереди",
  opening: "Открывается",
  waiting: "Ждём готовности Яндекса к следующей отправке",
  sending: "Отправляется",
  sent: "Отправлено",
  uncertain: "Отправка не подтверждена",
  filled: "Поля заполнены",
  manual: "Требуется доработка",
  error: "Ошибка",
};
const profileFields: [keyof Profile, string, string][] = [
  ["fio", "ФИО *", "text"],
  ["email", "Email для ответа *", "email"],
  ["date", "Дата обращения *", "date"],
];
const today = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};
function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  text?: string,
  cls?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (text) node.textContent = text;
  if (cls) node.className = cls;
  return node;
}
function button(text: string, fn: () => void, cls = "") {
  const b = el("button", text, cls);
  b.type = "button";
  b.onclick = fn;
  return b;
}
function field(label: string, input: HTMLElement) {
  const wrap = el("label", label);
  wrap.append(input);
  return wrap;
}

export function mountUI() {
  return createLauncher(mountPanel);
}

async function mountPanel(onClose: () => void) {
  const surface = await createSurface();
  const { root } = surface;
  let previewTimer: ReturnType<typeof setTimeout> | undefined;
  function schedulePreview(event?: Event) {
    clearTimeout(previewTimer);
    if (event && "isComposing" in event && event.isComposing) return;
    previewTimer = setTimeout(preview, 120);
  }
  const style = el("style");
  style.textContent = CSS;
  root.append(style);
  const overlay = el("div", undefined, "overlay");
  overlay.hidden = true;
  const panel = el("section", undefined, "panel");
  panel.setAttribute("role", "dialog");
  panel.setAttribute("aria-modal", "true");
  panel.setAttribute("aria-label", "Обращения по ПД");
  overlay.append(panel);
  root.append(overlay);
  const header = el("header");
  const heading = el("div");
  heading.append(
    el("span", "ЛОКАЛЬНЫЙ ПОМОЩНИК", "eyebrow"),
    el("h1", "Обращения по ПД"),
    el(
      "p",
      "Выберите компании и проверьте текст. Письма отправляются по одному в этой вкладке почты.",
      "muted",
    ),
  );
  header.append(
    heading,
    button("Закрыть", () => close(), "ghost"),
  );
  panel.append(header);
  const accountNote = el("p", "", "account");
  panel.append(accountNote);
  const accountTools = el("div", undefined, "toolbar");
  accountTools.append(
    button("Проверить аккаунт", refreshAccount, "ghost"),
    button(
      "Скопировать диагностику",
      () => {
        GM_setClipboard(JSON.stringify(yandexDiagnostics(document), null, 2));
        accountNote.textContent =
          "Диагностика скопирована. Она содержит только структуру элементов профиля — без писем, адресов и cookies.";
      },
      "ghost",
    ),
  );
  panel.append(accountTools);
  const error = el("p", "", "error");
  error.setAttribute("role", "alert");
  error.hidden = true;
  panel.append(error);
  const tabs = el("div", undefined, "tabs");
  let mode: Mode = "withdrawal";
  const modeSelect = el("select");
  modeSelect.append(
    new Option("Отзыв согласия для рекрутмента", "withdrawal"),
    new Option("Запрос информации об обработке ПД", "inquiry"),
  );
  tabs.append(field("Тип обращения", modeSelect));
  const deliverySelect = el("select");
  deliverySelect.name = "deliveryMode";
  deliverySelect.append(
    new Option("Отправлять автоматически", "send"),
    new Option("Только черновики", "draft"),
  );
  tabs.append(field("Действие с письмами", deliverySelect));
  const deliveryNote = el("p", "", "note");
  panel.append(tabs, deliveryNote);
  const layout = el("div", undefined, "layout");
  panel.append(layout);
  const left = el("div");
  const right = el("div");
  layout.append(left, right);
  left.append(el("h2", "1. Ваши данные"));
  const profileForm = el("div", undefined, "fields");
  left.append(profileForm);
  const profileStatus = el(
    "p",
    "Данные сохраняются в этом браузере автоматически.",
    "muted",
  );
  profileStatus.dataset.role = "profile-storage-status";
  profileStatus.setAttribute("aria-live", "polite");
  const inputs = new Map<keyof Profile, HTMLInputElement>();
  for (const [key, label, type] of profileFields) {
    const input = el("input");
    input.type = type;
    input.autocomplete = "off";
    input.name = key;
    if (key === "date") input.value = today();
    inputs.set(key, input);
    profileForm.append(field(label, input));
    input.oninput = (event) => {
      if (!("isComposing" in event && event.isComposing))
        saveField(key, input.value);
      schedulePreview(event);
    };
    input.addEventListener("compositionend", () => {
      saveField(key, input.value);
      schedulePreview();
    });
  }
  restoreProfile();
  left.append(profileStatus);
  left.append(
    el(
      "p",
      "ФИО и email сохраняются в Tampermonkey до нажатия «Очистить данные». В новой вкладке дата обращения — сегодняшняя. Изменения шаблона действуют только в текущей вкладке. Подписи и вложения добавляются вручную.",
      "muted",
    ),
  );
  left.append(el("h2", "2. Компании"));
  const search = el("input");
  search.type = "search";
  search.placeholder = "Найти компанию";
  search.setAttribute("aria-label", "Найти компанию");
  left.append(search);
  const companies: Company[] = structuredClone(data.companies);
  const saved = store.get<Record<string, Partial<Company>>>(SETTINGS) || {};
  for (const c of companies)
    if (saved[c.id]) {
      const s = saved[c.id];
      for (const key of ["legalName", "inn", "ogrn"] as const)
        if (typeof s[key] === "string") c[key] = s[key];
      if (
        Array.isArray(s.emails) &&
        s.emails.every((e) => typeof e === "string")
      )
        c.emails = s.emails;
    }
  const selected = new Set<string>();
  const toolbar = el("div", undefined, "toolbar");
  toolbar.append(
    button("Выбрать все", () => {
      companies.forEach((c) => selected.add(c.id));
      renderCompanies();
      preview();
    }),
    button(
      "Снять выбор",
      () => {
        selected.clear();
        renderCompanies();
        preview();
      },
      "ghost",
    ),
  );
  left.append(toolbar);
  const companyList = el("div", undefined, "company-list");
  left.append(companyList);
  let current = companies[0];
  const card = el("details");
  card.append(el("summary", "Реквизиты и примечания компании"));
  left.append(card);
  const companyFields = el("div", undefined, "fields");
  card.append(companyFields);
  const notes = el("p", "", "note");
  card.append(notes);
  const interactions = new Map<string, string>();
  const interaction = el("textarea");
  interaction.rows = 3;
  interaction.placeholder = "Например: отклик на вакансию, дата собеседования";
  const interactionWrap = field(
    "Сведения о взаимодействии / обработке данных",
    interaction,
  );
  card.append(interactionWrap);
  interaction.oninput = () => {
    interactions.set(current.id, interaction.value);
    schedulePreview();
  };
  right.append(el("h2", "3. Шаблон и предпросмотр"));
  const templates: Record<Mode, Template> = structuredClone(data.templates);
  const editor = el("details");
  editor.append(el("summary", "Изменить тему и текст шаблона"));
  const subject = el("input");
  const body = el("textarea");
  body.rows = 12;
  editor.append(
    field("Тема", subject),
    field("Текст", body),
    el(
      "p",
      "Подстановки: {{ФИО}}, {{Компания}}, {{Email}}, {{Дата}}. Служебная шапка не добавляется. Дата и инструкции компании включаются в письмо.",
      "muted",
    ),
    button(
      "Восстановить исходный шаблон",
      () => {
        templates[mode] = structuredClone(data.templates[mode]);
        loadTemplate();
        preview();
      },
      "ghost",
    ),
  );
  right.append(editor);
  subject.oninput = () => {
    templates[mode].subject = subject.value;
    schedulePreview();
  };
  body.oninput = () => {
    templates[mode].body = body.value;
    schedulePreview();
  };
  const previewSelect = el("select");
  for (const c of companies) previewSelect.append(new Option(c.name, c.id));
  right.append(field("Предпросмотр для компании", previewSelect));
  const previewTitle = el("p", "", "preview-title");
  const previewTo = el("p", "", "muted");
  const previewText = el("pre");
  right.append(previewTitle, previewTo, previewText);
  const gaps = el("div", undefined, "note");
  right.append(gaps);
  const copies = el("div", undefined, "toolbar");
  right.append(copies);
  for (const [title, key] of [
    ["Адреса", "to"],
    ["Тема", "subject"],
    ["Текст", "body"],
  ] as const)
    copies.append(
      button(
        `Копировать: ${title}`,
        () =>
          safe(() => {
            const l = letter(current);
            GM_setClipboard(key === "to" ? l.to.join(", ") : l[key]);
            announce("Скопировано в буфер обмена.");
          }),
        "ghost",
      ),
    );
  const footer = el("footer");
  const count = el("span");
  const launch = button("Отправить письма", () => void start(), "primary");
  const stop = button(
    "Остановить",
    () => {
      queue?.stop();
      transport?.clear();
    },
    "ghost",
  );
  stop.disabled = true;
  const resume = button(
    "Продолжить очередь",
    () => void resumeQueue(),
    "ghost",
  );
  resume.hidden = true;
  const clear = button("Очистить данные", () => safe(() => reset()), "ghost");
  footer.append(count, launch, stop, resume, clear);
  panel.append(footer);
  const progress = el("div", undefined, "progress");
  progress.setAttribute("aria-live", "polite");
  panel.append(progress);
  const statusList = el("div", undefined, "results");
  panel.append(statusList);
  const resultRows = new Map<
    string,
    {
      row: HTMLElement;
      badge: HTMLElement;
      error: HTMLElement;
      notice: HTMLElement;
      retry?: HTMLButtonElement;
    }
  >();
  const dock = el("aside", undefined, "queue-dock");
  dock.hidden = true;
  const dockProgress = el("p", "", "dock-progress");
  dockProgress.setAttribute("aria-live", "polite");
  const dockCurrent = el("p", "", "muted");
  const dockActions = el("div", undefined, "toolbar");
  const dockStop = button("Остановить", () => {
    queue?.stop();
    transport?.clear();
  });
  const dockOpen = button("Открыть панель", () => open());
  dockActions.append(dockStop, dockOpen);
  dock.append(dockProgress, dockCurrent, dockActions);
  root.append(dock);
  let queue: Queue | undefined;
  let queueDelivery: DeliveryMode = "send";
  let transport: CurrentTabTransport | undefined;
  const live = el("p", "", "muted");
  live.setAttribute("aria-live", "polite");
  panel.append(live);
  let sensitiveSince = Date.now();
  const expiryTimer = setInterval(() => {
    if (Date.now() - sensitiveSince >= TTL) {
      try {
        reset(false);
      } catch {
        error.textContent =
          "Не удалось очистить временные задания. Сохранённые данные формы остаются в браузере.";
        error.hidden = false;
      }
    }
  }, 60000);
  function announce(message: string) {
    live.textContent = message;
  }
  function safe(fn: () => void) {
    try {
      error.hidden = true;
      fn();
    } catch (e) {
      error.textContent = e instanceof Error ? e.message : "Ошибка";
      error.hidden = false;
    }
  }
  function profile(): Profile {
    return {
      inn: "",
      phone: "",
      series: "",
      number: "",
      issuer: "",
      city: "",
      issued: "",
      ...Object.fromEntries([...inputs].map(([k, v]) => [k, v.value.trim()])),
    } as Profile;
  }
  function restoreProfile() {
    try {
      const saved = readProfile(store);
      for (const [key, input] of inputs) {
        if (isSavedProfileField(key)) input.value = saved[key] || "";
      }
      profileStatus.className = "muted";
      profileStatus.textContent = Object.keys(saved).length
        ? "Сохранённые данные загружены. Изменения сохраняются автоматически."
        : "Данные сохраняются в этом браузере автоматически.";
    } catch {
      profileStatus.className = "error";
      profileStatus.textContent =
        "Не удалось загрузить сохранённые данные из Tampermonkey. Введённые поля остаются доступны в этой вкладке.";
    }
  }
  function saveField(key: keyof Profile, value: string) {
    if (!isSavedProfileField(key)) return;
    try {
      saveProfileField(store, key, value);
      profileStatus.className = "muted";
      profileStatus.textContent = "Сохранено в этом браузере.";
    } catch {
      profileStatus.className = "error";
      profileStatus.textContent =
        "Не удалось сохранить данные в Tampermonkey. Они останутся только в этой вкладке; повторите изменение поля после восстановления хранилища.";
    }
  }
  function letter(c: Company) {
    return makeLetter(
      c,
      profile(),
      mode,
      templates[mode],
      interactions.get(c.id),
    );
  }
  function saveCatalog() {
    const value: Record<string, Partial<Company>> = {};
    for (const c of companies)
      value[c.id] = {
        legalName: c.legalName,
        inn: c.inn,
        ogrn: c.ogrn,
        emails: c.emails,
      };
    store.set(SETTINGS, value);
  }
  function loadTemplate() {
    subject.value = templates[mode].subject;
    body.value = templates[mode].body;
    interactionWrap.hidden = mode !== "inquiry";
  }
  function renderCard() {
    companyFields.replaceChildren();
    for (const [key, label] of [
      ["legalName", "Юридическое наименование"],
      ["inn", "ИНН организации"],
      ["ogrn", "ОГРН организации"],
      ["emails", "Email получателей через запятую"],
    ] as const) {
      const input = el("input");
      input.value =
        key === "emails" ? current.emails.join(", ") : current[key] || "";
      input.oninput = () => {
        if (key === "emails")
          current.emails = input.value
            .split(/[,;]/)
            .map((s) => s.trim())
            .filter(Boolean);
        else current[key] = input.value.trim();
        saveCatalog();
        schedulePreview();
      };
      companyFields.append(field(label, input));
    }
    notes.textContent = `${current.name}. ${current.notes || "Особых инструкций в исходной базе нет."}`;
    interaction.value = interactions.get(current.id) || "";
  }
  function renderCompanies() {
    companyList.replaceChildren();
    const needle = search.value.trim().toLowerCase();
    for (const c of companies.filter((c) =>
      c.name.toLowerCase().includes(needle),
    )) {
      const row = el("div", undefined, "company");
      const checkbox = el("input");
      checkbox.type = "checkbox";
      checkbox.checked = selected.has(c.id);
      checkbox.setAttribute("aria-label", `Выбрать ${c.name}`);
      checkbox.onchange = () => {
        checkbox.checked ? selected.add(c.id) : selected.delete(c.id);
        preview();
      };
      const details = el("div");
      details.append(
        button(
          c.name,
          () => {
            current = c;
            previewSelect.value = c.id;
            renderCard();
            preview();
          },
          "company-name",
        ),
        el("small", c.emails.join(", ")),
        el("small", `Статус из исходной базы: ${c.sourceStatus}`, "muted"),
      );
      if (c.notes)
        details.append(el("span", "Есть особые инструкции", "badge"));
      row.append(checkbox, details);
      companyList.append(row);
    }
    count.textContent = `Выбрано ${selected.size} из ${companies.length}`;
  }
  function preview() {
    count.textContent = `Выбрано ${selected.size} из ${companies.length}`;
    const autoSend = deliverySelect.value === "send";
    launch.textContent = autoSend
      ? `Отправить ${selected.size} писем`
      : `Подготовить ${selected.size} черновиков`;
    deliveryNote.textContent = autoSend
      ? "Кнопка «Отправить» запускает рассылку всем выбранным компаниям в этой вкладке. После подтверждения отправки открывается следующий редактор. Отправляется текст из предпросмотра, без добавления файлов и подписи документа. Если они нужны, выберите «Только черновики». Пропуски дополнительных реквизитов не останавливают отправку."
      : "Скрипт заполнит один черновик в этой вкладке и приостановит очередь. Добавьте нужные вложения и подпись. Отправьте письмо или закройте редактор с сохранением черновика, затем нажмите «Продолжить очередь» для следующей компании.";
    launch.disabled = !!queue?.running || selected.size === 0;
    try {
      const l = letter(current);
      previewTitle.textContent = l.subject;
      previewTo.textContent = `Кому: ${l.to.join(", ")}`;
      previewText.textContent = l.body;
      gaps.replaceChildren();
      if (l.missing.length)
        gaps.append(el("p", `Не заполнено: ${l.missing.join("; ")}.`));
      for (const s of l.actions) gaps.append(el("p", s));
    } catch (e) {
      previewTitle.textContent = current.name;
      previewTo.textContent = current.emails.join(", ");
      previewText.textContent =
        "Заполните обязательные поля, чтобы увидеть письмо.";
      gaps.textContent = e instanceof Error ? e.message : "Проверьте данные.";
    }
  }
  function update() {
    const running = !!queue?.running;
    launch.disabled = running || selected.size === 0;
    stop.disabled = !running;
    dockStop.disabled = !running;
    resume.hidden =
      !queue ||
      running ||
      !queue.items.some(
        (i) => i.status === "queued" || (i.status === "error" && !i.attempted),
      );
    for (const input of layout.querySelectorAll("input,select,textarea"))
      (input as HTMLInputElement).disabled = running;
    modeSelect.disabled = running;
    deliverySelect.disabled = running;
    if (!queue) {
      statusList.replaceChildren();
      resultRows.clear();
      dock.hidden = true;
      if (overlay.hidden) surface.expand(false);
      return;
    }
    const done = queue.items.filter((i) =>
      queueDelivery === "send"
        ? i.status === "sent"
        : i.status === "manual" || i.status === "filled",
    ).length;
    const summary = `${queueDelivery === "send" ? "Отправлено" : "Подготовлено"} ${done} из ${queue.items.length}`;
    const canContinue = queue.items.some(
      (item) =>
        item.status === "queued" ||
        (item.status === "error" && !item.attempted),
    );
    progress.textContent = `${summary}. ${running ? "Очередь работает в этой вкладке." : canContinue ? "Очередь приостановлена. Проверьте результат ниже и нажмите «Продолжить очередь»." : "Очередь завершена."}`;
    dockProgress.textContent = summary;
    const active = queue.items.find(
      (item) =>
        item.status === "opening" ||
        item.status === "waiting" ||
        item.status === "sending",
    );
    const failed = queue.items.find(
      (item) => item.status === "error" || item.status === "uncertain",
    );
    const lastSent = queue.items
      .filter((item) => item.status === "sent")
      .at(-1);
    dockCurrent.textContent = active
      ? active.status === "waiting"
        ? `${active.letter.companyName} · Ждём готовности Яндекса к следующей отправке.`
        : active.status === "sending"
          ? `${lastSent ? `${lastSent.letter.companyName}: отправлено. ` : ""}${active.letter.companyName}: ждём подтверждения почты.`
          : `${active.letter.companyName} · Подготавливаем письмо`
      : failed?.status === "uncertain"
        ? `${failed.letter.companyName}: подтверждение не получено. ${canContinue ? "Очередь приостановлена. Проверьте «Отправленные»; продолжение — в панели." : "Проверьте «Отправленные»."}`
        : failed
          ? `Очередь приостановлена: ${failed.letter.companyName}. ${failed.error || "Не удалось подготовить письмо."}${canContinue ? " Продолжение — в панели." : ""}`
          : queueDelivery === "draft" && canContinue
            ? "Черновик открыт. Сохраните или отправьте его; продолжение — в панели."
            : canContinue
              ? "Очередь остановлена. Продолжение — в панели."
              : "Готово.";
    if (overlay.hidden) collapseToDock();
    renderResults();
    preview();
  }
  function renderResults() {
    if (!queue) return;
    const ids = new Set(queue.items.map((item) => item.id));
    for (const [id, view] of resultRows) {
      if (!ids.has(id)) {
        view.row.remove();
        resultRows.delete(id);
      }
    }
    for (const item of queue.items) {
      let view = resultRows.get(item.id);
      if (!view) {
        const row = el("div", undefined, "result");
        const badge = el("span", "", "badge");
        const rowError = el("p", "", "error");
        const notice = el("p", "", "note");
        row.append(
          el("strong", item.letter.companyName),
          badge,
          rowError,
          notice,
        );
        const detail = el("details");
        const detailText = el("div", "", "result-body");
        const detailCopies = el("div");
        let rendered = false;
        detail.append(
          el("summary", "Письмо и ручные действия"),
          detailText,
          detailCopies,
        );
        detail.addEventListener("toggle", () => {
          if (!detail.open || rendered) return;
          // Letter text can be long. Keep it out of the synchronous queue
          // notification path, and preserve expanded details across updates.
          safe(() => {
            detailText.append(
              el("p", `Кому: ${item.letter.to.join(", ")}`),
              el("p", item.letter.subject),
              el("pre", item.letter.body),
            );
            for (const text of [
              ...item.letter.missing.map((text) => `Не заполнено: ${text}`),
              ...item.letter.actions,
            ])
              detailText.append(el("p", text));
            rendered = true;
          });
        });
        for (const [name, text] of [
          ["адреса", item.letter.to.join(", ")],
          ["тему", item.letter.subject],
          ["текст", item.letter.body],
        ])
          detailCopies.append(
            button(`Копировать ${name}`, () => GM_setClipboard(text), "ghost"),
          );
        row.append(detail);
        statusList.append(row);
        view = { row, badge, error: rowError, notice };
        resultRows.set(item.id, view);
      }
      view.badge.textContent = labels[item.status];
      view.error.textContent = item.error || "";
      view.error.hidden = !item.error;
      view.notice.hidden = item.status !== "uncertain";
      view.notice.textContent =
        item.status === "uncertain"
          ? "Проверьте «Отправленные» и текущий редактор. Скрипт не повторяет эту отправку: письмо уже могло уйти. Продолжение очереди обработает только оставшиеся компании."
          : "";
      if (item.status === "error" && item.attempted && !queue.running) {
        if (!view.retry) {
          view.retry = button(
            "Повторить после проверки письма",
            () => {
              if (
                window.confirm(
                  queueDelivery === "send"
                    ? "Проверьте «Отправленные» и прошлый черновик. Повтор создаст новое письмо и автоматически отправит его. Повторить?"
                    : "Убедитесь, что прошлое письмо не отправлено. Повтор создаст новый черновик. Создать?",
                )
              ) {
                item.attempted = false;
                item.status = "queued";
                void resumeQueue();
              }
            },
            "ghost",
          );
          view.row.append(view.retry);
        }
      } else {
        view.retry?.remove();
        view.retry = undefined;
      }
    }
  }
  async function start() {
    safe(() => {
      if (queue?.running) return;
      const account = currentMailContext();
      if (!account)
        throw new Error(
          "Страница почты не распознана. Откройте Gmail или Яндекс Почту; для Gmail должна быть доступна информация текущего аккаунта.",
        );
      const letters = companies.filter((c) => selected.has(c.id)).map(letter);
      if (!letters.length) throw new Error("Выберите компании.");
      transport?.clear();
      queueDelivery = deliverySelect.value as DeliveryMode;
      transport = new CurrentTabTransport(account, queueDelivery);
      queue = new Queue(letters, transport, update, queueDelivery === "draft");
      void execute(queue, transport);
    });
  }
  async function resumeQueue() {
    if (!queue || queue.running || !transport) return;
    await execute(queue, transport, true);
  }
  async function execute(q: Queue, t: CurrentTabTransport, retry = false) {
    try {
      if (!navigator.locks)
        throw new Error(
          "Браузер не поддерживает блокировки вкладок. Используйте ручное копирование.",
        );
      await navigator.locks.request(
        "return-pd-controller",
        { ifAvailable: true },
        async (lock) => {
          if (!lock)
            throw new Error(
              "Очередь уже выполняется в другой вкладке этой почты.",
            );
          collapseToDock();
          await q.run(retry);
        },
      );
    } catch (e) {
      error.textContent = e instanceof Error ? e.message : "Ошибка очереди";
      error.hidden = false;
      open();
    } finally {
      t.clear();
    }
  }
  function reset(clearSaved = true) {
    if (clearSaved) {
      try {
        store.delete(PROFILE_KEY);
      } catch {
        profileStatus.className = "error";
        profileStatus.textContent =
          "Не удалось удалить сохранённые данные из Tampermonkey. Повторите очистку после восстановления хранилища.";
        return;
      }
    }
    sensitiveSince = Date.now();
    queue?.stop();
    transport?.clear();
    queue = undefined;
    if (clearSaved) {
      for (const [k, v] of inputs) v.value = k === "date" ? today() : "";
      profileStatus.className = "muted";
      profileStatus.textContent =
        "Сохранённые данные удалены. Новый ввод сохраняется автоматически.";
    }
    interactions.clear();
    interaction.value = "";
    templates.withdrawal = structuredClone(data.templates.withdrawal);
    templates.inquiry = structuredClone(data.templates.inquiry);
    selected.clear();
    if (clearSaved) store.delete(SETTINGS);
    if (clearSaved) {
      for (const key of store.keys()) {
        if (key.startsWith(PREFIX)) store.delete(key);
      }
    }
    if (clearSaved) {
      for (let i = 0; i < companies.length; i++)
        companies[i] = structuredClone(data.companies[i]);
    }
    current = companies[0];
    previewSelect.value = current.id;
    statusList.replaceChildren();
    resultRows.clear();
    progress.textContent = clearSaved
      ? "Данные скрипта очищены. Черновики в почте не удалены."
      : "Временные тексты и результаты очищены через 24 часа. Сохранённые данные формы и каталог остались в браузере.";
    loadTemplate();
    renderCard();
    renderCompanies();
    preview();
    update();
  }
  function open() {
    dock.hidden = true;
    surface.expand(true);
    overlay.hidden = false;
    refreshAccount();
    inputs.get("fio")!.focus();
  }
  function refreshAccount() {
    const a = currentMailContext();
    accountTools.hidden = a?.useCurrentSession === true;
    if (a?.useCurrentSession) {
      accountNote.textContent =
        "Яндекс Почта · текущая сессия браузера. Письма открываются из текущего ящика; отправитель указан в редакторе почты.";
      return;
    }
    accountNote.textContent = a
      ? `Аккаунт: ${a.email || "Яндекс ID (идентификатор распознан)"} · ${a.provider === "gmail" ? "Gmail" : "Яндекс Почта"}`
      : "Аккаунт пока не определён. Автоматическая работа с редактором недоступна; ручное копирование работает.";
  }
  function collapseToDock() {
    overlay.hidden = true;
    dock.hidden = false;
    surface.compact();
  }
  function close() {
    if (queue) collapseToDock();
    else {
      overlay.hidden = true;
      surface.expand(false);
    }
    onClose();
  }
  overlay.addEventListener("keydown", (event) => {
    if (event.isComposing) return;
    if (event.key === "Escape") close();
    if (event.key === "Tab") {
      const nodes = [
        ...panel.querySelectorAll<HTMLElement>(
          "button,input,select,textarea,summary",
        ),
      ].filter(
        (n) => !n.hasAttribute("disabled") && n.getClientRects().length > 0,
      );
      const index = nodes.indexOf(root.activeElement as HTMLElement);
      if (event.shiftKey && index <= 0) {
        event.preventDefault();
        nodes.at(-1)?.focus();
      } else if (!event.shiftKey && index === nodes.length - 1) {
        event.preventDefault();
        nodes[0]?.focus();
      }
    }
  });
  search.oninput = renderCompanies;
  previewSelect.onchange = () => {
    current = companies.find((c) => c.id === previewSelect.value)!;
    renderCard();
    preview();
  };
  modeSelect.onchange = () => {
    mode = modeSelect.value as Mode;
    loadTemplate();
    preview();
  };
  deliverySelect.onchange = preview;
  const onPageHide = () => {
    queue?.stop();
    transport?.clear();
  };
  window.addEventListener("pagehide", onPageHide);
  // Clearing remains available in the panel; do not register duplicate menus after recovery.
  loadTemplate();
  renderCard();
  renderCompanies();
  preview();
  return {
    open,
    isAlive: () =>
      surface.frame.isConnected &&
      surface.frame.contentDocument === root.ownerDocument &&
      root.isConnected,
    dispose() {
      clearInterval(expiryTimer);
      clearTimeout(previewTimer);
      window.removeEventListener("pagehide", onPageHide);
      queue?.stop();
      try {
        transport?.clear();
      } finally {
        surface.frame.remove();
      }
    },
  };
}

const CSS = `
:host{all:initial;font:14px/1.5 system-ui,-apple-system,sans-serif;color:#213b33}*{box-sizing:border-box}[hidden]{display:none!important}button,input,select,textarea{font:inherit}button,summary{cursor:pointer}button{border:1px solid #cedad3;border-radius:8px;padding:8px 12px;background:#fff;color:#23483a}button:hover{background:#eef4ef}button:disabled{opacity:.5;cursor:not-allowed}input,textarea,select{width:100%;border:1px solid #cbd8d1;border-radius:8px;padding:9px 10px;background:#fff;color:#1b3329}textarea{resize:vertical}button:focus-visible,input:focus-visible,select:focus-visible,textarea:focus-visible,summary:focus-visible{outline:3px solid #8cb8a3;outline-offset:2px}label{display:block;font-size:12px;font-weight:600}label>input,label>select,label>textarea{display:block;margin-top:5px;font-weight:400}h1{font-size:28px;line-height:1.2;letter-spacing:-.8px;margin:6px 0}h2{font-size:16px;margin:22px 0 12px}p{margin:8px 0}small{display:block;font-size:11px;overflow-wrap:anywhere}pre{font:13px/1.7 system-ui;white-space:pre-wrap;overflow-wrap:anywhere;margin:12px 0;background:#fff;border:1px solid #dee5df;border-radius:10px;padding:18px;max-height:480px;overflow:auto}details{margin:12px 0}summary{font-weight:600;padding:8px 0}details>label{margin:10px 0}.launcher{position:fixed;right:24px;bottom:24px;z-index:2147483645;background:#204c3c;color:#fff;box-shadow:0 4px 20px #0002}.launcher:hover{background:#2f634f}.overlay{position:fixed;inset:0;z-index:2147483646;background:#12251cc2;padding:24px;overflow:auto}.panel{max-width:1240px;margin:0 auto;background:#f7f9f5;border:1px solid #d6dfd7;border-radius:18px;padding:28px;box-shadow:0 24px 90px #0004}.panel header{display:flex;justify-content:space-between;align-items:flex-start;gap:16px}.queue-dock{margin:8px;padding:12px 14px;background:#f7f9f5;border:1px solid #d6dfd7;border-radius:12px;box-shadow:0 4px 20px #0002;display:flex;flex-direction:column;max-height:176px;overflow:hidden}.queue-dock p{margin:0 0 6px}.queue-dock .dock-progress{font-weight:650;flex-shrink:0}.queue-dock .muted{font-size:12px;overflow-wrap:anywhere;overflow:auto;min-height:0}.queue-dock .toolbar{margin:8px 0 0;flex-shrink:0}.queue-dock button{padding:6px 10px}.eyebrow{font-size:10px;letter-spacing:2px;color:#517b67;font-weight:700}.muted{color:#65766b;font-weight:400}.account{background:#e8f0e8;padding:9px 12px;border-radius:8px}.tabs{max-width:420px;margin-top:18px}.layout{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1.1fr);gap:32px}.fields{display:grid;grid-template-columns:1fr 1fr;gap:10px}.toolbar{display:flex;gap:8px;flex-wrap:wrap;margin:10px 0}.company-list{max-height:390px;overflow:auto;border:1px solid #dbe3dc;border-radius:10px;background:#fff}.company{display:flex;align-items:flex-start;gap:12px;padding:12px;border-bottom:1px solid #e8ece8}.company:last-child{border-bottom:0}.company>input{width:16px;height:16px;margin-top:7px;accent-color:#245740}.company-name{border:0;padding:0;background:none;text-align:left;font-weight:650}.badge{display:inline-block;font-size:10px;font-weight:600;border-radius:5px;background:#e9eee4;padding:3px 6px;margin:5px 0}.note{padding:12px;background:#f3f0e4;color:#68582b;border-radius:9px;font-size:12px}.preview-title{font-weight:650;font-size:15px}.primary{background:#204c3c;color:white;border-color:#204c3c}.primary:hover{background:#32614b}.ghost{background:transparent}.error{color:#a52c29;white-space:pre-wrap}.panel footer{display:flex;align-items:center;gap:10px;flex-wrap:wrap;border-top:1px solid #d5dfd6;padding-top:20px;margin-top:24px}.panel footer>span{margin-right:auto}.progress{margin-top:16px;font-weight:600}.results{display:grid;gap:10px}.result{background:white;border:1px solid #dbe2db;border-radius:9px;padding:12px}.result>strong{margin-right:12px}.result details button{margin:4px}.result pre{max-height:200px}@media(max-width:800px){.layout{grid-template-columns:1fr}.overlay{padding:8px}.panel{padding:16px}.fields{grid-template-columns:1fr 1fr}.launcher{right:12px;bottom:12px}}@media(prefers-reduced-motion:no-preference){button{transition:background .15s}}`;
