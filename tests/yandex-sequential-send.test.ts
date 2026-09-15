import { test } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { currentMailContext } from "../src/adapters";
import { Queue, RECEIPT_PREFIX, type SendReceipt } from "../src/queue";
import { CurrentTabTransport } from "../src/transport";
import type { Letter } from "../src/types";
import {
  installMailEditorFixture,
  installYandexRecipientFixture,
} from "./mail-editor-fixture";

test(
  "Yandex sends 27 letters after each previous toast expires instead of triggering its notification deduplication",
  { timeout: 40_000 },
  async () => {
    const dom = new JSDOM(
      '<!doctype html><body><button class="mail-ComposeButton">Написать</button><div role="alert" data-testid="statusline_root_container"><div class="qa-StatuslineRoot"></div></div></body>',
      { url: "https://mail.yandex.ru/?uid=123456#tabs/relevant" },
    );
    const w = dom.window;
    const originals = new Map<string, PropertyDescriptor | undefined>();
    function expose(name: string, value: unknown) {
      originals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
      Object.defineProperty(globalThis, name, {
        configurable: true,
        writable: true,
        value,
      });
    }
    for (const key of [
      "document",
      "location",
      "history",
      "navigator",
      "HTMLElement",
      "HTMLInputElement",
      "HTMLTextAreaElement",
      "Event",
      "InputEvent",
      "KeyboardEvent",
    ] as const)
      expose(key, w[key]);
    expose("getComputedStyle", w.getComputedStyle.bind(w));
    expose("CKEDITOR", undefined);
    expose("unsafeWindow", undefined);
    const editorModel = installMailEditorFixture(w, "yandex");
    w.HTMLElement.prototype.getClientRects = function () {
      return [{ width: 100, height: 30 }] as unknown as DOMRectList;
    };
    const values = new Map<string, unknown>();
    expose("GM_getValue", (key: string) => values.get(key));
    expose("GM_setValue", (key: string, value: unknown) =>
      values.set(key, structuredClone(value)),
    );
    expose("GM_deleteValue", (key: string) => values.delete(key));
    expose("GM_listValues", () => [...values.keys()]);
    let externalActions = 0;
    const forbiddenExternalAction = () => {
      externalActions++;
      throw new Error("Test mail must stay in the simulated document");
    };
    expose("GM_openInTab", forbiddenExternalAction);
    w.open = forbiddenExternalAction;
    w.fetch = forbiddenExternalAction;
    const initialUrl = w.location.href;
    const letters: Letter[] = Array.from({ length: 27 }, (_, index) => ({
      companyId: `company-${index + 1}`,
      companyName: `Компания ${index + 1}`,
      to: [
        `company-${index + 1}@example.invalid`,
        ...([2, 11].includes(index)
          ? [`company-${index + 1}-second@example.invalid`]
          : []),
      ],
      subject: `Обращение ${index + 1}`,
      body: `Текст обращения компании ${index + 1}.\n\nСледующий абзац с кириллицей.`,
      missing: [],
      actions: [],
    }));
    const sent: Pick<Letter, "to" | "subject" | "body">[] = [];
    const claimsAtClick: number[] = [];
    let maxEditors = 0;
    let composed = 0;
    let deduplicated = 0;
    let notifications = 0;
    const expiryTimers = new Set<ReturnType<typeof setTimeout>>();
    const popup = w.document.createElement("div");
    popup.className = "composeReact";
    const statusline = w.document.querySelector(".qa-StatuslineRoot")!;
    w.document
      .querySelector(".mail-ComposeButton")!
      .addEventListener("click", () => {
        composed++;
        popup.innerHTML =
          '<div class="ComposeRecipients-ToField"><input name="to" aria-label="To"></div><input name="subject"><div class="composeReact-MBody"><div contenteditable="true"></div></div><div class="ComposeControlPanel-SendButton"><button>Отправить</button></div>';
        const to = popup.querySelector<HTMLInputElement>('[name="to"]')!;
        const subject =
          popup.querySelector<HTMLInputElement>('[name="subject"]')!;
        const body = popup.querySelector<HTMLElement>(
          '[contenteditable="true"]',
        )!;
        editorModel.register(body);
        const recipientModel = installYandexRecipientFixture(w, to);
        popup.querySelector("button")!.addEventListener("click", () => {
          // Read the application's committed model: visible DOM alone is insufficient.
          assert.equal(
            recipientModel.commits(),
            1,
            "each company's recipients must commit atomically",
          );
          assert.equal(recipientModel.enters(), 1);
          sent.push({
            to: recipientModel.addresses(),
            subject: subject.value,
            body: editorModel.modelText(body),
          });
          claimsAtClick.push(
            [...values.values()].filter(
              (value) => (value as SendReceipt).state === "sending",
            ).length,
          );
          popup.replaceChildren(); // Yandex retains the outer compose container.
          // Observed Yandex behavior: the next real send succeeds, but while
          // the previous toast exists the host publishes no new DOM/state at all.
          // Removal of that old toast cannot prove the second send succeeded.
          if (
            statusline.querySelector(
              '[data-testid="statusline_item_container"]',
            )
          ) {
            deduplicated++;
            return;
          }
          notifications++;
          const notification = w.document.createElement("div");
          notification.dataset.testid = "statusline_item_container";
          notification.innerHTML =
            '<div class="MessageBox" name="MessageSent"><div class="MessageBox-Content"><div data-testid="statusline_content_wrapper_container"><div data-testid="statusline_success-icon_container"><svg></svg></div><span class="Text">Message sent</span></div></div></div>';
          statusline.append(notification);
          // Compress the host's multi-second expiry, but keep it longer than
          // the adapter's 500ms fill checkpoint so an eager second Send dedups.
          const expiry = setTimeout(() => {
            notification.remove();
            expiryTimers.delete(expiry);
          }, 900);
          expiryTimers.add(expiry);
        });
        w.document.body.append(popup);
        maxEditors = Math.max(
          maxEditors,
          w.document.querySelectorAll('.composeReact [contenteditable="true"]')
            .length,
        );
      });
    let watchdog: ReturnType<typeof setTimeout> | undefined;
    let waitingFor = "";
    const transitions = letters.map(() => [] as string[]);
    const transport = new CurrentTabTransport(currentMailContext()!);
    const queue = new Queue(letters, transport, () => {
      queue.items.forEach((item, index) => {
        if (transitions[index].at(-1) !== item.status)
          transitions[index].push(item.status);
      });
      const sending = queue.items.find((item) => item.status === "sending");
      if ((sending?.id || "") === waitingFor) return;
      if (watchdog) clearTimeout(watchdog);
      waitingFor = sending?.id || "";
      // A regression need not consume the sender's whole 20-second timeout.
      // Valid synthetic acknowledgements are synchronous; abort a stalled item.
      if (sending) watchdog = setTimeout(() => queue.stop(), 1500);
    });
    try {
      await queue.run();
      assert.deepEqual(
        queue.items.map((item) => item.status),
        Array(27).fill("sent"),
      );
      assert.deepEqual(
        sent,
        letters.map(({ to, subject, body }) => ({ to, subject, body })),
      );
      assert.ok(sent.every((message) => message.body.trim().length > 0));
      assert.equal(composed, 27);
      assert.equal(maxEditors, 1);
      assert.equal(externalActions, 0);
      assert.equal(w.location.href, initialUrl);
      assert.equal(
        deduplicated,
        0,
        "never click Send while its previous toast still exists",
      );
      assert.equal(
        notifications,
        27,
        "every sent item needs its own fresh host acknowledgement",
      );
      assert.deepEqual(
        transitions.map((states) =>
          states.filter((stage) => stage !== "waiting"),
        ),
        letters.map(() => ["queued", "opening", "sending", "sent"]),
      );
      assert.deepEqual(claimsAtClick, Array(27).fill(1));
      assert.equal(values.size, 27);
      assert.ok(
        [...values.entries()].every(
          ([key, value]) =>
            key.startsWith(RECEIPT_PREFIX) &&
            (value as SendReceipt).state === "sent",
        ),
      );
      await queue.run(true);
      assert.equal(
        sent.length,
        27,
        "completed letters must never be sent again",
      );
    } finally {
      if (watchdog) clearTimeout(watchdog);
      for (const expiry of expiryTimers) clearTimeout(expiry);
      queue.stop();
      transport.clear();
      dom.window.close();
      for (const [name, descriptor] of originals) {
        if (descriptor) Object.defineProperty(globalThis, name, descriptor);
        else Reflect.deleteProperty(globalThis, name);
      }
    }
  },
);
