import { test } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { yandexAccount, yandexDiagnostics } from "../src/yandex-account";
import { sameAccount } from "../src/adapters";
const url = new URL("https://mail.yandex.ru/");
function read(html: string) {
  const d = new JSDOM(html);
  try {
    return yandexAccount(d.window.document, url);
  } finally {
    d.window.close();
  }
}
test("Yandex reads email on parent account control and avatar title", () => {
  assert.equal(
    read(
      '<a class="user-account" title="Иван (test@yandex.ru)"><span class="user-account__name">Иван</span></a>',
    )?.email,
    "test@yandex.ru",
  );
  assert.equal(
    read('<img class="user-pic__image" alt="test@yandex.ru">')?.email,
    "test@yandex.ru",
  );
});
test("explicit login is an identity, display names are not", () => {
  assert.equal(
    read('<span class="user-account__login">test.login</span>')?.email,
    "test.login@yandex.ru",
  );
  assert.equal(read('<span class="user-account__name">Ivan</span>'), null);
  assert.equal(
    read('<span class="user-account" data-login="employee@example.org"></span>')
      ?.email,
    "employee@example.org",
  );
});
test("Yandex domain aliases resolve to the same account", () => {
  const a = read(
    '<span class="user-account__login">test</span><span class="user-account__name">test@ya.ru</span>',
  );
  assert.equal(a?.email, "test@yandex.ru");
});
test("current profile UID works without exposing an email and detects switching", () => {
  const a = read(
    '<a class="user-account" href="https://passport.yandex.ru/profile?uid=123"><span>Иван</span></a>',
  )!;
  assert.equal(a.uid, "123");
  assert.equal(a.email, "");
  assert.equal(
    sameAccount(
      a,
      read('<span class="user-account" data-uid="123">Иван</span>'),
    ),
    true,
  );
  assert.equal(
    sameAccount(
      a,
      read('<span class="user-account" data-uid="124">Иван</span>'),
    ),
    false,
  );
  assert.equal(
    read(
      '<a class="user-account" href="https://evil.example/profile?uid=123">Иван</a>',
    ),
    null,
  );
});
test("message addresses, hidden accounts and switcher choices are excluded", () => {
  const a = read(
    '<p>other@example.org</p><span class="user-account__name">test@yandex.ru</span><div hidden><span class="user-account__login">other</span></div><div role="listbox"><span class="user-account__login">third</span></div>',
  );
  assert.equal(a?.email, "test@yandex.ru");
  assert.equal(
    read(
      '<span class="user-account__login">first</span><span class="user-account__login">second</span>',
    ),
    null,
  );
});
test("diagnostics do not contain identity, email, cookies, or message contents", () => {
  const dom = new JSDOM(
    '<p>private message</p><span class="user-account__name secret-value" title="test@yandex.ru" data-uid="12345">test@yandex.ru</span>',
  );
  const text = JSON.stringify(yandexDiagnostics(dom.window.document));
  assert.doesNotMatch(text, /test@yandex|12345|private message|secret-value/);
  assert.match(text, /data-uid/);
  dom.window.close();
});
