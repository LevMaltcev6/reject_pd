import { test } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import type { PreparedLetter } from "../src/adapters";
import { EditorError } from "../src/editor-errors";
import { SendError, sendLetter } from "../src/send-letter";

function fixture() {
  const dom = new JSDOM("<!doctype html><body></body>", {
    url: "https://mail.yandex.ru/",
  });
  const w = dom.window;
  for (const key of ["document", "HTMLElement", "getComputedStyle"] as const)
    Object.defineProperty(globalThis, key, {
      configurable: true,
      writable: true,
      value: key === "getComputedStyle" ? w.getComputedStyle.bind(w) : w[key],
    });
  w.HTMLElement.prototype.getClientRects = function () {
    return [{ width: 100, height: 30 }] as unknown as DOMRectList;
  };
  const root = document.createElement("div");
  root.className = "composeReact";
  root.innerHTML =
    '<div contenteditable="true">Expected body</div><button>Send</button>';
  const body = root.querySelector<HTMLElement>("[contenteditable]")!;
  const statusline = document.createElement("div");
  statusline.setAttribute("role", "alert");
  statusline.dataset.testid = "statusline_root_container";
  statusline.innerHTML = '<div class="qa-StatuslineRoot"></div>';
  document.body.append(root, statusline);
  const prepared: PreparedLetter = {
    root,
    body,
    provider: "yandex",
    assertActive() {
      if (!body.isConnected || !root.contains(body))
        throw new EditorError("body_missing");
    },
  };
  let clicks = 0;
  const addNotice = (name = "MessageSent") => {
    const item = document.createElement("div");
    item.dataset.testid = "statusline_item_container";
    item.innerHTML = `<div class="MessageBox" name="${name}"><span>Message sent</span></div>`;
    statusline.firstElementChild!.append(item);
    return item;
  };
  root.querySelector("button")!.addEventListener("click", () => {
    clicks++;
    addNotice();
    root.remove();
  });
  return { dom, root, body, prepared, addNotice, clicks: () => clicks };
}

test("Yandex waits for the prior mounted MessageSent item to be removed before claiming and clicking", async () => {
  const f = fixture();
  try {
    const previous = f.addNotice();
    previous.style.opacity = "0"; // The observed fade still suppresses another toast.
    previous.hidden = true;
    let waiting = 0;
    let claims = 0;
    const sending = sendLetter(
      f.prepared,
      new AbortController().signal,
      () => {
        claims++;
        assert.equal(previous.isConnected, false);
      },
      () => waiting++,
    );
    assert.equal(waiting, 1);
    assert.equal(claims, 0);
    assert.equal(f.clicks(), 0);
    setTimeout(() => previous.remove(), 30);
    await sending;
    assert.equal(waiting, 1);
    assert.equal(claims, 1);
    assert.equal(f.clicks(), 1);
  } finally {
    f.dom.window.close();
  }
});

test("stopping while waiting for the old toast never claims or clicks Send", async () => {
  const f = fixture();
  try {
    const previous = f.addNotice();
    const abort = new AbortController();
    const sending = sendLetter(
      f.prepared,
      abort.signal,
      () => assert.fail("must not claim while waiting"),
      () => setTimeout(() => abort.abort(), 20),
    );
    await assert.rejects(
      sending,
      (error: unknown) =>
        error instanceof SendError && error.code === "cancelled",
    );
    assert.equal(f.clicks(), 0);
    assert.equal(previous.isConnected, true);
    assert.equal(f.root.isConnected, true);
  } finally {
    f.dom.window.close();
  }
});

test("letter edits while waiting for the old toast do not block the send attempt", async () => {
  const f = fixture();
  try {
    const previous = f.addNotice();
    let claims = 0;
    await sendLetter(
      f.prepared,
      new AbortController().signal,
      () => claims++,
      () =>
        setTimeout(() => {
          f.body.textContent = "Changed by user";
          previous.remove();
        }, 20),
    );
    assert.equal(claims, 1);
    assert.equal(f.clicks(), 1);
  } finally {
    f.dom.window.close();
  }
});

test("closing the editor while waiting for the old toast prevents the send attempt", async () => {
  const f = fixture();
  try {
    const previous = f.addNotice();
    await assert.rejects(
      sendLetter(
        f.prepared,
        new AbortController().signal,
        () => assert.fail("closed editor must not be claimed"),
        () =>
          setTimeout(() => {
            f.root.remove();
            previous.remove();
          }, 20),
      ),
      (error: unknown) =>
        error instanceof EditorError && error.code === "body_missing",
    );
    assert.equal(f.clicks(), 0);
  } finally {
    f.dom.window.close();
  }
});

test("a stuck MessageSent notice has a bounded static timeout before any send claim", async () => {
  const f = fixture();
  const originalNow = Date.now;
  try {
    f.addNotice();
    const now = originalNow();
    let offset = 0;
    Date.now = () => now + offset;
    await assert.rejects(
      sendLetter(
        f.prepared,
        new AbortController().signal,
        () => assert.fail("timeout must precede the claim"),
        () => {
          offset = 12001;
        },
      ),
      (error: unknown) =>
        error instanceof SendError && error.code === "previous_notice_timeout",
    );
    assert.equal(f.clicks(), 0);
    assert.equal(f.root.isConnected, true);
  } finally {
    Date.now = originalNow;
    f.dom.window.close();
  }
});

for (const unrelated of [false, true]) {
  test(`Yandex does not announce a wait when ${unrelated ? "only an unrelated notification is mounted" : "no prior success item exists"}`, async () => {
    const f = fixture();
    try {
      if (unrelated) f.addNotice("DraftSaved");
      await sendLetter(
        f.prepared,
        new AbortController().signal,
        () => {},
        () => assert.fail("no MessageSent item is blocking"),
      );
      assert.equal(f.clicks(), 1);
    } finally {
      f.dom.window.close();
    }
  });
}
