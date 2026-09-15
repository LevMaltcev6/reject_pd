// ==UserScript==
// @name         Возврат ПД — подготовка обращений
// @namespace    return-pd.local
// @version      0.1.5
// @description  Подготовка отдельных писем по вашим шаблонам. Отправка только вручную.
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
// @grant        GM_openInTab
// @grant        GM_registerMenuCommand
// @grant        GM_setClipboard
// ==/UserScript==
"use strict";
(() => {
  // src/queue.ts
  var Queue = class {
    constructor(letters, transport, changed) {
      this.transport = transport;
      this.changed = changed;
      this.items = letters.map((letter) => ({
        id: crypto.randomUUID(),
        letter,
        status: "queued"
      }));
    }
    items;
    running = false;
    controller = new AbortController();
    stop() {
      this.controller.abort();
    }
    async run(retry = false) {
      if (this.running) return;
      this.running = true;
      this.controller = new AbortController();
      this.changed();
      try {
        for (const item of this.items) {
          if (this.controller.signal.aborted) break;
          if (item.status !== "queued" && !(retry && item.status === "error" && !item.attempted))
            continue;
          item.status = "opening";
          item.error = void 0;
          this.changed();
          try {
            await this.transport.prepare(item.letter, this.controller.signal);
            item.status = item.letter.missing.length || item.letter.actions.length ? "manual" : "filled";
          } catch (error) {
            item.status = "error";
            item.error = error instanceof Error ? error.message : "\u041D\u0435 \u0443\u0434\u0430\u043B\u043E\u0441\u044C \u043F\u043E\u0434\u0433\u043E\u0442\u043E\u0432\u0438\u0442\u044C \u043F\u0438\u0441\u044C\u043C\u043E.";
            item.attempted = error instanceof AttemptedError;
            this.changed();
            break;
          }
          this.changed();
        }
      } finally {
        this.running = false;
        this.changed();
      }
    }
  };
  var AttemptedError = class extends Error {
  };
  var PREFIX = "return-pd:job:";
  var TTL = 24 * 60 * 60 * 1e3;
  function cleanExpired(store2, now = Date.now()) {
    for (const key of store2.keys().filter((k) => k.startsWith(PREFIX))) {
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
      version: "0.1.5",
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

  // src/adapters.ts
  var emailPattern2 = /[A-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
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
        for (const match2 of str?.match(emailPattern2) || [])
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
  async function waitFor(get, signal, timeout = 2e4) {
    const until = Date.now() + timeout;
    while (Date.now() < until) {
      signal.throwIfAborted();
      const value = get();
      if (value) return value;
      await new Promise((r) => setTimeout(r, 150));
    }
    throw new Error(
      "\u041F\u043E\u0447\u0442\u043E\u0432\u044B\u0439 \u0438\u043D\u0442\u0435\u0440\u0444\u0435\u0439\u0441 \u043D\u0435 \u0433\u043E\u0442\u043E\u0432 \u0438\u043B\u0438 \u0438\u0437\u043C\u0435\u043D\u0438\u043B\u0441\u044F. \u0418\u0441\u043F\u043E\u043B\u044C\u0437\u0443\u0439\u0442\u0435 \u0440\u0443\u0447\u043D\u043E\u0435 \u043A\u043E\u043F\u0438\u0440\u043E\u0432\u0430\u043D\u0438\u0435."
    );
  }
  function one(selector, root = document) {
    const nodes = [...root.querySelectorAll(selector)].filter(visible);
    return nodes.length === 1 ? nodes[0] : null;
  }
  function setInput(el2, value) {
    if (!(el2 instanceof HTMLInputElement || el2 instanceof HTMLTextAreaElement))
      throw new Error("\u041D\u0435 \u043D\u0430\u0439\u0434\u0435\u043D\u043E \u0442\u0435\u043A\u0441\u0442\u043E\u0432\u043E\u0435 \u043F\u043E\u043B\u0435.");
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
    const chips = root.querySelectorAll(
      provider === "gmail" ? "[email], [data-hovercard-id]" : '.composeYabble, .composeYabbles .nb-yabble, [data-testid="recipient-chip"]'
    );
    return [
      ...new Set(
        [...chips].flatMap(
          (e) => [
            e.getAttribute("email"),
            e.getAttribute("data-hovercard-id"),
            e.getAttribute("data-email"),
            e.getAttribute("title"),
            e.textContent
          ].flatMap((s) => s?.match(emailPattern2) || [])
        ).map((s) => s.toLowerCase())
      )
    ].sort();
  }
  async function fillLetter(account, letter, signal, stillActive = () => true) {
    const guard = () => {
      signal.throwIfAborted();
      if (!stillActive()) throw new Error("\u0417\u0430\u0434\u0430\u043D\u0438\u0435 \u043E\u0442\u043C\u0435\u043D\u0435\u043D\u043E.");
      if (!matchesMailContext(account))
        throw new Error(
          "\u0421\u0442\u0440\u0430\u043D\u0438\u0446\u0430 \u043F\u043E\u0447\u0442\u044B \u0438\u0437\u043C\u0435\u043D\u0438\u043B\u0430\u0441\u044C \u0438\u043B\u0438 \u043D\u0435\u0434\u043E\u0441\u0442\u0443\u043F\u043D\u0430 \u0434\u043B\u044F \u044D\u0442\u043E\u0433\u043E \u0437\u0430\u0434\u0430\u043D\u0438\u044F. \u041F\u043E\u0434\u0433\u043E\u0442\u043E\u0432\u043A\u0430 \u043E\u0441\u0442\u0430\u043D\u043E\u0432\u043B\u0435\u043D\u0430."
        );
    };
    await waitFor(() => matchesMailContext(account), signal);
    guard();
    if ([...document.querySelectorAll(bodies[account.provider])].some(visible))
      throw new Error("\u0412\u043E \u0432\u043A\u043B\u0430\u0434\u043A\u0435 \u0443\u0436\u0435 \u043E\u0442\u043A\u0440\u044B\u0442 \u0440\u0435\u0434\u0430\u043A\u0442\u043E\u0440. \u041E\u043D \u043D\u0435 \u0431\u0443\u0434\u0435\u0442 \u0438\u0437\u043C\u0435\u043D\u0451\u043D.");
    const button2 = await waitFor(() => composeButton(account.provider), signal);
    guard();
    button2.click();
    const body = await waitFor(() => one(bodies[account.provider]), signal);
    guard();
    const root = account.provider === "gmail" ? body.closest('[role="dialog"]') || body.closest("form") : body.closest(
      '.ComposePopup, .composeReact, .compose, [data-testid="compose"]'
    );
    if (!root)
      throw new Error("\u041D\u0435 \u0443\u0434\u0430\u043B\u043E\u0441\u044C \u0431\u0435\u0437\u043E\u043F\u0430\u0441\u043D\u043E \u043E\u043F\u0440\u0435\u0434\u0435\u043B\u0438\u0442\u044C \u0440\u0435\u0434\u0430\u043A\u0442\u043E\u0440 \u043F\u0438\u0441\u044C\u043C\u0430.");
    const subject = one(
      account.provider === "gmail" ? 'input[name="subjectbox"]' : 'input[name="subject"], .composeTextField[name="subj"], input[name="subj"]',
      root
    );
    if (!(subject instanceof HTMLInputElement))
      throw new Error("\u041D\u0435 \u043D\u0430\u0439\u0434\u0435\u043D\u043E \u043F\u043E\u043B\u0435 \u0442\u0435\u043C\u044B.");
    if (subject.value.trim() || recipientAddresses(root, account.provider).length)
      throw new Error("\u0420\u0435\u0434\u0430\u043A\u0442\u043E\u0440 \u0441\u043E\u0434\u0435\u0440\u0436\u0438\u0442 \u0434\u0430\u043D\u043D\u044B\u0435. \u0418\u0437\u043C\u0435\u043D\u0435\u043D\u0438\u044F \u043D\u0435 \u0432\u043D\u0435\u0441\u0435\u043D\u044B.");
    const signature = body.querySelector(
      ".gmail_signature, .mail-Signature, .compose-signature"
    );
    if (body.textContent?.trim() && body.textContent.trim() !== signature?.textContent?.trim())
      throw new Error("\u0420\u0435\u0434\u0430\u043A\u0442\u043E\u0440 \u0443\u0436\u0435 \u0441\u043E\u0434\u0435\u0440\u0436\u0438\u0442 \u0442\u0435\u043A\u0441\u0442. \u0418\u0437\u043C\u0435\u043D\u0435\u043D\u0438\u044F \u043D\u0435 \u0432\u043D\u0435\u0441\u0435\u043D\u044B.");
    const originalSignature = signature?.textContent?.trim() || "";
    for (const address of letter.to) {
      guard();
      const recipient = one(
        account.provider === "gmail" ? 'input[name="to"], textarea[name="to"], input[role="combobox"][aria-label="To recipients"], input[role="combobox"][aria-label="\u041F\u043E\u043B\u0443\u0447\u0430\u0442\u0435\u043B\u0438"]' : '.composeYabbles input, input[name="to"]',
        root
      );
      if (!recipient) throw new Error("\u041D\u0435 \u043D\u0430\u0439\u0434\u0435\u043D\u043E \u043E\u0434\u043D\u043E\u0437\u043D\u0430\u0447\u043D\u043E\u0435 \u043F\u043E\u043B\u0435 \u043F\u043E\u043B\u0443\u0447\u0430\u0442\u0435\u043B\u0435\u0439.");
      recipient.focus();
      setInput(recipient, address);
      enter(recipient);
      await waitFor(
        () => recipientAddresses(root, account.provider).includes(
          address.toLowerCase()
        ),
        signal,
        5e3
      );
    }
    guard();
    setInput(subject, letter.subject);
    const text = letter.body + (originalSignature ? `

${originalSignature}` : "");
    body.focus();
    body.replaceChildren(document.createTextNode(text));
    body.style.whiteSpace = "pre-wrap";
    body.dispatchEvent(
      new InputEvent("input", {
        bubbles: true,
        inputType: "insertText",
        data: text
      })
    );
    body.dispatchEvent(new Event("change", { bubbles: true }));
    body.blur();
    subject.blur();
    await new Promise((r) => setTimeout(r, 500));
    guard();
    const actual = recipientAddresses(root, account.provider);
    const expected = [...new Set(letter.to.map((s) => s.toLowerCase()))].sort();
    if (JSON.stringify(actual) !== JSON.stringify(expected) || subject.value !== letter.subject || body.textContent !== text)
      throw new Error(
        "\u041F\u043E\u043B\u044F \u043D\u0435 \u043F\u0440\u043E\u0448\u043B\u0438 \u043F\u0440\u043E\u0432\u0435\u0440\u043A\u0443. \u041F\u0440\u043E\u0432\u0435\u0440\u044C\u0442\u0435 \u043F\u0438\u0441\u044C\u043C\u043E \u0432\u0440\u0443\u0447\u043D\u0443\u044E; \u043F\u043E\u0432\u0442\u043E\u0440 \u0430\u0432\u0442\u043E\u043C\u0430\u0442\u0438\u0447\u0435\u0441\u043A\u0438 \u043D\u0435 \u0441\u043E\u0437\u0434\u0430\u0451\u0442\u0441\u044F."
      );
  }

  // src/transport.ts
  var store = {
    get: (key) => GM_getValue(key),
    set: (key, value) => GM_setValue(key, value),
    delete: (key) => GM_deleteValue(key),
    keys: () => GM_listValues()
  };
  var pause = () => new Promise((r) => setTimeout(r, 250));
  var BrowserTransport = class {
    constructor(account) {
      this.account = account;
    }
    owner = crypto.randomUUID();
    keys = /* @__PURE__ */ new Set();
    clear() {
      for (const key of this.keys) store.delete(key);
      this.keys.clear();
    }
    async prepare(letter, signal) {
      signal.throwIfAborted();
      if (!matchesMailContext(this.account))
        throw new Error(
          "\u0418\u0441\u0445\u043E\u0434\u043D\u0430\u044F \u0432\u043A\u043B\u0430\u0434\u043A\u0430 \u043F\u043E\u0447\u0442\u044B \u0438\u0437\u043C\u0435\u043D\u0438\u043B\u0430\u0441\u044C. \u041E\u0442\u043A\u0440\u043E\u0439\u0442\u0435 \u043F\u0430\u043D\u0435\u043B\u044C \u0432 \u043D\u0443\u0436\u043D\u043E\u0439 \u043F\u043E\u0447\u0442\u0435 \u0437\u0430\u043D\u043E\u0432\u043E."
        );
      const id = crypto.randomUUID();
      const key = PREFIX + id;
      const now = Date.now();
      const job = {
        id,
        owner: this.owner,
        created: now,
        expires: now + TTL,
        account: this.account,
        letter,
        state: "waiting"
      };
      store.set(key, job);
      this.keys.add(key);
      const url = new URL(this.account.baseUrl);
      url.searchParams.set("pd_task", id);
      let opened = false;
      try {
        const tab = GM_openInTab(url.href, {
          active: true,
          insert: true,
          setParent: true
        });
        if (!tab) throw new Error("Tampermonkey \u043D\u0435 \u043E\u0442\u043A\u0440\u044B\u043B \u0432\u043A\u043B\u0430\u0434\u043A\u0443.");
        opened = true;
        const deadline = Date.now() + 9e4;
        while (Date.now() < deadline) {
          signal.throwIfAborted();
          const current = store.get(key);
          if (!current) throw new Error("\u0417\u0430\u0434\u0430\u043D\u0438\u0435 \u043E\u0447\u0438\u0449\u0435\u043D\u043E \u0438\u043B\u0438 \u043E\u0442\u043C\u0435\u043D\u0435\u043D\u043E.");
          if (current.state === "done") return;
          if (current.state === "error")
            throw new Error(current.error || "\u041E\u0448\u0438\u0431\u043A\u0430 \u0437\u0430\u043F\u043E\u043B\u043D\u0435\u043D\u0438\u044F.");
          if (tab.closed) throw new Error("\u0412\u043A\u043B\u0430\u0434\u043A\u0430 \u0437\u0430\u043A\u0440\u044B\u0442\u0430.");
          await pause();
        }
        throw new Error("\u0412\u043A\u043B\u0430\u0434\u043A\u0430 \u043D\u0435 \u043F\u043E\u0434\u0442\u0432\u0435\u0440\u0434\u0438\u043B\u0430 \u0437\u0430\u043F\u043E\u043B\u043D\u0435\u043D\u0438\u0435 \u0437\u0430 90 \u0441\u0435\u043A\u0443\u043D\u0434.");
      } catch (error) {
        const message = signal.aborted ? "\u041E\u0447\u0435\u0440\u0435\u0434\u044C \u043E\u0441\u0442\u0430\u043D\u043E\u0432\u043B\u0435\u043D\u0430. \u041F\u0440\u043E\u0432\u0435\u0440\u044C\u0442\u0435 \u0443\u0436\u0435 \u043E\u0442\u043A\u0440\u044B\u0442\u0443\u044E \u0432\u043A\u043B\u0430\u0434\u043A\u0443." : error instanceof Error ? error.message : "\u041E\u0448\u0438\u0431\u043A\u0430 \u043F\u043E\u0434\u0433\u043E\u0442\u043E\u0432\u043A\u0438.";
        if (opened) throw new AttemptedError(message);
        throw new Error(message);
      } finally {
        store.delete(key);
        this.keys.delete(key);
      }
    }
  };
  async function runWorker() {
    const url = new URL(location.href);
    const id = url.searchParams.get("pd_task");
    if (!id) return false;
    url.searchParams.delete("pd_task");
    history.replaceState(history.state, "", url.href);
    if (!/^[\da-f-]{36}$/.test(id)) return true;
    if (!navigator.locks) {
      showWorkerNote(
        "\u0411\u0440\u0430\u0443\u0437\u0435\u0440 \u043D\u0435 \u043F\u043E\u0434\u0434\u0435\u0440\u0436\u0438\u0432\u0430\u0435\u0442 \u0431\u043B\u043E\u043A\u0438\u0440\u043E\u0432\u043A\u0438 \u0432\u043A\u043B\u0430\u0434\u043E\u043A. \u0418\u0441\u043F\u043E\u043B\u044C\u0437\u0443\u0439\u0442\u0435 \u0440\u0443\u0447\u043D\u043E\u0435 \u043A\u043E\u043F\u0438\u0440\u043E\u0432\u0430\u043D\u0438\u0435.",
        []
      );
      return true;
    }
    await navigator.locks.request(
      "return-pd-worker-" + id,
      { ifAvailable: true },
      async (lock) => {
        if (lock) await consumeJob(id);
      }
    );
    return true;
  }
  async function consumeJob(id) {
    const key = PREFIX + id;
    const job = store.get(key);
    if (!job || job.expires <= Date.now() || job.state !== "waiting") return;
    store.set(key, { ...job, state: "claimed" });
    const abort = new AbortController();
    const watcher = setInterval(() => {
      const current = store.get(key);
      if (!current || current.expires <= Date.now()) abort.abort();
    }, 200);
    try {
      await fillLetter(
        job.account,
        job.letter,
        abort.signal,
        () => store.get(key)?.state === "claimed"
      );
      if (store.get(key)) store.set(key, { ...job, state: "done" });
      showWorkerNote("\u041F\u043E\u043B\u044F \u0437\u0430\u043F\u043E\u043B\u043D\u0435\u043D\u044B. \u041F\u0440\u043E\u0432\u0435\u0440\u044C\u0442\u0435 \u043F\u0438\u0441\u044C\u043C\u043E; \u043E\u0442\u043F\u0440\u0430\u0432\u043A\u0430 \u2014 \u0432\u0440\u0443\u0447\u043D\u0443\u044E.", [
        ...job.letter.missing.map((s) => `\u041D\u0435 \u0437\u0430\u043F\u043E\u043B\u043D\u0435\u043D\u043E: ${s}`),
        ...job.letter.actions
      ]);
    } catch {
      const error = "\u0410\u043A\u043A\u0430\u0443\u043D\u0442 \u0438\u043B\u0438 \u043F\u043E\u043B\u044F \u043D\u0435 \u043F\u0440\u043E\u0448\u043B\u0438 \u043F\u0440\u043E\u0432\u0435\u0440\u043A\u0443. \u0412\u0435\u0440\u043D\u0438\u0442\u0435\u0441\u044C \u0432 \u043F\u0430\u043D\u0435\u043B\u044C: \u043F\u0438\u0441\u044C\u043C\u043E \u043C\u043E\u0436\u043D\u043E \u0441\u043A\u043E\u043F\u0438\u0440\u043E\u0432\u0430\u0442\u044C \u0432\u0440\u0443\u0447\u043D\u0443\u044E.";
      if (store.get(key)) store.set(key, { ...job, state: "error", error });
      showWorkerNote(error, []);
    } finally {
      clearInterval(watcher);
    }
  }
  function showWorkerNote(title, notes) {
    const host = document.createElement("div");
    document.body.append(host);
    const root = host.attachShadow({ mode: "closed" });
    const box = document.createElement("aside");
    box.style.cssText = "position:fixed;right:16px;bottom:90px;z-index:2147483646;background:#fff;color:#172b26;border:1px solid #b0c8be;border-radius:12px;padding:16px;font:14px/1.5 system-ui;max-width:380px;box-shadow:0 8px 32px #0003;max-height:45vh;overflow:auto";
    const heading = document.createElement("strong");
    heading.textContent = title;
    box.append(heading);
    for (const note of notes) {
      const p = document.createElement("p");
      p.textContent = note;
      box.append(p);
    }
    const close = document.createElement("button");
    close.textContent = "\u0421\u043A\u0440\u044B\u0442\u044C";
    close.onclick = () => host.remove();
    box.append(close);
    root.append(box);
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
        withdrawalExtra: ""
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
        withdrawalExtra: ""
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
        withdrawalExtra: ""
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
        withdrawalExtra: "\u0412 \u043F\u0443\u043D\u043A\u0442\u0435 11 \u0417\u0430\u043A\u043B\u044E\u0447\u0438\u0442\u0435\u043B\u044C\u043D\u044B\u0435 \u043F\u043E\u043B\u043E\u0436\u0435\u043D\u0438\u044F \u041F\u041E\u041B\u0418\u0422\u0418\u041A\u0418 \u0432 \u043E\u0442\u043D\u043E\u0448\u0435\u043D\u0438\u0438 \u043E\u0431\u0440\u0430\u0431\u043E\u0442\u043A\u0438 \u043F\u0435\u0440\u0441\u043E\u043D\u0430\u043B\u044C\u043D\u044B\u0445 \u0434\u0430\u043D\u043D\u044B\u0445 \u0432 \u041E\u041E\u041E \xAB\u0421\u0431\u0435\u0440\u0431\u0430\u043D\u043A-\u0422\u0435\u043B\u0435\u043A\u043E\u043C\xBB \u0432 \u043A\u043E\u043D\u0442\u0430\u043A\u0442\u043D\u043E\u0439 \u0438\u043D\u0444\u043E\u0440\u043C\u0430\u0446\u0438\u0438 \u0443\u043A\u0430\u0437\u0430\u043D\u044B \u0434\u0432\u0430 \u0432\u0438\u0434\u0430 \u0441\u0432\u044F\u0437\u0438, \u0430 \u0438\u043C\u0435\u043D\u043D\u043E: \u044D\u043B\u0435\u043A\u0442\u0440\u043E\u043D\u043D\u0430\u044F \u043F\u043E\u0447\u0442\u0430 \u0438 \u043F\u043E\u0447\u0442\u043E\u0432\u044B\u0439 \u0430\u0434\u0440\u0435\u0441.\n\n\xAB\u041B\u044E\u0431\u044B\u0435 \u043E\u0431\u0440\u0430\u0449\u0435\u043D\u0438\u044F, \u043A\u0430\u0441\u0430\u044E\u0449\u0438\u0435\u0441\u044F \u043E\u0431\u0440\u0430\u0431\u043E\u0442\u043A\u0438 \u041F\u0414\u043D, \u043D\u0430\u043F\u0440\u0430\u0432\u043B\u044F\u044E\u0442\u0441\u044F \u041E\u0431\u0449\u0435\u0441\u0442\u0432\u0443 \u043D\u0430 \u044D\u043B\u0435\u043A\u0442\u0440\u043E\u043D\u043D\u0443\u044E \u043F\u043E\u0447\u0442\u0443: privacy@sberbank-tele.com, \u043B\u0438\u0431\u043E \u043D\u0430 \u043F\u043E\u0447\u0442\u043E\u0432\u044B\u0439 \u0430\u0434\u0440\u0435\u0441: 117997, \u0433. \u041C\u043E\u0441\u043A\u0432\u0430, \u0443\u043B. \u0412\u0430\u0432\u0438\u043B\u043E\u0432\u0430, \u0434. 19\xBB.\n\n\u041F\u0440\u043E\u0448\u0443 \u0440\u0430\u0441\u0441\u043C\u043E\u0442\u0440\u0435\u0442\u044C \u043C\u043E\u0451 \u043E\u0431\u0440\u0430\u0449\u0435\u043D\u0438\u0435 \u0432 \u044D\u043B\u0435\u043A\u0442\u0440\u043E\u043D\u043D\u043E\u043C \u0432\u0438\u0434\u0435"
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
        withdrawalExtra: ""
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
        withdrawalExtra: ""
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
        withdrawalExtra: ""
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
        withdrawalExtra: ""
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
        withdrawalExtra: ""
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
        withdrawalExtra: ""
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
        withdrawalExtra: ""
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
        withdrawalExtra: ""
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
        withdrawalExtra: ""
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
        withdrawalExtra: ""
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
        withdrawalExtra: ""
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
        withdrawalExtra: ""
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
        withdrawalExtra: ""
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
        withdrawalExtra: ""
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
        withdrawalExtra: ""
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
        withdrawalExtra: ""
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
        withdrawalExtra: ""
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
        withdrawalExtra: ""
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
        withdrawalExtra: ""
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
        withdrawalExtra: ""
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
        withdrawalExtra: ""
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
        withdrawalExtra: ""
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
        withdrawalExtra: ""
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
    for (const [key, label] of Object.entries({
      inn: "\u0418\u041D\u041D \u0437\u0430\u044F\u0432\u0438\u0442\u0435\u043B\u044F",
      phone: "\u0422\u0435\u043B\u0435\u0444\u043E\u043D",
      series: "\u0421\u0435\u0440\u0438\u044F \u043F\u0430\u0441\u043F\u043E\u0440\u0442\u0430",
      number: "\u041D\u043E\u043C\u0435\u0440 \u043F\u0430\u0441\u043F\u043E\u0440\u0442\u0430",
      issuer: "\u041A\u0435\u043C \u0432\u044B\u0434\u0430\u043D \u043F\u0430\u0441\u043F\u043E\u0440\u0442",
      city: "\u0413\u043E\u0440\u043E\u0434 \u0432\u044B\u0434\u0430\u0447\u0438",
      issued: "\u0414\u0430\u0442\u0430 \u0432\u044B\u0434\u0430\u0447\u0438"
    })) {
      if (!p[key].trim()) missing.push(label);
    }
    if (!c.legalName?.trim())
      missing.push("\u042E\u0440\u0438\u0434\u0438\u0447\u0435\u0441\u043A\u043E\u0435 \u043D\u0430\u0438\u043C\u0435\u043D\u043E\u0432\u0430\u043D\u0438\u0435 \u043E\u0440\u0433\u0430\u043D\u0438\u0437\u0430\u0446\u0438\u0438");
    if (!c.inn?.trim()) missing.push("\u0418\u041D\u041D \u043E\u0440\u0433\u0430\u043D\u0438\u0437\u0430\u0446\u0438\u0438");
    if (!c.ogrn?.trim()) missing.push("\u041E\u0413\u0420\u041D \u043E\u0440\u0433\u0430\u043D\u0438\u0437\u0430\u0446\u0438\u0438");
    if (mode === "inquiry" && !interaction.trim())
      missing.push("\u0421\u0432\u0435\u0434\u0435\u043D\u0438\u044F \u043E \u0432\u0437\u0430\u0438\u043C\u043E\u0434\u0435\u0439\u0441\u0442\u0432\u0438\u0438 / \u043E\u0431\u0440\u0430\u0431\u043E\u0442\u043A\u0435 \u0434\u0430\u043D\u043D\u044B\u0445");
    const header = [
      values["\u041A\u043E\u043C\u043F\u0430\u043D\u0438\u044F"],
      [c.inn && `\u0418\u041D\u041D ${c.inn}`, c.ogrn && `\u041E\u0413\u0420\u041D ${c.ogrn}`].filter(Boolean).join(", "),
      "",
      `\u043E\u0442 ${values["\u0424\u0418\u041E"]}`
    ];
    if (p.inn.trim()) header.push(`\u0418\u041D\u041D ${p.inn.trim()}`);
    const passport = [
      p.series && `\u0441\u0435\u0440\u0438\u044F ${p.series}`,
      p.number && `\u2116 ${p.number}`,
      p.issuer && `\u0432\u044B\u0434\u0430\u043D ${p.issuer}`,
      p.city,
      p.issued
    ].filter(Boolean).join(", ");
    if (passport) header.push(`\u041F\u0430\u0441\u043F\u043E\u0440\u0442: ${passport}`);
    header.push(`e-mail: ${values.Email}`);
    if (p.phone.trim()) header.push(`\u0422\u0435\u043B\u0435\u0444\u043E\u043D: ${p.phone.trim()}`);
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
      header.filter((x, i) => x || i === 2).join("\n"),
      title,
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
    const label = "\u2197 \u041E\u0431\u0440\u0430\u0449\u0435\u043D\u0438\u044F \u043F\u043E \u041F\u0414 \xB7 0.1.5";
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
        "\u041E\u0431\u0440\u0430\u0449\u0435\u043D\u0438\u044F \u043F\u043E \u041F\u0414 \xB7 0.1.5 \u2014 \u043E\u0442\u043A\u0440\u044B\u0442\u044C",
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

  // src/ui.ts
  var SETTINGS = "return-pd:catalog-v1";
  var labels = {
    queued: "\u0412 \u043E\u0447\u0435\u0440\u0435\u0434\u0438",
    opening: "\u041E\u0442\u043A\u0440\u044B\u0432\u0430\u0435\u0442\u0441\u044F",
    filled: "\u041F\u043E\u043B\u044F \u0437\u0430\u043F\u043E\u043B\u043D\u0435\u043D\u044B",
    manual: "\u0422\u0440\u0435\u0431\u0443\u0435\u0442\u0441\u044F \u0434\u043E\u0440\u0430\u0431\u043E\u0442\u043A\u0430",
    error: "\u041E\u0448\u0438\u0431\u043A\u0430"
  };
  var profileFields = [
    ["fio", "\u0424\u0418\u041E *", "text"],
    ["email", "Email \u0434\u043B\u044F \u043E\u0442\u0432\u0435\u0442\u0430 *", "email"],
    ["inn", "\u0418\u041D\u041D \u0437\u0430\u044F\u0432\u0438\u0442\u0435\u043B\u044F", "text"],
    ["phone", "\u0422\u0435\u043B\u0435\u0444\u043E\u043D", "tel"],
    ["series", "\u0421\u0435\u0440\u0438\u044F \u043F\u0430\u0441\u043F\u043E\u0440\u0442\u0430", "text"],
    ["number", "\u041D\u043E\u043C\u0435\u0440 \u043F\u0430\u0441\u043F\u043E\u0440\u0442\u0430", "text"],
    ["issuer", "\u041A\u0435\u043C \u0432\u044B\u0434\u0430\u043D \u043F\u0430\u0441\u043F\u043E\u0440\u0442", "text"],
    ["city", "\u0413\u043E\u0440\u043E\u0434 \u0432\u044B\u0434\u0430\u0447\u0438", "text"],
    ["issued", "\u0414\u0430\u0442\u0430 \u0432\u044B\u0434\u0430\u0447\u0438", "date"],
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
    panel.setAttribute("aria-label", "\u041F\u043E\u0434\u0433\u043E\u0442\u043E\u0432\u043A\u0430 \u043E\u0431\u0440\u0430\u0449\u0435\u043D\u0438\u0439 \u043F\u043E \u041F\u0414");
    overlay.append(panel);
    root.append(overlay);
    const header = el("header");
    const heading = el("div");
    heading.append(
      el("span", "\u041B\u041E\u041A\u0410\u041B\u042C\u041D\u042B\u0419 \u041F\u041E\u041C\u041E\u0429\u041D\u0418\u041A", "eyebrow"),
      el("h1", "\u041E\u0431\u0440\u0430\u0449\u0435\u043D\u0438\u044F \u043F\u043E \u041F\u0414"),
      el(
        "p",
        "\u041F\u043E\u0434\u0433\u043E\u0442\u043E\u0432\u044C\u0442\u0435 \u043F\u0438\u0441\u044C\u043C\u0430. \u041F\u0440\u043E\u0432\u0435\u0440\u044C\u0442\u0435 \u0438 \u043E\u0442\u043F\u0440\u0430\u0432\u044C\u0442\u0435 \u0438\u0445 \u0438\u0437 \u0441\u0432\u043E\u0435\u0439 \u043F\u043E\u0447\u0442\u044B.",
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
    panel.append(tabs);
    const layout = el("div", void 0, "layout");
    panel.append(layout);
    const left = el("div");
    const right = el("div");
    layout.append(left, right);
    left.append(el("h2", "1. \u0412\u0430\u0448\u0438 \u0434\u0430\u043D\u043D\u044B\u0435"));
    const profileForm = el("div", void 0, "fields");
    left.append(profileForm);
    const inputs = /* @__PURE__ */ new Map();
    for (const [key, label, type] of profileFields) {
      const input = el("input");
      input.type = type;
      input.autocomplete = "off";
      input.name = key;
      if (key === "date") input.value = today();
      inputs.set(key, input);
      profileForm.append(field(label, input));
      input.oninput = schedulePreview;
      input.addEventListener("compositionend", () => schedulePreview());
    }
    left.append(
      el(
        "p",
        "\u0414\u0430\u043D\u043D\u044B\u0435 \u0444\u043E\u0440\u043C\u044B \u0438 \u0438\u0437\u043C\u0435\u043D\u0435\u043D\u0438\u044F \u0442\u0435\u043A\u0441\u0442\u0430 \u0438\u0441\u043F\u043E\u043B\u044C\u0437\u0443\u044E\u0442\u0441\u044F \u0442\u043E\u043B\u044C\u043A\u043E \u0432 \u0442\u0435\u043A\u0443\u0449\u0435\u0439 \u0441\u0435\u0441\u0441\u0438\u0438. \u041F\u043E\u0434\u043F\u0438\u0441\u0438 \u0438 \u0432\u043B\u043E\u0436\u0435\u043D\u0438\u044F \u0434\u043E\u0431\u0430\u0432\u043B\u044F\u044E\u0442\u0441\u044F \u0432\u0440\u0443\u0447\u043D\u0443\u044E.",
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
        for (const key of ["legalName", "inn", "ogrn"])
          if (typeof s[key] === "string") c[key] = s[key];
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
    card.append(el("summary", "\u0420\u0435\u043A\u0432\u0438\u0437\u0438\u0442\u044B \u0438 \u043F\u0440\u0438\u043C\u0435\u0447\u0430\u043D\u0438\u044F \u043A\u043E\u043C\u043F\u0430\u043D\u0438\u0438"));
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
        "\u041F\u043E\u0434\u0441\u0442\u0430\u043D\u043E\u0432\u043A\u0438: {{\u0424\u0418\u041E}}, {{\u041A\u043E\u043C\u043F\u0430\u043D\u0438\u044F}}, {{Email}}, {{\u0414\u0430\u0442\u0430}}. \u0428\u0430\u043F\u043A\u0430, \u0434\u0430\u0442\u0430 \u0438 \u0441\u043F\u0435\u0446\u0438\u0430\u043B\u044C\u043D\u044B\u0435 \u0438\u043D\u0441\u0442\u0440\u0443\u043A\u0446\u0438\u0438 \u0434\u043E\u0431\u0430\u0432\u043B\u044F\u044E\u0442\u0441\u044F \u043E\u0442\u0434\u0435\u043B\u044C\u043D\u043E.",
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
    const launch = button("\u041F\u043E\u0434\u0433\u043E\u0442\u043E\u0432\u0438\u0442\u044C \u043F\u0438\u0441\u044C\u043C\u0430", () => void start(), "primary");
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
    const clear = button("\u041E\u0447\u0438\u0441\u0442\u0438\u0442\u044C \u0434\u0430\u043D\u043D\u044B\u0435", () => reset(), "ghost");
    footer.append(count, launch, stop, resume, clear);
    panel.append(footer);
    const progress = el("div", void 0, "progress");
    progress.setAttribute("aria-live", "polite");
    panel.append(progress);
    const statusList = el("div", void 0, "results");
    panel.append(statusList);
    let queue;
    let transport;
    const live = el("p", "", "muted");
    live.setAttribute("aria-live", "polite");
    panel.append(live);
    let sensitiveSince = Date.now();
    const expiryTimer = setInterval(() => {
      if (Date.now() - sensitiveSince >= TTL) {
        reset();
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
      return Object.fromEntries(
        [...inputs].map(([k, v]) => [k, v.value.trim()])
      );
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
          legalName: c.legalName,
          inn: c.inn,
          ogrn: c.ogrn,
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
      for (const [key, label] of [
        ["legalName", "\u042E\u0440\u0438\u0434\u0438\u0447\u0435\u0441\u043A\u043E\u0435 \u043D\u0430\u0438\u043C\u0435\u043D\u043E\u0432\u0430\u043D\u0438\u0435"],
        ["inn", "\u0418\u041D\u041D \u043E\u0440\u0433\u0430\u043D\u0438\u0437\u0430\u0446\u0438\u0438"],
        ["ogrn", "\u041E\u0413\u0420\u041D \u043E\u0440\u0433\u0430\u043D\u0438\u0437\u0430\u0446\u0438\u0438"],
        ["emails", "Email \u043F\u043E\u043B\u0443\u0447\u0430\u0442\u0435\u043B\u0435\u0439 \u0447\u0435\u0440\u0435\u0437 \u0437\u0430\u043F\u044F\u0442\u0443\u044E"]
      ]) {
        const input = el("input");
        input.value = key === "emails" ? current.emails.join(", ") : current[key] || "";
        input.oninput = () => {
          if (key === "emails")
            current.emails = input.value.split(/[,;]/).map((s) => s.trim()).filter(Boolean);
          else current[key] = input.value.trim();
          saveCatalog();
          schedulePreview();
        };
        companyFields.append(field(label, input));
      }
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
      launch.textContent = `\u041F\u043E\u0434\u0433\u043E\u0442\u043E\u0432\u0438\u0442\u044C ${selected.size} \u043F\u0438\u0441\u0435\u043C`;
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
      resume.hidden = !queue || running || !queue.items.some(
        (i) => i.status === "queued" || i.status === "error" && !i.attempted
      );
      for (const input of layout.querySelectorAll("input,select,textarea"))
        input.disabled = running;
      modeSelect.disabled = running;
      statusList.replaceChildren();
      if (!queue) return;
      const done = queue.items.filter(
        (i) => i.status === "manual" || i.status === "filled"
      ).length;
      progress.textContent = `\u041F\u043E\u0434\u0433\u043E\u0442\u043E\u0432\u043B\u0435\u043D\u043E ${done} \u0438\u0437 ${queue.items.length}. ${running ? "\u041D\u0435 \u0437\u0430\u043A\u0440\u044B\u0432\u0430\u0439\u0442\u0435 \u0438\u0441\u0445\u043E\u0434\u043D\u0443\u044E \u0432\u043A\u043B\u0430\u0434\u043A\u0443." : "\u041E\u0447\u0435\u0440\u0435\u0434\u044C \u043D\u0435 \u0432\u044B\u043F\u043E\u043B\u043D\u044F\u0435\u0442\u0441\u044F."}`;
      for (const item of queue.items) {
        const row = el("div", void 0, "result");
        row.append(
          el("strong", item.letter.companyName),
          el("span", labels[item.status], "badge")
        );
        if (item.error) row.append(el("p", item.error, "error"));
        const detail = el("details");
        detail.append(
          el("summary", "\u041F\u0438\u0441\u044C\u043C\u043E \u0438 \u0440\u0443\u0447\u043D\u044B\u0435 \u0434\u0435\u0439\u0441\u0442\u0432\u0438\u044F"),
          el("p", `\u041A\u043E\u043C\u0443: ${item.letter.to.join(", ")}`),
          el("p", item.letter.subject),
          el("pre", item.letter.body)
        );
        for (const s of [
          ...item.letter.missing.map((s2) => `\u041D\u0435 \u0437\u0430\u043F\u043E\u043B\u043D\u0435\u043D\u043E: ${s2}`),
          ...item.letter.actions
        ])
          detail.append(el("p", s));
        for (const [name, text] of [
          ["\u0430\u0434\u0440\u0435\u0441\u0430", item.letter.to.join(", ")],
          ["\u0442\u0435\u043C\u0443", item.letter.subject],
          ["\u0442\u0435\u043A\u0441\u0442", item.letter.body]
        ])
          detail.append(
            button(`\u041A\u043E\u043F\u0438\u0440\u043E\u0432\u0430\u0442\u044C ${name}`, () => GM_setClipboard(text), "ghost")
          );
        row.append(detail);
        if (item.status === "error" && item.attempted && !running)
          row.append(
            button(
              "\u041F\u043E\u0432\u0442\u043E\u0440\u0438\u0442\u044C \u043F\u043E\u0441\u043B\u0435 \u043F\u0440\u043E\u0432\u0435\u0440\u043A\u0438 \u0432\u043A\u043B\u0430\u0434\u043A\u0438",
              () => {
                if (window.confirm(
                  "\u0423\u0431\u0435\u0434\u0438\u0442\u0435\u0441\u044C, \u0447\u0442\u043E \u043F\u0440\u043E\u0448\u043B\u043E\u0435 \u043F\u0438\u0441\u044C\u043C\u043E \u043D\u0435 \u043E\u0442\u043F\u0440\u0430\u0432\u043B\u0435\u043D\u043E, \u0438 \u0437\u0430\u043A\u0440\u043E\u0439\u0442\u0435 \u0435\u0433\u043E \u0447\u0435\u0440\u043D\u043E\u0432\u0438\u043A, \u0435\u0441\u043B\u0438 \u043F\u043E\u0432\u0442\u043E\u0440 \u0431\u043E\u043B\u044C\u0448\u0435 \u043D\u0435 \u043D\u0443\u0436\u0435\u043D. \u041F\u043E\u0432\u0442\u043E\u0440 \u0441\u043E\u0437\u0434\u0430\u0441\u0442 \u043D\u043E\u0432\u043E\u0435 \u043F\u0438\u0441\u044C\u043C\u043E. \u0421\u043E\u0437\u0434\u0430\u0442\u044C?"
                )) {
                  item.attempted = false;
                  item.status = "queued";
                  void resumeQueue();
                }
              },
              "ghost"
            )
          );
        statusList.append(row);
      }
      preview();
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
        transport = new BrowserTransport(account);
        queue = new Queue(letters, transport, update);
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
            await q.run(retry);
          }
        );
      } catch (e) {
        error.textContent = e instanceof Error ? e.message : "\u041E\u0448\u0438\u0431\u043A\u0430 \u043E\u0447\u0435\u0440\u0435\u0434\u0438";
        error.hidden = false;
      } finally {
        t.clear();
      }
    }
    function reset() {
      sensitiveSince = Date.now();
      queue?.stop();
      transport?.clear();
      queue = void 0;
      for (const [k, v] of inputs) v.value = k === "date" ? today() : "";
      interactions.clear();
      interaction.value = "";
      templates.withdrawal = structuredClone(data_default.templates.withdrawal);
      templates.inquiry = structuredClone(data_default.templates.inquiry);
      selected.clear();
      store.delete(SETTINGS);
      for (const key of store.keys()) {
        if (key.startsWith(PREFIX)) store.delete(key);
      }
      for (let i = 0; i < companies.length; i++)
        companies[i] = structuredClone(data_default.companies[i]);
      current = companies[0];
      previewSelect.value = current.id;
      statusList.replaceChildren();
      progress.textContent = "\u0414\u0430\u043D\u043D\u044B\u0435 \u0441\u043A\u0440\u0438\u043F\u0442\u0430 \u043E\u0447\u0438\u0449\u0435\u043D\u044B. \u0427\u0435\u0440\u043D\u043E\u0432\u0438\u043A\u0438 \u0432 \u043F\u043E\u0447\u0442\u0435 \u043D\u0435 \u0443\u0434\u0430\u043B\u0435\u043D\u044B.";
      loadTemplate();
      renderCard();
      renderCompanies();
      preview();
      update();
    }
    function open() {
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
      accountNote.textContent = a ? `\u0410\u043A\u043A\u0430\u0443\u043D\u0442: ${a.email || "\u042F\u043D\u0434\u0435\u043A\u0441 ID (\u0438\u0434\u0435\u043D\u0442\u0438\u0444\u0438\u043A\u0430\u0442\u043E\u0440 \u0440\u0430\u0441\u043F\u043E\u0437\u043D\u0430\u043D)"} \xB7 ${a.provider === "gmail" ? "Gmail" : "\u042F\u043D\u0434\u0435\u043A\u0441 \u041F\u043E\u0447\u0442\u0430"}` : "\u0410\u043A\u043A\u0430\u0443\u043D\u0442 \u043F\u043E\u043A\u0430 \u043D\u0435 \u043E\u043F\u0440\u0435\u0434\u0435\u043B\u0451\u043D. \u041F\u043E\u0434\u0433\u043E\u0442\u043E\u0432\u043A\u0430 \u0432\u043A\u043B\u0430\u0434\u043E\u043A \u043D\u0435\u0434\u043E\u0441\u0442\u0443\u043F\u043D\u0430; \u0440\u0443\u0447\u043D\u043E\u0435 \u043A\u043E\u043F\u0438\u0440\u043E\u0432\u0430\u043D\u0438\u0435 \u0440\u0430\u0431\u043E\u0442\u0430\u0435\u0442.";
    }
    function close() {
      overlay.hidden = true;
      surface.expand(false);
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
:host{all:initial;font:14px/1.5 system-ui,-apple-system,sans-serif;color:#213b33}*{box-sizing:border-box}[hidden]{display:none!important}button,input,select,textarea{font:inherit}button,summary{cursor:pointer}button{border:1px solid #cedad3;border-radius:8px;padding:8px 12px;background:#fff;color:#23483a}button:hover{background:#eef4ef}button:disabled{opacity:.5;cursor:not-allowed}input,textarea,select{width:100%;border:1px solid #cbd8d1;border-radius:8px;padding:9px 10px;background:#fff;color:#1b3329}textarea{resize:vertical}button:focus-visible,input:focus-visible,select:focus-visible,textarea:focus-visible,summary:focus-visible{outline:3px solid #8cb8a3;outline-offset:2px}label{display:block;font-size:12px;font-weight:600}label>input,label>select,label>textarea{display:block;margin-top:5px;font-weight:400}h1{font-size:28px;line-height:1.2;letter-spacing:-.8px;margin:6px 0}h2{font-size:16px;margin:22px 0 12px}p{margin:8px 0}small{display:block;font-size:11px;overflow-wrap:anywhere}pre{font:13px/1.7 system-ui;white-space:pre-wrap;overflow-wrap:anywhere;margin:12px 0;background:#fff;border:1px solid #dee5df;border-radius:10px;padding:18px;max-height:480px;overflow:auto}details{margin:12px 0}summary{font-weight:600;padding:8px 0}details>label{margin:10px 0}.launcher{position:fixed;right:24px;bottom:24px;z-index:2147483645;background:#204c3c;color:#fff;box-shadow:0 4px 20px #0002}.launcher:hover{background:#2f634f}.overlay{position:fixed;inset:0;z-index:2147483646;background:#12251cc2;padding:24px;overflow:auto}.panel{max-width:1240px;margin:0 auto;background:#f7f9f5;border:1px solid #d6dfd7;border-radius:18px;padding:28px;box-shadow:0 24px 90px #0004}.panel header{display:flex;justify-content:space-between;align-items:flex-start;gap:16px}.eyebrow{font-size:10px;letter-spacing:2px;color:#517b67;font-weight:700}.muted{color:#65766b;font-weight:400}.account{background:#e8f0e8;padding:9px 12px;border-radius:8px}.tabs{max-width:420px;margin-top:18px}.layout{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1.1fr);gap:32px}.fields{display:grid;grid-template-columns:1fr 1fr;gap:10px}.toolbar{display:flex;gap:8px;flex-wrap:wrap;margin:10px 0}.company-list{max-height:390px;overflow:auto;border:1px solid #dbe3dc;border-radius:10px;background:#fff}.company{display:flex;align-items:flex-start;gap:12px;padding:12px;border-bottom:1px solid #e8ece8}.company:last-child{border-bottom:0}.company>input{width:16px;height:16px;margin-top:7px;accent-color:#245740}.company-name{border:0;padding:0;background:none;text-align:left;font-weight:650}.badge{display:inline-block;font-size:10px;font-weight:600;border-radius:5px;background:#e9eee4;padding:3px 6px;margin:5px 0}.note{padding:12px;background:#f3f0e4;color:#68582b;border-radius:9px;font-size:12px}.preview-title{font-weight:650;font-size:15px}.primary{background:#204c3c;color:white;border-color:#204c3c}.primary:hover{background:#32614b}.ghost{background:transparent}.error{color:#a52c29;white-space:pre-wrap}.panel footer{display:flex;align-items:center;gap:10px;flex-wrap:wrap;border-top:1px solid #d5dfd6;padding-top:20px;margin-top:24px}.panel footer>span{margin-right:auto}.progress{margin-top:16px;font-weight:600}.results{display:grid;gap:10px}.result{background:white;border:1px solid #dbe2db;border-radius:9px;padding:12px}.result>strong{margin-right:12px}.result details button{margin:4px}.result pre{max-height:200px}@media(max-width:800px){.layout{grid-template-columns:1fr}.overlay{padding:8px}.panel{padding:16px}.fields{grid-template-columns:1fr 1fr}.launcher{right:12px;bottom:12px}}@media(prefers-reduced-motion:no-preference){button{transition:background .15s}}`;

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
