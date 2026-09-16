// ==UserScript==
// @name         Возврат ПД — подготовка обращений
// @namespace    return-pd.local
// @version      0.2.9
// @description  Рассылка по вашим шаблонам в текущей вкладке почты. Доступен режим черновиков.
// @match        https://mail.google.com/*
// @match        https://mail.yandex.ru/*
// @match        https://mail.yandex.com/*
// @match        https://mail.yandex.by/*
// @match        https://mail.yandex.kz/*
// @run-at       document-idle
// @noframes
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_deleteValue
// @grant        GM_listValues
// @grant        GM_registerMenuCommand
// @grant        GM_setClipboard
// @grant        unsafeWindow
// ==/UserScript==
"use strict";
(() => {
  // src/queue.ts
  var Queue = class {
    constructor(letters, transport, changed, pauseAfterDraft = false) {
      this.transport = transport;
      this.changed = changed;
      this.pauseAfterDraft = pauseAfterDraft;
      this.items = letters.map((letter) => ({
        id: crypto.randomUUID(),
        letter,
        status: "queued"
      }));
    }
    items;
    running = false;
    controller = new AbortController();
    notify() {
      try {
        this.changed();
      } catch {
      }
    }
    stop() {
      this.controller.abort();
    }
    async run(retry = false) {
      if (this.running) return;
      this.running = true;
      this.controller = new AbortController();
      this.notify();
      try {
        for (const item of this.items) {
          if (this.controller.signal.aborted) break;
          if (item.status !== "queued" && !(retry && item.status === "error" && !item.attempted))
            continue;
          item.status = "opening";
          item.error = void 0;
          this.notify();
          try {
            const result = await this.transport.prepare(
              item.letter,
              this.controller.signal,
              (stage) => {
                item.status = stage;
                this.notify();
              }
            );
            item.status = result === "sent" ? "sent" : item.letter.missing.length || item.letter.actions.length ? "manual" : "filled";
          } catch (error) {
            item.status = error instanceof UncertainError ? "uncertain" : "error";
            item.error = error instanceof Error ? error.message : "\u041D\u0435 \u0443\u0434\u0430\u043B\u043E\u0441\u044C \u043F\u043E\u0434\u0433\u043E\u0442\u043E\u0432\u0438\u0442\u044C \u043F\u0438\u0441\u044C\u043C\u043E.";
            item.attempted = error instanceof AttemptedError;
            this.notify();
            break;
          }
          this.notify();
          if (this.pauseAfterDraft && item.status !== "sent") break;
        }
      } finally {
        this.running = false;
        this.notify();
      }
    }
  };
  var AttemptedError = class extends Error {
  };
  var UncertainError = class extends AttemptedError {
    constructor() {
      super(
        "\u041F\u0438\u0441\u044C\u043C\u043E \u043C\u043E\u0433\u043B\u043E \u0431\u044B\u0442\u044C \u043E\u0442\u043F\u0440\u0430\u0432\u043B\u0435\u043D\u043E, \u043D\u043E \u043F\u043E\u0434\u0442\u0432\u0435\u0440\u0436\u0434\u0435\u043D\u0438\u0435 \u043D\u0435 \u043F\u043E\u043B\u0443\u0447\u0435\u043D\u043E. \u041F\u0440\u043E\u0432\u0435\u0440\u044C\u0442\u0435 \xAB\u041E\u0442\u043F\u0440\u0430\u0432\u043B\u0435\u043D\u043D\u044B\u0435\xBB \u0438 \u043D\u0435 \u0437\u0430\u043F\u0443\u0441\u043A\u0430\u0439\u0442\u0435 \u044D\u0442\u043E \u043F\u0438\u0441\u044C\u043C\u043E \u043F\u043E\u0432\u0442\u043E\u0440\u043D\u043E, \u043F\u043E\u043A\u0430 \u043D\u0435 \u043F\u0440\u043E\u0432\u0435\u0440\u0438\u0442\u0435 \u0440\u0435\u0437\u0443\u043B\u044C\u0442\u0430\u0442."
      );
      this.name = "UncertainError";
    }
  };
  var PREFIX = "return-pd:job:";
  var RECEIPT_PREFIX = "return-pd:receipt:";
  var TTL = 24 * 60 * 60 * 1e3;
  function cleanExpired(store2, now = Date.now()) {
    for (const key of store2.keys().filter((k) => k.startsWith(PREFIX) || k.startsWith(RECEIPT_PREFIX))) {
      const job = store2.get(key);
      if (!job || !Number.isFinite(job.expires) || job.expires <= now)
        store2.delete(key);
    }
  }

  // src/yandex-account.ts
  var controls = '.mail-User-Name, .mail-User, .user-account, .user-account__name, .user-account__login, .user-pic, .user-pic__image, [data-testid="user-account"], .legouser__current-account';
  var emailPattern = /[A-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
  var knownYandexDomain = /^(yandex\.(ru|com|by|kz)|ya\.ru)$/i;
  function normalizeEmail(email) {
    const [login, domain] = email.toLowerCase().split("@");
    return `${login}@${knownYandexDomain.test(domain) ? "yandex.ru" : domain}`;
  }
  function active(el2, doc) {
    for (let p = el2; p; p = p.parentElement) {
      if (p.hasAttribute("hidden") || p.getAttribute("aria-hidden") === "true")
        return false;
      const style = doc.defaultView?.getComputedStyle(p);
      if (style?.display === "none" || style?.visibility === "hidden")
        return false;
    }
    return !el2.closest(
      '.legouser__accounts, [role="listbox"], [data-testid="account-switcher"]'
    );
  }
  function yandexAccount(doc, url) {
    const emails = /* @__PURE__ */ new Set();
    const uids = /* @__PURE__ */ new Set();
    for (const el2 of doc.querySelectorAll(controls)) {
      if (!active(el2, doc)) continue;
      for (const text of [
        el2.getAttribute("data-email"),
        el2.getAttribute("aria-label"),
        el2.getAttribute("title"),
        el2.getAttribute("alt"),
        el2.textContent
      ]) {
        for (const email of text?.match(emailPattern) || [])
          emails.add(normalizeEmail(email));
      }
      const login = el2.getAttribute("data-login") || (el2.matches(".user-account__login") ? el2.textContent?.trim() : null);
      if (login && /^[a-z0-9][a-z0-9._-]*$/i.test(login))
        emails.add(`${login.toLowerCase()}@yandex.ru`);
      else if (login && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(login))
        emails.add(normalizeEmail(login));
      const uid = el2.getAttribute("data-uid");
      if (uid && /^\d+$/.test(uid)) uids.add(uid);
      const anchor = el2.matches("a[href]") ? el2 : el2.closest("a[href]");
      if (anchor) {
        try {
          const href = new URL(anchor.getAttribute("href"), url);
          if (/^(passport|id)\.yandex\.(ru|com|by|kz)$/.test(href.hostname) && /^\/profile\/?$/.test(href.pathname)) {
            const id = href.searchParams.get("uid");
            if (id && /^\d+$/.test(id)) uids.add(id);
          }
        } catch {
        }
      }
    }
    if (uids.size > 1 || emails.size > 1) return null;
    if (!uids.size && !emails.size) return null;
    return {
      provider: "yandex",
      email: [...emails][0] || "",
      uid: [...uids][0],
      baseUrl: `${url.origin}/`
    };
  }
  function yandexDiagnostics(doc) {
    return {
      version: "0.2.9",
      controls: [...doc.querySelectorAll(controls)].map((el2) => ({
        tag: el2.tagName,
        active: active(el2, doc),
        selectors: controls.split(", ").filter((selector) => el2.matches(selector)),
        attributes: [
          "title",
          "aria-label",
          "data-login",
          "data-email",
          "data-uid",
          "alt"
        ].filter((a) => el2.hasAttribute(a)),
        textHasEmail: !!(el2.textContent || "").match(emailPattern)
      }))
    };
  }

  // src/editor-errors.ts
  var messages = {
    cancelled: "\u0417\u0430\u0434\u0430\u043D\u0438\u0435 \u043E\u0442\u043C\u0435\u043D\u0435\u043D\u043E. \u0423\u0436\u0435 \u0432\u043D\u0435\u0441\u0451\u043D\u043D\u044B\u0435 \u0432 \u043F\u0438\u0441\u044C\u043C\u043E \u0434\u0430\u043D\u043D\u044B\u0435 \u043E\u0441\u0442\u0430\u043B\u0438\u0441\u044C \u0432 \u0440\u0435\u0434\u0430\u043A\u0442\u043E\u0440\u0435.",
    context_unavailable: "\u0421\u0442\u0440\u0430\u043D\u0438\u0446\u0430 \u043F\u043E\u0447\u0442\u044B \u0438\u0437\u043C\u0435\u043D\u0438\u043B\u0430\u0441\u044C \u0438\u043B\u0438 \u043D\u0435\u0434\u043E\u0441\u0442\u0443\u043F\u043D\u0430 \u0434\u043B\u044F \u044D\u0442\u043E\u0433\u043E \u0437\u0430\u0434\u0430\u043D\u0438\u044F. \u041F\u043E\u0434\u0433\u043E\u0442\u043E\u0432\u043A\u0430 \u043E\u0441\u0442\u0430\u043D\u043E\u0432\u043B\u0435\u043D\u0430.",
    compose_button_missing: "\u041D\u0435 \u043D\u0430\u0439\u0434\u0435\u043D\u0430 \u0435\u0434\u0438\u043D\u0441\u0442\u0432\u0435\u043D\u043D\u0430\u044F \u043A\u043D\u043E\u043F\u043A\u0430 \xAB\u041D\u0430\u043F\u0438\u0441\u0430\u0442\u044C\xBB. \u0421\u043A\u0440\u0438\u043F\u0442 \u043D\u0435 \u0441\u043C\u043E\u0433 \u043E\u0442\u043A\u0440\u044B\u0442\u044C \u043D\u043E\u0432\u043E\u0435 \u043F\u0438\u0441\u044C\u043C\u043E.",
    body_missing: "\u041F\u043E\u0441\u043B\u0435 \u043D\u0430\u0436\u0430\u0442\u0438\u044F \xAB\u041D\u0430\u043F\u0438\u0441\u0430\u0442\u044C\xBB \u043D\u0435 \u043D\u0430\u0439\u0434\u0435\u043D\u043E \u043F\u043E\u043B\u0435 \u0442\u0435\u043A\u0441\u0442\u0430 \u043F\u0438\u0441\u044C\u043C\u0430. \u0421\u043A\u0440\u0438\u043F\u0442 \u043D\u0435 \u0440\u0430\u0441\u043F\u043E\u0437\u043D\u0430\u043B \u0440\u0435\u0434\u0430\u043A\u0442\u043E\u0440 \u043F\u043E\u0447\u0442\u044B.",
    editor_root_missing: "\u041F\u043E\u043B\u0435 \u0442\u0435\u043A\u0441\u0442\u0430 \u043D\u0430\u0439\u0434\u0435\u043D\u043E, \u043D\u043E \u043D\u0435 \u0443\u0434\u0430\u043B\u043E\u0441\u044C \u043E\u043F\u0440\u0435\u0434\u0435\u043B\u0438\u0442\u044C \u0433\u0440\u0430\u043D\u0438\u0446\u044B \u0440\u0435\u0434\u0430\u043A\u0442\u043E\u0440\u0430 \u043F\u0438\u0441\u044C\u043C\u0430.",
    subject_missing: "\u041D\u0435 \u043D\u0430\u0439\u0434\u0435\u043D\u043E \u0435\u0434\u0438\u043D\u0441\u0442\u0432\u0435\u043D\u043D\u043E\u0435 \u043F\u043E\u043B\u0435 \u0442\u0435\u043C\u044B \u043F\u0438\u0441\u044C\u043C\u0430.",
    recipients_missing: "\u041D\u0435 \u043D\u0430\u0439\u0434\u0435\u043D\u043E \u0435\u0434\u0438\u043D\u0441\u0442\u0432\u0435\u043D\u043D\u043E\u0435 \u043F\u043E\u043B\u0435 \xAB\u041A\u043E\u043C\u0443\xBB.",
    recipient_unconfirmed: "\u0410\u0434\u0440\u0435\u0441 \u0432\u0432\u0435\u0434\u0451\u043D \u0432 \xAB\u041A\u043E\u043C\u0443\xBB, \u043D\u043E \u0441\u043A\u0440\u0438\u043F\u0442 \u043D\u0435 \u0441\u043C\u043E\u0433 \u043F\u043E\u0434\u0442\u0432\u0435\u0440\u0434\u0438\u0442\u044C \u0435\u0433\u043E \u0434\u043E\u0431\u0430\u0432\u043B\u0435\u043D\u0438\u0435 \u0432 \u0441\u043F\u0438\u0441\u043E\u043A \u043F\u043E\u043B\u0443\u0447\u0430\u0442\u0435\u043B\u0435\u0439.",
    existing_editor: "\u0412\u043E \u0432\u043A\u043B\u0430\u0434\u043A\u0435 \u0443\u0436\u0435 \u043E\u0442\u043A\u0440\u044B\u0442 \u0440\u0435\u0434\u0430\u043A\u0442\u043E\u0440. \u041E\u043D \u043D\u0435 \u0431\u0443\u0434\u0435\u0442 \u0438\u0437\u043C\u0435\u043D\u0451\u043D.",
    existing_recipients: "\u0412 \u043D\u043E\u0432\u043E\u043C \u0440\u0435\u0434\u0430\u043A\u0442\u043E\u0440\u0435 \u0443\u0436\u0435 \u0435\u0441\u0442\u044C \u043F\u043E\u043B\u0443\u0447\u0430\u0442\u0435\u043B\u0438. \u0421\u043A\u0440\u0438\u043F\u0442 \u043E\u0441\u0442\u0430\u043D\u043E\u0432\u0438\u043B\u0441\u044F, \u0447\u0442\u043E\u0431\u044B \u043D\u0435 \u0438\u0437\u043C\u0435\u043D\u0438\u0442\u044C \u0432\u0430\u0448\u0435 \u043F\u0438\u0441\u044C\u043C\u043E.",
    existing_subject: "\u0412 \u043D\u043E\u0432\u043E\u043C \u0440\u0435\u0434\u0430\u043A\u0442\u043E\u0440\u0435 \u0443\u0436\u0435 \u0437\u0430\u043F\u043E\u043B\u043D\u0435\u043D\u0430 \u0442\u0435\u043C\u0430. \u0421\u043A\u0440\u0438\u043F\u0442 \u043E\u0441\u0442\u0430\u043D\u043E\u0432\u0438\u043B\u0441\u044F, \u0447\u0442\u043E\u0431\u044B \u043D\u0435 \u0438\u0437\u043C\u0435\u043D\u0438\u0442\u044C \u0432\u0430\u0448\u0435 \u043F\u0438\u0441\u044C\u043C\u043E.",
    existing_body: "\u0420\u0435\u0434\u0430\u043A\u0442\u043E\u0440 \u0443\u0436\u0435 \u0441\u043E\u0434\u0435\u0440\u0436\u0438\u0442 \u0442\u0435\u043A\u0441\u0442 \u0438\u043B\u0438 \u043D\u0435\u0440\u0430\u0441\u043F\u043E\u0437\u043D\u0430\u043D\u043D\u0443\u044E \u043F\u043E\u0434\u043F\u0438\u0441\u044C. \u0421\u043A\u0440\u0438\u043F\u0442 \u043E\u0441\u0442\u0430\u043D\u043E\u0432\u0438\u043B\u0441\u044F, \u0447\u0442\u043E\u0431\u044B \u043D\u0435 \u0441\u0442\u0435\u0440\u0435\u0442\u044C \u0438\u0445.",
    recipients_mismatch: "\u041F\u043E\u0441\u043B\u0435 \u0437\u0430\u043F\u043E\u043B\u043D\u0435\u043D\u0438\u044F \u0441\u043F\u0438\u0441\u043E\u043A \u043F\u043E\u043B\u0443\u0447\u0430\u0442\u0435\u043B\u0435\u0439 \u043D\u0435 \u0441\u043E\u0432\u043F\u0430\u043B \u0441 \u0437\u0430\u0434\u0430\u043D\u0438\u0435\u043C. \u041F\u0440\u043E\u0432\u0435\u0440\u044C\u0442\u0435 \u043F\u043E\u043B\u0435 \xAB\u041A\u043E\u043C\u0443\xBB \u0432 \u043F\u0438\u0441\u044C\u043C\u0435.",
    subject_mismatch: "\u041F\u043E\u0441\u043B\u0435 \u0437\u0430\u043F\u043E\u043B\u043D\u0435\u043D\u0438\u044F \u0442\u0435\u043C\u0430 \u043D\u0435 \u0441\u043E\u0432\u043F\u0430\u043B\u0430 \u0441 \u0437\u0430\u0434\u0430\u043D\u0438\u0435\u043C. \u041F\u0440\u043E\u0432\u0435\u0440\u044C\u0442\u0435 \u0442\u0435\u043C\u0443 \u043F\u0438\u0441\u044C\u043C\u0430.",
    body_mismatch: "\u041F\u043E\u0441\u043B\u0435 \u0437\u0430\u043F\u043E\u043B\u043D\u0435\u043D\u0438\u044F \u0442\u0435\u043A\u0441\u0442 \u0432 \u0440\u0435\u0434\u0430\u043A\u0442\u043E\u0440\u0435 \u043D\u0435 \u0441\u043E\u0432\u043F\u0430\u043B \u0441 \u0437\u0430\u0434\u0430\u043D\u0438\u0435\u043C. \u041F\u0440\u043E\u0432\u0435\u0440\u044C\u0442\u0435 \u0442\u0435\u043A\u0441\u0442 \u043F\u0438\u0441\u044C\u043C\u0430.",
    body_not_committed: "\u0420\u0435\u0434\u0430\u043A\u0442\u043E\u0440 \u043F\u043E\u0447\u0442\u044B \u043D\u0435 \u043F\u043E\u0434\u0442\u0432\u0435\u0440\u0434\u0438\u043B \u0441\u043E\u0445\u0440\u0430\u043D\u0435\u043D\u0438\u0435 \u0442\u0435\u043A\u0441\u0442\u0430 \u043F\u0438\u0441\u044C\u043C\u0430. \u041E\u0442\u043F\u0440\u0430\u0432\u043A\u0430 \u043D\u0435 \u0437\u0430\u043F\u0443\u0441\u043A\u0430\u043B\u0430\u0441\u044C. \u0422\u0435\u043A\u0441\u0442 \u043C\u043E\u0436\u043D\u043E \u0441\u043A\u043E\u043F\u0438\u0440\u043E\u0432\u0430\u0442\u044C \u0438\u0437 \u043F\u0430\u043D\u0435\u043B\u0438.",
    input_unavailable: "\u041D\u0430\u0439\u0434\u0435\u043D\u043D\u044B\u0439 \u044D\u043B\u0435\u043C\u0435\u043D\u0442 \u043F\u043E\u0447\u0442\u044B \u043D\u0435 \u043F\u043E\u0434\u0434\u0435\u0440\u0436\u0438\u0432\u0430\u0435\u0442 \u0432\u0432\u043E\u0434 \u0442\u0435\u043A\u0441\u0442\u0430. \u0421\u043A\u0440\u0438\u043F\u0442 \u043D\u0435 \u0441\u043C\u043E\u0433 \u0437\u0430\u043F\u043E\u043B\u043D\u0438\u0442\u044C \u043F\u043E\u043B\u0435.",
    interface_timeout: "\u041D\u0443\u0436\u043D\u044B\u0439 \u044D\u043B\u0435\u043C\u0435\u043D\u0442 \u043F\u043E\u0447\u0442\u043E\u0432\u043E\u0433\u043E \u0438\u043D\u0442\u0435\u0440\u0444\u0435\u0439\u0441\u0430 \u043D\u0435 \u043F\u043E\u044F\u0432\u0438\u043B\u0441\u044F \u0432\u043E\u0432\u0440\u0435\u043C\u044F.",
    unexpected: "\u0417\u0430\u043F\u043E\u043B\u043D\u0435\u043D\u0438\u0435 \u043E\u0441\u0442\u0430\u043D\u043E\u0432\u0438\u043B\u043E\u0441\u044C \u0438\u0437-\u0437\u0430 \u0432\u043D\u0443\u0442\u0440\u0435\u043D\u043D\u0435\u0439 \u043E\u0448\u0438\u0431\u043A\u0438 \u0441\u043A\u0440\u0438\u043F\u0442\u0430. \u041F\u043E\u0434\u0433\u043E\u0442\u043E\u0432\u043A\u0443 \u043F\u0438\u0441\u044C\u043C\u0430 \u043F\u043E\u0434\u0442\u0432\u0435\u0440\u0434\u0438\u0442\u044C \u043D\u0435 \u0443\u0434\u0430\u043B\u043E\u0441\u044C."
  };
  var EditorError = class extends Error {
    constructor(code) {
      super(messages[code]);
      this.code = code;
      this.name = "EditorError";
    }
  };
  function workerErrorMessage(error, signal) {
    if (signal.aborted) return messages.cancelled;
    return error instanceof EditorError ? messages[error.code] : messages.unexpected;
  }

  // src/mail-body.ts
  var messages2 = {
    unavailable: "\u041D\u0435 \u0443\u0434\u0430\u043B\u043E\u0441\u044C \u043F\u043E\u0434\u043A\u043B\u044E\u0447\u0438\u0442\u044C\u0441\u044F \u043A \u0440\u0435\u0434\u0430\u043A\u0442\u043E\u0440\u0443 \u0442\u0435\u043A\u0441\u0442\u0430 \u043F\u043E\u0447\u0442\u044B. \u041F\u0438\u0441\u044C\u043C\u043E \u043D\u0435 \u043E\u0442\u043F\u0440\u0430\u0432\u043B\u0435\u043D\u043E.",
    write_failed: "\u0420\u0435\u0434\u0430\u043A\u0442\u043E\u0440 \u043F\u043E\u0447\u0442\u044B \u043D\u0435 \u043F\u043E\u0434\u0442\u0432\u0435\u0440\u0434\u0438\u043B \u0441\u043E\u0445\u0440\u0430\u043D\u0435\u043D\u0438\u0435 \u0442\u0435\u043A\u0441\u0442\u0430. \u041F\u0438\u0441\u044C\u043C\u043E \u043D\u0435 \u043E\u0442\u043F\u0440\u0430\u0432\u043B\u0435\u043D\u043E.",
    mismatch: "\u0421\u043E\u0445\u0440\u0430\u043D\u0451\u043D\u043D\u044B\u0439 \u0442\u0435\u043A\u0441\u0442 \u043F\u0438\u0441\u044C\u043C\u0430 \u043E\u0442\u043B\u0438\u0447\u0430\u0435\u0442\u0441\u044F \u043E\u0442 \u043F\u043E\u0434\u0433\u043E\u0442\u043E\u0432\u043B\u0435\u043D\u043D\u043E\u0433\u043E. \u041F\u0438\u0441\u044C\u043C\u043E \u043D\u0435 \u043E\u0442\u043F\u0440\u0430\u0432\u043B\u0435\u043D\u043E.",
    cancelled: "\u0417\u0430\u043F\u043E\u043B\u043D\u0435\u043D\u0438\u0435 \u0442\u0435\u043A\u0441\u0442\u0430 \u043E\u0441\u0442\u0430\u043D\u043E\u0432\u043B\u0435\u043D\u043E. \u041F\u0438\u0441\u044C\u043C\u043E \u043D\u0435 \u043E\u0442\u043F\u0440\u0430\u0432\u043B\u0435\u043D\u043E."
  };
  var MailBodyError = class extends Error {
    constructor(code) {
      super(messages2[code]);
      this.code = code;
      this.name = "MailBodyError";
    }
  };
  function guard(body, signal) {
    if (signal.aborted) throw new MailBodyError("cancelled");
    if (!body.isConnected) throw new MailBodyError("unavailable");
  }
  function canonical(text) {
    return text.replace(/\r\n?/g, "\n").replace(/\u00a0/g, " ").trim();
  }
  function renderedText(root) {
    let result = "";
    const appendBreak = (count) => {
      if (!result) return;
      const existing = result.match(/\n*$/)[0].length;
      if (existing < count) result += "\n".repeat(count - existing);
    };
    const visit = (node, preserve2) => {
      if (node.nodeType === 3) {
        const value = node.textContent || "";
        if (!preserve2 && /^[\t\r\n\f ]*$/.test(value) && (!result || result.endsWith("\n")))
          return;
        result += preserve2 ? value : value.replace(/[\t\r\n\f ]+/g, " ");
        return;
      }
      if (node.nodeType !== 1) return;
      const element = node;
      const tag = element.tagName.toLowerCase();
      if (["script", "style", "template", "noscript"].includes(tag)) return;
      if (element.hidden || element.getAttribute("aria-hidden") === "true")
        return;
      if (element.getAttribute("data-cke-filler") !== null || element.getAttribute("data-cke-bogus") !== null)
        return;
      if (tag === "br") {
        result += "\n";
        return;
      }
      const paragraph = /^(p|h[1-6]|blockquote)$/.test(tag);
      const block = paragraph || /^(div|section|article|header|footer|li|tr|pre)$/.test(tag);
      if (block) appendBreak(paragraph ? 2 : 1);
      const literal = preserve2 || tag === "pre" || /^(pre|pre-wrap|break-spaces)$/.test(element.style?.whiteSpace || "");
      for (const child of element.childNodes) visit(child, literal);
      if (block) appendBreak(paragraph ? 2 : 1);
    };
    const preserve = /^(pre|pre-wrap|break-spaces)$/.test(
      root.style?.whiteSpace || ""
    );
    for (const child of root.childNodes) visit(child, preserve);
    return canonical(result.replace(/ *\n */g, "\n"));
  }
  function htmlText(html, body) {
    const Parser = body.ownerDocument.defaultView?.DOMParser;
    if (!Parser) throw new MailBodyError("unavailable");
    const parsed = new Parser().parseFromString(html, "text/html");
    return renderedText(parsed.body);
  }
  function textHtml(text) {
    const escaped = text.replace(/\r\n?/g, "\n").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
    const html = escaped.split("\n").map(
      (line) => line.replace(/ {2,}/g, (spaces) => ` ${"&nbsp;".repeat(spaces.length - 1)}`).replace(/^ | $/g, "&nbsp;")
    ).join("<br>");
    return `<p>${html}</p>`;
  }
  function editorWindow(body) {
    return typeof unsafeWindow !== "undefined" && unsafeWindow ? unsafeWindow : body.ownerDocument.defaultView || {};
  }
  function matchingEditor(body) {
    const instances = editorWindow(body).CKEDITOR?.instances;
    if (!instances) return;
    const matches = Object.values(instances).filter((instance2) => {
      try {
        return instance2.editable?.()?.$ === body;
      } catch {
        return false;
      }
    });
    if (matches.length > 1) throw new MailBodyError("unavailable");
    const instance = matches[0];
    if (!instance || instance.status !== "ready" || instance.readOnly) return;
    if (typeof instance.setData !== "function" || typeof instance.getData !== "function" || typeof instance.fire !== "function")
      throw new MailBodyError("unavailable");
    return instance;
  }
  async function readyEditor(body, signal) {
    const until = Date.now() + 5e3;
    while (Date.now() < until) {
      guard(body, signal);
      const instance = matchingEditor(body);
      if (instance) return instance;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new MailBodyError("unavailable");
  }
  async function setEditorData(instance, html, body, signal) {
    await new Promise((resolve, reject) => {
      let settled = false;
      const finish = (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        signal.removeEventListener("abort", abort);
        if (error) reject(error);
        else resolve();
      };
      const abort = () => finish(new MailBodyError("cancelled"));
      const timeout = setTimeout(
        () => finish(new MailBodyError("write_failed")),
        5e3
      );
      signal.addEventListener("abort", abort, { once: true });
      try {
        guard(body, signal);
        instance.setData(html, { callback: () => finish() });
      } catch {
        finish(new MailBodyError(signal.aborted ? "cancelled" : "write_failed"));
      }
    });
  }
  async function writeMailBody(body, text, signal) {
    try {
      guard(body, signal);
      const expected = canonical(text);
      if (!expected) throw new MailBodyError("write_failed");
      const hostname = body.ownerDocument.location?.hostname || "";
      const managed = !!editorWindow(body).CKEDITOR || /^mail\.yandex\.(ru|com|by|kz)$/.test(hostname) || body.matches(".cke_editable, .cke_wysiwyg_div, [data-cke-editor-id]");
      if (managed) {
        const instance = await readyEditor(body, signal);
        guard(body, signal);
        await setEditorData(instance, textHtml(text), body, signal);
        guard(body, signal);
        if (matchingEditor(body) !== instance)
          throw new MailBodyError("unavailable");
        instance.fire("change");
        const verify2 = () => {
          try {
            guard(body, signal);
            if (matchingEditor(body) !== instance)
              throw new MailBodyError("unavailable");
            const stored = instance.getData();
            if (typeof stored !== "string" || htmlText(stored, body) !== expected || renderedText(body) !== expected)
              throw new MailBodyError("mismatch");
          } catch (error) {
            if (error instanceof MailBodyError) throw error;
            throw new MailBodyError("mismatch");
          }
        };
        verify2();
        return { verify: verify2 };
      }
      const doc = body.ownerDocument;
      if (typeof doc.execCommand !== "function")
        throw new MailBodyError("unavailable");
      const selection = doc.getSelection();
      if (!selection) throw new MailBodyError("unavailable");
      body.focus();
      const range = doc.createRange();
      range.selectNodeContents(body);
      selection.removeAllRanges();
      selection.addRange(range);
      guard(body, signal);
      body.style.whiteSpace = "pre-wrap";
      if (!doc.execCommand("insertText", false, text))
        throw new MailBodyError("write_failed");
      const verify = () => {
        guard(body, signal);
        if (renderedText(body) !== expected) throw new MailBodyError("mismatch");
      };
      verify();
      return { verify };
    } catch (error) {
      if (error instanceof MailBodyError) throw error;
      throw new MailBodyError(signal.aborted ? "cancelled" : "write_failed");
    }
  }

  // src/yandex-recipients.ts
  var editableSelector = 'input, textarea, [contenteditable="true"], [contenteditable="plaintext-only"]';
  var chipSelector = '.yabble-compose, .js-yabble, .composeYabble, .composeYabbles .nb-yabble, [data-testid="recipient-chip"]';
  var toWrapper = ".ComposeRecipients-ToField, .tst-field-to";
  var copyWrapper = ".ComposeRecipients-CcField, .ComposeRecipients-BccField, .tst-field-cc, .tst-field-bcc";
  var fromWrapper = ".ComposeAddressFrom, .ComposeRecipients-FromField, .tst-field-from";
  var bodySelector = '.composeReact-MBody, .ComposeMbody, .cke_wysiwyg_div, [aria-label="Message Body"], [aria-label="\u0422\u0435\u043A\u0441\u0442 \u043F\u0438\u0441\u044C\u043C\u0430"]';
  var emailPattern2 = /[A-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
  var normalize = (text) => (text || "").trim().replace(/[:：]\s*$/, "").toLowerCase();
  var toNames = /* @__PURE__ */ new Set(["to", "\u043A\u043E\u043C\u0443"]);
  var copyNames = /* @__PURE__ */ new Set(["cc", "bcc", "\u043A\u043E\u043F\u0438\u044F", "\u0441\u043A\u0440\u044B\u0442\u0430\u044F \u043A\u043E\u043F\u0438\u044F"]);
  var unrelatedNames = /* @__PURE__ */ new Set([
    "from",
    "\u043E\u0442",
    "\u043E\u0442 \u043A\u043E\u0433\u043E",
    "\u043E\u0442\u043F\u0440\u0430\u0432\u0438\u0442\u0435\u043B\u044C",
    "subject",
    "subjectbox",
    "subj",
    "\u0442\u0435\u043C\u0430"
  ]);
  function names(element, root) {
    const values = [
      element.getAttribute("name"),
      element.getAttribute("aria-label"),
      element.getAttribute("title")
    ];
    for (const id of (element.getAttribute("aria-labelledby") || "").split(
      /\s+/
    )) {
      if (id)
        values.push(
          element.ownerDocument.getElementById(id)?.textContent || null
        );
    }
    const labelledBy = (element.getAttribute("aria-labelledby") || "").split(/\s+/).filter(Boolean).map((id) => element.ownerDocument.getElementById(id)?.textContent || "").join(" ");
    if (labelledBy) values.push(labelledBy);
    if (element.id) {
      for (const label of root.querySelectorAll("label[for]")) {
        if (label.getAttribute("for") === element.id)
          values.push(label.textContent);
      }
    }
    const parentLabel = element.closest("label");
    if (parentLabel) values.push(parentLabel.textContent);
    return values.map(normalize).filter(Boolean);
  }
  function excluded(element) {
    return !!element.closest(`${bodySelector}, ${fromWrapper}`);
  }
  function editable(element, isVisible) {
    if (!isVisible(element) || excluded(element)) return false;
    if (element.closest(
      '[hidden], [aria-hidden="true"], [aria-disabled="true"], [aria-readonly="true"], [inert]'
    ) || element.hasAttribute("disabled") || element.hasAttribute("readonly") || element.matches(":disabled"))
      return false;
    if (element.tagName === "INPUT") {
      const type = (element.getAttribute("type") || "text").toLowerCase();
      return ["text", "email", "search"].includes(type);
    }
    return element.tagName === "TEXTAREA" || ["true", "plaintext-only"].includes(
      element.getAttribute("contenteditable") || ""
    );
  }
  function candidates(root, isVisible) {
    return [...root.querySelectorAll(editableSelector)].filter((element) => editable(element, isVisible)).map((element) => ({ element, names: names(element, root) })).filter(
      (candidate) => !candidate.names.some((name) => unrelatedNames.has(name))
    );
  }
  function resolveYandexTo(root, isVisible) {
    const eligible = candidates(root, isVisible).filter(
      (candidate) => !candidate.element.closest(copyWrapper) && !candidate.names.some((name) => copyNames.has(name))
    );
    const precise = eligible.filter(
      (candidate) => candidate.names.some((name) => toNames.has(name)) || candidate.element.closest(toWrapper)
    );
    if (precise.length) return precise.length === 1 ? precise[0].element : null;
    const fallback = eligible.filter(
      (candidate) => candidate.element.closest(".composeYabbles")
    );
    return fallback.length === 1 ? fallback[0].element : null;
  }
  function yandexRecipientAddresses(root) {
    const addresses = /* @__PURE__ */ new Set();
    for (const chip of root.querySelectorAll(chipSelector)) {
      if (excluded(chip)) continue;
      const outerChip = chip.parentElement?.closest(chipSelector);
      if (outerChip && root.contains(outerChip)) continue;
      for (const value of [
        chip.getAttribute("data-email"),
        chip.getAttribute("email"),
        chip.getAttribute("data-hovercard-id"),
        chip.getAttribute("data-value"),
        chip.getAttribute("title"),
        chip.textContent
      ]) {
        const matches = value?.match(emailPattern2) || [];
        if (!matches.length) continue;
        for (const address of matches) addresses.add(address.toLowerCase());
        break;
      }
    }
    return [...addresses].sort();
  }
  function pendingText(node) {
    if (node.nodeType === 3) return node.textContent || "";
    if (node.nodeType === 1 && node.matches(chipSelector)) return "";
    return [...node.childNodes].map(pendingText).join("");
  }
  function yandexPendingRecipientText(element) {
    return element.tagName === "INPUT" || element.tagName === "TEXTAREA" ? element.value : pendingText(element);
  }
  function yandexHasPendingRecipient(root, isVisible) {
    return candidates(root, isVisible).some((candidate) => {
      const element = candidate.element;
      const recipientField = candidate.names.some(
        (name) => toNames.has(name) || copyNames.has(name)
      ) || element.closest(`${toWrapper}, ${copyWrapper}, .composeYabbles`);
      if (!recipientField) return false;
      const text = yandexPendingRecipientText(element);
      return text.replace(/[\s\u200B-\u200D\u2060\uFEFF]/g, "").length > 0;
    });
  }
  function yandexHasCopyRecipients(root) {
    for (const wrapper of root.querySelectorAll(copyWrapper)) {
      if (yandexRecipientAddresses(wrapper).length) return true;
    }
    const fields = [...root.querySelectorAll(editableSelector)].filter((element) => !excluded(element)).map((element) => ({ element, names: names(element, root) })).filter(
      (candidate) => !candidate.names.some((name) => unrelatedNames.has(name)) && (candidate.names.some(
        (name) => toNames.has(name) || copyNames.has(name)
      ) || !!candidate.element.closest(
        `${toWrapper}, ${copyWrapper}, .composeYabbles`
      ))
    );
    for (const candidate of fields) {
      if (!candidate.names.some((name) => copyNames.has(name)) && !candidate.element.closest(copyWrapper))
        continue;
      const field2 = candidate.element;
      if ((field2.tagName === "INPUT" || field2.tagName === "TEXTAREA") && field2.value.trim())
        return true;
      if (yandexRecipientAddresses(field2).length) return true;
      for (let region = field2.parentElement; region && region !== root; region = region.parentElement) {
        if (fields.some(
          (other) => other.element !== field2 && region.contains(other.element)
        ))
          break;
        if (yandexRecipientAddresses(region).length) return true;
      }
    }
    return false;
  }

  // src/adapters.ts
  var emailPattern3 = /[A-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
  var visible = (e) => e instanceof HTMLElement && !e.hidden && e.getAttribute("aria-hidden") !== "true" && getComputedStyle(e).display !== "none" && getComputedStyle(e).visibility !== "hidden" && e.getClientRects().length > 0;
  function identifyAccount(doc = document, href = location.href) {
    const url = new URL(href);
    const gmail = url.hostname === "mail.google.com";
    if (!gmail && !/^mail\.yandex\.(ru|com|by|kz)$/.test(url.hostname))
      return null;
    if (!gmail) return yandexAccount(doc, url);
    const selectors = gmail ? '[aria-label*="Google Account"], [aria-label*="\u0410\u043A\u043A\u0430\u0443\u043D\u0442 Google"], a[href*="SignOutOptions"]' : '.mail-User-Name, .user-account__name, .user-account__login, [data-testid="user-account"]';
    const addresses = /* @__PURE__ */ new Set();
    for (const el2 of doc.querySelectorAll(selectors)) {
      for (const str of [
        el2.getAttribute("aria-label"),
        el2.getAttribute("title"),
        el2.textContent
      ]) {
        for (const match2 of str?.match(emailPattern3) || [])
          addresses.add(match2.toLowerCase());
      }
    }
    if (addresses.size !== 1) return null;
    const match = url.pathname.match(/^\/mail\/u\/(\d+)\//);
    if (gmail && !match) return null;
    return {
      provider: gmail ? "gmail" : "yandex",
      email: [...addresses][0],
      baseUrl: gmail ? `${url.origin}/mail/u/${match[1]}/` : `${url.origin}/`
    };
  }
  function sameAccount(a, b) {
    return !!b && a.provider === b.provider && (a.uid ? a.uid === b.uid : !!a.email && a.email === b.email) && a.baseUrl === b.baseUrl;
  }
  function currentMailContext(doc = document, href = location.href) {
    const url = new URL(href);
    if (url.protocol !== "https:" || url.port) return null;
    if (/^mail\.yandex\.(ru|com|by|kz)$/.test(url.hostname)) {
      return {
        provider: "yandex",
        email: "",
        baseUrl: `${url.origin}/`,
        useCurrentSession: true
      };
    }
    return identifyAccount(doc, href);
  }
  function matchesMailContext(expected, doc = document, href = location.href) {
    if (expected.useCurrentSession) {
      const current = currentMailContext(doc, href);
      return expected.provider === "yandex" && current?.provider === "yandex" && expected.baseUrl === current.baseUrl;
    }
    return sameAccount(expected, identifyAccount(doc, href));
  }
  async function waitFor(get, signal, timeout = 2e4, errorCode = "interface_timeout") {
    const until = Date.now() + timeout;
    while (Date.now() < until) {
      signal.throwIfAborted();
      const value = get();
      if (value) return value;
      await new Promise((r) => setTimeout(r, 150));
    }
    signal.throwIfAborted();
    throw new EditorError(errorCode);
  }
  function one(selector, root = document) {
    const nodes = [...root.querySelectorAll(selector)].filter(visible);
    return nodes.length === 1 ? nodes[0] : null;
  }
  function setInput(el2, value) {
    if (!(el2 instanceof HTMLInputElement || el2 instanceof HTMLTextAreaElement))
      throw new EditorError("input_unavailable");
    const prototype = el2 instanceof HTMLInputElement ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, "value").set.call(el2, value);
    el2.dispatchEvent(new Event("input", { bubbles: true }));
    el2.dispatchEvent(new Event("change", { bubbles: true }));
  }
  function enter(el2) {
    el2.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "Enter",
        code: "Enter",
        keyCode: 13,
        which: 13,
        bubbles: true,
        cancelable: true
      })
    );
    el2.dispatchEvent(
      new KeyboardEvent("keyup", {
        key: "Enter",
        code: "Enter",
        keyCode: 13,
        which: 13,
        bubbles: true
      })
    );
  }
  function insertRecipient(el2, address) {
    if (el2 instanceof HTMLInputElement || el2 instanceof HTMLTextAreaElement) {
      setInput(el2, address);
      return;
    }
    if (!["true", "plaintext-only"].includes(
      el2.getAttribute("contenteditable") || ""
    ))
      throw new EditorError("input_unavailable");
    const doc = el2.ownerDocument;
    const selection = doc.getSelection();
    if (!selection) throw new EditorError("input_unavailable");
    const range = doc.createRange();
    range.selectNodeContents(el2);
    range.collapse(false);
    selection.removeAllRanges();
    selection.addRange(range);
    if (typeof doc.execCommand === "function" && doc.execCommand("insertText", false, address))
      return;
    range.insertNode(doc.createTextNode(address));
    range.collapse(false);
    selection.removeAllRanges();
    selection.addRange(range);
    el2.dispatchEvent(
      new InputEvent("input", {
        bubbles: true,
        inputType: "insertText",
        data: address
      })
    );
  }
  var bodies = {
    gmail: '[contenteditable="true"][role="textbox"][aria-label="Message Body"], [contenteditable="true"][role="textbox"][aria-label="\u0422\u0435\u043A\u0441\u0442 \u043F\u0438\u0441\u044C\u043C\u0430"]',
    yandex: '.cke_wysiwyg_div[contenteditable="true"], .composeReact-MBody [contenteditable="true"], .ComposeMbody [contenteditable="true"]'
  };
  function composeButton(provider) {
    if (provider === "yandex") {
      const b = one(
        '.mail-ComposeButton, .mail-ComposeButton-Wrap a, [data-testid="compose-button"]'
      );
      if (b) return b;
    }
    const buttons = [...document.querySelectorAll('[role="button"], button, a')].filter(visible).filter(
      (e) => /^(Compose|Написать|Написать письмо)$/i.test(
        e.textContent?.trim() || ""
      ) || /^(Compose|Написать|Написать письмо)$/i.test(
        e.getAttribute("aria-label") || ""
      )
    );
    return buttons.length === 1 ? buttons[0] : null;
  }
  function recipientAddresses(root, provider) {
    if (provider === "yandex") return yandexRecipientAddresses(root);
    const chips = root.querySelectorAll("[email], [data-hovercard-id]");
    return [
      ...new Set(
        [...chips].flatMap(
          (e) => [
            e.getAttribute("email"),
            e.getAttribute("data-hovercard-id"),
            e.getAttribute("data-email"),
            e.getAttribute("title"),
            e.textContent
          ].flatMap((s) => s?.match(emailPattern3) || [])
        ).map((s) => s.toLowerCase())
      )
    ].sort();
  }
  function hasPendingGmailRecipient(root) {
    return [
      ...root.querySelectorAll(
        'input[name="to"], textarea[name="to"], input[name="cc"], textarea[name="cc"], input[name="bcc"], textarea[name="bcc"], input[role="combobox"][aria-label="To recipients"], input[role="combobox"][aria-label="\u041F\u043E\u043B\u0443\u0447\u0430\u0442\u0435\u043B\u0438"]'
      )
    ].some(
      (input) => visible(input) && input.type !== "hidden" && input.value.trim().length > 0
    );
  }
  function hasCopyRecipients(root, provider) {
    if (provider === "yandex") return yandexHasCopyRecipients(root);
    const copyFields = root.querySelectorAll(
      'input[name="cc"], input[name="bcc"], textarea[name="cc"], textarea[name="bcc"], [data-name="cc"], [data-name="bcc"], [aria-label="Cc recipients"], [aria-label="Bcc recipients"], [aria-label="\u041F\u043E\u043B\u0443\u0447\u0430\u0442\u0435\u043B\u0438 \u043A\u043E\u043F\u0438\u0438"], [aria-label="\u041F\u043E\u043B\u0443\u0447\u0430\u0442\u0435\u043B\u0438 \u0441\u043A\u0440\u044B\u0442\u043E\u0439 \u043A\u043E\u043F\u0438\u0438"]'
    );
    return [...copyFields].some((field2) => {
      if ((field2 instanceof HTMLInputElement || field2 instanceof HTMLTextAreaElement) && field2.value.trim())
        return true;
      const region = field2.closest("tr") || (field2.parentElement !== root ? field2.parentElement : null) || field2;
      if (recipientAddresses(region, provider).length) return true;
      return false;
    });
  }
  async function commitYandexRecipients(root, recipient, subject, body, originalBodyText, addresses, findRecipient, guard2) {
    const expected = [
      ...new Set(addresses.map((value) => value.toLowerCase()))
    ].sort();
    const normalizePending = (value) => value.replace(/[\u200B-\u200D\u2060\uFEFF]/g, "").replace(/\u00a0/g, " ").trim();
    const insertedText = normalizePending(addresses.join(", "));
    const checkEditor = () => {
      guard2();
      if (!root.isConnected || !root.contains(body) || !visible(body))
        throw new EditorError("body_missing");
      if (!root.contains(subject) || !visible(subject))
        throw new EditorError("subject_missing");
      if (!root.contains(recipient) || findRecipient() !== recipient)
        throw new EditorError("recipients_missing");
      if (subject.value.trim()) throw new EditorError("existing_subject");
      if ((body.textContent?.trim() || "") !== originalBodyText)
        throw new EditorError("existing_body");
      if (yandexHasCopyRecipients(root))
        throw new EditorError("recipients_mismatch");
      const actual = yandexRecipientAddresses(root);
      if (actual.some((address) => !expected.includes(address)))
        throw new EditorError("recipients_mismatch");
      const pending = normalizePending(yandexPendingRecipientText(recipient));
      if (!actual.length && pending !== insertedText)
        throw new EditorError("recipients_mismatch");
      return { actual, pending };
    };
    await new Promise((resolve) => setTimeout(resolve, 0));
    if (!checkEditor().actual.length) enter(recipient);
    const until = Date.now() + 5e3;
    while (Date.now() < until) {
      const { actual, pending } = checkEditor();
      if (JSON.stringify(actual) === JSON.stringify(expected) && !pending) return;
      if (!actual.length) {
        recipient.focus();
        const afterFocus = checkEditor();
        if (!afterFocus.actual.length) subject.focus();
      }
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
    checkEditor();
    throw new EditorError("recipient_unconfirmed");
  }
  async function fillLetter(account, letter, signal, stillActive = () => true) {
    const guard2 = () => {
      signal.throwIfAborted();
      if (!stillActive()) throw new EditorError("cancelled");
      if (!matchesMailContext(account))
        throw new EditorError("context_unavailable");
    };
    await waitFor(
      () => matchesMailContext(account),
      signal,
      2e4,
      "context_unavailable"
    );
    guard2();
    if ([...document.querySelectorAll(bodies[account.provider])].some(visible))
      throw new EditorError("existing_editor");
    const button2 = await waitFor(
      () => composeButton(account.provider),
      signal,
      2e4,
      "compose_button_missing"
    );
    guard2();
    button2.click();
    const body = await waitFor(
      () => one(bodies[account.provider]),
      signal,
      2e4,
      "body_missing"
    );
    guard2();
    const root = account.provider === "gmail" ? body.closest('[role="dialog"]') || body.closest("form") : body.closest(
      '.ComposePopup, .composeReact, .compose, [data-testid="compose"]'
    );
    if (!(root instanceof HTMLElement))
      throw new EditorError("editor_root_missing");
    const subject = one(
      account.provider === "gmail" ? 'input[name="subjectbox"]' : 'input[name="subject"], .composeTextField[name="subj"], input[name="subj"]',
      root
    );
    if (!(subject instanceof HTMLInputElement))
      throw new EditorError("subject_missing");
    if (subject.value.trim()) throw new EditorError("existing_subject");
    if (recipientAddresses(root, account.provider).length)
      throw new EditorError("existing_recipients");
    const signature = body.querySelector(
      ".gmail_signature, .mail-Signature, .compose-signature"
    );
    if (body.textContent?.trim() && body.textContent.trim() !== signature?.textContent?.trim())
      throw new EditorError("existing_body");
    const originalSignature = signature?.textContent?.trim() || "";
    const findRecipient = () => account.provider === "yandex" ? resolveYandexTo(root, visible) : one(
      'input[name="to"], textarea[name="to"], input[role="combobox"][aria-label="To recipients"], input[role="combobox"][aria-label="\u041F\u043E\u043B\u0443\u0447\u0430\u0442\u0435\u043B\u0438"]',
      root
    );
    await waitFor(findRecipient, signal, 1e4, "recipients_missing");
    guard2();
    if (subject.value.trim()) throw new EditorError("existing_subject");
    if (recipientAddresses(root, account.provider).length)
      throw new EditorError("existing_recipients");
    if (body.textContent?.trim() && body.textContent.trim() !== originalSignature)
      throw new EditorError("existing_body");
    if (account.provider === "yandex" && yandexHasPendingRecipient(root, visible))
      throw new EditorError("existing_recipients");
    const originalBodyText = body.textContent?.trim() || "";
    const recipientBatches = account.provider === "yandex" ? [letter.to] : letter.to.map((address) => [address]);
    for (const addresses of recipientBatches) {
      guard2();
      const recipient = await waitFor(
        findRecipient,
        signal,
        1e4,
        "recipients_missing"
      );
      guard2();
      recipient.focus();
      insertRecipient(recipient, addresses.join(", "));
      if (account.provider === "yandex") {
        await commitYandexRecipients(
          root,
          recipient,
          subject,
          body,
          originalBodyText,
          addresses,
          findRecipient,
          guard2
        );
      } else {
        enter(recipient);
        await waitFor(
          () => addresses.every(
            (address) => recipientAddresses(root, account.provider).includes(
              address.toLowerCase()
            )
          ),
          signal,
          5e3,
          "recipient_unconfirmed"
        );
      }
    }
    guard2();
    setInput(subject, letter.subject);
    const text = letter.body + (originalSignature ? `

${originalSignature}` : "");
    let bodyCheckpoint;
    try {
      bodyCheckpoint = await writeMailBody(body, text, signal);
    } catch (cause) {
      guard2();
      throw new EditorError(
        cause instanceof MailBodyError && cause.code === "mismatch" ? "body_mismatch" : "body_not_committed"
      );
    }
    body.blur();
    subject.blur();
    await new Promise((r) => setTimeout(r, 500));
    const expected = [...new Set(letter.to.map((s) => s.toLowerCase()))].sort();
    const expectedSubject = letter.subject;
    const verify = () => {
      guard2();
      if (!root.isConnected || !root.contains(body) || !visible(body))
        throw new EditorError("body_missing");
      if (!root.contains(subject) || !visible(subject))
        throw new EditorError("subject_missing");
      const actual = recipientAddresses(root, account.provider);
      if (JSON.stringify(actual) !== JSON.stringify(expected) || hasCopyRecipients(root, account.provider))
        throw new EditorError("recipients_mismatch");
      if (account.provider === "yandex" ? yandexHasPendingRecipient(root, visible) : hasPendingGmailRecipient(root))
        throw new EditorError("recipient_unconfirmed");
      if (subject.value !== expectedSubject)
        throw new EditorError("subject_mismatch");
      try {
        bodyCheckpoint.verify();
      } catch {
        throw new EditorError("body_mismatch");
      }
    };
    verify();
    return {
      root,
      body,
      provider: account.provider,
      verify
    };
  }

  // src/send-letter.ts
  var messages3 = {
    button_missing: "\u041D\u0435 \u043D\u0430\u0439\u0434\u0435\u043D\u0430 \u0434\u043E\u0441\u0442\u0443\u043F\u043D\u0430\u044F \u043A\u043D\u043E\u043F\u043A\u0430 \xAB\u041E\u0442\u043F\u0440\u0430\u0432\u0438\u0442\u044C\xBB \u0432 \u043F\u043E\u0434\u0433\u043E\u0442\u043E\u0432\u043B\u0435\u043D\u043D\u043E\u043C \u043F\u0438\u0441\u044C\u043C\u0435. \u041E\u0442\u043F\u0440\u0430\u0432\u043A\u0430 \u043D\u0435 \u0437\u0430\u043F\u0443\u0441\u043A\u0430\u043B\u0430\u0441\u044C.",
    button_ambiguous: "\u0412 \u0440\u0435\u0434\u0430\u043A\u0442\u043E\u0440\u0435 \u043D\u0430\u0439\u0434\u0435\u043D\u043E \u043D\u0435\u0441\u043A\u043E\u043B\u044C\u043A\u043E \u043A\u043D\u043E\u043F\u043E\u043A \xAB\u041E\u0442\u043F\u0440\u0430\u0432\u0438\u0442\u044C\xBB. \u041E\u0442\u043F\u0440\u0430\u0432\u043A\u0430 \u043D\u0435 \u0437\u0430\u043F\u0443\u0441\u043A\u0430\u043B\u0430\u0441\u044C.",
    already_attempted: "\u0414\u043B\u044F \u044D\u0442\u043E\u0433\u043E \u043F\u0438\u0441\u044C\u043C\u0430 \u043E\u0442\u043F\u0440\u0430\u0432\u043A\u0430 \u0443\u0436\u0435 \u0437\u0430\u043F\u0443\u0441\u043A\u0430\u043B\u0430\u0441\u044C. \u041F\u043E\u0432\u0442\u043E\u0440\u043D\u0430\u044F \u043E\u0442\u043F\u0440\u0430\u0432\u043A\u0430 \u043E\u0442\u043A\u043B\u044E\u0447\u0435\u043D\u0430: \u043F\u0440\u043E\u0432\u0435\u0440\u044C\u0442\u0435 \xAB\u041E\u0442\u043F\u0440\u0430\u0432\u043B\u0435\u043D\u043D\u044B\u0435\xBB.",
    cancelled: "\u041E\u0442\u043F\u0440\u0430\u0432\u043A\u0430 \u043E\u0441\u0442\u0430\u043D\u043E\u0432\u043B\u0435\u043D\u0430 \u0434\u043E \u043D\u0430\u0436\u0430\u0442\u0438\u044F \xAB\u041E\u0442\u043F\u0440\u0430\u0432\u0438\u0442\u044C\xBB. \u041F\u0438\u0441\u044C\u043C\u043E \u043E\u0441\u0442\u0430\u043B\u043E\u0441\u044C \u0432 \u0440\u0435\u0434\u0430\u043A\u0442\u043E\u0440\u0435.",
    unexpected: "\u041D\u0435 \u0443\u0434\u0430\u043B\u043E\u0441\u044C \u0437\u0430\u043F\u0443\u0441\u0442\u0438\u0442\u044C \u043E\u0442\u043F\u0440\u0430\u0432\u043A\u0443. \u041A\u043D\u043E\u043F\u043A\u0430 \xAB\u041E\u0442\u043F\u0440\u0430\u0432\u0438\u0442\u044C\xBB \u043D\u0435 \u043D\u0430\u0436\u0438\u043C\u0430\u043B\u0430\u0441\u044C.",
    previous_notice_timeout: "\u041F\u0440\u0435\u0434\u044B\u0434\u0443\u0449\u0435\u0435 \u0443\u0432\u0435\u0434\u043E\u043C\u043B\u0435\u043D\u0438\u0435 \u042F\u043D\u0434\u0435\u043A\u0441\u0430 \u043E\u0431 \u043E\u0442\u043F\u0440\u0430\u0432\u043A\u0435 \u043D\u0435 \u0438\u0441\u0447\u0435\u0437\u043B\u043E \u0437\u0430 12 \u0441\u0435\u043A\u0443\u043D\u0434. \u0422\u0435\u043A\u0443\u0449\u0435\u0435 \u043F\u0438\u0441\u044C\u043C\u043E \u043D\u0435 \u043E\u0442\u043F\u0440\u0430\u0432\u043B\u0435\u043D\u043E. \u0414\u043E\u0436\u0434\u0438\u0442\u0435\u0441\u044C \u0438\u0441\u0447\u0435\u0437\u043D\u043E\u0432\u0435\u043D\u0438\u044F \u0443\u0432\u0435\u0434\u043E\u043C\u043B\u0435\u043D\u0438\u044F."
  };
  var SendError = class extends Error {
    constructor(code) {
      super(messages3[code]);
      this.code = code;
      this.name = "SendError";
    }
  };
  var SendUncertainError = class extends Error {
    constructor() {
      super(
        "\u041E\u0442\u043F\u0440\u0430\u0432\u043A\u0430 \u0437\u0430\u043F\u0443\u0441\u043A\u0430\u043B\u0430\u0441\u044C, \u043D\u043E \u043F\u043E\u0434\u0442\u0432\u0435\u0440\u0436\u0434\u0435\u043D\u0438\u0435 \u043F\u043E\u0447\u0442\u044B \u043D\u0435 \u043F\u043E\u043B\u0443\u0447\u0435\u043D\u043E. \u041F\u0440\u043E\u0432\u0435\u0440\u044C\u0442\u0435 \xAB\u041E\u0442\u043F\u0440\u0430\u0432\u043B\u0435\u043D\u043D\u044B\u0435\xBB \u0438 \u0447\u0435\u0440\u043D\u043E\u0432\u0438\u043A. \u0410\u0432\u0442\u043E\u043C\u0430\u0442\u0438\u0447\u0435\u0441\u043A\u043E\u0433\u043E \u043F\u043E\u0432\u0442\u043E\u0440\u0430 \u043D\u0435 \u0431\u0443\u0434\u0435\u0442."
      );
      this.name = "SendUncertainError";
    }
  };
  var attempted = /* @__PURE__ */ new WeakSet();
  var composeRoots = '.ComposePopup, .composeReact, .compose, [data-testid="compose"], [role="dialog"], form';
  var normalize2 = (value) => (value || "").replace(/[\u200B-\u200F\u202A-\u202E\u2060-\u206F\uFEFF]/g, "").replace(/\s+/g, " ").trim();
  var sendName = /^(?:Send|Отправить)(?:\s*\([^)]*\))?$/i;
  var delayedControl = '.ComposeControlPanel-DelayedSendingButton, .qa-Compose-DelayedSendingButton, [aria-haspopup="menu"], [aria-haspopup="true"]';
  function shown(element) {
    if (!element.isConnected || !visible(element)) return false;
    for (let parent = element; parent; parent = parent.parentElement) {
      if (parent.matches('[hidden], [aria-hidden="true"], [inert]')) return false;
      const style = getComputedStyle(parent);
      if (style.display === "none" || style.visibility === "hidden") return false;
    }
    return true;
  }
  function enabled(button2) {
    return !button2.matches(":disabled") && !button2.closest('[aria-disabled="true"], [disabled], [inert]');
  }
  function sendButton(prepared) {
    const buttons = [
      ...prepared.root.querySelectorAll(
        'button, [role="button"], input[type="submit"]'
      )
    ].filter((button2) => {
      if (!shown(button2) || button2.closest(delayedControl)) return false;
      const nearest = button2.closest(composeRoots);
      if (nearest && nearest !== prepared.root && prepared.root.contains(nearest) && !nearest.contains(prepared.body))
        return false;
      const labels2 = [
        button2.getAttribute("aria-label"),
        button2.getAttribute("data-tooltip"),
        button2.getAttribute("title"),
        button2.textContent,
        button2.getAttribute("value")
      ].map(normalize2).filter(Boolean);
      if (labels2.some(
        (label) => /schedule|send later|delayed|по таймеру|отложенн|позже/i.test(label)
      ))
        return false;
      const observedYandex = prepared.provider === "yandex" && !!button2.closest(
        ".ComposeControlPanel-SendButton, .qa-Compose-SendButton"
      );
      return observedYandex || labels2.some((label) => sendName.test(label));
    });
    if (buttons.length > 1) throw new SendError("button_ambiguous");
    return buttons.length === 1 && enabled(buttons[0]) ? buttons[0] : null;
  }
  var notices = {
    gmail: '[role="alert"], [role="status"], .bAq',
    yandex: '[role="alert"], [role="status"], .mail-Notification, .notification, .Notification, .ComposeSuccess, .ComposeDoneScreen, .ComposeDoneScreen-Title, [data-testid="compose-success"], [data-testid="compose-done"]'
  };
  var viewedMessageBodies = {
    gmail: ".a3s",
    yandex: ".js-message-body, .react-message-wrapper__body"
  };
  var sentNotice = /^(?:Message (?:has been )?sent|Your message has been sent|(?:Ваше )?Письмо (?:успешно )?отправлено|(?:Ваше )?Сообщение (?:успешно )?отправлено)(?:[.!…]|\s|$)/i;
  var failedNotice = /^(?:Message (?:was )?not sent|(?:Could not|Couldn't|Failed to|Unable to) send|Не удалось отправить|(?:Письмо|Сообщение) не отправлено|Ошибка отправки)(?:[.!…:]|\s|$)/i;
  function notificationState(prepared) {
    const states = /* @__PURE__ */ new Map();
    const selector = notices[prepared.provider] + (prepared.provider === "yandex" ? ', [data-testid="statusline_root_container"] *' : "");
    for (const element of prepared.root.ownerDocument.querySelectorAll(
      selector
    )) {
      if (prepared.body.contains(element) || element.contains(prepared.body) || element.closest(viewedMessageBodies[prepared.provider]) || element.querySelector(viewedMessageBodies[prepared.provider]) || element.closest(
        '[contenteditable="true"], [contenteditable="plaintext-only"]'
      ))
        continue;
      const text = normalize2(element.textContent);
      if (!element.matches(notices[prepared.provider]) && !sentNotice.test(text) && !failedNotice.test(text))
        continue;
      if (!shown(element)) continue;
      const walker = element.ownerDocument.createTreeWalker(element, 4);
      let firstText;
      do {
        firstText = walker.nextNode();
      } while (firstText && !normalize2(firstText.textContent));
      states.set(element, {
        text,
        acknowledgement: sentNotice.exec(text)?.[0].replace(/[.!…\s]+$/, "").toLowerCase(),
        firstText
      });
    }
    return states;
  }
  function editorGone(prepared) {
    return !shown(prepared.root) || !shown(prepared.body);
  }
  async function waitForPreviousYandexNotice(prepared, signal, onWaiting) {
    if (prepared.provider !== "yandex") return;
    const selector = '[data-testid="statusline_root_container"] [data-testid="statusline_item_container"] [name="MessageSent"]';
    const pending = () => prepared.root.ownerDocument.querySelector(selector);
    if (!pending()) return;
    const deadline = Date.now() + 12e3;
    try {
      onWaiting?.();
    } catch {
    }
    while (pending()) {
      signal.throwIfAborted();
      prepared.verify();
      if (Date.now() >= deadline) throw new SendError("previous_notice_timeout");
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
    signal.throwIfAborted();
    prepared.verify();
  }
  async function sendLetter(prepared, signal, beforeClick, onWaiting) {
    let claimed = false;
    let observer;
    try {
      signal.throwIfAborted();
      if (attempted.has(prepared)) throw new SendError("already_attempted");
      prepared.verify();
      await waitForPreviousYandexNotice(prepared, signal, onWaiting);
      const deadline = Date.now() + 1e4;
      let button2 = null;
      while (!(button2 = sendButton(prepared))) {
        signal.throwIfAborted();
        prepared.verify();
        if (Date.now() >= deadline) throw new SendError("button_missing");
        await new Promise((resolve) => setTimeout(resolve, 150));
      }
      const baseline = notificationState(prepared);
      const baselineText = /* @__PURE__ */ new Map();
      for (const state of baseline.values())
        if (state.firstText && state.acknowledgement)
          baselineText.set(state.firstText, state.acknowledgement);
      let confirmed = false;
      let contradicted = false;
      const refreshedText = /* @__PURE__ */ new Set();
      const acknowledgements = /* @__PURE__ */ new Set();
      const observeSuccess = (records = []) => {
        if (!claimed) return;
        for (const record of records) {
          if (record.type === "characterData" && normalize2(record.oldValue) === normalize2(record.target.textContent))
            refreshedText.add(record.target);
        }
        const current = notificationState(prepared);
        for (const node of acknowledgements) {
          const text = normalize2(node.textContent);
          if (text && !sentNotice.test(text)) contradicted = true;
        }
        for (const [node, state] of current) {
          const previous = baseline.get(node);
          if (failedNotice.test(state.text) && (previous?.text !== state.text || previous.firstText !== state.firstText))
            contradicted = true;
          if (state.acknowledgement && state.firstText && // Wrapping/reordering old toasts changes their ancestor elements, not
          // the acknowledgement itself. Freshness follows its actual text node.
          (baselineText.get(state.firstText) !== state.acknowledgement || refreshedText.has(state.firstText)))
            acknowledgements.add(node);
        }
        if (contradicted) confirmed = false;
        else if (acknowledgements.size && editorGone(prepared)) confirmed = true;
      };
      const Observer = prepared.root.ownerDocument.defaultView?.MutationObserver;
      if (!Observer) throw new SendError("unexpected");
      observer = new Observer(observeSuccess);
      observer.observe(prepared.root.ownerDocument.documentElement, {
        subtree: true,
        childList: true,
        characterData: true,
        characterDataOldValue: true,
        attributes: true,
        attributeFilter: ["hidden", "aria-hidden", "style", "class"]
      });
      signal.throwIfAborted();
      prepared.verify();
      const ready = sendButton(prepared);
      if (ready !== button2) throw new SendError("button_missing");
      claimed = true;
      attempted.add(prepared);
      beforeClick();
      signal.throwIfAborted();
      button2.click();
      const sentDeadline = Date.now() + 2e4;
      while (Date.now() < sentDeadline) {
        signal.throwIfAborted();
        observeSuccess();
        if (confirmed) return;
        await new Promise((resolve) => setTimeout(resolve, 150));
      }
      throw new SendUncertainError();
    } catch (error) {
      if (claimed) throw new SendUncertainError();
      if (signal.aborted) throw new SendError("cancelled");
      if (error instanceof SendError || error instanceof EditorError) throw error;
      throw new SendError("unexpected");
    } finally {
      observer?.disconnect();
    }
  }

  // src/transport.ts
  var store = {
    get: (key) => GM_getValue(key),
    set: (key, value) => GM_setValue(key, value),
    delete: (key) => GM_deleteValue(key),
    keys: () => GM_listValues()
  };
  var CurrentTabTransport = class {
    constructor(account, deliveryMode = "send") {
      this.account = account;
      this.deliveryMode = deliveryMode;
    }
    active;
    clear() {
      this.active?.controller.abort();
    }
    async prepare(letter, signal, progress) {
      if (signal.aborted) throw new Error(workerErrorMessage(void 0, signal));
      if (this.active)
        throw new Error(
          "\u041F\u0440\u0435\u0434\u044B\u0434\u0443\u0449\u0435\u0435 \u043F\u0438\u0441\u044C\u043C\u043E \u0435\u0449\u0451 \u043E\u0431\u0440\u0430\u0431\u0430\u0442\u044B\u0432\u0430\u0435\u0442\u0441\u044F. \u0414\u043E\u0436\u0434\u0438\u0442\u0435\u0441\u044C \u0437\u0430\u0432\u0435\u0440\u0448\u0435\u043D\u0438\u044F."
        );
      let contextMatches = false;
      try {
        contextMatches = matchesMailContext(this.account);
      } catch (cause) {
        throw new Error(workerErrorMessage(cause, signal));
      }
      if (!contextMatches)
        throw new Error(
          "\u0421\u0442\u0440\u0430\u043D\u0438\u0446\u0430 \u043F\u043E\u0447\u0442\u044B \u0438\u0437\u043C\u0435\u043D\u0438\u043B\u0430\u0441\u044C. \u041E\u0442\u043A\u0440\u043E\u0439\u0442\u0435 \u043F\u0430\u043D\u0435\u043B\u044C \u0432 \u043D\u0443\u0436\u043D\u043E\u0439 \u043F\u043E\u0447\u0442\u0435 \u0437\u0430\u043D\u043E\u0432\u043E."
        );
      const operation = { controller: new AbortController(), token: {} };
      this.active = operation;
      const abort = () => operation.controller.abort();
      signal.addEventListener("abort", abort, { once: true });
      const view = document.defaultView;
      view?.addEventListener("pagehide", abort, { once: true });
      const localSignal = operation.controller.signal;
      const isLive = () => this.active?.token === operation.token && !localSignal.aborted;
      const guard2 = () => {
        localSignal.throwIfAborted();
        if (!isLive()) throw new EditorError("cancelled");
        if (!matchesMailContext(this.account))
          throw new EditorError("context_unavailable");
      };
      const id = crypto.randomUUID();
      const receiptKey = RECEIPT_PREFIX + id;
      const expires = Date.now() + TTL;
      let committed = false;
      try {
        const prepared = await fillLetter(
          this.account,
          letter,
          localSignal,
          isLive
        );
        guard2();
        if (this.deliveryMode === "draft") return;
        const onWaiting = () => {
          guard2();
          try {
            progress?.("waiting");
          } catch {
          }
          guard2();
        };
        await sendLetter(
          prepared,
          localSignal,
          () => {
            guard2();
            if (store.get(receiptKey)) throw new Error("Send already claimed");
            committed = true;
            store.set(receiptKey, {
              id,
              expires,
              state: "sending"
            });
            const receipt = store.get(receiptKey);
            if (receipt?.id !== id || receipt.state !== "sending")
              throw new Error("Send receipt unavailable");
            try {
              progress?.("sending");
            } catch {
            }
            guard2();
          },
          onWaiting
        );
        guard2();
        store.set(receiptKey, {
          id,
          expires,
          state: "sent"
        });
        return "sent";
      } catch (cause) {
        if (committed || cause instanceof SendUncertainError || cause instanceof UncertainError) {
          try {
            store.set(receiptKey, {
              id,
              expires,
              state: "uncertain"
            });
          } catch {
          }
          throw new UncertainError();
        }
        const message = cause instanceof SendError ? new SendError(cause.code).message : workerErrorMessage(cause, localSignal);
        if (cause instanceof EditorError && ["existing_editor", "compose_button_missing"].includes(cause.code))
          throw new Error(message);
        throw new AttemptedError(message);
      } finally {
        signal.removeEventListener("abort", abort);
        view?.removeEventListener("pagehide", abort);
        if (this.active?.token === operation.token) this.active = void 0;
      }
    }
  };
  async function runWorker() {
    const url = new URL(location.href);
    const id = url.searchParams.get("pd_task");
    if (!id) return false;
    url.searchParams.delete("pd_task");
    history.replaceState(history.state, "", url.href);
    if (/^[\da-f-]{36}$/.test(id)) {
      try {
        store.delete(PREFIX + id);
      } catch {
      }
    }
    return true;
  }

  // src/generated/data.json
  var data_default = {
    companies: [
      {
        id: "5a282799e3e5",
        name: "\u041C\u0422\u0421",
        emails: [
          "privacy@mts.ru"
        ],
        sourceStatus: "\u041E\u0442\u0432\u0435\u0442 \u043F\u043E\u043B\u0443\u0447\u0435\u043D, \u041F\u0414 \u0443\u0434\u0430\u043B\u0435\u043D\u044B",
        notes: "",
        special: null,
        withdrawalExtra: "",
        legalName: "\u041F\u0410\u041E \xAB\u041C\u0422\u0421\xBB",
        inn: "7740000076",
        ogrn: "1027700149124"
      },
      {
        id: "4a4f5f0c3bc8",
        name: "\u041E\u041A\u041A\u041E",
        emails: [
          "mail@okko.tv"
        ],
        sourceStatus: "\u041E\u0442\u0432\u0435\u0442 \u043F\u043E\u043B\u0443\u0447\u0435\u043D, \u041F\u0414 \u0443\u0434\u0430\u043B\u0435\u043D\u044B",
        notes: "",
        special: null,
        withdrawalExtra: "",
        legalName: "\u041E\u041E\u041E \xAB\u041E\u043A\u043A\u043E\xBB",
        inn: "7814665871",
        ogrn: "1167847381130"
      },
      {
        id: "e47da5c37812",
        name: "\u0417\u043E\u043B\u043E\u0442\u043E\u0435 \u042F\u0431\u043B\u043E\u043A\u043E",
        emails: [
          "order@goldapple.ru",
          "CTD@goldapple.ru"
        ],
        sourceStatus: "\u041E\u0442\u0432\u0435\u0442 \u043F\u043E\u043B\u0443\u0447\u0435\u043D, \u041F\u0414 \u0443\u0434\u0430\u043B\u0435\u043D\u044B",
        notes: "",
        special: null,
        withdrawalExtra: "",
        legalName: "\u041E\u041E\u041E \xAB\u0415\u043A\u0430\u0442\u0435\u0440\u0438\u043D\u0431\u0443\u0440\u0433 \u042F\u0431\u043B\u043E\u043A\u043E\xBB",
        inn: "6670381056",
        ogrn: "1126670019585"
      },
      {
        id: "1b2d16c4e3db",
        name: "\u0421\u0431\u0435\u0440 \u041C\u043E\u0431\u0430\u0439\u043B",
        emails: [
          "privacy@sberbank-tele.com"
        ],
        sourceStatus: "\u041E\u0442\u0432\u0435\u0442 \u043F\u043E\u043B\u0443\u0447\u0435\u043D, \u041F\u0414 \u0443\u0434\u0430\u043B\u0435\u043D\u044B",
        notes: '\u0412 \u044D\u043B\u0435\u043A\u0442\u0440\u043E\u043D\u043D\u043E\u043C \u043F\u0438\u0441\u044C\u043C\u0435 \u043F\u0440\u043E\u043F\u0438\u0441\u0430\u0442\u044C: "\u0412 \u043F\u0443\u043D\u043A\u0442\u0435 11 \u0417\u0430\u043A\u043B\u044E\u0447\u0438\u0442\u0435\u043B\u044C\u043D\u044B\u0435 \u043F\u043E\u043B\u043E\u0436\u0435\u043D\u0438\u044F \u041F\u041E\u041B\u0418\u0422\u0418\u041A\u0418 \u0432 \u043E\u0442\u043D\u043E\u0448\u0435\u043D\u0438\u0438 \u043E\u0431\u0440\u0430\u0431\u043E\u0442\u043A\u0438 \u043F\u0435\u0440\u0441\u043E\u043D\u0430\u043B\u044C\u043D\u044B\u0445 \u0434\u0430\u043D\u043D\u044B\u0445 \u0432 \u041E\u041E\u041E \xAB\u0421\u0431\u0435\u0440\u0431\u0430\u043D\u043A-\u0422\u0435\u043B\u0435\u043A\u043E\u043C\xBB \u0432 \u043A\u043E\u043D\u0442\u0430\u043A\u0442\u043D\u043E\u0439 \u0438\u043D\u0444\u043E\u0440\u043C\u0430\u0446\u0438\u0438 \u0443\u043A\u0430\u0437\u0430\u043D\u044B \u0434\u0432\u0430 \u0432\u0438\u0434\u0430 \u0441\u0432\u044F\u0437\u0438, \u0430 \u0438\u043C\u0435\u043D\u043D\u043E: \u044D\u043B\u0435\u043A\u0442\u0440\u043E\u043D\u043D\u0430\u044F \u043F\u043E\u0447\u0442\u0430 \u0438 \u043F\u043E\u0447\u0442\u043E\u0432\u044B\u0439 \u0430\u0434\u0440\u0435\u0441.\n\n\xAB\u041B\u044E\u0431\u044B\u0435 \u043E\u0431\u0440\u0430\u0449\u0435\u043D\u0438\u044F, \u043A\u0430\u0441\u0430\u044E\u0449\u0438\u0435\u0441\u044F \u043E\u0431\u0440\u0430\u0431\u043E\u0442\u043A\u0438 \u041F\u0414\u043D, \u043D\u0430\u043F\u0440\u0430\u0432\u043B\u044F\u044E\u0442\u0441\u044F \u041E\u0431\u0449\u0435\u0441\u0442\u0432\u0443 \u043D\u0430 \u044D\u043B\u0435\u043A\u0442\u0440\u043E\u043D\u043D\u0443\u044E \u043F\u043E\u0447\u0442\u0443: privacy@sberbank-tele.com, \u043B\u0438\u0431\u043E \u043D\u0430 \u043F\u043E\u0447\u0442\u043E\u0432\u044B\u0439 \u0430\u0434\u0440\u0435\u0441: 117997, \u0433. \u041C\u043E\u0441\u043A\u0432\u0430, \u0443\u043B. \u0412\u0430\u0432\u0438\u043B\u043E\u0432\u0430, \u0434. 19\xBB.\n\n\u041F\u0440\u043E\u0448\u0443 \u0440\u0430\u0441\u0441\u043C\u043E\u0442\u0440\u0435\u0442\u044C \u043C\u043E\u0451 \u043E\u0431\u0440\u0430\u0449\u0435\u043D\u0438\u0435 \u0432 \u044D\u043B\u0435\u043A\u0442\u0440\u043E\u043D\u043D\u043E\u043C \u0432\u0438\u0434\u0435".   \u041A \u043F\u0438\u0441\u044C\u043C\u0443 \u043F\u0440\u0438\u043B\u043E\u0436\u0438\u0442\u044C PDF \u0444\u0430\u0439\u043B \u0441 \u043E\u0442\u0437\u044B\u0432\u043E\u043C \u0441\u043E\u0433\u043B\u0430\u0441\u0438\u044F.',
        special: "pdf",
        withdrawalExtra: "\u0412 \u043F\u0443\u043D\u043A\u0442\u0435 11 \u0417\u0430\u043A\u043B\u044E\u0447\u0438\u0442\u0435\u043B\u044C\u043D\u044B\u0435 \u043F\u043E\u043B\u043E\u0436\u0435\u043D\u0438\u044F \u041F\u041E\u041B\u0418\u0422\u0418\u041A\u0418 \u0432 \u043E\u0442\u043D\u043E\u0448\u0435\u043D\u0438\u0438 \u043E\u0431\u0440\u0430\u0431\u043E\u0442\u043A\u0438 \u043F\u0435\u0440\u0441\u043E\u043D\u0430\u043B\u044C\u043D\u044B\u0445 \u0434\u0430\u043D\u043D\u044B\u0445 \u0432 \u041E\u041E\u041E \xAB\u0421\u0431\u0435\u0440\u0431\u0430\u043D\u043A-\u0422\u0435\u043B\u0435\u043A\u043E\u043C\xBB \u0432 \u043A\u043E\u043D\u0442\u0430\u043A\u0442\u043D\u043E\u0439 \u0438\u043D\u0444\u043E\u0440\u043C\u0430\u0446\u0438\u0438 \u0443\u043A\u0430\u0437\u0430\u043D\u044B \u0434\u0432\u0430 \u0432\u0438\u0434\u0430 \u0441\u0432\u044F\u0437\u0438, \u0430 \u0438\u043C\u0435\u043D\u043D\u043E: \u044D\u043B\u0435\u043A\u0442\u0440\u043E\u043D\u043D\u0430\u044F \u043F\u043E\u0447\u0442\u0430 \u0438 \u043F\u043E\u0447\u0442\u043E\u0432\u044B\u0439 \u0430\u0434\u0440\u0435\u0441.\n\n\xAB\u041B\u044E\u0431\u044B\u0435 \u043E\u0431\u0440\u0430\u0449\u0435\u043D\u0438\u044F, \u043A\u0430\u0441\u0430\u044E\u0449\u0438\u0435\u0441\u044F \u043E\u0431\u0440\u0430\u0431\u043E\u0442\u043A\u0438 \u041F\u0414\u043D, \u043D\u0430\u043F\u0440\u0430\u0432\u043B\u044F\u044E\u0442\u0441\u044F \u041E\u0431\u0449\u0435\u0441\u0442\u0432\u0443 \u043D\u0430 \u044D\u043B\u0435\u043A\u0442\u0440\u043E\u043D\u043D\u0443\u044E \u043F\u043E\u0447\u0442\u0443: privacy@sberbank-tele.com, \u043B\u0438\u0431\u043E \u043D\u0430 \u043F\u043E\u0447\u0442\u043E\u0432\u044B\u0439 \u0430\u0434\u0440\u0435\u0441: 117997, \u0433. \u041C\u043E\u0441\u043A\u0432\u0430, \u0443\u043B. \u0412\u0430\u0432\u0438\u043B\u043E\u0432\u0430, \u0434. 19\xBB.\n\n\u041F\u0440\u043E\u0448\u0443 \u0440\u0430\u0441\u0441\u043C\u043E\u0442\u0440\u0435\u0442\u044C \u043C\u043E\u0451 \u043E\u0431\u0440\u0430\u0449\u0435\u043D\u0438\u0435 \u0432 \u044D\u043B\u0435\u043A\u0442\u0440\u043E\u043D\u043D\u043E\u043C \u0432\u0438\u0434\u0435",
        legalName: "\u041E\u041E\u041E \xAB\u0421\u0431\u0435\u0440\u0431\u0430\u043D\u043A-\u0422\u0435\u043B\u0435\u043A\u043E\u043C\xBB",
        inn: "7736264044",
        ogrn: "1167746305430"
      },
      {
        id: "9b818ab53240",
        name: "\u0411\u0438\u0417\u043E\u043D",
        emails: [
          "info@bi.zone"
        ],
        sourceStatus: "\u041D\u0435\u0442 \u043E\u0442\u0432\u0435\u0442\u0430, \u0437\u0430\u043F\u0440\u043E\u0441 \u043E\u0442\u043F\u0440\u0430\u0432\u043B\u0435\u043D",
        notes: "",
        special: null,
        withdrawalExtra: "",
        legalName: "\u041E\u041E\u041E \xAB\u0411\u0418\u0417\u041E\u041D\xBB",
        inn: "9701036178",
        ogrn: "1167746317210"
      },
      {
        id: "acda9a9c5fb4",
        name: "\u0411\u0438\u043B\u0430\u0439\u043D",
        emails: [
          "otvet@beeline.ru"
        ],
        sourceStatus: "\u041D\u0435\u0442 \u043E\u0442\u0432\u0435\u0442\u0430, \u0437\u0430\u043F\u0440\u043E\u0441 \u043E\u0442\u043F\u0440\u0430\u0432\u043B\u0435\u043D",
        notes: "",
        special: null,
        withdrawalExtra: "",
        legalName: "\u041F\u0410\u041E \xAB\u0412\u044B\u043C\u043F\u0435\u043B\u041A\u043E\u043C\xBB",
        inn: "7713076301",
        ogrn: "1027700166636"
      },
      {
        id: "37df0db92f3a",
        name: "\u0421\u0414\u042D\u041A",
        emails: [
          "cdek_rabota@cdek.ru"
        ],
        sourceStatus: "\u041E\u0442\u0432\u0435\u0442 \u043F\u043E\u043B\u0443\u0447\u0435\u043D, \u041F\u0414 \u0443\u0434\u0430\u043B\u0435\u043D\u044B",
        notes: "",
        special: null,
        withdrawalExtra: "",
        legalName: "\u041E\u041E\u041E \xAB\u0421\u0414\u042D\u041A-\u0413\u043B\u043E\u0431\u0430\u043B\xBB",
        inn: "7722327689",
        ogrn: "1157746448463"
      },
      {
        id: "85099762b60b",
        name: "\u0422\u0435\u043D\u0437\u043E\u0440",
        emails: [
          "tensor@tensor.ru"
        ],
        sourceStatus: "\u041E\u0442\u0432\u0435\u0442 \u043F\u043E\u043B\u0443\u0447\u0435\u043D, \u041F\u0414 \u0443\u0434\u0430\u043B\u0435\u043D\u044B",
        notes: "",
        special: null,
        withdrawalExtra: "",
        legalName: "\u041E\u041E\u041E \xAB\u041A\u043E\u043C\u043F\u0430\u043D\u0438\u044F \xAB\u0422\u0435\u043D\u0437\u043E\u0440\xBB",
        inn: "7605016030",
        ogrn: "1027600787994"
      },
      {
        id: "2dd67355ac40",
        name: "\u0422\u0430\u043A\u0441\u043A\u043E\u043C",
        emails: [
          "taxcom@taxcom.ru"
        ],
        sourceStatus: "\u041D\u0435\u0442 \u043E\u0442\u0432\u0435\u0442\u0430, \u0437\u0430\u043F\u0440\u043E\u0441 \u043E\u0442\u043F\u0440\u0430\u0432\u043B\u0435\u043D",
        notes: "",
        special: null,
        withdrawalExtra: "",
        legalName: "\u041E\u041E\u041E \xAB\u0422\u0430\u043A\u0441\u043A\u043E\u043C\xBB",
        inn: "7704211201",
        ogrn: "1027700071530"
      },
      {
        id: "204ddb8a15ea",
        name: "\u0422\u043E\u0447\u043A\u0430 \u0411\u0430\u043D\u043A",
        emails: [
          "tochka@tochka.com"
        ],
        sourceStatus: "\u041E\u0442\u0432\u0435\u0442 \u043F\u043E\u043B\u0443\u0447\u0435\u043D, \u041F\u0414 \u0443\u0434\u0430\u043B\u0435\u043D\u044B",
        notes: "",
        special: null,
        withdrawalExtra: "",
        legalName: "\u041E\u041E\u041E \xAB\u0411\u0410\u041D\u041A \u0422\u041E\u0427\u041A\u0410\xBB",
        inn: "9705120864",
        ogrn: "1187746637143"
      },
      {
        id: "d6e05ed3eb65",
        name: "\u041C\u0430\u0433\u043D\u0438\u0442",
        emails: [
          "info@magnit.ru"
        ],
        sourceStatus: "\u041D\u0435\u0442 \u043E\u0442\u0432\u0435\u0442\u0430, \u0437\u0430\u043F\u0440\u043E\u0441 \u043E\u0442\u043F\u0440\u0430\u0432\u043B\u0435\u043D",
        notes: "",
        special: null,
        withdrawalExtra: "",
        legalName: "\u041F\u0410\u041E \xAB\u041C\u0430\u0433\u043D\u0438\u0442\xBB",
        inn: "2309085638",
        ogrn: "1032304945947"
      },
      {
        id: "784090cbcdf0",
        name: "\u041A\u0443\u043F\u0435\u0440",
        emails: [
          "kuper@kuper.ru",
          "hello@kuper.ru"
        ],
        sourceStatus: "\u041E\u0442\u0432\u0435\u0442 \u043F\u043E\u043B\u0443\u0447\u0435\u043D, \u041F\u0414 \u0443\u0434\u0430\u043B\u0435\u043D\u044B",
        notes: "",
        special: null,
        withdrawalExtra: "",
        legalName: "\u041E\u041E\u041E \xAB\u0418\u043D\u0441\u0442\u0430\u043C\u0430\u0440\u0442 \u0421\u0435\u0440\u0432\u0438\u0441\xBB",
        inn: "9705118142",
        ogrn: "1187746494980"
      },
      {
        id: "bf0d255c8484",
        name: "\u041B\u0443\u0447\u0438",
        emails: [
          "privacy@luchi.ru"
        ],
        sourceStatus: "\u041E\u0442\u0432\u0435\u0442 \u043F\u043E\u043B\u0443\u0447\u0435\u043D, \u041F\u0414 \u0443\u0434\u0430\u043B\u0435\u043D\u044B",
        notes: "",
        special: null,
        withdrawalExtra: "",
        legalName: "\u041E\u041E\u041E \xAB\u041B\u0443\u0447\u0438 \u0417\u0434\u043E\u0440\u043E\u0432\u044C\u0435\xBB",
        inn: "7106021081",
        ogrn: "1157154006767"
      },
      {
        id: "183e7e526673",
        name: "\u0421\u0417 \u041F\u0418\u041A",
        emails: [
          "info@pik.ru"
        ],
        sourceStatus: "\u041E\u0442\u0432\u0435\u0442 \u043F\u043E\u043B\u0443\u0447\u0435\u043D, \u041F\u0414 \u0443\u0434\u0430\u043B\u0435\u043D\u044B",
        notes: "",
        special: null,
        withdrawalExtra: "",
        legalName: "\u041F\u0410\u041E \xAB\u041F\u0418\u041A \u0421\u0417\xBB",
        inn: "7713011336",
        ogrn: "1027739137084"
      },
      {
        id: "44327d5e3d30",
        name: "\u0414\u0418\u0414\u0416\u0418 \u0422\u0415\u0425",
        emails: [
          "sales@digitech.ru"
        ],
        sourceStatus: "\u041D\u0435\u0442 \u043E\u0442\u0432\u0435\u0442\u0430, \u0437\u0430\u043F\u0440\u043E\u0441 \u043E\u0442\u043F\u0440\u0430\u0432\u043B\u0435\u043D",
        notes: "",
        special: null,
        withdrawalExtra: "",
        legalName: "\u041E\u041E\u041E \xAB\u0414\u0418\u0414\u0416\u0418 \u0422\u0415\u0425\xBB",
        inn: "6679126050",
        ogrn: "1196658045055"
      },
      {
        id: "8035f16c937b",
        name: "\u0421\u0430\u043C\u043E\u043A\u0430\u0442",
        emails: [
          "dpo@samokat.ru"
        ],
        sourceStatus: "\u041E\u0442\u0432\u0435\u0442 \u043F\u043E\u043B\u0443\u0447\u0435\u043D, \u041F\u0414 \u0443\u0434\u0430\u043B\u0435\u043D\u044B",
        notes: "",
        special: null,
        withdrawalExtra: "",
        legalName: "\u041E\u041E\u041E \xAB\u0423\u043C\u043D\u044B\u0439 \u0440\u0438\u0442\u0435\u0439\u043B\xBB",
        inn: "7811554010",
        ogrn: "1137847232852"
      },
      {
        id: "67a9b1e7bda3",
        name: "\u0413\u041A \u0410\u0441\u0442\u0440\u0430",
        emails: [
          "legal@astralinux.ru"
        ],
        sourceStatus: "\u041E\u0442\u0432\u0435\u0442 \u043F\u043E\u043B\u0443\u0447\u0435\u043D, \u041F\u0414 \u0443\u0434\u0430\u043B\u0435\u043D\u044B",
        notes: "",
        special: null,
        withdrawalExtra: "",
        legalName: "\u041E\u041E\u041E \xAB\u0420\u0443\u0441\u0411\u0418\u0422\u0435\u0445-\u0410\u0441\u0442\u0440\u0430\xBB",
        inn: "7726388700",
        ogrn: "5167746207459"
      },
      {
        id: "dbd27579debe",
        name: "\u0421\u0417 \u0421\u0430\u043C\u043E\u043B\u0435\u0442",
        emails: [
          "request_pdn@samolet.ru"
        ],
        sourceStatus: "\u041E\u0442\u0432\u0435\u0442 \u043F\u043E\u043B\u0443\u0447\u0435\u043D, \u041F\u0414 \u0443\u0434\u0430\u043B\u0435\u043D\u044B",
        notes: "",
        special: null,
        withdrawalExtra: "",
        legalName: "\u041F\u0410\u041E \xAB\u0413\u041A \xAB\u0421\u0430\u043C\u043E\u043B\u0435\u0442\xBB",
        inn: "9731004688",
        ogrn: "1187746590283"
      },
      {
        id: "256425cd2755",
        name: "\u0411\u0430\u043D\u043A \u0414\u043E\u043C.\u0420\u0424",
        emails: [
          "info.bank@domrf.ru"
        ],
        sourceStatus: "\u041E\u0442\u0432\u0435\u0442 \u043F\u043E\u043B\u0443\u0447\u0435\u043D, \u041F\u0414 \u0443\u0434\u0430\u043B\u0435\u043D\u044B",
        notes: "",
        special: null,
        withdrawalExtra: "",
        legalName: "\u0410\u041E \xAB\u0411\u0430\u043D\u043A \u0414\u041E\u041C.\u0420\u0424\xBB",
        inn: "7725038124",
        ogrn: "1037739527077"
      },
      {
        id: "ecfab97afc0e",
        name: "\u0420\u0435\u043D\u0435\u0441\u0441\u0430\u043D\u0441 \u0411\u0430\u043D\u043A",
        emails: [
          "consultant@rencredit.ru"
        ],
        sourceStatus: "\u041E\u0442\u0432\u0435\u0442 \u043F\u043E\u043B\u0443\u0447\u0435\u043D, \u041F\u0414 \u0443\u0434\u0430\u043B\u0435\u043D\u044B",
        notes: "",
        special: null,
        withdrawalExtra: "",
        legalName: "\u041A\u0411 \xAB\u0420\u0435\u043D\u0435\u0441\u0441\u0430\u043D\u0441 \u041A\u0440\u0435\u0434\u0438\u0442\xBB (\u041E\u041E\u041E)",
        inn: "7744000126",
        ogrn: "1027739586291"
      },
      {
        id: "075c8ff89799",
        name: "\u041B\u0430\u043C\u043E\u0434\u0430",
        emails: [
          "help@lamoda.ru"
        ],
        sourceStatus: "\u041E\u0442\u0432\u0435\u0442 \u043F\u043E\u043B\u0443\u0447\u0435\u043D, \u041F\u0414 \u0443\u0434\u0430\u043B\u0435\u043D\u044B",
        notes: "",
        special: null,
        withdrawalExtra: "",
        legalName: "\u041E\u041E\u041E \xAB\u041A\u0443\u043F\u0438\u0448\u0443\u0437\xBB",
        inn: "7705935687",
        ogrn: "5107746007628"
      },
      {
        id: "d13adb34b27c",
        name: "\u0421\u041A\u0411 \u041A\u043E\u043D\u0442\u0443\u0440",
        emails: [
          "info@skbkontur.ru"
        ],
        sourceStatus: "\u041E\u0442\u0432\u0435\u0442 \u043F\u043E\u043B\u0443\u0447\u0435\u043D, \u041F\u0414 \u0443\u0434\u0430\u043B\u0435\u043D\u044B",
        notes: "\u041F\u0440\u043E\u0441\u044F\u0442 \u0440\u0443\u0447\u043D\u0443\u044E \u043F\u043E\u0434\u043F\u0438\u0441\u044C. \u041D\u0435\u043E\u0431\u0445\u043E\u0434\u0438\u043C\u043E \u0440\u0430\u0441\u043F\u0435\u0447\u0430\u0442\u0430\u0442\u044C \u0433\u043E\u0442\u043E\u0432\u044B\u0439 \u0431\u043B\u0430\u043D\u043A \u0438 \u0437\u0430\u043F\u043E\u043B\u043D\u0438\u0442\u044C \u043E\u0442 \u0440\u0443\u043A\u0438.",
        special: "signature",
        withdrawalExtra: "",
        legalName: "\u0410\u041E \xAB\u041F\u0424 \u0421\u041A\u0411 \u041A\u043E\u043D\u0442\u0443\u0440\xBB",
        inn: "6663003127",
        ogrn: "1026605606620"
      },
      {
        id: "e363466a89ca",
        name: "\u0421\u043E\u043A\u043E\u043B\u043E\u0432",
        emails: [
          "pdn@svretail.ru"
        ],
        sourceStatus: "\u041E\u0442\u0432\u0435\u0442 \u043F\u043E\u043B\u0443\u0447\u0435\u043D, \u041F\u0414 \u0443\u0434\u0430\u043B\u0435\u043D\u044B",
        notes: "",
        special: null,
        withdrawalExtra: "",
        legalName: "\u041E\u041E\u041E \xAB\u0421\u0412 \u0420\u0438\u0442\u0435\u0439\u043B\xBB",
        inn: "7716918034",
        ogrn: "1187746709677"
      },
      {
        id: "6cfdaac7b52a",
        name: "\u041B\u0430\u043D\u0438\u0442",
        emails: [
          "lanit@lanit.ru"
        ],
        sourceStatus: "\u041E\u0442\u0432\u0435\u0442 \u043F\u043E\u043B\u0443\u0447\u0435\u043D, \u041F\u0414 \u0443\u0434\u0430\u043B\u0435\u043D\u044B",
        notes: "",
        special: null,
        withdrawalExtra: "",
        legalName: "\u0410\u041E \xAB\u041B\u0410\u041D\u0418\u0422\xBB",
        inn: "7727004113",
        ogrn: "1027739031572"
      },
      {
        id: "97aaf5fdf152",
        name: "\u0420\u043E\u0441\u0442\u0435\u043B\u0435\u043A\u043E\u043C",
        emails: [
          "rostelecom@rt.ru"
        ],
        sourceStatus: "\u041E\u0442\u0432\u0435\u0442 \u043F\u043E\u043B\u0443\u0447\u0435\u043D, \u041F\u0414 \u0443\u0434\u0430\u043B\u0435\u043D\u044B",
        notes: "",
        special: null,
        withdrawalExtra: "",
        legalName: "\u041F\u0410\u041E \xAB\u0420\u043E\u0441\u0442\u0435\u043B\u0435\u043A\u043E\u043C\xBB",
        inn: "7707049388",
        ogrn: "1027700198767"
      },
      {
        id: "51d96642af56",
        name: "\u0421\u0431\u0435\u0440\u0422\u0440\u043E\u0439\u043A\u0430",
        emails: [
          "info@sbertroika.ru"
        ],
        sourceStatus: "\u041E\u0442\u0432\u0435\u0442 \u043F\u043E\u043B\u0443\u0447\u0435\u043D, \u041F\u0414 \u0443\u0434\u0430\u043B\u0435\u043D\u044B",
        notes: "",
        special: null,
        withdrawalExtra: "",
        legalName: "\u041E\u041E\u041E \xAB\u0421\u0431\u0435\u0440\u0422\u0440\u043E\u0439\u043A\u0430\xBB",
        inn: "9702027017",
        ogrn: "1207700477820"
      },
      {
        id: "1c737c6ba00d",
        name: "\u0421\u0431\u0435\u0440",
        emails: [
          "Vopros_HR@sberbank.ru"
        ],
        sourceStatus: "\u041E\u0442\u0432\u0435\u0442 \u043F\u043E\u043B\u0443\u0447\u0435\u043D, \u041F\u0414 \u0443\u0434\u0430\u043B\u0435\u043D\u044B",
        notes: "",
        special: null,
        withdrawalExtra: "",
        legalName: "\u041F\u0410\u041E \xAB\u0421\u0431\u0435\u0440\u0431\u0430\u043D\u043A \u0420\u043E\u0441\u0441\u0438\u0438\xBB",
        inn: "7707083893",
        ogrn: "1027700132195"
      },
      {
        id: "a8fb5d5d06c9",
        name: "\u0410\u041E \xAB\u0411\u0410\u0420\u0421 \u0413\u0440\u0443\u043F\xBB",
        sourceStatus: "",
        notes: "",
        special: null,
        withdrawalExtra: "",
        legalName: "\u0410\u041E \xAB\u0411\u0410\u0420\u0421 \u0413\u0440\u0443\u043F\xBB",
        inn: "1655251590",
        ogrn: "1121690063923",
        emails: [
          "bars@bars.group"
        ]
      },
      {
        id: "fac3c205270d",
        name: "\u0410\u041E \xAB\u0410\u0439\u0441\u043E\u0440\u0441\xBB",
        sourceStatus: "",
        notes: "",
        special: null,
        withdrawalExtra: "",
        legalName: "\u0410\u041E \xAB\u0410\u0439\u0441\u043E\u0440\u0441\xBB",
        inn: "9706009675",
        ogrn: "1207700393977",
        emails: [
          "support@isource.ru"
        ]
      },
      {
        id: "0fb2ea150de4",
        name: "\u041F\u0410\u041E \xAB\u0421\u043E\u0444\u0442\u043B\u0430\u0439\u043D\xBB",
        sourceStatus: "",
        notes: "",
        special: null,
        withdrawalExtra: "",
        legalName: "\u041F\u0410\u041E \xAB\u0421\u043E\u0444\u0442\u043B\u0430\u0439\u043D\xBB",
        inn: "7736227885",
        ogrn: "1027736009333",
        emails: [
          "info@softline.ru"
        ]
      },
      {
        id: "93d11b902057",
        name: "\xAB\u041D\u043E\u0432\u044B\u0439 \u0410\u0439 \u0422\u0438 \u041F\u0440\u043E\u0435\u043A\u0442\xBB",
        sourceStatus: "",
        notes: "",
        special: null,
        withdrawalExtra: "",
        legalName: "\xAB\u041D\u043E\u0432\u044B\u0439 \u0410\u0439 \u0422\u0438 \u041F\u0440\u043E\u0435\u043A\u0442\xBB",
        inn: "7724338125",
        ogrn: "1157746958830",
        emails: [
          "3L@3L.ru",
          "rma@3L.ru"
        ]
      },
      {
        id: "102dfee06312",
        name: "\u041E\u041E\u041E \xAB\u041E\u0431\u043B\u0430\u0447\u043D\u044B\u0435 \u0442\u0435\u0445\u043D\u043E\u043B\u043E\u0433\u0438\u0438\xBB",
        sourceStatus: "",
        notes: "",
        special: null,
        withdrawalExtra: "",
        legalName: "\u041E\u041E\u041E \xAB\u041E\u0431\u043B\u0430\u0447\u043D\u044B\u0435 \u0442\u0435\u0445\u043D\u043E\u043B\u043E\u0433\u0438\u0438\xBB",
        inn: "7736279160",
        ogrn: "5167746080057",
        emails: [
          "security@cloud.ru"
        ]
      },
      {
        id: "d659759d7c9b",
        name: "\u0410\u041E \xAB\u041B\u0430\u0431\u043E\u0440\u0430\u0442\u043E\u0440\u0438\u044F \u041A\u0430\u0441\u043F\u0435\u0440\u0441\u043A\u043E\u0433\u043E\xBB",
        sourceStatus: "",
        notes: "",
        special: null,
        withdrawalExtra: "",
        legalName: "\u0410\u041E \xAB\u041B\u0430\u0431\u043E\u0440\u0430\u0442\u043E\u0440\u0438\u044F \u041A\u0430\u0441\u043F\u0435\u0440\u0441\u043A\u043E\u0433\u043E\xBB",
        inn: "7713140469",
        ogrn: "1027739867473",
        emails: [
          "info@kaspersky.com"
        ]
      },
      {
        id: "7c9eb642f593",
        name: "\u041E\u041E\u041E \xAB\u0420\u0443\u0431\u0438\u0442\u0435\u0445\xBB",
        sourceStatus: "",
        notes: "",
        special: null,
        withdrawalExtra: "",
        legalName: "\u041E\u041E\u041E \xAB\u0420\u0443\u0431\u0438\u0442\u0435\u0445\xBB",
        inn: "7702404085",
        ogrn: "1167746693784",
        emails: [
          "info@rubytech.ru"
        ]
      },
      {
        id: "f85211ee5736",
        name: "\u0410\u041E \xAB\u0422\u0411\u0430\u043D\u043A\xBB",
        sourceStatus: "",
        notes: "",
        special: null,
        withdrawalExtra: "",
        legalName: "\u0410\u041E \xAB\u0422\u0411\u0430\u043D\u043A\xBB",
        inn: "7710140679",
        ogrn: "1027739642281",
        emails: [
          "deposit@tbank.ru"
        ]
      },
      {
        id: "5dda21bcc380",
        name: "\u0410\u041E \xAB\u0410\u0439-\u0422\u0435\u043A\u043E\xBB",
        sourceStatus: "",
        notes: "",
        special: null,
        withdrawalExtra: "",
        legalName: "\u0410\u041E \xAB\u0410\u0439-\u0422\u0435\u043A\u043E\xBB",
        inn: "7704160892",
        ogrn: "1027700031061",
        emails: [
          "income@i-teco.ru"
        ]
      },
      {
        id: "302886347af0",
        name: "\xAB\u0418\u0422 \u0418\u041A\u0421 5 \u0422\u0435\u0445\u043D\u043E\u043B\u043E\u0433\u0438\u0438\xBB",
        sourceStatus: "",
        notes: "",
        special: null,
        withdrawalExtra: "",
        legalName: "\xAB\u0418\u0422 \u0418\u041A\u0421 5 \u0422\u0435\u0445\u043D\u043E\u043B\u043E\u0433\u0438\u0438\xBB",
        inn: "1615014289",
        ogrn: "1181690101911",
        emails: [
          "pdn@x5.ru"
        ]
      },
      {
        id: "a9e445367d12",
        name: "\u041E\u041E\u041E \xAB\u041B\u0423\u041A\u041E\u0419\u041B-\u0422\u0435\u0445\u043D\u043E\u043B\u043E\u0433\u0438\u0438\xBB",
        sourceStatus: "",
        notes: "",
        special: null,
        withdrawalExtra: "",
        legalName: "\u041E\u041E\u041E \xAB\u041B\u0423\u041A\u041E\u0419\u041B-\u0422\u0435\u0445\u043D\u043E\u043B\u043E\u0433\u0438\u0438\xBB",
        inn: "9709038314",
        ogrn: "1187746909129",
        emails: [
          "luktech@lukoil.com"
        ]
      },
      {
        id: "b9edc839a2ae",
        name: "\u041F\u0410\u041E \xAB\u0411\u0410\u041D\u041A \u0423\u0420\u0410\u041B\u0421\u0418\u0411\xBB",
        sourceStatus: "",
        notes: "",
        special: null,
        withdrawalExtra: "",
        legalName: "\u041F\u0410\u041E \xAB\u0411\u0410\u041D\u041A \u0423\u0420\u0410\u041B\u0421\u0418\u0411\xBB",
        inn: "0274062111",
        ogrn: "1020280000190",
        emails: [
          "infsec@uralsib.ru"
        ]
      },
      {
        id: "cd7faa2d1d77",
        name: "\u041F\u0410\u041E \xAB\u041C\u0422\u0421-\u0411\u0430\u043D\u043A\xBB",
        sourceStatus: "",
        notes: "",
        special: null,
        withdrawalExtra: "",
        legalName: "\u041F\u0410\u041E \xAB\u041C\u0422\u0421-\u0411\u0430\u043D\u043A\xBB",
        inn: "7702045051",
        ogrn: "1027739053704",
        emails: [
          "info@mtsbank.ru"
        ]
      },
      {
        id: "64f89a333338",
        name: "\u041E\u041E\u041E \xAB\u0410\u0432\u0438\u0442\u043E \u0422\u0435\u0445\xBB",
        sourceStatus: "",
        notes: "",
        special: null,
        withdrawalExtra: "",
        legalName: "\u041E\u041E\u041E \xAB\u0410\u0432\u0438\u0442\u043E \u0422\u0435\u0445\xBB",
        inn: "9710089440",
        ogrn: "1217700216403",
        emails: [
          "tech@avito.ru"
        ]
      },
      {
        id: "87387cbbf569",
        name: "\u0410\u041E \xAB\u0420\u043E\u0441\u0441\u0435\u043B\u044C\u0445\u043E\u0437\u0431\u0430\u043D\u043A\xBB",
        sourceStatus: "",
        notes: "",
        special: null,
        withdrawalExtra: "",
        legalName: "\u0410\u041E \xAB\u0420\u043E\u0441\u0441\u0435\u043B\u044C\u0445\u043E\u0437\u0431\u0430\u043D\u043A\xBB",
        inn: "7725114488",
        ogrn: "1027700342890",
        emails: [
          "office@rshb.ru"
        ]
      },
      {
        id: "a339794270f5",
        name: "\xAB\u0412\u041A \u0426\u0438\u0444\u0440\u043E\u0432\u044B\u0435 \u0422\u0435\u0445\u043D\u043E\u043B\u043E\u0433\u0438\u0438\xBB",
        sourceStatus: "",
        notes: "",
        special: null,
        withdrawalExtra: "",
        legalName: "\xAB\u0412\u041A \u0426\u0438\u0444\u0440\u043E\u0432\u044B\u0435 \u0422\u0435\u0445\u043D\u043E\u043B\u043E\u0433\u0438\u0438\xBB",
        inn: "7714415613",
        ogrn: "5177746017158",
        emails: [
          "digital.tech@corp.mail.ru"
        ]
      },
      {
        id: "6505b3009112",
        name: "\u041E\u041E\u041E \xAB\u041B\u041E\u0426\u0418\u042F\xBB",
        sourceStatus: "",
        notes: "",
        special: null,
        withdrawalExtra: "",
        legalName: "\u041E\u041E\u041E \xAB\u041B\u041E\u0426\u0418\u042F\xBB",
        inn: "9731028047",
        ogrn: "1197746102388",
        emails: [
          "cs@loodsen.ru"
        ]
      },
      {
        id: "4dd283e53237",
        name: "\u041E\u041E\u041E \xAB\u0410\u0440\u0435\u043D\u0430\u0434\u0430\u0442\u0430 \u0421\u043E\u0444\u0442\u0432\u0435\u0440\xBB",
        sourceStatus: "",
        notes: "",
        special: null,
        withdrawalExtra: "",
        legalName: "\u041E\u041E\u041E \xAB\u0410\u0440\u0435\u043D\u0430\u0434\u0430\u0442\u0430 \u0421\u043E\u0444\u0442\u0432\u0435\u0440\xBB",
        inn: "7713468845",
        ogrn: "1197746413160",
        emails: [
          "info@arenadata.io"
        ]
      },
      {
        id: "2c4b0ea41284",
        name: "\xAB\u0413\u041A \xAB\u0418\u043D\u043D\u043E\u0442\u0435\u0445\xBB",
        sourceStatus: "",
        notes: "",
        special: null,
        withdrawalExtra: "",
        legalName: "\xAB\u0413\u041A \xAB\u0418\u043D\u043D\u043E\u0442\u0435\u0445\xBB",
        inn: "9703073496",
        ogrn: "1227700086460",
        emails: [
          "dpo@inno.tech"
        ]
      },
      {
        id: "37fe40eb2a72",
        name: "\u0410\u041E \xAB\u041E\u0422\u041F \u0411\u0430\u043D\u043A\xBB",
        sourceStatus: "",
        notes: "",
        special: null,
        withdrawalExtra: "",
        legalName: "\u0410\u041E \xAB\u041E\u0422\u041F \u0411\u0430\u043D\u043A\xBB",
        inn: "7708001614",
        ogrn: "1027739176563",
        emails: [
          "spravka@otpbank.ru"
        ]
      },
      {
        id: "8a6ab74549a6",
        name: "\u041F\u0410\u041E \xAB\u0418\u043D\u0442\u0435\u0440 \u0420\u0410\u041E\xBB",
        sourceStatus: "",
        notes: "",
        special: null,
        withdrawalExtra: "",
        legalName: "\u041F\u0410\u041E \xAB\u0418\u043D\u0442\u0435\u0440 \u0420\u0410\u041E\xBB",
        inn: "2320109650",
        ogrn: "1022302933630",
        emails: [
          "office@interrao.ru"
        ]
      },
      {
        id: "209f19a16f49",
        name: "\u041E\u041E\u041E \xAB\u0410\u0441\u0442\u043E\u043D\xBB",
        sourceStatus: "",
        notes: "",
        special: null,
        withdrawalExtra: "",
        legalName: "\u041E\u041E\u041E \xAB\u0410\u0441\u0442\u043E\u043D\xBB",
        inn: "9715350151",
        ogrn: "1197746397045",
        emails: [
          "info@astondevs.ru"
        ]
      },
      {
        id: "cbb0dbe7c3ef",
        name: "\u041E\u041E\u041E \xAB\u0415\u0413\u0410\u0420 \u0422\u0435\u0445\u043D\u043E\u043B\u043E\u0433\u0438\u0438\xBB",
        sourceStatus: "",
        notes: "",
        special: null,
        withdrawalExtra: "",
        legalName: "\u041E\u041E\u041E \xAB\u0415\u0413\u0410\u0420 \u0422\u0435\u0445\u043D\u043E\u043B\u043E\u0433\u0438\u0438\xBB",
        inn: "9718022825",
        ogrn: "1167746777868",
        emails: [
          "info@egartech.ru"
        ]
      }
    ],
    templates: {
      withdrawal: {
        body: "\u042F, {{\u0424\u0418\u041E}}, \u0432 \u0441\u043E\u043E\u0442\u0432\u0435\u0442\u0441\u0442\u0432\u0438\u0438 \u0441 \u0447.2 \u0441\u0442.9 \u0424\u0435\u0434\u0435\u0440\u0430\u043B\u044C\u043D\u043E\u0433\u043E \u0437\u0430\u043A\u043E\u043D\u0430 \u043E\u0442 27.07.2006 \u0433. \u2116 152-\u0424\u0417 \xAB\u041E \u043F\u0435\u0440\u0441\u043E\u043D\u0430\u043B\u044C\u043D\u044B\u0445 \u0434\u0430\u043D\u043D\u044B\u0445\xBB, \u043D\u0430\u0441\u0442\u043E\u044F\u0449\u0438\u043C \u0434\u043E\u043A\u0443\u043C\u0435\u043D\u0442\u043E\u043C \u043E\u0442\u0437\u044B\u0432\u0430\u044E \u0441\u0432\u043E\u0435 \u0441\u043E\u0433\u043B\u0430\u0441\u0438\u0435 \u043D\u0430 \u043E\u0431\u0440\u0430\u0431\u043E\u0442\u043A\u0443 \u0432\u0441\u0435\u0445 \u043C\u043E\u0438\u0445 \u043F\u0435\u0440\u0441\u043E\u043D\u0430\u043B\u044C\u043D\u044B\u0445 \u0434\u0430\u043D\u043D\u044B\u0445 \u0432 \u0441\u0438\u0441\u0442\u0435\u043C\u0430\u0445 \u043F\u043E\u0434\u0431\u043E\u0440\u0430 \u043F\u0435\u0440\u0441\u043E\u043D\u0430\u043B\u0430, \u0438\u0441\u043F\u043E\u043B\u044C\u0437\u0443\u0435\u043C\u044B\u0445 \u0440\u0435\u043A\u0440\u0443\u0442\u0435\u0440\u0430\u043C\u0438, \u0440\u0430\u043D\u0435\u0435 \u043F\u0440\u0435\u0434\u043E\u0441\u0442\u0430\u0432\u043B\u0435\u043D\u043D\u044B\u0435 {{\u041A\u043E\u043C\u043F\u0430\u043D\u0438\u044F}} (\u0434\u0430\u043B\u0435\u0435 \u2013 \u041E\u043F\u0435\u0440\u0430\u0442\u043E\u0440). \u041A \u0447\u0438\u0441\u043B\u0443 \u0442\u0430\u043A\u0438\u0445 \u0441\u0438\u0441\u0442\u0435\u043C, \u0432 \u0447\u0430\u0441\u0442\u043D\u043E\u0441\u0442\u0438, \u043E\u0442\u043D\u043E\u0441\u0438\u0442\u0441\u044F \u0425\u0430\u043D\u0442\u0444\u043B\u043E\u0443 \u0438 \u0430\u043D\u0430\u043B\u043E\u0433\u0438\u0447\u043D\u044B\u0435 \u043F\u0440\u043E\u0433\u0440\u0430\u043C\u043C\u043D\u044B\u0435 \u0440\u0435\u0448\u0435\u043D\u0438\u044F.\n\n\u041D\u0430 \u043E\u0441\u043D\u043E\u0432\u0430\u043D\u0438\u0438 \u0432\u044B\u0448\u0435\u0438\u0437\u043B\u043E\u0436\u0435\u043D\u043D\u043E\u0433\u043E, \u0442\u0440\u0435\u0431\u0443\u044E:\n\n1. \u0421 \u043C\u043E\u043C\u0435\u043D\u0442\u0430 \u043F\u043E\u043B\u0443\u0447\u0435\u043D\u0438\u044F \u043D\u0430\u0441\u0442\u043E\u044F\u0449\u0435\u0433\u043E \u043E\u0442\u0437\u044B\u0432\u0430 \u043F\u0440\u0435\u043A\u0440\u0430\u0442\u0438\u0442\u044C \u043E\u0431\u0440\u0430\u0431\u043E\u0442\u043A\u0443 \u0432\u0441\u0435\u0445 \u043C\u043E\u0438\u0445 \u043F\u0435\u0440\u0441\u043E\u043D\u0430\u043B\u044C\u043D\u044B\u0445 \u0434\u0430\u043D\u043D\u044B\u0445 \u0432 \u0441\u043F\u0435\u0446\u0438\u0430\u043B\u0438\u0437\u0438\u0440\u043E\u0432\u0430\u043D\u043D\u044B\u0445 \u0441\u0438\u0441\u0442\u0435\u043C\u0430\u0445 \u043F\u043E\u0434\u0431\u043E\u0440\u0430 \u043F\u0435\u0440\u0441\u043E\u043D\u0430\u043B\u0430, \u0438\u0441\u043F\u043E\u043B\u044C\u0437\u0443\u0435\u043C\u044B\u0445 \u0440\u0435\u043A\u0440\u0443\u0442\u0435\u0440\u0430\u043C\u0438, \u0437\u0430 \u0438\u0441\u043A\u043B\u044E\u0447\u0435\u043D\u0438\u0435\u043C \u0441\u043B\u0443\u0447\u0430\u0435\u0432, \u043A\u043E\u0433\u0434\u0430 \u043F\u0440\u043E\u0434\u043E\u043B\u0436\u0435\u043D\u0438\u0435 \u043E\u0431\u0440\u0430\u0431\u043E\u0442\u043A\u0438 \u0434\u043E\u043F\u0443\u0441\u043A\u0430\u0435\u0442\u0441\u044F \u0437\u0430\u043A\u043E\u043D\u043E\u0434\u0430\u0442\u0435\u043B\u044C\u0441\u0442\u0432\u043E\u043C \u0420\u043E\u0441\u0441\u0438\u0439\u0441\u043A\u043E\u0439 \u0424\u0435\u0434\u0435\u0440\u0430\u0446\u0438\u0438 \u0431\u0435\u0437 \u0441\u043E\u0433\u043B\u0430\u0441\u0438\u044F \u0441\u0443\u0431\u044A\u0435\u043A\u0442\u0430.\n\n2. \u0423\u043D\u0438\u0447\u0442\u043E\u0436\u0438\u0442\u044C \u0432\u0441\u0435 \u043C\u043E\u0438 \u043F\u0435\u0440\u0441\u043E\u043D\u0430\u043B\u044C\u043D\u044B\u0435 \u0434\u0430\u043D\u043D\u044B\u0435 \u0432 \u0441\u0438\u0441\u0442\u0435\u043C\u0430\u0445 \u043F\u043E\u0434\u0431\u043E\u0440\u0430 \u043F\u0435\u0440\u0441\u043E\u043D\u0430\u043B\u0430 \u0432 \u0441\u0440\u043E\u043A, \u043D\u0435 \u043F\u0440\u0435\u0432\u044B\u0448\u0430\u044E\u0449\u0438\u0439 30 (\u0422\u0440\u0438\u0434\u0446\u0430\u0442\u0438) \u043A\u0430\u043B\u0435\u043D\u0434\u0430\u0440\u043D\u044B\u0445 \u0434\u043D\u0435\u0439 \u0441 \u0434\u0430\u0442\u044B \u043F\u043E\u0441\u0442\u0443\u043F\u043B\u0435\u043D\u0438\u044F \u043D\u0430\u0441\u0442\u043E\u044F\u0449\u0435\u0433\u043E \u043E\u0442\u0437\u044B\u0432\u0430.\n\n3. \u041F\u043E\u0434\u0442\u0432\u0435\u0440\u0434\u0438\u0442\u044C \u0432 \u0444\u043E\u0440\u043C\u0430\u0442\u0435 \u043E\u0444\u0438\u0446\u0438\u0430\u043B\u044C\u043D\u043E\u0433\u043E \u043F\u0438\u0441\u044C\u043C\u0430, \u043E\u0444\u043E\u0440\u043C\u043B\u0435\u043D\u043D\u043E\u0433\u043E \u0432 \u0441\u043E\u043E\u0442\u0432\u0435\u0442\u0441\u0442\u0432\u0438\u0438 \u0441 \u0434\u0435\u043B\u043E\u043F\u0440\u043E\u0438\u0437\u0432\u043E\u0434\u0441\u0442\u0432\u0435\u043D\u043D\u044B\u043C\u0438 \u0441\u0442\u0430\u043D\u0434\u0430\u0440\u0442\u0430\u043C\u0438 \u0412\u0430\u0448\u0435\u0439 \u043A\u043E\u043C\u043F\u0430\u043D\u0438\u0438, \u0447\u0442\u043E \u043C\u043E\u0438 \u043F\u0435\u0440\u0441\u043E\u043D\u0430\u043B\u044C\u043D\u044B\u0435 \u0434\u0430\u043D\u043D\u044B\u0435 \u043D\u0435 \u043F\u0435\u0440\u0435\u0434\u0430\u044E\u0442\u0441\u044F \u0442\u0440\u0435\u0442\u044C\u0438\u043C \u043B\u0438\u0446\u0430\u043C \u0438 \u0443\u0434\u0430\u043B\u0435\u043D\u044B \u0438\u0437 \u0432\u043D\u0443\u0442\u0440\u0435\u043D\u043D\u0438\u0445 \u0441\u0438\u0441\u0442\u0435\u043C \u043F\u043E\u0434\u0431\u043E\u0440\u0430 \u043F\u0435\u0440\u0441\u043E\u043D\u0430\u043B\u0430, \u0438\u0441\u043F\u043E\u043B\u044C\u0437\u0443\u0435\u043C\u044B\u0445 \u0412\u0430\u0448\u0435\u0439 \u043A\u043E\u043C\u043F\u0430\u043D\u0438\u0435\u0439 \u0434\u043B\u044F \u0446\u0435\u043B\u0435\u0439 \u0440\u0435\u043A\u0440\u0443\u0442\u043C\u0435\u043D\u0442\u0430.\n\n4. \u041D\u0430\u043F\u0440\u0430\u0432\u0438\u0442\u044C \u043E\u0442\u0432\u0435\u0442 \u043D\u0430 \u043F\u043E\u0447\u0442\u0443: {{Email}}.\n\n\u0417\u0430 \u043D\u0435\u0438\u0441\u043F\u043E\u043B\u043D\u0435\u043D\u0438\u0435 \u0442\u0440\u0435\u0431\u043E\u0432\u0430\u043D\u0438\u0439 \u0437\u0430\u043A\u043E\u043D\u043E\u0434\u0430\u0442\u0435\u043B\u044C\u0441\u0442\u0432\u0430 \u0420\u043E\u0441\u0441\u0438\u0439\u0441\u043A\u043E\u0439 \u0424\u0435\u0434\u0435\u0440\u0430\u0446\u0438\u0438 \u0432 \u043E\u0431\u043B\u0430\u0441\u0442\u0438 \u043F\u0435\u0440\u0441\u043E\u043D\u0430\u043B\u044C\u043D\u044B\u0445 \u0434\u0430\u043D\u043D\u044B\u0445 \u043F\u0440\u0435\u0434\u0443\u0441\u043C\u043E\u0442\u0440\u0435\u043D\u0430 \u0430\u0434\u043C\u0438\u043D\u0438\u0441\u0442\u0440\u0430\u0442\u0438\u0432\u043D\u0430\u044F \u043E\u0442\u0432\u0435\u0442\u0441\u0442\u0432\u0435\u043D\u043D\u043E\u0441\u0442\u044C \u043F\u043E \u0441\u0442.13.11 \u041A\u043E\u0410\u041F \u0420\u0424.",
        subject: "\u041E\u0442\u0437\u044B\u0432 \u0441\u043E\u0433\u043B\u0430\u0441\u0438\u044F \u043D\u0430 \u043E\u0431\u0440\u0430\u0431\u043E\u0442\u043A\u0443 \u043F\u0435\u0440\u0441\u043E\u043D\u0430\u043B\u044C\u043D\u044B\u0445 \u0434\u0430\u043D\u043D\u044B\u0445 \u2014 {{\u0424\u0418\u041E}}"
      },
      inquiry: {
        body: "\u042F, {{\u0424\u0418\u041E}} (\u0434\u0430\u043B\u0435\u0435 \u2013 \u041F\u043E\u043B\u044C\u0437\u043E\u0432\u0430\u0442\u0435\u043B\u044C), \u0432 \u0441\u043E\u043E\u0442\u0432\u0435\u0442\u0441\u0442\u0432\u0438\u0438 \u0441\u043E \u0441\u0442\u0430\u0442\u044C\u0435\u0439 14 \u0424\u0435\u0434\u0435\u0440\u0430\u043B\u044C\u043D\u043E\u0433\u043E \u0437\u0430\u043A\u043E\u043D\u0430 \u043E\u0442 27.07.2006 \u0433. \u2116 152-\u0424\u0417 \xAB\u041E \u043F\u0435\u0440\u0441\u043E\u043D\u0430\u043B\u044C\u043D\u044B\u0445 \u0434\u0430\u043D\u043D\u044B\u0445\xBB \u043F\u0440\u043E\u0448\u0443 {{\u041A\u043E\u043C\u043F\u0430\u043D\u0438\u044F}} (\u0434\u0430\u043B\u0435\u0435 \u2013 \u041E\u043F\u0435\u0440\u0430\u0442\u043E\u0440) \u043F\u0440\u0435\u0434\u043E\u0441\u0442\u0430\u0432\u0438\u0442\u044C \u0441\u043B\u0435\u0434\u0443\u044E\u0449\u0443\u044E \u0438\u043D\u0444\u043E\u0440\u043C\u0430\u0446\u0438\u044E:\n\n1. \u043F\u043E\u0434\u0442\u0432\u0435\u0440\u0434\u0438\u0442\u044C \u0444\u0430\u043A\u0442 \u043E\u0431\u0440\u0430\u0431\u043E\u0442\u043A\u0438 \u043F\u0435\u0440\u0441\u043E\u043D\u0430\u043B\u044C\u043D\u044B\u0445 \u0434\u0430\u043D\u043D\u044B\u0445 \u041F\u043E\u043B\u044C\u0437\u043E\u0432\u0430\u0442\u0435\u043B\u044F \u0432\u043E \u0432\u043D\u0443\u0442\u0440\u0435\u043D\u043D\u0438\u0445 \u0441\u0438\u0441\u0442\u0435\u043C\u0430\u0445, \u0432 \u0442\u043E\u043C \u0447\u0438\u0441\u043B\u0435, \u0432\u043E \u0432\u043D\u0443\u0442\u0440\u0435\u043D\u043D\u0438\u0445 \u0441\u0438\u0441\u0442\u0435\u043C\u0430\u0445 \u043F\u043E\u0434\u0431\u043E\u0440\u0430 \u043F\u0435\u0440\u0441\u043E\u043D\u0430\u043B\u0430, \u0438\u0441\u043F\u043E\u043B\u044C\u0437\u0443\u0435\u043C\u044B\u0445 \u0434\u043B\u044F \u0446\u0435\u043B\u0435\u0439 \u0440\u0435\u043A\u0440\u0443\u0442\u043C\u0435\u043D\u0442\u0430 \u041E\u043F\u0435\u0440\u0430\u0442\u043E\u0440\u043E\u043C;\n\n2. \u043F\u0440\u0430\u0432\u043E\u0432\u044B\u0435 \u043E\u0441\u043D\u043E\u0432\u0430\u043D\u0438\u044F \u0438 \u0446\u0435\u043B\u0438 \u043E\u0431\u0440\u0430\u0431\u043E\u0442\u043A\u0438 \u043F\u0435\u0440\u0441\u043E\u043D\u0430\u043B\u044C\u043D\u044B\u0445 \u0434\u0430\u043D\u043D\u044B\u0445 \u041F\u043E\u043B\u044C\u0437\u043E\u0432\u0430\u0442\u0435\u043B\u044F \u0432\u043E \u0432\u043D\u0443\u0442\u0440\u0435\u043D\u043D\u0438\u0445 \u0441\u0438\u0441\u0442\u0435\u043C\u0430\u0445, \u0432 \u0442\u043E\u043C \u0447\u0438\u0441\u043B\u0435, \u0432\u043E \u0432\u043D\u0443\u0442\u0440\u0435\u043D\u043D\u0438\u0445 \u0441\u0438\u0441\u0442\u0435\u043C\u0430\u0445 \u043F\u043E\u0434\u0431\u043E\u0440\u0430 \u043F\u0435\u0440\u0441\u043E\u043D\u0430\u043B\u0430, \u0438\u0441\u043F\u043E\u043B\u044C\u0437\u0443\u0435\u043C\u044B\u0445 \u0434\u043B\u044F \u0446\u0435\u043B\u0435\u0439 \u0440\u0435\u043A\u0440\u0443\u0442\u043C\u0435\u043D\u0442\u0430 \u041E\u043F\u0435\u0440\u0430\u0442\u043E\u0440\u043E\u043C;\n\n3. \u043F\u0435\u0440\u0435\u0447\u0435\u043D\u044C \u043F\u0435\u0440\u0441\u043E\u043D\u0430\u043B\u044C\u043D\u044B\u0445 \u0434\u0430\u043D\u043D\u044B\u0445 \u041F\u043E\u043B\u044C\u0437\u043E\u0432\u0430\u0442\u0435\u043B\u044F, \u043E\u0431\u0440\u0430\u0431\u0430\u0442\u044B\u0432\u0430\u0435\u043C\u044B\u0445 \u0432\u043E \u0432\u043D\u0443\u0442\u0440\u0435\u043D\u043D\u0438\u0445 \u0441\u0438\u0441\u0442\u0435\u043C\u0430\u0445, \u0432 \u0442\u043E\u043C \u0447\u0438\u0441\u043B\u0435, \u0432\u043E \u0432\u043D\u0443\u0442\u0440\u0435\u043D\u043D\u0438\u0445 \u0441\u0438\u0441\u0442\u0435\u043C\u0430\u0445 \u043F\u043E\u0434\u0431\u043E\u0440\u0430 \u043F\u0435\u0440\u0441\u043E\u043D\u0430\u043B\u0430, \u0438\u0441\u043F\u043E\u043B\u044C\u0437\u0443\u0435\u043C\u044B\u0445 \u0434\u043B\u044F \u0446\u0435\u043B\u0435\u0439 \u0440\u0435\u043A\u0440\u0443\u0442\u043C\u0435\u043D\u0442\u0430 \u041E\u043F\u0435\u0440\u0430\u0442\u043E\u0440\u043E\u043C;\n\n4. \u0438\u0441\u0442\u043E\u0447\u043D\u0438\u043A \u043F\u043E\u043B\u0443\u0447\u0435\u043D\u0438\u044F \u041E\u043F\u0435\u0440\u0430\u0442\u043E\u0440\u043E\u043C \u043F\u0435\u0440\u0441\u043E\u043D\u0430\u043B\u044C\u043D\u044B\u0445 \u0434\u0430\u043D\u043D\u044B\u0445 \u0432\u043E \u0432\u043D\u0443\u0442\u0440\u0435\u043D\u043D\u0438\u0445 \u0441\u0438\u0441\u0442\u0435\u043C\u0430\u0445, \u0432 \u0442\u043E\u043C \u0447\u0438\u0441\u043B\u0435, \u0432\u043E \u0432\u043D\u0443\u0442\u0440\u0435\u043D\u043D\u0438\u0445 \u0441\u0438\u0441\u0442\u0435\u043C\u0430\u0445 \u043F\u043E\u0434\u0431\u043E\u0440\u0430 \u043F\u0435\u0440\u0441\u043E\u043D\u0430\u043B\u0430, \u0438\u0441\u043F\u043E\u043B\u044C\u0437\u0443\u0435\u043C\u044B\u0445 \u0434\u043B\u044F \u0446\u0435\u043B\u0435\u0439 \u0440\u0435\u043A\u0440\u0443\u0442\u043C\u0435\u043D\u0442\u0430;\n\n5. \u043F\u0440\u0438\u043C\u0435\u043D\u044F\u0435\u043C\u044B\u0435 \u041E\u043F\u0435\u0440\u0430\u0442\u043E\u0440\u043E\u043C \u0441\u043F\u043E\u0441\u043E\u0431\u044B \u043E\u0431\u0440\u0430\u0431\u043E\u0442\u043A\u0438 \u043F\u0435\u0440\u0441\u043E\u043D\u0430\u043B\u044C\u043D\u044B\u0445 \u0434\u0430\u043D\u043D\u044B\u0445 \u041F\u043E\u043B\u044C\u0437\u043E\u0432\u0430\u0442\u0435\u043B\u044F \u0432\u043E \u0432\u043D\u0443\u0442\u0440\u0435\u043D\u043D\u0438\u0445 \u0441\u0438\u0441\u0442\u0435\u043C\u0430\u0445, \u0432 \u0442\u043E\u043C \u0447\u0438\u0441\u043B\u0435, \u0432\u043E \u0432\u043D\u0443\u0442\u0440\u0435\u043D\u043D\u0438\u0445 \u0441\u0438\u0441\u0442\u0435\u043C\u0430\u0445 \u043F\u043E\u0434\u0431\u043E\u0440\u0430 \u043F\u0435\u0440\u0441\u043E\u043D\u0430\u043B\u0430, \u0438\u0441\u043F\u043E\u043B\u044C\u0437\u0443\u0435\u043C\u044B\u0445 \u0434\u043B\u044F \u0446\u0435\u043B\u0435\u0439 \u0440\u0435\u043A\u0440\u0443\u0442\u043C\u0435\u043D\u0442\u0430;\n\n6. \u0441\u0432\u0435\u0434\u0435\u043D\u0438\u044F \u043E \u0441\u0440\u043E\u043A\u0430\u0445 \u043E\u0431\u0440\u0430\u0431\u043E\u0442\u043A\u0438 \u043F\u0435\u0440\u0441\u043E\u043D\u0430\u043B\u044C\u043D\u044B\u0445 \u0434\u0430\u043D\u043D\u044B\u0445 \u041F\u043E\u043B\u044C\u0437\u043E\u0432\u0430\u0442\u0435\u043B\u044F \u0432\u043E \u0432\u043D\u0443\u0442\u0440\u0435\u043D\u043D\u0438\u0445 \u0441\u0438\u0441\u0442\u0435\u043C\u0430\u0445, \u0432 \u0442\u043E\u043C \u0447\u0438\u0441\u043B\u0435, \u0432\u043E \u0432\u043D\u0443\u0442\u0440\u0435\u043D\u043D\u0438\u0445 \u0441\u0438\u0441\u0442\u0435\u043C\u0430\u0445 \u043F\u043E\u0434\u0431\u043E\u0440\u0430 \u043F\u0435\u0440\u0441\u043E\u043D\u0430\u043B\u0430, \u0438\u0441\u043F\u043E\u043B\u044C\u0437\u0443\u0435\u043C\u044B\u0445 \u0434\u043B\u044F \u0446\u0435\u043B\u0435\u0439 \u0440\u0435\u043A\u0440\u0443\u0442\u043C\u0435\u043D\u0442\u0430, \u0432 \u0442\u043E\u043C \u0447\u0438\u0441\u043B\u0435 \u043E \u0441\u0440\u043E\u043A\u0430\u0445 \u0438\u0445 \u0445\u0440\u0430\u043D\u0435\u043D\u0438\u044F \u041E\u043F\u0435\u0440\u0430\u0442\u043E\u0440\u043E\u043C;\n\n7. \u0441\u0432\u0435\u0434\u0435\u043D\u0438\u044F \u043E\u0431 \u043E\u0441\u0443\u0449\u0435\u0441\u0442\u0432\u043B\u0435\u043D\u043D\u043E\u0439 \u0438\u043B\u0438 \u043E \u043F\u0440\u0435\u0434\u043F\u043E\u043B\u0430\u0433\u0430\u0435\u043C\u043E\u0439 \u0442\u0440\u0430\u043D\u0441\u0433\u0440\u0430\u043D\u0438\u0447\u043D\u043E\u0439 \u043F\u0435\u0440\u0435\u0434\u0430\u0447\u0435 \u043F\u0435\u0440\u0441\u043E\u043D\u0430\u043B\u044C\u043D\u044B\u0445 \u0434\u0430\u043D\u043D\u044B\u0445 \u041F\u043E\u043B\u044C\u0437\u043E\u0432\u0430\u0442\u0435\u043B\u044F \u0432\u043E \u0432\u043D\u0443\u0442\u0440\u0435\u043D\u043D\u0438\u0445 \u0441\u0438\u0441\u0442\u0435\u043C\u0430\u0445, \u0432 \u0442\u043E\u043C \u0447\u0438\u0441\u043B\u0435, \u0432\u043E \u0432\u043D\u0443\u0442\u0440\u0435\u043D\u043D\u0438\u0445 \u0441\u0438\u0441\u0442\u0435\u043C\u0430\u0445 \u043F\u043E\u0434\u0431\u043E\u0440\u0430 \u043F\u0435\u0440\u0441\u043E\u043D\u0430\u043B\u0430, \u0438\u0441\u043F\u043E\u043B\u044C\u0437\u0443\u0435\u043C\u044B\u0445 \u0434\u043B\u044F \u0446\u0435\u043B\u0435\u0439 \u0440\u0435\u043A\u0440\u0443\u0442\u043C\u0435\u043D\u0442\u0430;\n\n8. \u0441\u0432\u0435\u0434\u0435\u043D\u0438\u044F \u043E \u043B\u0438\u0446\u0430\u0445 (\u0437\u0430 \u0438\u0441\u043A\u043B\u044E\u0447\u0435\u043D\u0438\u0435\u043C \u0440\u0430\u0431\u043E\u0442\u043D\u0438\u043A\u043E\u0432 \u041E\u043F\u0435\u0440\u0430\u0442\u043E\u0440\u0430), \u043A\u043E\u0442\u043E\u0440\u044B\u0435 \u0438\u043C\u0435\u044E\u0442 \u0434\u043E\u0441\u0442\u0443\u043F \u043A \u043F\u0435\u0440\u0441\u043E\u043D\u0430\u043B\u044C\u043D\u044B\u043C \u0434\u0430\u043D\u043D\u044B\u043C \u0438\u043B\u0438 \u043A\u043E\u0442\u043E\u0440\u044B\u043C \u043C\u043E\u0433\u0443\u0442 \u0431\u044B\u0442\u044C \u0440\u0430\u0441\u043A\u0440\u044B\u0442\u044B \u043F\u0435\u0440\u0441\u043E\u043D\u0430\u043B\u044C\u043D\u044B\u0435 \u0434\u0430\u043D\u043D\u044B\u0435 \u043D\u0430 \u043E\u0441\u043D\u043E\u0432\u0430\u043D\u0438\u0438 \u0434\u043E\u0433\u043E\u0432\u043E\u0440\u0430 \u0441 \u041E\u043F\u0435\u0440\u0430\u0442\u043E\u0440\u043E\u043C \u0438\u043B\u0438 \u043D\u0430 \u043E\u0441\u043D\u043E\u0432\u0430\u043D\u0438\u0438 \u0424\u0435\u0434\u0435\u0440\u0430\u043B\u044C\u043D\u043E\u0433\u043E \u0437\u0430\u043A\u043E\u043D\u0430 \u043E\u0442 27.07.2006 \u0433. \u2116 152-\u0424\u0417 \xAB\u041E \u043F\u0435\u0440\u0441\u043E\u043D\u0430\u043B\u044C\u043D\u044B\u0445 \u0434\u0430\u043D\u043D\u044B\u0445\xBB;\n\n9. \u043D\u0430\u0438\u043C\u0435\u043D\u043E\u0432\u0430\u043D\u0438\u0435 \u0438\u043B\u0438 \u0444\u0430\u043C\u0438\u043B\u0438\u044E, \u0438\u043C\u044F, \u043E\u0442\u0447\u0435\u0441\u0442\u0432\u043E \u0438 \u0430\u0434\u0440\u0435\u0441 (\u043F\u043E\u0447\u0442\u043E\u0432\u044B\u0439 \u0430\u0434\u0440\u0435\u0441 \u0438 \u0430\u0434\u0440\u0435\u0441 \u044D\u043B\u0435\u043A\u0442\u0440\u043E\u043D\u043D\u043E\u0439 \u043F\u043E\u0447\u0442\u044B) \u043B\u0438\u0446\u0430, \u043E\u0441\u0443\u0449\u0435\u0441\u0442\u0432\u043B\u044F\u044E\u0449\u0435\u0433\u043E \u043E\u0431\u0440\u0430\u0431\u043E\u0442\u043A\u0443 \u043F\u0435\u0440\u0441\u043E\u043D\u0430\u043B\u044C\u043D\u044B\u0445 \u0434\u0430\u043D\u043D\u044B\u0445 \u041F\u043E\u043B\u044C\u0437\u043E\u0432\u0430\u0442\u0435\u043B\u044F \u043F\u043E \u043F\u043E\u0440\u0443\u0447\u0435\u043D\u0438\u044E \u041E\u043F\u0435\u0440\u0430\u0442\u043E\u0440\u0430, \u0435\u0441\u043B\u0438 \u043E\u0431\u0440\u0430\u0431\u043E\u0442\u043A\u0430 \u043F\u043E\u0440\u0443\u0447\u0435\u043D\u0430 \u0438\u043B\u0438 \u0431\u0443\u0434\u0435\u0442 \u043F\u043E\u0440\u0443\u0447\u0435\u043D\u0430 \u0442\u0430\u043A\u043E\u043C\u0443 \u043B\u0438\u0446\u0443;\n\n10. \u043D\u0430\u0438\u043C\u0435\u043D\u043E\u0432\u0430\u043D\u0438\u0435 \u0438\u043B\u0438 \u0444\u0430\u043C\u0438\u043B\u0438\u044E, \u0438\u043C\u044F, \u043E\u0442\u0447\u0435\u0441\u0442\u0432\u043E \u0438 \u0430\u0434\u0440\u0435\u0441 (\u043F\u043E\u0447\u0442\u043E\u0432\u044B\u0439 \u0430\u0434\u0440\u0435\u0441 \u0438 \u0430\u0434\u0440\u0435\u0441 \u044D\u043B\u0435\u043A\u0442\u0440\u043E\u043D\u043D\u043E\u0439 \u043F\u043E\u0447\u0442\u044B) \u043B\u0438\u0446\u0430, \u043E\u0441\u0443\u0449\u0435\u0441\u0442\u0432\u043B\u044F\u044E\u0449\u0435\u0433\u043E \u043E\u0431\u0440\u0430\u0431\u043E\u0442\u043A\u0443 \u043F\u0435\u0440\u0441\u043E\u043D\u0430\u043B\u044C\u043D\u044B\u0445 \u0434\u0430\u043D\u043D\u044B\u0445 \u041F\u043E\u043B\u044C\u0437\u043E\u0432\u0430\u0442\u0435\u043B\u044F \u0432 \u0440\u0435\u0437\u0443\u043B\u044C\u0442\u0430\u0442\u0435 \u0438\u0445 \u043F\u0435\u0440\u0435\u0434\u0430\u0447\u0438 \u041E\u043F\u0435\u0440\u0430\u0442\u043E\u0440\u043E\u043C (\u0432 \u0442\u043E\u043C \u0447\u0438\u0441\u043B\u0435 \u043D\u0430 \u043E\u0441\u043D\u043E\u0432\u0430\u043D\u0438\u0438 \u0441\u043E\u0433\u043B\u0430\u0441\u0438\u044F \u041F\u043E\u043B\u044C\u0437\u043E\u0432\u0430\u0442\u0435\u043B\u044F);\n\n11. \u0441\u0432\u0435\u0434\u0435\u043D\u0438\u044F \u043E \u0441\u043F\u043E\u0441\u043E\u0431\u0430\u0445 \u0438\u0441\u043F\u043E\u043B\u043D\u0435\u043D\u0438\u044F \u041E\u043F\u0435\u0440\u0430\u0442\u043E\u0440\u043E\u043C \u043E\u0431\u044F\u0437\u0430\u043D\u043D\u043E\u0441\u0442\u0435\u0439, \u0443\u0441\u0442\u0430\u043D\u043E\u0432\u043B\u0435\u043D\u043D\u044B\u0445 \u0441\u0442\u0430\u0442\u044C\u0435\u0439 18.1 \u0424\u0435\u0434\u0435\u0440\u0430\u043B\u044C\u043D\u043E\u0433\u043E \u0437\u0430\u043A\u043E\u043D\u0430 \u043E\u0442 27.07.2006 \u0433. \u2116 152-\u0424\u0417 \xAB\u041E \u043F\u0435\u0440\u0441\u043E\u043D\u0430\u043B\u044C\u043D\u044B\u0445 \u0434\u0430\u043D\u043D\u044B\u0445\xBB;\n\n12. \u043F\u043E\u0440\u044F\u0434\u043E\u043A \u043E\u0441\u0443\u0449\u0435\u0441\u0442\u0432\u043B\u0435\u043D\u0438\u044F \u041F\u043E\u043B\u044C\u0437\u043E\u0432\u0430\u0442\u0435\u043B\u0435\u043C \u043F\u0440\u0430\u0432, \u043F\u0440\u0435\u0434\u0443\u0441\u043C\u043E\u0442\u0440\u0435\u043D\u043D\u044B\u0445 \u0424\u0435\u0434\u0435\u0440\u0430\u043B\u044C\u043D\u044B\u043C \u0437\u0430\u043A\u043E\u043D\u043E\u043C \u043E\u0442 27.07.2006 \u0433. \u2116 152-\u0424\u0417 \xAB\u041E \u043F\u0435\u0440\u0441\u043E\u043D\u0430\u043B\u044C\u043D\u044B\u0445 \u0434\u0430\u043D\u043D\u044B\u0445\xBB.\n\n\u041F\u0440\u043E\u0448\u0443 \u0432 \u0442\u0435\u0447\u0435\u043D\u0438\u0435 10 (\u0414\u0435\u0441\u044F\u0442\u0438) \u0440\u0430\u0431\u043E\u0447\u0438\u0445 \u0434\u043D\u0435\u0439 \u0441\u043E\u043E\u0431\u0449\u0438\u0442\u044C \u043C\u043D\u0435 \u0443\u043A\u0430\u0437\u0430\u043D\u043D\u0443\u044E \u0438\u043D\u0444\u043E\u0440\u043C\u0430\u0446\u0438\u044E \u043F\u043E \u0430\u0434\u0440\u0435\u0441\u0443 \u044D\u043B\u0435\u043A\u0442\u0440\u043E\u043D\u043D\u043E\u0439 \u043F\u043E\u0447\u0442\u044B:  {{Email}}",
        subject: "\u0417\u0430\u043F\u0440\u043E\u0441 \u0438\u043D\u0444\u043E\u0440\u043C\u0430\u0446\u0438\u0438 \u043E\u0431 \u043E\u0431\u0440\u0430\u0431\u043E\u0442\u043A\u0435 \u043F\u0435\u0440\u0441\u043E\u043D\u0430\u043B\u044C\u043D\u044B\u0445 \u0434\u0430\u043D\u043D\u044B\u0445 \u2014 {{\u0424\u0418\u041E}}"
      }
    },
    sources: [
      {
        file: "\u0421\u043F\u0438\u0441\u043E\u043A \u043A\u043E\u043C\u043F\u0430\u043D\u0438\u0438\u0306 \u0434\u043B\u044F \u043E\u0442\u0437\u044B\u0432\u0430 \u041F\u0414.xlsx",
        sha256: "fc88d94ce2c2316993d915178a1a3aeabe2691ae10f60cb023d52a83b50099dd"
      },
      {
        file: "\u0440\u0435\u043A\u0432\u0438\u0437\u0438\u0442\u044B.xlsx",
        sha256: "4273ff4347d3e3d962de2715bda330fe8f32c878338479f67ec241430d76e12a"
      },
      {
        file: "\u0428\u0430\u0431\u043B\u043E\u043D \u043E\u0442\u0437\u044B\u0432\u0430 \u041F\u0414 \u0443\u043D\u0438\u0432\u0435\u0440\u0441\u0430\u043B\u044C\u043D\u044B\u0438\u0306.docx",
        sha256: "83b0e65576c14cd7b58a9ff7accbb8266c0d1490887cf08540aa3e06744bc801"
      },
      {
        file: "\u0428\u0430\u0431\u043B\u043E\u043D_\u0437\u0430\u043F\u0440\u043E\u0441\u0430_\u043D\u0430_\u043F\u0440\u0435\u0434\u043E\u0441\u0442\u0430\u0432\u043B\u0435\u043D\u0438\u0435_\u0438\u043D\u0444\u043E\u0440\u043C\u0430\u0446\u0438\u0438,_\u043A\u0430\u0441\u0430\u044E\u0449\u0435\u0438\u0306\u0441\u044F_\u043E\u0431\u0440\u0430\u0431\u043E\u0442\u043A\u0438.docx",
        sha256: "24b1914816ba2af13a1ea7865c37054a29852f243d5d7023064cbce1511b0c62"
      }
    ]
  };

  // src/letters.ts
  var validEmail = (s) => /^[^\s@,;<>]+@[^\s@,;<>]+\.[^\s@,;<>]+$/.test(s);
  function validateProfile(p) {
    if (!p.fio.trim() || /[\r\n]/.test(p.fio))
      throw new Error("\u0412\u0432\u0435\u0434\u0438\u0442\u0435 \u0424\u0418\u041E \u043E\u0434\u043D\u043E\u0439 \u0441\u0442\u0440\u043E\u043A\u043E\u0439.");
    if (!validEmail(p.email.trim()))
      throw new Error("\u0412\u0432\u0435\u0434\u0438\u0442\u0435 \u043A\u043E\u0440\u0440\u0435\u043A\u0442\u043D\u044B\u0439 email \u0434\u043B\u044F \u043E\u0442\u0432\u0435\u0442\u0430.");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(p.date))
      throw new Error("\u0423\u043A\u0430\u0436\u0438\u0442\u0435 \u0434\u0430\u0442\u0443 \u043E\u0431\u0440\u0430\u0449\u0435\u043D\u0438\u044F.");
  }
  function substitute(text, values) {
    const result = text.replace(/\{\{([^{}]+)\}\}/g, (_, key) => {
      if (!(key in values)) throw new Error(`\u041D\u0435\u0438\u0437\u0432\u0435\u0441\u0442\u043D\u0430\u044F \u043F\u043E\u0434\u0441\u0442\u0430\u043D\u043E\u0432\u043A\u0430: ${key}`);
      return values[key];
    });
    if (/\{\{|\}\}|\[[^\]]+\]|_{3,}/.test(result))
      throw new Error("\u0412 \u0448\u0430\u0431\u043B\u043E\u043D\u0435 \u043E\u0441\u0442\u0430\u043B\u0438\u0441\u044C \u043D\u0435\u0437\u0430\u043F\u043E\u043B\u043D\u0435\u043D\u043D\u044B\u0435 \u043E\u0431\u043E\u0437\u043D\u0430\u0447\u0435\u043D\u0438\u044F.");
    return result;
  }
  function makeLetter(c, p, mode, t, interaction = "") {
    validateProfile(p);
    if (!c.emails.length || c.emails.some((e) => !validEmail(e)))
      throw new Error(`\u041F\u0440\u043E\u0432\u0435\u0440\u044C\u0442\u0435 \u0430\u0434\u0440\u0435\u0441\u0430: ${c.name}`);
    const values = {
      \u0424\u0418\u041E: p.fio.trim(),
      \u041A\u043E\u043C\u043F\u0430\u043D\u0438\u044F: c.legalName?.trim() || c.name,
      Email: p.email.trim(),
      \u0414\u0430\u0442\u0430: p.date
    };
    const missing = [];
    if (mode === "inquiry" && !interaction.trim())
      missing.push("\u0421\u0432\u0435\u0434\u0435\u043D\u0438\u044F \u043E \u0432\u0437\u0430\u0438\u043C\u043E\u0434\u0435\u0439\u0441\u0442\u0432\u0438\u0438 / \u043E\u0431\u0440\u0430\u0431\u043E\u0442\u043A\u0435 \u0434\u0430\u043D\u043D\u044B\u0445");
    const requisites = [
      [
        c.inn && `\u0418\u041D\u041D \u043E\u0440\u0433\u0430\u043D\u0438\u0437\u0430\u0446\u0438\u0438: ${c.inn}`,
        c.ogrn && `\u041E\u0413\u0420\u041D \u043E\u0440\u0433\u0430\u043D\u0438\u0437\u0430\u0446\u0438\u0438: ${c.ogrn}`
      ].filter(Boolean).join(", ")
    ];
    if (p.inn.trim()) requisites.push(`\u0418\u041D\u041D \u0437\u0430\u044F\u0432\u0438\u0442\u0435\u043B\u044F: ${p.inn.trim()}`);
    const passport = [
      p.series && `\u0441\u0435\u0440\u0438\u044F ${p.series}`,
      p.number && `\u2116 ${p.number}`,
      p.issuer && `\u0432\u044B\u0434\u0430\u043D ${p.issuer}`,
      p.city,
      p.issued
    ].filter(Boolean).join(", ");
    if (passport) requisites.push(`\u041F\u0430\u0441\u043F\u043E\u0440\u0442: ${passport}`);
    if (p.phone.trim()) requisites.push(`\u0422\u0435\u043B\u0435\u0444\u043E\u043D: ${p.phone.trim()}`);
    const title = mode === "withdrawal" ? "\u041E\u0422\u0417\u042B\u0412 \u0421\u041E\u0413\u041B\u0410\u0421\u0418\u042F\n\u043D\u0430 \u043E\u0431\u0440\u0430\u0431\u043E\u0442\u043A\u0443 \u043F\u0435\u0440\u0441\u043E\u043D\u0430\u043B\u044C\u043D\u044B\u0445 \u0434\u0430\u043D\u043D\u044B\u0445" : "\u0417\u0410\u041F\u0420\u041E\u0421\n\u043D\u0430 \u043F\u0440\u0435\u0434\u043E\u0441\u0442\u0430\u0432\u043B\u0435\u043D\u0438\u0435 \u0438\u043D\u0444\u043E\u0440\u043C\u0430\u0446\u0438\u0438, \u043A\u0430\u0441\u0430\u044E\u0449\u0435\u0439\u0441\u044F \u043E\u0431\u0440\u0430\u0431\u043E\u0442\u043A\u0438 \u043F\u0435\u0440\u0441\u043E\u043D\u0430\u043B\u044C\u043D\u044B\u0445 \u0434\u0430\u043D\u043D\u044B\u0445";
    const actions = [
      "\u041F\u043E\u0434\u043F\u0438\u0441\u044C \u043D\u0435 \u0434\u043E\u0431\u0430\u0432\u043B\u0435\u043D\u0430: \u043F\u0440\u0438 \u043D\u0435\u043E\u0431\u0445\u043E\u0434\u0438\u043C\u043E\u0441\u0442\u0438 \u043F\u043E\u0434\u043F\u0438\u0448\u0438\u0442\u0435 \u043E\u0431\u0440\u0430\u0449\u0435\u043D\u0438\u0435 \u0438 \u043F\u0440\u0438\u043B\u043E\u0436\u0438\u0442\u0435 \u0434\u043E\u043A\u0443\u043C\u0435\u043D\u0442 \u0432\u0440\u0443\u0447\u043D\u0443\u044E."
    ];
    if (mode === "inquiry")
      actions[0] = "\u0417\u0430\u043F\u0440\u043E\u0441 \u043D\u0435 \u043F\u043E\u0434\u043F\u0438\u0441\u0430\u043D. \u041F\u043E\u0434\u0433\u043E\u0442\u043E\u0432\u044C\u0442\u0435 \u0438 \u043F\u043E\u0434\u043F\u0438\u0448\u0438\u0442\u0435 \u0434\u043E\u043A\u0443\u043C\u0435\u043D\u0442 \u0432\u0440\u0443\u0447\u043D\u0443\u044E; \u0424\u0418\u041E \u0432 \u043F\u0438\u0441\u044C\u043C\u0435 \u043D\u0435 \u044F\u0432\u043B\u044F\u0435\u0442\u0441\u044F \u044D\u043B\u0435\u043A\u0442\u0440\u043E\u043D\u043D\u043E\u0439 \u043F\u043E\u0434\u043F\u0438\u0441\u044C\u044E.";
    if (mode === "withdrawal" && c.special === "pdf")
      actions.push(
        "\u041F\u0440\u0438\u043B\u043E\u0436\u0438\u0442\u0435 PDF \u0441 \u043E\u0442\u0437\u044B\u0432\u043E\u043C \u0441\u043E\u0433\u043B\u0430\u0441\u0438\u044F (\u043F\u0440\u0438\u043C\u0435\u0447\u0430\u043D\u0438\u0435 \u0438\u0437 \u0438\u0441\u0445\u043E\u0434\u043D\u043E\u0439 \u0431\u0430\u0437\u044B)."
      );
    if (mode === "withdrawal" && c.special === "signature") actions.push(c.notes);
    const body = [
      title,
      requisites.filter(Boolean).join("\n"),
      mode === "inquiry" && interaction.trim() ? `\u0421\u0432\u0435\u0434\u0435\u043D\u0438\u044F \u043E \u0432\u0437\u0430\u0438\u043C\u043E\u0434\u0435\u0439\u0441\u0442\u0432\u0438\u0438 / \u043E\u0431\u0440\u0430\u0431\u043E\u0442\u043A\u0435 \u0434\u0430\u043D\u043D\u044B\u0445: ${interaction.trim()}` : "",
      substitute(t.body, values),
      mode === "withdrawal" ? c.withdrawalExtra : "",
      `${p.date.split("-").reverse().join(".")}
${values["\u0424\u0418\u041E"]}`
    ].filter(Boolean).join("\n\n");
    const subject = substitute(t.subject, values).trim();
    if (!subject || /[\r\n]/.test(subject) || !t.body.trim())
      throw new Error(
        "\u0422\u0435\u043C\u0430 \u0434\u043E\u043B\u0436\u043D\u0430 \u0431\u044B\u0442\u044C \u043E\u0434\u043D\u043E\u0439 \u0441\u0442\u0440\u043E\u043A\u043E\u0439, \u0442\u0435\u043A\u0441\u0442 \u043D\u0435 \u0434\u043E\u043B\u0436\u0435\u043D \u0431\u044B\u0442\u044C \u043F\u0443\u0441\u0442\u044B\u043C."
      );
    return {
      companyId: c.id,
      companyName: c.name,
      to: [...new Set(c.emails)],
      subject,
      body,
      missing,
      actions
    };
  }

  // src/ui-surface.ts
  async function createSurface(doc = document) {
    const frame = doc.createElement("iframe");
    frame.id = "return-pd-ui";
    frame.title = "\u041E\u0431\u0440\u0430\u0449\u0435\u043D\u0438\u044F \u043F\u043E \u041F\u0414";
    frame.setAttribute("referrerpolicy", "no-referrer");
    frame.style.cssText = "position:fixed!important;bottom:0!important;right:0!important;width:260px!important;height:84px!important;border:0!important;margin:0!important;padding:0!important;background:transparent!important;z-index:2147483647!important;display:block!important;color-scheme:light!important;";
    await new Promise((resolve) => {
      const timeout = setTimeout(resolve, 1500);
      frame.addEventListener(
        "load",
        () => {
          clearTimeout(timeout);
          resolve();
        },
        { once: true }
      );
      doc.body.append(frame);
    });
    const inner = frame.contentDocument;
    if (!inner?.body) {
      frame.remove();
      throw new Error("\u041D\u0435 \u0443\u0434\u0430\u043B\u043E\u0441\u044C \u043E\u0442\u043A\u0440\u044B\u0442\u044C \u043B\u043E\u043A\u0430\u043B\u044C\u043D\u0443\u044E \u043F\u0430\u043D\u0435\u043B\u044C.");
    }
    inner.documentElement.lang = "ru";
    inner.body.style.cssText = "margin:0;background:transparent;";
    const host = inner.createElement("div");
    inner.body.append(host);
    const root = host.attachShadow({ mode: "open" });
    return {
      frame,
      root,
      expand(open) {
        frame.style.setProperty("display", open ? "block" : "none", "important");
        frame.style.setProperty("width", open ? "100%" : "260px", "important");
        frame.style.setProperty("height", open ? "100%" : "84px", "important");
        frame.style.setProperty("bottom", "0", "important");
        frame.style.setProperty("right", "0", "important");
      },
      compact() {
        frame.style.setProperty("display", "block", "important");
        frame.style.setProperty("width", "min(380px, 100vw)", "important");
        frame.style.setProperty("height", "192px", "important");
        frame.style.setProperty("bottom", "84px", "important");
        frame.style.setProperty("right", "0", "important");
      }
    };
  }

  // src/launcher.ts
  function createLauncher(createPanel, doc = document) {
    const host = doc.createElement("div");
    host.id = "return-pd-launcher";
    host.style.cssText = "all:initial!important;position:fixed!important;right:20px!important;bottom:20px!important;z-index:2147483647!important;display:block!important;visibility:visible!important;opacity:1!important;pointer-events:auto!important;";
    const root = host.attachShadow({ mode: "open" });
    const style = doc.createElement("style");
    style.textContent = "button{font:14px system-ui;cursor:pointer;background:#204c3c;color:white;border:1px solid #93b6a3;border-radius:9px;padding:12px 16px;box-shadow:0 4px 20px #0003}button:focus-visible{outline:3px solid #9bd6b9}p{font:13px/1.5 system-ui;max-width:320px;padding:12px;background:white;color:#8d2929;border:1px solid #d6b3b3;border-radius:8px}[hidden]{display:none!important}";
    const trigger = doc.createElement("button");
    trigger.type = "button";
    const label = "\u2197 \u041E\u0431\u0440\u0430\u0449\u0435\u043D\u0438\u044F \u043F\u043E \u041F\u0414 \xB7 0.2.9";
    trigger.textContent = label;
    const failure = doc.createElement("p");
    failure.hidden = true;
    failure.setAttribute("role", "alert");
    root.append(style, failure, trigger);
    let disposed = false;
    let panel;
    let pending;
    function dropPanel() {
      const previous = panel;
      panel = void 0;
      try {
        previous?.dispose();
      } catch {
      }
    }
    function attach() {
      if (disposed || !doc.body) return;
      if (host.parentNode !== doc.body) doc.body.append(host);
      if (panel && !panel.isAlive()) {
        dropPanel();
        failure.textContent = "\u041F\u043E\u0447\u0442\u0430 \u043F\u0435\u0440\u0435\u0437\u0430\u0433\u0440\u0443\u0437\u0438\u043B\u0430 \u0444\u043E\u0440\u043C\u0443. \u041F\u043E\u0434\u0433\u043E\u0442\u043E\u0432\u043A\u0430 \u043E\u0441\u0442\u0430\u043D\u043E\u0432\u043B\u0435\u043D\u0430; \u043F\u0430\u043D\u0435\u043B\u044C \u043C\u043E\u0436\u043D\u043E \u043E\u0442\u043A\u0440\u044B\u0442\u044C \u0441\u043D\u043E\u0432\u0430.";
        failure.hidden = false;
      }
    }
    attach();
    const observer = new doc.defaultView.MutationObserver(attach);
    observer.observe(doc.documentElement, { childList: true, subtree: true });
    function report(message) {
      if (disposed) return;
      failure.textContent = message;
      failure.hidden = false;
      attach();
    }
    async function openPanel() {
      trigger.textContent = "\u041E\u0442\u043A\u0440\u044B\u0432\u0430\u044E\u2026";
      failure.hidden = true;
      try {
        if (panel && !panel.isAlive()) {
          dropPanel();
        }
        if (!panel) panel = await createPanel(() => trigger.focus());
        if (disposed) {
          dropPanel();
          return;
        }
        panel.open();
        doc.body.append(host);
      } catch {
        dropPanel();
        doc.querySelector("iframe#return-pd-ui")?.remove();
        report(
          "\u041D\u0435 \u0443\u0434\u0430\u043B\u043E\u0441\u044C \u043E\u0442\u043A\u0440\u044B\u0442\u044C \u0444\u043E\u0440\u043C\u0443. \u041A\u043D\u043E\u043F\u043A\u0430 \u0440\u0430\u0431\u043E\u0442\u0430\u0435\u0442 \u2014 \u043C\u043E\u0436\u043D\u043E \u043F\u043E\u0432\u0442\u043E\u0440\u0438\u0442\u044C \u0437\u0430\u043F\u0443\u0441\u043A. \u0418\u0437\u043E\u043B\u044F\u0446\u0438\u044F \u0432\u0432\u043E\u0434\u0430 \u043E\u0442 \u043F\u043E\u0447\u0442\u044B \u0441\u043E\u0445\u0440\u0430\u043D\u0435\u043D\u0430."
        );
      } finally {
        trigger.textContent = label;
      }
    }
    function open() {
      if (disposed) return Promise.resolve();
      pending ??= openPanel().finally(() => {
        pending = void 0;
      });
      return pending;
    }
    trigger.onclick = () => void open();
    try {
      GM_registerMenuCommand(
        "\u041E\u0431\u0440\u0430\u0449\u0435\u043D\u0438\u044F \u043F\u043E \u041F\u0414 \xB7 0.2.9 \u2014 \u043E\u0442\u043A\u0440\u044B\u0442\u044C",
        () => void open()
      );
    } catch {
    }
    return {
      open,
      report,
      dispose() {
        disposed = true;
        observer.disconnect();
        dropPanel();
        host.remove();
      }
    };
  }

  // src/profile-storage.ts
  var PROFILE_KEY = "return-pd:profile-v1";
  var savedProfileFields = [
    "fio",
    "email",
    "inn",
    "phone",
    "series",
    "number",
    "issuer",
    "city",
    "issued"
  ];
  function isSavedProfileField(key) {
    return savedProfileFields.includes(key);
  }
  function readProfile(store2) {
    const raw = store2.get(PROFILE_KEY);
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
    const result = {};
    for (const key of savedProfileFields) {
      const value = raw[key];
      if (typeof value === "string") result[key] = value;
    }
    return result;
  }
  function saveProfileField(store2, key, value) {
    const saved = readProfile(store2);
    if (value) saved[key] = value;
    else delete saved[key];
    if (Object.keys(saved).length) store2.set(PROFILE_KEY, saved);
    else store2.delete(PROFILE_KEY);
  }

  // src/ui.ts
  var SETTINGS = "return-pd:catalog-v1";
  var labels = {
    queued: "\u0412 \u043E\u0447\u0435\u0440\u0435\u0434\u0438",
    opening: "\u041E\u0442\u043A\u0440\u044B\u0432\u0430\u0435\u0442\u0441\u044F",
    waiting: "\u0416\u0434\u0451\u043C \u0433\u043E\u0442\u043E\u0432\u043D\u043E\u0441\u0442\u0438 \u042F\u043D\u0434\u0435\u043A\u0441\u0430 \u043A \u0441\u043B\u0435\u0434\u0443\u044E\u0449\u0435\u0439 \u043E\u0442\u043F\u0440\u0430\u0432\u043A\u0435",
    sending: "\u041E\u0442\u043F\u0440\u0430\u0432\u043B\u044F\u0435\u0442\u0441\u044F",
    sent: "\u041E\u0442\u043F\u0440\u0430\u0432\u043B\u0435\u043D\u043E",
    uncertain: "\u041E\u0442\u043F\u0440\u0430\u0432\u043A\u0430 \u043D\u0435 \u043F\u043E\u0434\u0442\u0432\u0435\u0440\u0436\u0434\u0435\u043D\u0430",
    filled: "\u041F\u043E\u043B\u044F \u0437\u0430\u043F\u043E\u043B\u043D\u0435\u043D\u044B",
    manual: "\u0422\u0440\u0435\u0431\u0443\u0435\u0442\u0441\u044F \u0434\u043E\u0440\u0430\u0431\u043E\u0442\u043A\u0430",
    error: "\u041E\u0448\u0438\u0431\u043A\u0430"
  };
  var profileFields = [
    ["fio", "\u0424\u0418\u041E *", "text"],
    ["email", "Email \u0434\u043B\u044F \u043E\u0442\u0432\u0435\u0442\u0430 *", "email"],
    ["date", "\u0414\u0430\u0442\u0430 \u043E\u0431\u0440\u0430\u0449\u0435\u043D\u0438\u044F *", "date"]
  ];
  var today = () => {
    const d = /* @__PURE__ */ new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  };
  function el(tag, text, cls) {
    const node = document.createElement(tag);
    if (text) node.textContent = text;
    if (cls) node.className = cls;
    return node;
  }
  function button(text, fn, cls = "") {
    const b = el("button", text, cls);
    b.type = "button";
    b.onclick = fn;
    return b;
  }
  function field(label, input) {
    const wrap = el("label", label);
    wrap.append(input);
    return wrap;
  }
  function mountUI() {
    return createLauncher(mountPanel);
  }
  async function mountPanel(onClose) {
    const surface = await createSurface();
    const { root } = surface;
    let previewTimer;
    function schedulePreview(event) {
      clearTimeout(previewTimer);
      if (event && "isComposing" in event && event.isComposing) return;
      previewTimer = setTimeout(preview, 120);
    }
    const style = el("style");
    style.textContent = CSS;
    root.append(style);
    const overlay = el("div", void 0, "overlay");
    overlay.hidden = true;
    const panel = el("section", void 0, "panel");
    panel.setAttribute("role", "dialog");
    panel.setAttribute("aria-modal", "true");
    panel.setAttribute("aria-label", "\u041E\u0431\u0440\u0430\u0449\u0435\u043D\u0438\u044F \u043F\u043E \u041F\u0414");
    overlay.append(panel);
    root.append(overlay);
    const header = el("header");
    const heading = el("div");
    heading.append(
      el("span", "\u041B\u041E\u041A\u0410\u041B\u042C\u041D\u042B\u0419 \u041F\u041E\u041C\u041E\u0429\u041D\u0418\u041A", "eyebrow"),
      el("h1", "\u041E\u0431\u0440\u0430\u0449\u0435\u043D\u0438\u044F \u043F\u043E \u041F\u0414"),
      el(
        "p",
        "\u0412\u044B\u0431\u0435\u0440\u0438\u0442\u0435 \u043A\u043E\u043C\u043F\u0430\u043D\u0438\u0438 \u0438 \u043F\u0440\u043E\u0432\u0435\u0440\u044C\u0442\u0435 \u0442\u0435\u043A\u0441\u0442. \u041F\u0438\u0441\u044C\u043C\u0430 \u043E\u0442\u043F\u0440\u0430\u0432\u043B\u044F\u044E\u0442\u0441\u044F \u043F\u043E \u043E\u0434\u043D\u043E\u043C\u0443 \u0432 \u044D\u0442\u043E\u0439 \u0432\u043A\u043B\u0430\u0434\u043A\u0435 \u043F\u043E\u0447\u0442\u044B.",
        "muted"
      )
    );
    header.append(
      heading,
      button("\u0417\u0430\u043A\u0440\u044B\u0442\u044C", () => close(), "ghost")
    );
    panel.append(header);
    const accountNote = el("p", "", "account");
    panel.append(accountNote);
    const accountTools = el("div", void 0, "toolbar");
    accountTools.append(
      button("\u041F\u0440\u043E\u0432\u0435\u0440\u0438\u0442\u044C \u0430\u043A\u043A\u0430\u0443\u043D\u0442", refreshAccount, "ghost"),
      button(
        "\u0421\u043A\u043E\u043F\u0438\u0440\u043E\u0432\u0430\u0442\u044C \u0434\u0438\u0430\u0433\u043D\u043E\u0441\u0442\u0438\u043A\u0443",
        () => {
          GM_setClipboard(JSON.stringify(yandexDiagnostics(document), null, 2));
          accountNote.textContent = "\u0414\u0438\u0430\u0433\u043D\u043E\u0441\u0442\u0438\u043A\u0430 \u0441\u043A\u043E\u043F\u0438\u0440\u043E\u0432\u0430\u043D\u0430. \u041E\u043D\u0430 \u0441\u043E\u0434\u0435\u0440\u0436\u0438\u0442 \u0442\u043E\u043B\u044C\u043A\u043E \u0441\u0442\u0440\u0443\u043A\u0442\u0443\u0440\u0443 \u044D\u043B\u0435\u043C\u0435\u043D\u0442\u043E\u0432 \u043F\u0440\u043E\u0444\u0438\u043B\u044F \u2014 \u0431\u0435\u0437 \u043F\u0438\u0441\u0435\u043C, \u0430\u0434\u0440\u0435\u0441\u043E\u0432 \u0438 cookies.";
        },
        "ghost"
      )
    );
    panel.append(accountTools);
    const error = el("p", "", "error");
    error.setAttribute("role", "alert");
    error.hidden = true;
    panel.append(error);
    const tabs = el("div", void 0, "tabs");
    let mode = "withdrawal";
    const modeSelect = el("select");
    modeSelect.append(
      new Option("\u041E\u0442\u0437\u044B\u0432 \u0441\u043E\u0433\u043B\u0430\u0441\u0438\u044F \u0434\u043B\u044F \u0440\u0435\u043A\u0440\u0443\u0442\u043C\u0435\u043D\u0442\u0430", "withdrawal"),
      new Option("\u0417\u0430\u043F\u0440\u043E\u0441 \u0438\u043D\u0444\u043E\u0440\u043C\u0430\u0446\u0438\u0438 \u043E\u0431 \u043E\u0431\u0440\u0430\u0431\u043E\u0442\u043A\u0435 \u041F\u0414", "inquiry")
    );
    tabs.append(field("\u0422\u0438\u043F \u043E\u0431\u0440\u0430\u0449\u0435\u043D\u0438\u044F", modeSelect));
    const deliverySelect = el("select");
    deliverySelect.name = "deliveryMode";
    deliverySelect.append(
      new Option("\u041E\u0442\u043F\u0440\u0430\u0432\u043B\u044F\u0442\u044C \u0430\u0432\u0442\u043E\u043C\u0430\u0442\u0438\u0447\u0435\u0441\u043A\u0438", "send"),
      new Option("\u0422\u043E\u043B\u044C\u043A\u043E \u0447\u0435\u0440\u043D\u043E\u0432\u0438\u043A\u0438", "draft")
    );
    tabs.append(field("\u0414\u0435\u0439\u0441\u0442\u0432\u0438\u0435 \u0441 \u043F\u0438\u0441\u044C\u043C\u0430\u043C\u0438", deliverySelect));
    const deliveryNote = el("p", "", "note");
    panel.append(tabs, deliveryNote);
    const layout = el("div", void 0, "layout");
    panel.append(layout);
    const left = el("div");
    const right = el("div");
    layout.append(left, right);
    left.append(el("h2", "1. \u0412\u0430\u0448\u0438 \u0434\u0430\u043D\u043D\u044B\u0435"));
    const profileForm = el("div", void 0, "fields");
    left.append(profileForm);
    const profileStatus = el(
      "p",
      "\u0414\u0430\u043D\u043D\u044B\u0435 \u0441\u043E\u0445\u0440\u0430\u043D\u044F\u044E\u0442\u0441\u044F \u0432 \u044D\u0442\u043E\u043C \u0431\u0440\u0430\u0443\u0437\u0435\u0440\u0435 \u0430\u0432\u0442\u043E\u043C\u0430\u0442\u0438\u0447\u0435\u0441\u043A\u0438.",
      "muted"
    );
    profileStatus.dataset.role = "profile-storage-status";
    profileStatus.setAttribute("aria-live", "polite");
    const inputs = /* @__PURE__ */ new Map();
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
        "\u0424\u0418\u041E \u0438 email \u0441\u043E\u0445\u0440\u0430\u043D\u044F\u044E\u0442\u0441\u044F \u0432 Tampermonkey \u0434\u043E \u043D\u0430\u0436\u0430\u0442\u0438\u044F \xAB\u041E\u0447\u0438\u0441\u0442\u0438\u0442\u044C \u0434\u0430\u043D\u043D\u044B\u0435\xBB. \u0412 \u043D\u043E\u0432\u043E\u0439 \u0432\u043A\u043B\u0430\u0434\u043A\u0435 \u0434\u0430\u0442\u0430 \u043E\u0431\u0440\u0430\u0449\u0435\u043D\u0438\u044F \u2014 \u0441\u0435\u0433\u043E\u0434\u043D\u044F\u0448\u043D\u044F\u044F. \u0418\u0437\u043C\u0435\u043D\u0435\u043D\u0438\u044F \u0448\u0430\u0431\u043B\u043E\u043D\u0430 \u0434\u0435\u0439\u0441\u0442\u0432\u0443\u044E\u0442 \u0442\u043E\u043B\u044C\u043A\u043E \u0432 \u0442\u0435\u043A\u0443\u0449\u0435\u0439 \u0432\u043A\u043B\u0430\u0434\u043A\u0435. \u041F\u043E\u0434\u043F\u0438\u0441\u0438 \u0438 \u0432\u043B\u043E\u0436\u0435\u043D\u0438\u044F \u0434\u043E\u0431\u0430\u0432\u043B\u044F\u044E\u0442\u0441\u044F \u0432\u0440\u0443\u0447\u043D\u0443\u044E.",
        "muted"
      )
    );
    left.append(el("h2", "2. \u041A\u043E\u043C\u043F\u0430\u043D\u0438\u0438"));
    const search = el("input");
    search.type = "search";
    search.placeholder = "\u041D\u0430\u0439\u0442\u0438 \u043A\u043E\u043C\u043F\u0430\u043D\u0438\u044E";
    search.setAttribute("aria-label", "\u041D\u0430\u0439\u0442\u0438 \u043A\u043E\u043C\u043F\u0430\u043D\u0438\u044E");
    left.append(search);
    const companies = structuredClone(data_default.companies);
    const saved = store.get(SETTINGS) || {};
    for (const c of companies)
      if (saved[c.id]) {
        const s = saved[c.id];
        if (Array.isArray(s.emails) && s.emails.every((e) => typeof e === "string"))
          c.emails = s.emails;
      }
    const selected = /* @__PURE__ */ new Set();
    const toolbar = el("div", void 0, "toolbar");
    toolbar.append(
      button("\u0412\u044B\u0431\u0440\u0430\u0442\u044C \u0432\u0441\u0435", () => {
        companies.forEach((c) => selected.add(c.id));
        renderCompanies();
        preview();
      }),
      button(
        "\u0421\u043D\u044F\u0442\u044C \u0432\u044B\u0431\u043E\u0440",
        () => {
          selected.clear();
          renderCompanies();
          preview();
        },
        "ghost"
      )
    );
    left.append(toolbar);
    const companyList = el("div", void 0, "company-list");
    left.append(companyList);
    let current = companies[0];
    const card = el("details");
    card.append(el("summary", "\u0410\u0434\u0440\u0435\u0441\u0430 \u0438 \u043F\u0440\u0438\u043C\u0435\u0447\u0430\u043D\u0438\u044F \u043A\u043E\u043C\u043F\u0430\u043D\u0438\u0438"));
    left.append(card);
    const companyFields = el("div", void 0, "fields");
    card.append(companyFields);
    const notes = el("p", "", "note");
    card.append(notes);
    const interactions = /* @__PURE__ */ new Map();
    const interaction = el("textarea");
    interaction.rows = 3;
    interaction.placeholder = "\u041D\u0430\u043F\u0440\u0438\u043C\u0435\u0440: \u043E\u0442\u043A\u043B\u0438\u043A \u043D\u0430 \u0432\u0430\u043A\u0430\u043D\u0441\u0438\u044E, \u0434\u0430\u0442\u0430 \u0441\u043E\u0431\u0435\u0441\u0435\u0434\u043E\u0432\u0430\u043D\u0438\u044F";
    const interactionWrap = field(
      "\u0421\u0432\u0435\u0434\u0435\u043D\u0438\u044F \u043E \u0432\u0437\u0430\u0438\u043C\u043E\u0434\u0435\u0439\u0441\u0442\u0432\u0438\u0438 / \u043E\u0431\u0440\u0430\u0431\u043E\u0442\u043A\u0435 \u0434\u0430\u043D\u043D\u044B\u0445",
      interaction
    );
    card.append(interactionWrap);
    interaction.oninput = () => {
      interactions.set(current.id, interaction.value);
      schedulePreview();
    };
    right.append(el("h2", "3. \u0428\u0430\u0431\u043B\u043E\u043D \u0438 \u043F\u0440\u0435\u0434\u043F\u0440\u043E\u0441\u043C\u043E\u0442\u0440"));
    const templates = structuredClone(data_default.templates);
    const editor = el("details");
    editor.append(el("summary", "\u0418\u0437\u043C\u0435\u043D\u0438\u0442\u044C \u0442\u0435\u043C\u0443 \u0438 \u0442\u0435\u043A\u0441\u0442 \u0448\u0430\u0431\u043B\u043E\u043D\u0430"));
    const subject = el("input");
    const body = el("textarea");
    body.rows = 12;
    editor.append(
      field("\u0422\u0435\u043C\u0430", subject),
      field("\u0422\u0435\u043A\u0441\u0442", body),
      el(
        "p",
        "\u041F\u043E\u0434\u0441\u0442\u0430\u043D\u043E\u0432\u043A\u0438: {{\u0424\u0418\u041E}}, {{\u041A\u043E\u043C\u043F\u0430\u043D\u0438\u044F}}, {{Email}}, {{\u0414\u0430\u0442\u0430}}. \u0421\u043B\u0443\u0436\u0435\u0431\u043D\u0430\u044F \u0448\u0430\u043F\u043A\u0430 \u043D\u0435 \u0434\u043E\u0431\u0430\u0432\u043B\u044F\u0435\u0442\u0441\u044F. \u0414\u0430\u0442\u0430 \u0438 \u0438\u043D\u0441\u0442\u0440\u0443\u043A\u0446\u0438\u0438 \u043A\u043E\u043C\u043F\u0430\u043D\u0438\u0438 \u0432\u043A\u043B\u044E\u0447\u0430\u044E\u0442\u0441\u044F \u0432 \u043F\u0438\u0441\u044C\u043C\u043E.",
        "muted"
      ),
      button(
        "\u0412\u043E\u0441\u0441\u0442\u0430\u043D\u043E\u0432\u0438\u0442\u044C \u0438\u0441\u0445\u043E\u0434\u043D\u044B\u0439 \u0448\u0430\u0431\u043B\u043E\u043D",
        () => {
          templates[mode] = structuredClone(data_default.templates[mode]);
          loadTemplate();
          preview();
        },
        "ghost"
      )
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
    right.append(field("\u041F\u0440\u0435\u0434\u043F\u0440\u043E\u0441\u043C\u043E\u0442\u0440 \u0434\u043B\u044F \u043A\u043E\u043C\u043F\u0430\u043D\u0438\u0438", previewSelect));
    const previewTitle = el("p", "", "preview-title");
    const previewTo = el("p", "", "muted");
    const previewText = el("pre");
    right.append(previewTitle, previewTo, previewText);
    const gaps = el("div", void 0, "note");
    right.append(gaps);
    const copies = el("div", void 0, "toolbar");
    right.append(copies);
    for (const [title, key] of [
      ["\u0410\u0434\u0440\u0435\u0441\u0430", "to"],
      ["\u0422\u0435\u043C\u0430", "subject"],
      ["\u0422\u0435\u043A\u0441\u0442", "body"]
    ])
      copies.append(
        button(
          `\u041A\u043E\u043F\u0438\u0440\u043E\u0432\u0430\u0442\u044C: ${title}`,
          () => safe(() => {
            const l = letter(current);
            GM_setClipboard(key === "to" ? l.to.join(", ") : l[key]);
            announce("\u0421\u043A\u043E\u043F\u0438\u0440\u043E\u0432\u0430\u043D\u043E \u0432 \u0431\u0443\u0444\u0435\u0440 \u043E\u0431\u043C\u0435\u043D\u0430.");
          }),
          "ghost"
        )
      );
    const footer = el("footer");
    const count = el("span");
    const launch = button("\u041E\u0442\u043F\u0440\u0430\u0432\u0438\u0442\u044C \u043F\u0438\u0441\u044C\u043C\u0430", () => void start(), "primary");
    const stop = button(
      "\u041E\u0441\u0442\u0430\u043D\u043E\u0432\u0438\u0442\u044C",
      () => {
        queue?.stop();
        transport?.clear();
      },
      "ghost"
    );
    stop.disabled = true;
    const resume = button(
      "\u041F\u0440\u043E\u0434\u043E\u043B\u0436\u0438\u0442\u044C \u043E\u0447\u0435\u0440\u0435\u0434\u044C",
      () => void resumeQueue(),
      "ghost"
    );
    resume.hidden = true;
    const clear = button("\u041E\u0447\u0438\u0441\u0442\u0438\u0442\u044C \u0434\u0430\u043D\u043D\u044B\u0435", () => safe(() => reset()), "ghost");
    footer.append(count, launch, stop, resume, clear);
    panel.append(footer);
    const progress = el("div", void 0, "progress");
    progress.setAttribute("aria-live", "polite");
    panel.append(progress);
    const statusList = el("div", void 0, "results");
    panel.append(statusList);
    const resultRows = /* @__PURE__ */ new Map();
    const dock = el("aside", void 0, "queue-dock");
    dock.hidden = true;
    const dockProgress = el("p", "", "dock-progress");
    dockProgress.setAttribute("aria-live", "polite");
    const dockCurrent = el("p", "", "muted");
    const dockActions = el("div", void 0, "toolbar");
    const dockStop = button("\u041E\u0441\u0442\u0430\u043D\u043E\u0432\u0438\u0442\u044C", () => {
      queue?.stop();
      transport?.clear();
    });
    const dockOpen = button("\u041E\u0442\u043A\u0440\u044B\u0442\u044C \u043F\u0430\u043D\u0435\u043B\u044C", () => open());
    dockActions.append(dockStop, dockOpen);
    dock.append(dockProgress, dockCurrent, dockActions);
    root.append(dock);
    let queue;
    let queueDelivery = "send";
    let transport;
    const live = el("p", "", "muted");
    live.setAttribute("aria-live", "polite");
    panel.append(live);
    let sensitiveSince = Date.now();
    const expiryTimer = setInterval(() => {
      if (Date.now() - sensitiveSince >= TTL) {
        try {
          reset(false);
        } catch {
          error.textContent = "\u041D\u0435 \u0443\u0434\u0430\u043B\u043E\u0441\u044C \u043E\u0447\u0438\u0441\u0442\u0438\u0442\u044C \u0432\u0440\u0435\u043C\u0435\u043D\u043D\u044B\u0435 \u0437\u0430\u0434\u0430\u043D\u0438\u044F. \u0421\u043E\u0445\u0440\u0430\u043D\u0451\u043D\u043D\u044B\u0435 \u0434\u0430\u043D\u043D\u044B\u0435 \u0444\u043E\u0440\u043C\u044B \u043E\u0441\u0442\u0430\u044E\u0442\u0441\u044F \u0432 \u0431\u0440\u0430\u0443\u0437\u0435\u0440\u0435.";
          error.hidden = false;
        }
      }
    }, 6e4);
    function announce(message) {
      live.textContent = message;
    }
    function safe(fn) {
      try {
        error.hidden = true;
        fn();
      } catch (e) {
        error.textContent = e instanceof Error ? e.message : "\u041E\u0448\u0438\u0431\u043A\u0430";
        error.hidden = false;
      }
    }
    function profile() {
      return {
        inn: "",
        phone: "",
        series: "",
        number: "",
        issuer: "",
        city: "",
        issued: "",
        ...Object.fromEntries([...inputs].map(([k, v]) => [k, v.value.trim()]))
      };
    }
    function restoreProfile() {
      try {
        const saved2 = readProfile(store);
        for (const [key, input] of inputs) {
          if (isSavedProfileField(key)) input.value = saved2[key] || "";
        }
        profileStatus.className = "muted";
        profileStatus.textContent = Object.keys(saved2).length ? "\u0421\u043E\u0445\u0440\u0430\u043D\u0451\u043D\u043D\u044B\u0435 \u0434\u0430\u043D\u043D\u044B\u0435 \u0437\u0430\u0433\u0440\u0443\u0436\u0435\u043D\u044B. \u0418\u0437\u043C\u0435\u043D\u0435\u043D\u0438\u044F \u0441\u043E\u0445\u0440\u0430\u043D\u044F\u044E\u0442\u0441\u044F \u0430\u0432\u0442\u043E\u043C\u0430\u0442\u0438\u0447\u0435\u0441\u043A\u0438." : "\u0414\u0430\u043D\u043D\u044B\u0435 \u0441\u043E\u0445\u0440\u0430\u043D\u044F\u044E\u0442\u0441\u044F \u0432 \u044D\u0442\u043E\u043C \u0431\u0440\u0430\u0443\u0437\u0435\u0440\u0435 \u0430\u0432\u0442\u043E\u043C\u0430\u0442\u0438\u0447\u0435\u0441\u043A\u0438.";
      } catch {
        profileStatus.className = "error";
        profileStatus.textContent = "\u041D\u0435 \u0443\u0434\u0430\u043B\u043E\u0441\u044C \u0437\u0430\u0433\u0440\u0443\u0437\u0438\u0442\u044C \u0441\u043E\u0445\u0440\u0430\u043D\u0451\u043D\u043D\u044B\u0435 \u0434\u0430\u043D\u043D\u044B\u0435 \u0438\u0437 Tampermonkey. \u0412\u0432\u0435\u0434\u0451\u043D\u043D\u044B\u0435 \u043F\u043E\u043B\u044F \u043E\u0441\u0442\u0430\u044E\u0442\u0441\u044F \u0434\u043E\u0441\u0442\u0443\u043F\u043D\u044B \u0432 \u044D\u0442\u043E\u0439 \u0432\u043A\u043B\u0430\u0434\u043A\u0435.";
      }
    }
    function saveField(key, value) {
      if (!isSavedProfileField(key)) return;
      try {
        saveProfileField(store, key, value);
        profileStatus.className = "muted";
        profileStatus.textContent = "\u0421\u043E\u0445\u0440\u0430\u043D\u0435\u043D\u043E \u0432 \u044D\u0442\u043E\u043C \u0431\u0440\u0430\u0443\u0437\u0435\u0440\u0435.";
      } catch {
        profileStatus.className = "error";
        profileStatus.textContent = "\u041D\u0435 \u0443\u0434\u0430\u043B\u043E\u0441\u044C \u0441\u043E\u0445\u0440\u0430\u043D\u0438\u0442\u044C \u0434\u0430\u043D\u043D\u044B\u0435 \u0432 Tampermonkey. \u041E\u043D\u0438 \u043E\u0441\u0442\u0430\u043D\u0443\u0442\u0441\u044F \u0442\u043E\u043B\u044C\u043A\u043E \u0432 \u044D\u0442\u043E\u0439 \u0432\u043A\u043B\u0430\u0434\u043A\u0435; \u043F\u043E\u0432\u0442\u043E\u0440\u0438\u0442\u0435 \u0438\u0437\u043C\u0435\u043D\u0435\u043D\u0438\u0435 \u043F\u043E\u043B\u044F \u043F\u043E\u0441\u043B\u0435 \u0432\u043E\u0441\u0441\u0442\u0430\u043D\u043E\u0432\u043B\u0435\u043D\u0438\u044F \u0445\u0440\u0430\u043D\u0438\u043B\u0438\u0449\u0430.";
      }
    }
    function letter(c) {
      return makeLetter(
        c,
        profile(),
        mode,
        templates[mode],
        interactions.get(c.id)
      );
    }
    function saveCatalog() {
      const value = {};
      for (const c of companies)
        value[c.id] = {
          emails: c.emails
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
      const input = el("input");
      input.value = current.emails.join(", ");
      input.oninput = () => {
        current.emails = input.value.split(/[,;]/).map((s) => s.trim()).filter(Boolean);
        saveCatalog();
        schedulePreview();
      };
      companyFields.append(field("Email \u043F\u043E\u043B\u0443\u0447\u0430\u0442\u0435\u043B\u0435\u0439 \u0447\u0435\u0440\u0435\u0437 \u0437\u0430\u043F\u044F\u0442\u0443\u044E", input));
      notes.textContent = `${current.name}. ${current.notes || "\u041E\u0441\u043E\u0431\u044B\u0445 \u0438\u043D\u0441\u0442\u0440\u0443\u043A\u0446\u0438\u0439 \u0432 \u0438\u0441\u0445\u043E\u0434\u043D\u043E\u0439 \u0431\u0430\u0437\u0435 \u043D\u0435\u0442."}`;
      interaction.value = interactions.get(current.id) || "";
    }
    function renderCompanies() {
      companyList.replaceChildren();
      const needle = search.value.trim().toLowerCase();
      for (const c of companies.filter(
        (c2) => c2.name.toLowerCase().includes(needle)
      )) {
        const row = el("div", void 0, "company");
        const checkbox = el("input");
        checkbox.type = "checkbox";
        checkbox.checked = selected.has(c.id);
        checkbox.setAttribute("aria-label", `\u0412\u044B\u0431\u0440\u0430\u0442\u044C ${c.name}`);
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
            "company-name"
          ),
          el("small", c.emails.join(", ")),
          el("small", `\u0421\u0442\u0430\u0442\u0443\u0441 \u0438\u0437 \u0438\u0441\u0445\u043E\u0434\u043D\u043E\u0439 \u0431\u0430\u0437\u044B: ${c.sourceStatus}`, "muted")
        );
        if (c.notes)
          details.append(el("span", "\u0415\u0441\u0442\u044C \u043E\u0441\u043E\u0431\u044B\u0435 \u0438\u043D\u0441\u0442\u0440\u0443\u043A\u0446\u0438\u0438", "badge"));
        row.append(checkbox, details);
        companyList.append(row);
      }
      count.textContent = `\u0412\u044B\u0431\u0440\u0430\u043D\u043E ${selected.size} \u0438\u0437 ${companies.length}`;
    }
    function preview() {
      count.textContent = `\u0412\u044B\u0431\u0440\u0430\u043D\u043E ${selected.size} \u0438\u0437 ${companies.length}`;
      const autoSend = deliverySelect.value === "send";
      launch.textContent = autoSend ? `\u041E\u0442\u043F\u0440\u0430\u0432\u0438\u0442\u044C ${selected.size} \u043F\u0438\u0441\u0435\u043C` : `\u041F\u043E\u0434\u0433\u043E\u0442\u043E\u0432\u0438\u0442\u044C ${selected.size} \u0447\u0435\u0440\u043D\u043E\u0432\u0438\u043A\u043E\u0432`;
      deliveryNote.textContent = autoSend ? "\u041A\u043D\u043E\u043F\u043A\u0430 \xAB\u041E\u0442\u043F\u0440\u0430\u0432\u0438\u0442\u044C\xBB \u0437\u0430\u043F\u0443\u0441\u043A\u0430\u0435\u0442 \u0440\u0430\u0441\u0441\u044B\u043B\u043A\u0443 \u0432\u0441\u0435\u043C \u0432\u044B\u0431\u0440\u0430\u043D\u043D\u044B\u043C \u043A\u043E\u043C\u043F\u0430\u043D\u0438\u044F\u043C \u0432 \u044D\u0442\u043E\u0439 \u0432\u043A\u043B\u0430\u0434\u043A\u0435. \u041F\u043E\u0441\u043B\u0435 \u043F\u043E\u0434\u0442\u0432\u0435\u0440\u0436\u0434\u0435\u043D\u0438\u044F \u043E\u0442\u043F\u0440\u0430\u0432\u043A\u0438 \u043E\u0442\u043A\u0440\u044B\u0432\u0430\u0435\u0442\u0441\u044F \u0441\u043B\u0435\u0434\u0443\u044E\u0449\u0438\u0439 \u0440\u0435\u0434\u0430\u043A\u0442\u043E\u0440. \u041E\u0442\u043F\u0440\u0430\u0432\u043B\u044F\u0435\u0442\u0441\u044F \u0442\u0435\u043A\u0441\u0442 \u0438\u0437 \u043F\u0440\u0435\u0434\u043F\u0440\u043E\u0441\u043C\u043E\u0442\u0440\u0430, \u0431\u0435\u0437 \u0434\u043E\u0431\u0430\u0432\u043B\u0435\u043D\u0438\u044F \u0444\u0430\u0439\u043B\u043E\u0432 \u0438 \u043F\u043E\u0434\u043F\u0438\u0441\u0438 \u0434\u043E\u043A\u0443\u043C\u0435\u043D\u0442\u0430. \u0415\u0441\u043B\u0438 \u043E\u043D\u0438 \u043D\u0443\u0436\u043D\u044B, \u0432\u044B\u0431\u0435\u0440\u0438\u0442\u0435 \xAB\u0422\u043E\u043B\u044C\u043A\u043E \u0447\u0435\u0440\u043D\u043E\u0432\u0438\u043A\u0438\xBB." : "\u0421\u043A\u0440\u0438\u043F\u0442 \u0437\u0430\u043F\u043E\u043B\u043D\u0438\u0442 \u043E\u0434\u0438\u043D \u0447\u0435\u0440\u043D\u043E\u0432\u0438\u043A \u0432 \u044D\u0442\u043E\u0439 \u0432\u043A\u043B\u0430\u0434\u043A\u0435 \u0438 \u043F\u0440\u0438\u043E\u0441\u0442\u0430\u043D\u043E\u0432\u0438\u0442 \u043E\u0447\u0435\u0440\u0435\u0434\u044C. \u0414\u043E\u0431\u0430\u0432\u044C\u0442\u0435 \u043D\u0443\u0436\u043D\u044B\u0435 \u0432\u043B\u043E\u0436\u0435\u043D\u0438\u044F \u0438 \u043F\u043E\u0434\u043F\u0438\u0441\u044C. \u041E\u0442\u043F\u0440\u0430\u0432\u044C\u0442\u0435 \u043F\u0438\u0441\u044C\u043C\u043E \u0438\u043B\u0438 \u0437\u0430\u043A\u0440\u043E\u0439\u0442\u0435 \u0440\u0435\u0434\u0430\u043A\u0442\u043E\u0440 \u0441 \u0441\u043E\u0445\u0440\u0430\u043D\u0435\u043D\u0438\u0435\u043C \u0447\u0435\u0440\u043D\u043E\u0432\u0438\u043A\u0430, \u0437\u0430\u0442\u0435\u043C \u043D\u0430\u0436\u043C\u0438\u0442\u0435 \xAB\u041F\u0440\u043E\u0434\u043E\u043B\u0436\u0438\u0442\u044C \u043E\u0447\u0435\u0440\u0435\u0434\u044C\xBB \u0434\u043B\u044F \u0441\u043B\u0435\u0434\u0443\u044E\u0449\u0435\u0439 \u043A\u043E\u043C\u043F\u0430\u043D\u0438\u0438.";
      launch.disabled = !!queue?.running || selected.size === 0;
      try {
        const l = letter(current);
        previewTitle.textContent = l.subject;
        previewTo.textContent = `\u041A\u043E\u043C\u0443: ${l.to.join(", ")}`;
        previewText.textContent = l.body;
        gaps.replaceChildren();
        if (l.missing.length)
          gaps.append(el("p", `\u041D\u0435 \u0437\u0430\u043F\u043E\u043B\u043D\u0435\u043D\u043E: ${l.missing.join("; ")}.`));
        for (const s of l.actions) gaps.append(el("p", s));
      } catch (e) {
        previewTitle.textContent = current.name;
        previewTo.textContent = current.emails.join(", ");
        previewText.textContent = "\u0417\u0430\u043F\u043E\u043B\u043D\u0438\u0442\u0435 \u043E\u0431\u044F\u0437\u0430\u0442\u0435\u043B\u044C\u043D\u044B\u0435 \u043F\u043E\u043B\u044F, \u0447\u0442\u043E\u0431\u044B \u0443\u0432\u0438\u0434\u0435\u0442\u044C \u043F\u0438\u0441\u044C\u043C\u043E.";
        gaps.textContent = e instanceof Error ? e.message : "\u041F\u0440\u043E\u0432\u0435\u0440\u044C\u0442\u0435 \u0434\u0430\u043D\u043D\u044B\u0435.";
      }
    }
    function update() {
      const running = !!queue?.running;
      launch.disabled = running || selected.size === 0;
      stop.disabled = !running;
      dockStop.disabled = !running;
      resume.hidden = !queue || running || !queue.items.some(
        (i) => i.status === "queued" || i.status === "error" && !i.attempted
      );
      for (const input of layout.querySelectorAll("input,select,textarea"))
        input.disabled = running;
      modeSelect.disabled = running;
      deliverySelect.disabled = running;
      if (!queue) {
        statusList.replaceChildren();
        resultRows.clear();
        dock.hidden = true;
        if (overlay.hidden) surface.expand(false);
        return;
      }
      const done = queue.items.filter(
        (i) => queueDelivery === "send" ? i.status === "sent" : i.status === "manual" || i.status === "filled"
      ).length;
      const summary = `${queueDelivery === "send" ? "\u041E\u0442\u043F\u0440\u0430\u0432\u043B\u0435\u043D\u043E" : "\u041F\u043E\u0434\u0433\u043E\u0442\u043E\u0432\u043B\u0435\u043D\u043E"} ${done} \u0438\u0437 ${queue.items.length}`;
      const canContinue = queue.items.some(
        (item) => item.status === "queued" || item.status === "error" && !item.attempted
      );
      progress.textContent = `${summary}. ${running ? "\u041E\u0447\u0435\u0440\u0435\u0434\u044C \u0440\u0430\u0431\u043E\u0442\u0430\u0435\u0442 \u0432 \u044D\u0442\u043E\u0439 \u0432\u043A\u043B\u0430\u0434\u043A\u0435." : canContinue ? "\u041E\u0447\u0435\u0440\u0435\u0434\u044C \u043F\u0440\u0438\u043E\u0441\u0442\u0430\u043D\u043E\u0432\u043B\u0435\u043D\u0430. \u041F\u0440\u043E\u0432\u0435\u0440\u044C\u0442\u0435 \u0440\u0435\u0437\u0443\u043B\u044C\u0442\u0430\u0442 \u043D\u0438\u0436\u0435 \u0438 \u043D\u0430\u0436\u043C\u0438\u0442\u0435 \xAB\u041F\u0440\u043E\u0434\u043E\u043B\u0436\u0438\u0442\u044C \u043E\u0447\u0435\u0440\u0435\u0434\u044C\xBB." : "\u041E\u0447\u0435\u0440\u0435\u0434\u044C \u0437\u0430\u0432\u0435\u0440\u0448\u0435\u043D\u0430."}`;
      dockProgress.textContent = summary;
      const active2 = queue.items.find(
        (item) => item.status === "opening" || item.status === "waiting" || item.status === "sending"
      );
      const failed = queue.items.find(
        (item) => item.status === "error" || item.status === "uncertain"
      );
      const lastSent = queue.items.filter((item) => item.status === "sent").at(-1);
      dockCurrent.textContent = active2 ? active2.status === "waiting" ? `${active2.letter.companyName} \xB7 \u0416\u0434\u0451\u043C \u0433\u043E\u0442\u043E\u0432\u043D\u043E\u0441\u0442\u0438 \u042F\u043D\u0434\u0435\u043A\u0441\u0430 \u043A \u0441\u043B\u0435\u0434\u0443\u044E\u0449\u0435\u0439 \u043E\u0442\u043F\u0440\u0430\u0432\u043A\u0435.` : active2.status === "sending" ? `${lastSent ? `${lastSent.letter.companyName}: \u043E\u0442\u043F\u0440\u0430\u0432\u043B\u0435\u043D\u043E. ` : ""}${active2.letter.companyName}: \u0436\u0434\u0451\u043C \u043F\u043E\u0434\u0442\u0432\u0435\u0440\u0436\u0434\u0435\u043D\u0438\u044F \u043F\u043E\u0447\u0442\u044B.` : `${active2.letter.companyName} \xB7 \u041F\u043E\u0434\u0433\u043E\u0442\u0430\u0432\u043B\u0438\u0432\u0430\u0435\u043C \u043F\u0438\u0441\u044C\u043C\u043E` : failed?.status === "uncertain" ? `${failed.letter.companyName}: \u043F\u043E\u0434\u0442\u0432\u0435\u0440\u0436\u0434\u0435\u043D\u0438\u0435 \u043D\u0435 \u043F\u043E\u043B\u0443\u0447\u0435\u043D\u043E. ${canContinue ? "\u041E\u0447\u0435\u0440\u0435\u0434\u044C \u043F\u0440\u0438\u043E\u0441\u0442\u0430\u043D\u043E\u0432\u043B\u0435\u043D\u0430. \u041F\u0440\u043E\u0432\u0435\u0440\u044C\u0442\u0435 \xAB\u041E\u0442\u043F\u0440\u0430\u0432\u043B\u0435\u043D\u043D\u044B\u0435\xBB; \u043F\u0440\u043E\u0434\u043E\u043B\u0436\u0435\u043D\u0438\u0435 \u2014 \u0432 \u043F\u0430\u043D\u0435\u043B\u0438." : "\u041F\u0440\u043E\u0432\u0435\u0440\u044C\u0442\u0435 \xAB\u041E\u0442\u043F\u0440\u0430\u0432\u043B\u0435\u043D\u043D\u044B\u0435\xBB."}` : failed ? `\u041E\u0447\u0435\u0440\u0435\u0434\u044C \u043F\u0440\u0438\u043E\u0441\u0442\u0430\u043D\u043E\u0432\u043B\u0435\u043D\u0430: ${failed.letter.companyName}. ${failed.error || "\u041D\u0435 \u0443\u0434\u0430\u043B\u043E\u0441\u044C \u043F\u043E\u0434\u0433\u043E\u0442\u043E\u0432\u0438\u0442\u044C \u043F\u0438\u0441\u044C\u043C\u043E."}${canContinue ? " \u041F\u0440\u043E\u0434\u043E\u043B\u0436\u0435\u043D\u0438\u0435 \u2014 \u0432 \u043F\u0430\u043D\u0435\u043B\u0438." : ""}` : queueDelivery === "draft" && canContinue ? "\u0427\u0435\u0440\u043D\u043E\u0432\u0438\u043A \u043E\u0442\u043A\u0440\u044B\u0442. \u0421\u043E\u0445\u0440\u0430\u043D\u0438\u0442\u0435 \u0438\u043B\u0438 \u043E\u0442\u043F\u0440\u0430\u0432\u044C\u0442\u0435 \u0435\u0433\u043E; \u043F\u0440\u043E\u0434\u043E\u043B\u0436\u0435\u043D\u0438\u0435 \u2014 \u0432 \u043F\u0430\u043D\u0435\u043B\u0438." : canContinue ? "\u041E\u0447\u0435\u0440\u0435\u0434\u044C \u043E\u0441\u0442\u0430\u043D\u043E\u0432\u043B\u0435\u043D\u0430. \u041F\u0440\u043E\u0434\u043E\u043B\u0436\u0435\u043D\u0438\u0435 \u2014 \u0432 \u043F\u0430\u043D\u0435\u043B\u0438." : "\u0413\u043E\u0442\u043E\u0432\u043E.";
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
          const row = el("div", void 0, "result");
          const badge = el("span", "", "badge");
          const rowError = el("p", "", "error");
          const notice = el("p", "", "note");
          row.append(
            el("strong", item.letter.companyName),
            badge,
            rowError,
            notice
          );
          const detail = el("details");
          const detailText = el("div", "", "result-body");
          const detailCopies = el("div");
          let rendered = false;
          detail.append(
            el("summary", "\u041F\u0438\u0441\u044C\u043C\u043E \u0438 \u0440\u0443\u0447\u043D\u044B\u0435 \u0434\u0435\u0439\u0441\u0442\u0432\u0438\u044F"),
            detailText,
            detailCopies
          );
          detail.addEventListener("toggle", () => {
            if (!detail.open || rendered) return;
            safe(() => {
              detailText.append(
                el("p", `\u041A\u043E\u043C\u0443: ${item.letter.to.join(", ")}`),
                el("p", item.letter.subject),
                el("pre", item.letter.body)
              );
              for (const text of [
                ...item.letter.missing.map((text2) => `\u041D\u0435 \u0437\u0430\u043F\u043E\u043B\u043D\u0435\u043D\u043E: ${text2}`),
                ...item.letter.actions
              ])
                detailText.append(el("p", text));
              rendered = true;
            });
          });
          for (const [name, text] of [
            ["\u0430\u0434\u0440\u0435\u0441\u0430", item.letter.to.join(", ")],
            ["\u0442\u0435\u043C\u0443", item.letter.subject],
            ["\u0442\u0435\u043A\u0441\u0442", item.letter.body]
          ])
            detailCopies.append(
              button(`\u041A\u043E\u043F\u0438\u0440\u043E\u0432\u0430\u0442\u044C ${name}`, () => GM_setClipboard(text), "ghost")
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
        view.notice.textContent = item.status === "uncertain" ? "\u041F\u0440\u043E\u0432\u0435\u0440\u044C\u0442\u0435 \xAB\u041E\u0442\u043F\u0440\u0430\u0432\u043B\u0435\u043D\u043D\u044B\u0435\xBB \u0438 \u0442\u0435\u043A\u0443\u0449\u0438\u0439 \u0440\u0435\u0434\u0430\u043A\u0442\u043E\u0440. \u0421\u043A\u0440\u0438\u043F\u0442 \u043D\u0435 \u043F\u043E\u0432\u0442\u043E\u0440\u044F\u0435\u0442 \u044D\u0442\u0443 \u043E\u0442\u043F\u0440\u0430\u0432\u043A\u0443: \u043F\u0438\u0441\u044C\u043C\u043E \u0443\u0436\u0435 \u043C\u043E\u0433\u043B\u043E \u0443\u0439\u0442\u0438. \u041F\u0440\u043E\u0434\u043E\u043B\u0436\u0435\u043D\u0438\u0435 \u043E\u0447\u0435\u0440\u0435\u0434\u0438 \u043E\u0431\u0440\u0430\u0431\u043E\u0442\u0430\u0435\u0442 \u0442\u043E\u043B\u044C\u043A\u043E \u043E\u0441\u0442\u0430\u0432\u0448\u0438\u0435\u0441\u044F \u043A\u043E\u043C\u043F\u0430\u043D\u0438\u0438." : "";
        if (item.status === "error" && item.attempted && !queue.running) {
          if (!view.retry) {
            view.retry = button(
              "\u041F\u043E\u0432\u0442\u043E\u0440\u0438\u0442\u044C \u043F\u043E\u0441\u043B\u0435 \u043F\u0440\u043E\u0432\u0435\u0440\u043A\u0438 \u043F\u0438\u0441\u044C\u043C\u0430",
              () => {
                if (window.confirm(
                  queueDelivery === "send" ? "\u041F\u0440\u043E\u0432\u0435\u0440\u044C\u0442\u0435 \xAB\u041E\u0442\u043F\u0440\u0430\u0432\u043B\u0435\u043D\u043D\u044B\u0435\xBB \u0438 \u043F\u0440\u043E\u0448\u043B\u044B\u0439 \u0447\u0435\u0440\u043D\u043E\u0432\u0438\u043A. \u041F\u043E\u0432\u0442\u043E\u0440 \u0441\u043E\u0437\u0434\u0430\u0441\u0442 \u043D\u043E\u0432\u043E\u0435 \u043F\u0438\u0441\u044C\u043C\u043E \u0438 \u0430\u0432\u0442\u043E\u043C\u0430\u0442\u0438\u0447\u0435\u0441\u043A\u0438 \u043E\u0442\u043F\u0440\u0430\u0432\u0438\u0442 \u0435\u0433\u043E. \u041F\u043E\u0432\u0442\u043E\u0440\u0438\u0442\u044C?" : "\u0423\u0431\u0435\u0434\u0438\u0442\u0435\u0441\u044C, \u0447\u0442\u043E \u043F\u0440\u043E\u0448\u043B\u043E\u0435 \u043F\u0438\u0441\u044C\u043C\u043E \u043D\u0435 \u043E\u0442\u043F\u0440\u0430\u0432\u043B\u0435\u043D\u043E. \u041F\u043E\u0432\u0442\u043E\u0440 \u0441\u043E\u0437\u0434\u0430\u0441\u0442 \u043D\u043E\u0432\u044B\u0439 \u0447\u0435\u0440\u043D\u043E\u0432\u0438\u043A. \u0421\u043E\u0437\u0434\u0430\u0442\u044C?"
                )) {
                  item.attempted = false;
                  item.status = "queued";
                  void resumeQueue();
                }
              },
              "ghost"
            );
            view.row.append(view.retry);
          }
        } else {
          view.retry?.remove();
          view.retry = void 0;
        }
      }
    }
    async function start() {
      safe(() => {
        if (queue?.running) return;
        const account = currentMailContext();
        if (!account)
          throw new Error(
            "\u0421\u0442\u0440\u0430\u043D\u0438\u0446\u0430 \u043F\u043E\u0447\u0442\u044B \u043D\u0435 \u0440\u0430\u0441\u043F\u043E\u0437\u043D\u0430\u043D\u0430. \u041E\u0442\u043A\u0440\u043E\u0439\u0442\u0435 Gmail \u0438\u043B\u0438 \u042F\u043D\u0434\u0435\u043A\u0441 \u041F\u043E\u0447\u0442\u0443; \u0434\u043B\u044F Gmail \u0434\u043E\u043B\u0436\u043D\u0430 \u0431\u044B\u0442\u044C \u0434\u043E\u0441\u0442\u0443\u043F\u043D\u0430 \u0438\u043D\u0444\u043E\u0440\u043C\u0430\u0446\u0438\u044F \u0442\u0435\u043A\u0443\u0449\u0435\u0433\u043E \u0430\u043A\u043A\u0430\u0443\u043D\u0442\u0430."
          );
        const letters = companies.filter((c) => selected.has(c.id)).map(letter);
        if (!letters.length) throw new Error("\u0412\u044B\u0431\u0435\u0440\u0438\u0442\u0435 \u043A\u043E\u043C\u043F\u0430\u043D\u0438\u0438.");
        transport?.clear();
        queueDelivery = deliverySelect.value;
        transport = new CurrentTabTransport(account, queueDelivery);
        queue = new Queue(letters, transport, update, queueDelivery === "draft");
        void execute(queue, transport);
      });
    }
    async function resumeQueue() {
      if (!queue || queue.running || !transport) return;
      await execute(queue, transport, true);
    }
    async function execute(q, t, retry = false) {
      try {
        if (!navigator.locks)
          throw new Error(
            "\u0411\u0440\u0430\u0443\u0437\u0435\u0440 \u043D\u0435 \u043F\u043E\u0434\u0434\u0435\u0440\u0436\u0438\u0432\u0430\u0435\u0442 \u0431\u043B\u043E\u043A\u0438\u0440\u043E\u0432\u043A\u0438 \u0432\u043A\u043B\u0430\u0434\u043E\u043A. \u0418\u0441\u043F\u043E\u043B\u044C\u0437\u0443\u0439\u0442\u0435 \u0440\u0443\u0447\u043D\u043E\u0435 \u043A\u043E\u043F\u0438\u0440\u043E\u0432\u0430\u043D\u0438\u0435."
          );
        await navigator.locks.request(
          "return-pd-controller",
          { ifAvailable: true },
          async (lock) => {
            if (!lock)
              throw new Error(
                "\u041E\u0447\u0435\u0440\u0435\u0434\u044C \u0443\u0436\u0435 \u0432\u044B\u043F\u043E\u043B\u043D\u044F\u0435\u0442\u0441\u044F \u0432 \u0434\u0440\u0443\u0433\u043E\u0439 \u0432\u043A\u043B\u0430\u0434\u043A\u0435 \u044D\u0442\u043E\u0439 \u043F\u043E\u0447\u0442\u044B."
              );
            collapseToDock();
            await q.run(retry);
          }
        );
      } catch (e) {
        error.textContent = e instanceof Error ? e.message : "\u041E\u0448\u0438\u0431\u043A\u0430 \u043E\u0447\u0435\u0440\u0435\u0434\u0438";
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
          profileStatus.textContent = "\u041D\u0435 \u0443\u0434\u0430\u043B\u043E\u0441\u044C \u0443\u0434\u0430\u043B\u0438\u0442\u044C \u0441\u043E\u0445\u0440\u0430\u043D\u0451\u043D\u043D\u044B\u0435 \u0434\u0430\u043D\u043D\u044B\u0435 \u0438\u0437 Tampermonkey. \u041F\u043E\u0432\u0442\u043E\u0440\u0438\u0442\u0435 \u043E\u0447\u0438\u0441\u0442\u043A\u0443 \u043F\u043E\u0441\u043B\u0435 \u0432\u043E\u0441\u0441\u0442\u0430\u043D\u043E\u0432\u043B\u0435\u043D\u0438\u044F \u0445\u0440\u0430\u043D\u0438\u043B\u0438\u0449\u0430.";
          return;
        }
      }
      sensitiveSince = Date.now();
      queue?.stop();
      transport?.clear();
      queue = void 0;
      if (clearSaved) {
        for (const [k, v] of inputs) v.value = k === "date" ? today() : "";
        profileStatus.className = "muted";
        profileStatus.textContent = "\u0421\u043E\u0445\u0440\u0430\u043D\u0451\u043D\u043D\u044B\u0435 \u0434\u0430\u043D\u043D\u044B\u0435 \u0443\u0434\u0430\u043B\u0435\u043D\u044B. \u041D\u043E\u0432\u044B\u0439 \u0432\u0432\u043E\u0434 \u0441\u043E\u0445\u0440\u0430\u043D\u044F\u0435\u0442\u0441\u044F \u0430\u0432\u0442\u043E\u043C\u0430\u0442\u0438\u0447\u0435\u0441\u043A\u0438.";
      }
      interactions.clear();
      interaction.value = "";
      templates.withdrawal = structuredClone(data_default.templates.withdrawal);
      templates.inquiry = structuredClone(data_default.templates.inquiry);
      selected.clear();
      if (clearSaved) store.delete(SETTINGS);
      if (clearSaved) {
        for (const key of store.keys()) {
          if (key.startsWith(PREFIX)) store.delete(key);
        }
      }
      if (clearSaved) {
        for (let i = 0; i < companies.length; i++)
          companies[i] = structuredClone(data_default.companies[i]);
      }
      current = companies[0];
      previewSelect.value = current.id;
      statusList.replaceChildren();
      resultRows.clear();
      progress.textContent = clearSaved ? "\u0414\u0430\u043D\u043D\u044B\u0435 \u0441\u043A\u0440\u0438\u043F\u0442\u0430 \u043E\u0447\u0438\u0449\u0435\u043D\u044B. \u0427\u0435\u0440\u043D\u043E\u0432\u0438\u043A\u0438 \u0432 \u043F\u043E\u0447\u0442\u0435 \u043D\u0435 \u0443\u0434\u0430\u043B\u0435\u043D\u044B." : "\u0412\u0440\u0435\u043C\u0435\u043D\u043D\u044B\u0435 \u0442\u0435\u043A\u0441\u0442\u044B \u0438 \u0440\u0435\u0437\u0443\u043B\u044C\u0442\u0430\u0442\u044B \u043E\u0447\u0438\u0449\u0435\u043D\u044B \u0447\u0435\u0440\u0435\u0437 24 \u0447\u0430\u0441\u0430. \u0421\u043E\u0445\u0440\u0430\u043D\u0451\u043D\u043D\u044B\u0435 \u0434\u0430\u043D\u043D\u044B\u0435 \u0444\u043E\u0440\u043C\u044B \u0438 \u043A\u0430\u0442\u0430\u043B\u043E\u0433 \u043E\u0441\u0442\u0430\u043B\u0438\u0441\u044C \u0432 \u0431\u0440\u0430\u0443\u0437\u0435\u0440\u0435.";
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
      inputs.get("fio").focus();
    }
    function refreshAccount() {
      const a = currentMailContext();
      accountTools.hidden = a?.useCurrentSession === true;
      if (a?.useCurrentSession) {
        accountNote.textContent = "\u042F\u043D\u0434\u0435\u043A\u0441 \u041F\u043E\u0447\u0442\u0430 \xB7 \u0442\u0435\u043A\u0443\u0449\u0430\u044F \u0441\u0435\u0441\u0441\u0438\u044F \u0431\u0440\u0430\u0443\u0437\u0435\u0440\u0430. \u041F\u0438\u0441\u044C\u043C\u0430 \u043E\u0442\u043A\u0440\u044B\u0432\u0430\u044E\u0442\u0441\u044F \u0438\u0437 \u0442\u0435\u043A\u0443\u0449\u0435\u0433\u043E \u044F\u0449\u0438\u043A\u0430; \u043E\u0442\u043F\u0440\u0430\u0432\u0438\u0442\u0435\u043B\u044C \u0443\u043A\u0430\u0437\u0430\u043D \u0432 \u0440\u0435\u0434\u0430\u043A\u0442\u043E\u0440\u0435 \u043F\u043E\u0447\u0442\u044B.";
        return;
      }
      accountNote.textContent = a ? `\u0410\u043A\u043A\u0430\u0443\u043D\u0442: ${a.email || "\u042F\u043D\u0434\u0435\u043A\u0441 ID (\u0438\u0434\u0435\u043D\u0442\u0438\u0444\u0438\u043A\u0430\u0442\u043E\u0440 \u0440\u0430\u0441\u043F\u043E\u0437\u043D\u0430\u043D)"} \xB7 ${a.provider === "gmail" ? "Gmail" : "\u042F\u043D\u0434\u0435\u043A\u0441 \u041F\u043E\u0447\u0442\u0430"}` : "\u0410\u043A\u043A\u0430\u0443\u043D\u0442 \u043F\u043E\u043A\u0430 \u043D\u0435 \u043E\u043F\u0440\u0435\u0434\u0435\u043B\u0451\u043D. \u0410\u0432\u0442\u043E\u043C\u0430\u0442\u0438\u0447\u0435\u0441\u043A\u0430\u044F \u0440\u0430\u0431\u043E\u0442\u0430 \u0441 \u0440\u0435\u0434\u0430\u043A\u0442\u043E\u0440\u043E\u043C \u043D\u0435\u0434\u043E\u0441\u0442\u0443\u043F\u043D\u0430; \u0440\u0443\u0447\u043D\u043E\u0435 \u043A\u043E\u043F\u0438\u0440\u043E\u0432\u0430\u043D\u0438\u0435 \u0440\u0430\u0431\u043E\u0442\u0430\u0435\u0442.";
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
          ...panel.querySelectorAll(
            "button,input,select,textarea,summary"
          )
        ].filter(
          (n) => !n.hasAttribute("disabled") && n.getClientRects().length > 0
        );
        const index = nodes.indexOf(root.activeElement);
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
      current = companies.find((c) => c.id === previewSelect.value);
      renderCard();
      preview();
    };
    modeSelect.onchange = () => {
      mode = modeSelect.value;
      loadTemplate();
      preview();
    };
    deliverySelect.onchange = preview;
    const onPageHide = () => {
      queue?.stop();
      transport?.clear();
    };
    window.addEventListener("pagehide", onPageHide);
    loadTemplate();
    renderCard();
    renderCompanies();
    preview();
    return {
      open,
      isAlive: () => surface.frame.isConnected && surface.frame.contentDocument === root.ownerDocument && root.isConnected,
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
      }
    };
  }
  var CSS = `
:host{all:initial;font:14px/1.5 system-ui,-apple-system,sans-serif;color:#213b33}*{box-sizing:border-box}[hidden]{display:none!important}button,input,select,textarea{font:inherit}button,summary{cursor:pointer}button{border:1px solid #cedad3;border-radius:8px;padding:8px 12px;background:#fff;color:#23483a}button:hover{background:#eef4ef}button:disabled{opacity:.5;cursor:not-allowed}input,textarea,select{width:100%;border:1px solid #cbd8d1;border-radius:8px;padding:9px 10px;background:#fff;color:#1b3329}textarea{resize:vertical}button:focus-visible,input:focus-visible,select:focus-visible,textarea:focus-visible,summary:focus-visible{outline:3px solid #8cb8a3;outline-offset:2px}label{display:block;font-size:12px;font-weight:600}label>input,label>select,label>textarea{display:block;margin-top:5px;font-weight:400}h1{font-size:28px;line-height:1.2;letter-spacing:-.8px;margin:6px 0}h2{font-size:16px;margin:22px 0 12px}p{margin:8px 0}small{display:block;font-size:11px;overflow-wrap:anywhere}pre{font:13px/1.7 system-ui;white-space:pre-wrap;overflow-wrap:anywhere;margin:12px 0;background:#fff;border:1px solid #dee5df;border-radius:10px;padding:18px;max-height:480px;overflow:auto}details{margin:12px 0}summary{font-weight:600;padding:8px 0}details>label{margin:10px 0}.launcher{position:fixed;right:24px;bottom:24px;z-index:2147483645;background:#204c3c;color:#fff;box-shadow:0 4px 20px #0002}.launcher:hover{background:#2f634f}.overlay{position:fixed;inset:0;z-index:2147483646;background:#12251cc2;padding:24px;overflow:auto}.panel{max-width:1240px;margin:0 auto;background:#f7f9f5;border:1px solid #d6dfd7;border-radius:18px;padding:28px;box-shadow:0 24px 90px #0004}.panel header{display:flex;justify-content:space-between;align-items:flex-start;gap:16px}.queue-dock{margin:8px;padding:12px 14px;background:#f7f9f5;border:1px solid #d6dfd7;border-radius:12px;box-shadow:0 4px 20px #0002;display:flex;flex-direction:column;max-height:176px;overflow:hidden}.queue-dock p{margin:0 0 6px}.queue-dock .dock-progress{font-weight:650;flex-shrink:0}.queue-dock .muted{font-size:12px;overflow-wrap:anywhere;overflow:auto;min-height:0}.queue-dock .toolbar{margin:8px 0 0;flex-shrink:0}.queue-dock button{padding:6px 10px}.eyebrow{font-size:10px;letter-spacing:2px;color:#517b67;font-weight:700}.muted{color:#65766b;font-weight:400}.account{background:#e8f0e8;padding:9px 12px;border-radius:8px}.tabs{max-width:420px;margin-top:18px}.layout{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1.1fr);gap:32px}.fields{display:grid;grid-template-columns:1fr 1fr;gap:10px}.toolbar{display:flex;gap:8px;flex-wrap:wrap;margin:10px 0}.company-list{max-height:390px;overflow:auto;border:1px solid #dbe3dc;border-radius:10px;background:#fff}.company{display:flex;align-items:flex-start;gap:12px;padding:12px;border-bottom:1px solid #e8ece8}.company:last-child{border-bottom:0}.company>input{width:16px;height:16px;margin-top:7px;accent-color:#245740}.company-name{border:0;padding:0;background:none;text-align:left;font-weight:650}.badge{display:inline-block;font-size:10px;font-weight:600;border-radius:5px;background:#e9eee4;padding:3px 6px;margin:5px 0}.note{padding:12px;background:#f3f0e4;color:#68582b;border-radius:9px;font-size:12px}.preview-title{font-weight:650;font-size:15px}.primary{background:#204c3c;color:white;border-color:#204c3c}.primary:hover{background:#32614b}.ghost{background:transparent}.error{color:#a52c29;white-space:pre-wrap}.panel footer{display:flex;align-items:center;gap:10px;flex-wrap:wrap;border-top:1px solid #d5dfd6;padding-top:20px;margin-top:24px}.panel footer>span{margin-right:auto}.progress{margin-top:16px;font-weight:600}.results{display:grid;gap:10px}.result{background:white;border:1px solid #dbe2db;border-radius:9px;padding:12px}.result>strong{margin-right:12px}.result details button{margin:4px}.result pre{max-height:200px}@media(max-width:800px){.layout{grid-template-columns:1fr}.overlay{padding:8px}.panel{padding:16px}.fields{grid-template-columns:1fr 1fr}.launcher{right:12px;bottom:12px}}@media(prefers-reduced-motion:no-preference){button{transition:background .15s}}`;

  // src/startup.ts
  function startApplication() {
    const ui = mountUI();
    const cleanup = () => {
      try {
        cleanExpired(store);
      } catch {
        ui.report(
          "\u041A\u043D\u043E\u043F\u043A\u0430 \u0433\u043E\u0442\u043E\u0432\u0430, \u043D\u043E \u0445\u0440\u0430\u043D\u0438\u043B\u0438\u0449\u0435 Tampermonkey \u043D\u0435\u0434\u043E\u0441\u0442\u0443\u043F\u043D\u043E. \u0410\u0432\u0442\u043E\u043C\u0430\u0442\u0438\u0447\u0435\u0441\u043A\u0430\u044F \u043F\u043E\u0434\u0433\u043E\u0442\u043E\u0432\u043A\u0430 \u043F\u0438\u0441\u0435\u043C \u043C\u043E\u0436\u0435\u0442 \u0431\u044B\u0442\u044C \u043D\u0435\u0434\u043E\u0441\u0442\u0443\u043F\u043D\u0430."
        );
      }
    };
    cleanup();
    const timer = setInterval(cleanup, 6e4);
    const ready = runWorker().catch(() => {
      ui.report(
        "\u041D\u0435 \u0443\u0434\u0430\u043B\u043E\u0441\u044C \u0432\u043E\u0441\u0441\u0442\u0430\u043D\u043E\u0432\u0438\u0442\u044C \u0437\u0430\u0434\u0430\u043D\u0438\u0435 \u044D\u0442\u043E\u0439 \u0432\u043A\u043B\u0430\u0434\u043A\u0438. \u041F\u0430\u043D\u0435\u043B\u044C \u0434\u043E\u0441\u0442\u0443\u043F\u043D\u0430 \u043F\u043E \u043A\u043D\u043E\u043F\u043A\u0435 \u043D\u0438\u0436\u0435."
      );
    });
    return {
      ready,
      dispose() {
        clearInterval(timer);
        ui.dispose();
      }
    };
  }

  // src/main.ts
  startApplication();
})();
