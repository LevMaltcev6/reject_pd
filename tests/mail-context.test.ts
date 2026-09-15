import { test } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { currentMailContext, matchesMailContext } from "../src/adapters";

test("Yandex current session never queries profile or message DOM", () => {
  const unreadable = {
    querySelectorAll() {
      throw Error("DOM must not be queried");
    },
  } as unknown as Document;
  const ctx = currentMailContext(
    unreadable,
    "https://mail.yandex.ru/?foo=bar#inbox",
  )!;
  assert.deepEqual(ctx, {
    provider: "yandex",
    email: "",
    baseUrl: "https://mail.yandex.ru/",
    useCurrentSession: true,
  });
  assert.equal(
    matchesMailContext(
      ctx,
      unreadable,
      "https://mail.yandex.ru/?pd_task=123#compose",
    ),
    true,
  );
});
test("Yandex session remains restricted to the original allowed HTTPS origin", () => {
  const dom = new JSDOM("<body></body>");
  const doc = dom.window.document;
  const ctx = currentMailContext(doc, "https://mail.yandex.ru/")!;
  for (const href of [
    "https://mail.yandex.com/",
    "http://mail.yandex.ru/",
    "https://mail.yandex.ru.evil.example/",
    "https://mail.yandex.ru:8443/",
    "https://passport.yandex.ru/",
  ])
    assert.equal(matchesMailContext(ctx, doc, href), false, href);
  assert.equal(currentMailContext(doc, "http://mail.yandex.ru/"), null);
  assert.equal(currentMailContext(doc, "https://mail.yandex.ru:8443/"), null);
  assert.equal(
    matchesMailContext(
      { ...ctx, baseUrl: "https://evil.example/" },
      doc,
      "https://evil.example/",
    ),
    false,
  );
  dom.window.close();
});
test("Gmail still requires the same identified mailbox", () => {
  const dom = new JSDOM(
    '<a aria-label="Google Account: first@example.org"></a>',
  );
  const doc = dom.window.document;
  const ctx = currentMailContext(doc, "https://mail.google.com/mail/u/0/")!;
  assert.equal(ctx.email, "first@example.org");
  doc
    .querySelector("a")!
    .setAttribute("aria-label", "Google Account: second@example.org");
  assert.equal(
    matchesMailContext(ctx, doc, "https://mail.google.com/mail/u/0/"),
    false,
  );
  doc.body.replaceChildren();
  assert.equal(
    currentMailContext(doc, "https://mail.google.com/mail/u/0/"),
    null,
  );
  dom.window.close();
});
