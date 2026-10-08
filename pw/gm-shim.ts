// GM_* shim source injected into the isolated Playwright browser together with
// the userscript bundle (design TD-002). Storage is backed by the persistent
// profile's localStorage so the synchronous Tampermonkey contract holds:
// startApplication() calls cleanExpired(store)/runWorker() synchronously at boot.

/** Mail hosts where the plugin may activate. Mirror of the userscript @match
 * header (scripts/build.mjs); keep both lists in sync. */
export const MAIL_HOSTS = [
  "mail.yandex.ru",
  "mail.yandex.com",
  "mail.yandex.by",
  "mail.yandex.kz",
  "mail.google.com",
] as const;

/** localStorage key wrapper: isolates plugin keys from the mail site's own
 * localStorage entries on the same origin. */
export const GM_STORAGE_PREFIX = "__returnPD::";

function normalizeHost(host: string): string {
  return host.trim().toLowerCase();
}

/** Guard deciding whether the init script may run: top frame only (@noframes)
 * and only on the mail hosts from the @match header. */
export function shouldActivate(host: string, isTopFrame: boolean): boolean {
  if (!isTopFrame) return false;
  return (MAIL_HOSTS as readonly string[]).includes(normalizeHost(host));
}

/** Standalone JS source installing the GM_* globals on `window`. Evaluated in
 * the page before the userscript bundle runs. */
export const gmShimSource = String.raw`
(function (window) {
  "use strict";
  var PREFIX = "__returnPD::";
  function wrapped(key) {
    return PREFIX + key;
  }
  function parse(text) {
    try {
      return JSON.parse(text);
    } catch (error) {
      return undefined;
    }
  }
  window.GM_getValue = function (key, defaultValue) {
    var text = window.localStorage.getItem(wrapped(key));
    if (text === null) return defaultValue;
    var value = parse(text);
    return value === undefined ? defaultValue : value;
  };
  window.GM_setValue = function (key, value) {
    window.localStorage.setItem(wrapped(key), JSON.stringify(value));
  };
  window.GM_deleteValue = function (key) {
    window.localStorage.removeItem(wrapped(key));
  };
  window.GM_listValues = function () {
    var keys = [];
    for (var i = 0; i < window.localStorage.length; i++) {
      var stored = window.localStorage.key(i);
      if (stored !== null && stored.indexOf(PREFIX) === 0) {
        keys.push(stored.slice(PREFIX.length));
      }
    }
    return keys;
  };
  window.GM_registerMenuCommand = function () {};
  window.GM_setClipboard = function (text) {
    try {
      window.navigator.clipboard.writeText(String(text)).catch(function () {});
    } catch (error) {
      // Clipboard without a user gesture or API may reject silently.
    }
  };
  window.unsafeWindow = window;
})(globalThis);
`;
