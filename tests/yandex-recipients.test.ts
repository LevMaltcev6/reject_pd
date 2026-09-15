import { test } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import {
  resolveYandexTo,
  yandexRecipientAddresses,
  yandexHasPendingRecipient,
} from "../src/yandex-recipients";

const visible = (element: Element) =>
  !element.closest('[hidden], [aria-hidden="true"], [style*="display:none"]');

function fixture(html: string) {
  const dom = new JSDOM(`<!doctype html><body>${html}</body>`);
  return { dom, root: dom.window.document.body };
}

test("observed Yandex To wrapper resolves its contenteditable with visible copy fields", () => {
  const { dom, root } = fixture(`
    <div class="MultipleAddressesDesktop ComposeRecipients-MultipleAddressField ComposeRecipients-ToField tst-field-to">
      <label for="compose-field-4">To</label>
      <div class="MultipleAddressesDesktop-Field ComposeYabblesField" role="combobox">
        <div contenteditable="true" spellcheck="false" is="x-bubbles" class="composeYabbles" data-selection="true" data-class-bubble="yabble-compose js-yabble" data-separator id="compose-field-4" title="To" aria-label="To" role="textbox" aria-controls=":a11y-compose-listbox" aria-expanded="false"></div>
      </div>
    </div>
    <div><label for="copy">Cc</label><div id="copy" class="composeYabbles" contenteditable="true"></div></div>
    <div><label for="hidden-copy">Bcc</label><div id="hidden-copy" class="composeYabbles" contenteditable="true"></div></div>
  `);
  assert.equal(
    resolveYandexTo(root, visible),
    root.querySelector("#compose-field-4"),
  );
  dom.window.close();
});

for (const markup of [
  '<input id="target" name="to">',
  '<textarea id="target" name="to"></textarea>',
  '<div id="target" contenteditable="true" aria-label="Кому:"></div>',
  '<label for="target">Кому</label><textarea id="target"></textarea>',
  '<span id="to-label">To</span><input id="target" aria-labelledby="to-label">',
  '<div class="ComposeRecipients-ToField"><input id="target"></div>',
  '<div class="tst-field-to"><div id="target" contenteditable="plaintext-only"></div></div>',
]) {
  test(`semantic To discovery supports ${markup}`, () => {
    const { dom, root } = fixture(
      `${markup}<input name="cc"><input name="bcc"><input name="subject">`,
    );
    assert.equal(resolveYandexTo(root, visible), root.querySelector("#target"));
    dom.window.close();
  });
}

test("a precise To wins over generic fields, but two actual To controls remain ambiguous", () => {
  const { dom, root } = fixture(
    '<input name="to" id="target"><div class="composeYabbles"><input></div>',
  );
  assert.equal(resolveYandexTo(root, visible), root.querySelector("#target"));
  root.insertAdjacentHTML(
    "beforeend",
    '<textarea aria-label="Кому"></textarea>',
  );
  assert.equal(resolveYandexTo(root, visible), null);
  dom.window.close();
});

test("generic Yandex fallback requires exactly one supported editable control", () => {
  const { dom, root } = fixture(
    '<div class="composeYabbles"><textarea id="target"></textarea></div>',
  );
  assert.equal(resolveYandexTo(root, visible), root.querySelector("#target"));
  root.insertAdjacentHTML(
    "beforeend",
    '<div class="composeYabbles" contenteditable="true"></div>',
  );
  assert.equal(resolveYandexTo(root, visible), null);
  dom.window.close();
});

test("hidden, disabled, readonly, sender, body and copy fields are excluded", () => {
  const { dom, root } = fixture(`
    <div hidden><input name="to"></div>
    <div aria-hidden="true"><input name="to"></div>
    <input name="to" disabled><input name="to" readonly>
    <fieldset disabled><input name="to"></fieldset>
    <div aria-disabled="true"><div aria-label="To" contenteditable="true"></div></div>
    <input type="hidden" name="to"><input name="from" class="composeYabbles">
    <div class="composeReact-MBody"><div class="composeYabbles" contenteditable="true"></div></div>
    <div class="composeYabbles"><input name="cc"><input aria-label="Скрытая копия"></div>
    <input name="subject" class="composeYabbles">
    <input id="target" name="to">
  `);
  assert.equal(resolveYandexTo(root, visible), root.querySelector("#target"));
  root.querySelector("#target")!.remove();
  assert.equal(resolveYandexTo(root, visible), null);
  dom.window.close();
});

test("committed Yandex chips are deduplicated; raw editor and sender emails are ignored", () => {
  const { dom, root } = fixture(`
    <div class="composeYabbles" contenteditable="true" aria-label="To">
      <span class="yabble-compose js-yabble" data-email="FIRST@example.org" title="FIRST@example.org"><span>Первый</span></span>
      <span class="js-yabble" data-value="second@example.org">second@example.org</span>
      pending@example.org
    </div>
    <span class="composeYabble" email="third@example.org">Третий</span>
    <div class="composeYabbles"><span class="nb-yabble" data-hovercard-id="fourth@example.org">Четвёртый</span></div>
    <span data-testid="recipient-chip" title="fifth@example.org">Пятый</span>
    <div class="composeReact-MBody"><span class="js-yabble">body@example.org</span></div>
    <div class="ComposeRecipients-FromField"><span class="js-yabble">sender@example.org</span></div>
    <div>unrelated@example.org</div>
  `);
  assert.deepEqual(yandexRecipientAddresses(root), [
    "fifth@example.org",
    "first@example.org",
    "fourth@example.org",
    "second@example.org",
    "third@example.org",
  ]);
  assert.equal(yandexHasPendingRecipient(root, visible), true);
  dom.window.close();
});

test("committed chips, nested remove labels and zero-width editor scaffolding are not pending text", () => {
  const { dom, root } = fixture(`
    <div contenteditable="true" aria-label="Кому" class="composeYabbles">
      <span class="yabble-compose js-yabble" contenteditable="false" data-email="saved@example.org">Имя <button>Удалить</button></span>
      <span>\u200b\u200c\u200d\u2060\ufeff&nbsp;</span><br>
    </div>
  `);
  assert.deepEqual(yandexRecipientAddresses(root), ["saved@example.org"]);
  assert.equal(yandexHasPendingRecipient(root, visible), false);
  root.querySelector("[contenteditable=true]")!.append("незавершённый адрес");
  assert.equal(yandexHasPendingRecipient(root, visible), true);
  dom.window.close();
});

test("observed Yandex bubble is committed and preserved while trailing entry text remains pending", () => {
  const { dom, root } = fixture(`
    <div class="ComposeRecipients-ToField">
      <div class="composeYabbles" contenteditable="true" aria-label="To">
        <span data-email="first@example.invalid" class="js-yabble yabble-compose" bubble contenteditable="false" draggable="true">
          <div class="ComposeYabble ComposeYabble_editable" contenteditable="false" tabindex="0">
            <div class="Text Text_typography_body-short-m ComposeYabble-Text">first@example.invalid</div>
            <button aria-label="Удалить">×</button>
          </div>
        </span>
        \u200b
      </div>
    </div>
  `);
  const original = root.innerHTML;
  assert.deepEqual(yandexRecipientAddresses(root), ["first@example.invalid"]);
  assert.equal(yandexHasPendingRecipient(root, visible), false);
  assert.equal(
    resolveYandexTo(root, visible),
    root.querySelector(".composeYabbles"),
  );
  assert.equal(root.innerHTML, original);
  root.querySelector(".composeYabbles")!.append("second@example.invalid");
  assert.equal(yandexHasPendingRecipient(root, visible), true);
  assert.deepEqual(yandexRecipientAddresses(root), ["first@example.invalid"]);
  dom.window.close();
});

test("observed Yandex sender bubble is excluded while To and copy recipient bubbles are counted", () => {
  const { dom, root } = fixture(`
    <div class="ComposeAddressFrom">
      <div class="ComposeAddressFrom-Field" title="From" tabindex="0" role="button" aria-haspopup="menu">
        <div class="ComposeAddressFrom-Content" tabindex="-1">
          <span class="js-yabble yabble-compose" data-email="sender@example.invalid">sender@example.invalid</span>
        </div>
      </div>
    </div>
    <div class="ComposeRecipients-ToField">
      <div class="composeYabbles" contenteditable="true" aria-label="To"></div>
    </div>
  `);
  assert.deepEqual(yandexRecipientAddresses(root), []);
  assert.equal(yandexHasPendingRecipient(root, visible), false);
  const to = root.querySelector(".composeYabbles")!;
  assert.equal(resolveYandexTo(root, visible), to);
  to.insertAdjacentHTML(
    "beforeend",
    '<span class="js-yabble yabble-compose" data-email="to@example.invalid" contenteditable="false">To Recipient</span>',
  );
  root.insertAdjacentHTML(
    "beforeend",
    `
    <div><label for="cc">Cc</label><div id="cc" class="composeYabbles" contenteditable="true"><span class="js-yabble yabble-compose" data-email="cc@example.invalid" contenteditable="false">Copy Recipient</span></div></div>
    <div><label for="bcc">Bcc</label><div id="bcc" class="composeYabbles" contenteditable="true"><span class="js-yabble yabble-compose" data-email="bcc@example.invalid" contenteditable="false">Hidden Copy Recipient</span></div></div>
  `,
  );
  assert.deepEqual(yandexRecipientAddresses(root), [
    "bcc@example.invalid",
    "cc@example.invalid",
    "to@example.invalid",
  ]);
  assert.equal(resolveYandexTo(root, visible), to);
  assert.equal(yandexHasPendingRecipient(root, visible), false);
  dom.window.close();
});

test("authoritative chip email wins over contradictory tooltip and concatenated action label", () => {
  const { dom, root } = fixture(`
    <div class="composeYabbles" contenteditable="true" aria-label="To">
      <span class="js-yabble yabble-compose" data-email="first@example.invalid" title="other@example.invalid" contenteditable="false">first@example.invalidDelete</span>
    </div>
  `);
  assert.deepEqual(yandexRecipientAddresses(root), ["first@example.invalid"]);
  dom.window.close();
});

test("nested recognized chip markup is not interpreted as an additional display-text recipient", () => {
  const { dom, root } = fixture(`
    <div class="composeYabbles" contenteditable="true" aria-label="To">
      <span class="js-yabble yabble-compose" data-email="first@example.invalid" contenteditable="false"><span class="composeYabble">first@example.invalidDelete</span></span>
      <span class="js-yabble" data-email="second@example.invalid" contenteditable="false">Second</span>
    </div>
  `);
  assert.deepEqual(yandexRecipientAddresses(root), [
    "first@example.invalid",
    "second@example.invalid",
  ]);
  dom.window.close();
});

test("chip extraction falls back through valid attributes, then tooltip, then display text", () => {
  const { dom, root } = fixture(`
    <span class="js-yabble" data-email="not-an-address" email="first@example.invalid" title="ignored@example.invalid">ignored2@example.invalid</span>
    <span class="js-yabble" data-email="" data-hovercard-id="second@example.invalid">ignored@example.invalid</span>
    <span class="js-yabble" data-value="third@example.invalid" title="ignored@example.invalid"></span>
    <span class="js-yabble" title="fourth@example.invalid">ignored@example.invalid</span>
    <span class="js-yabble">fifth@example.invalid</span>
  `);
  assert.deepEqual(yandexRecipientAddresses(root), [
    "fifth@example.invalid",
    "first@example.invalid",
    "fourth@example.invalid",
    "second@example.invalid",
    "third@example.invalid",
  ]);
  dom.window.close();
});

for (const field of ["to", "cc", "bcc"]) {
  test(`uncommitted ${field} input or textarea is protected before filling`, () => {
    const { dom, root } = fixture(
      `<textarea name="${field}">Существующее имя</textarea>`,
    );
    assert.deepEqual(yandexRecipientAddresses(root), []);
    assert.equal(yandexHasPendingRecipient(root, visible), true);
    assert.equal(root.querySelector("textarea")!.value, "Существующее имя");
    dom.window.close();
  });
}

test("typed sender, subject and body content do not count as pending recipient input", () => {
  const { dom, root } = fixture(`
    <input name="from" value="sender@example.org">
    <input name="subject" value="Моя тема">
    <div class="composeReact-MBody"><div contenteditable="true">body@example.org</div></div>
    <textarea name="to"> \u200b </textarea>
  `);
  assert.equal(yandexHasPendingRecipient(root, visible), false);
  assert.deepEqual(yandexRecipientAddresses(root), []);
  dom.window.close();
});
