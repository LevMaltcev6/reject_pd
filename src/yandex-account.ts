import type { Account } from "./types";

const controls =
  '.mail-User-Name, .mail-User, .user-account, .user-account__name, .user-account__login, .user-pic, .user-pic__image, [data-testid="user-account"], .legouser__current-account';
const emailPattern = /[A-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
const knownYandexDomain = /^(yandex\.(ru|com|by|kz)|ya\.ru)$/i;
function normalizeEmail(email: string) {
  const [login, domain] = email.toLowerCase().split("@");
  return `${login}@${knownYandexDomain.test(domain) ? "yandex.ru" : domain}`;
}
function active(el: Element, doc: Document) {
  for (let p: Element | null = el; p; p = p.parentElement) {
    if (p.hasAttribute("hidden") || p.getAttribute("aria-hidden") === "true")
      return false;
    const style = doc.defaultView?.getComputedStyle(p);
    if (style?.display === "none" || style?.visibility === "hidden")
      return false;
  }
  return !el.closest(
    '.legouser__accounts, [role="listbox"], [data-testid="account-switcher"]',
  );
}
export function yandexAccount(doc: Document, url: URL): Account | null {
  const emails = new Set<string>();
  const uids = new Set<string>();
  for (const el of doc.querySelectorAll(controls)) {
    if (!active(el, doc)) continue;
    for (const text of [
      el.getAttribute("data-email"),
      el.getAttribute("aria-label"),
      el.getAttribute("title"),
      el.getAttribute("alt"),
      el.textContent,
    ]) {
      for (const email of text?.match(emailPattern) || [])
        emails.add(normalizeEmail(email));
    }
    // Only explicit login fields. A display name such as "Ivan" is NOT a login.
    const login =
      el.getAttribute("data-login") ||
      (el.matches(".user-account__login") ? el.textContent?.trim() : null);
    if (login && /^[a-z0-9][a-z0-9._-]*$/i.test(login))
      emails.add(`${login.toLowerCase()}@yandex.ru`);
    else if (login && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(login))
      emails.add(normalizeEmail(login));
    const uid = el.getAttribute("data-uid");
    if (uid && /^\d+$/.test(uid)) uids.add(uid);
    // Read a profile link only from the current-account control, not arbitrary mail links.
    const anchor = el.matches("a[href]") ? el : el.closest("a[href]");
    if (anchor) {
      try {
        const href = new URL(anchor.getAttribute("href")!, url);
        if (
          /^(passport|id)\.yandex\.(ru|com|by|kz)$/.test(href.hostname) &&
          /^\/profile\/?$/.test(href.pathname)
        ) {
          const id = href.searchParams.get("uid");
          if (id && /^\d+$/.test(id)) uids.add(id);
        }
      } catch {
        /* A malformed link is not identity evidence. */
      }
    }
  }
  if (uids.size > 1 || emails.size > 1) return null;
  if (!uids.size && !emails.size) return null;
  return {
    provider: "yandex",
    email: [...emails][0] || "",
    uid: [...uids][0],
    baseUrl: `${url.origin}/`,
  };
}

/** Deliberately no attribute values, cookies, message text or account identifiers. */
export function yandexDiagnostics(doc: Document) {
  return {
    version: "0.2.10",
    controls: [...doc.querySelectorAll(controls)].map((el) => ({
      tag: el.tagName,
      active: active(el, doc),
      selectors: controls
        .split(", ")
        .filter((selector) => el.matches(selector)),
      attributes: [
        "title",
        "aria-label",
        "data-login",
        "data-email",
        "data-uid",
        "alt",
      ].filter((a) => el.hasAttribute(a)),
      textHasEmail: !!(el.textContent || "").match(emailPattern),
    })),
  };
}
