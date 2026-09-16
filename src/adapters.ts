import type { Account, Letter } from "./types";
import { yandexAccount } from "./yandex-account";
import { EditorError, type EditorErrorCode } from "./editor-errors";
import { writeMailBody } from "./mail-body";
import {
  resolveYandexTo,
  yandexRecipientAddresses,
  yandexHasPendingRecipient,
} from "./yandex-recipients";
const emailPattern = /[A-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
export const visible = (e: Element): e is HTMLElement =>
  e instanceof HTMLElement &&
  !e.hidden &&
  e.getAttribute("aria-hidden") !== "true" &&
  getComputedStyle(e).display !== "none" &&
  getComputedStyle(e).visibility !== "hidden" &&
  e.getClientRects().length > 0;
export function identifyAccount(
  doc = document,
  href = location.href,
): Account | null {
  const url = new URL(href);
  const gmail = url.hostname === "mail.google.com";
  if (!gmail && !/^mail\.yandex\.(ru|com|by|kz)$/.test(url.hostname))
    return null;
  if (!gmail) return yandexAccount(doc, url);
  // Only current-account controls, never message bodies or the account-switcher list.
  const selectors = gmail
    ? '[aria-label*="Google Account"], [aria-label*="Аккаунт Google"], a[href*="SignOutOptions"]'
    : '.mail-User-Name, .user-account__name, .user-account__login, [data-testid="user-account"]';
  const addresses = new Set<string>();
  for (const el of doc.querySelectorAll(selectors)) {
    for (const str of [
      el.getAttribute("aria-label"),
      el.getAttribute("title"),
      el.textContent,
    ]) {
      for (const match of str?.match(emailPattern) || [])
        addresses.add(match.toLowerCase());
    }
  }
  if (addresses.size !== 1) return null;
  const match = url.pathname.match(/^\/mail\/u\/(\d+)\//);
  if (gmail && !match) return null;
  return {
    provider: gmail ? "gmail" : "yandex",
    email: [...addresses][0],
    baseUrl: gmail ? `${url.origin}/mail/u/${match![1]}/` : `${url.origin}/`,
  };
}
export function sameAccount(a: Account, b: Account | null) {
  return (
    !!b &&
    a.provider === b.provider &&
    (a.uid ? a.uid === b.uid : !!a.email && a.email === b.email) &&
    a.baseUrl === b.baseUrl
  );
}
/** Yandex itself chooses the signed-in mailbox for a new tab. No avatar lookup. */
export function currentMailContext(
  doc = document,
  href = location.href,
): Account | null {
  const url = new URL(href);
  if (url.protocol !== "https:" || url.port) return null;
  if (/^mail\.yandex\.(ru|com|by|kz)$/.test(url.hostname)) {
    return {
      provider: "yandex",
      email: "",
      baseUrl: `${url.origin}/`,
      useCurrentSession: true,
    };
  }
  return identifyAccount(doc, href);
}
export function matchesMailContext(
  expected: Account,
  doc = document,
  href = location.href,
) {
  if (expected.useCurrentSession) {
    const current = currentMailContext(doc, href);
    return (
      expected.provider === "yandex" &&
      current?.provider === "yandex" &&
      expected.baseUrl === current.baseUrl
    );
  }
  return sameAccount(expected, identifyAccount(doc, href));
}
export async function waitFor<T>(
  get: () => T | null | undefined | false,
  signal: AbortSignal,
  timeout = 20000,
  errorCode: EditorErrorCode = "interface_timeout",
): Promise<T> {
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
function one(selector: string, root: ParentNode = document) {
  const nodes = [...root.querySelectorAll(selector)].filter(visible);
  return nodes.length === 1 ? nodes[0] : null;
}
function setInput(el: HTMLElement, value: string) {
  if (!(el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement))
    throw new EditorError("input_unavailable");
  const prototype =
    el instanceof HTMLInputElement
      ? HTMLInputElement.prototype
      : HTMLTextAreaElement.prototype;
  Object.getOwnPropertyDescriptor(prototype, "value")!.set!.call(el, value);
  el.dispatchEvent(new Event("input", { bubbles: true }));
  el.dispatchEvent(new Event("change", { bubbles: true }));
}
function enter(el: HTMLElement) {
  el.dispatchEvent(
    new KeyboardEvent("keydown", {
      key: "Enter",
      code: "Enter",
      keyCode: 13,
      which: 13,
      bubbles: true,
      cancelable: true,
    }),
  );
  el.dispatchEvent(
    new KeyboardEvent("keyup", {
      key: "Enter",
      code: "Enter",
      keyCode: 13,
      which: 13,
      bubbles: true,
    }),
  );
}
function insertRecipient(el: HTMLElement, address: string) {
  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
    setInput(el, address);
    return;
  }
  if (
    !["true", "plaintext-only"].includes(
      el.getAttribute("contenteditable") || "",
    )
  )
    throw new EditorError("input_unavailable");
  // Yandex's x-bubbles keeps committed recipients inside the editable itself.
  // Insert at the end instead of replacing its contents and deleting earlier chips.
  const doc = el.ownerDocument;
  const selection = doc.getSelection();
  if (!selection) throw new EditorError("input_unavailable");
  const range = doc.createRange();
  range.selectNodeContents(el);
  range.collapse(false);
  selection.removeAllRanges();
  selection.addRange(range);
  if (
    typeof doc.execCommand === "function" &&
    doc.execCommand("insertText", false, address)
  )
    return;
  range.insertNode(doc.createTextNode(address));
  range.collapse(false);
  selection.removeAllRanges();
  selection.addRange(range);
  el.dispatchEvent(
    new InputEvent("input", {
      bubbles: true,
      inputType: "insertText",
      data: address,
    }),
  );
}
const bodies = {
  gmail:
    '[contenteditable="true"][role="textbox"][aria-label="Message Body"], [contenteditable="true"][role="textbox"][aria-label="Текст письма"]',
  yandex:
    '.cke_wysiwyg_div[contenteditable="true"], .composeReact-MBody [contenteditable="true"], .ComposeMbody [contenteditable="true"]',
};
function composeButton(provider: Account["provider"]) {
  if (provider === "yandex") {
    const b = one(
      '.mail-ComposeButton, .mail-ComposeButton-Wrap a, [data-testid="compose-button"]',
    );
    if (b) return b;
  }
  const buttons = [...document.querySelectorAll('[role="button"], button, a')]
    .filter(visible)
    .filter(
      (e) =>
        /^(Compose|Написать|Написать письмо)$/i.test(
          e.textContent?.trim() || "",
        ) ||
        /^(Compose|Написать|Написать письмо)$/i.test(
          e.getAttribute("aria-label") || "",
        ),
    );
  return buttons.length === 1 ? buttons[0] : null;
}
function recipientAddresses(
  root: ParentNode,
  provider: Account["provider"],
): string[] {
  if (provider === "yandex") return yandexRecipientAddresses(root);
  const chips = root.querySelectorAll("[email], [data-hovercard-id]");
  return [
    ...new Set(
      [...chips]
        .flatMap((e) =>
          [
            e.getAttribute("email"),
            e.getAttribute("data-hovercard-id"),
            e.getAttribute("data-email"),
            e.getAttribute("title"),
            e.textContent,
          ].flatMap((s) => s?.match(emailPattern) || []),
        )
        .map((s) => s.toLowerCase()),
    ),
  ].sort();
}
export interface PreparedLetter {
  readonly root: HTMLElement;
  readonly body: HTMLElement;
  readonly provider: Account["provider"];
  /** Keep the operation in its own active editor; field validation belongs to mail. */
  assertActive(): void;
}

export async function fillLetter(
  account: Account,
  letter: Letter,
  signal: AbortSignal,
  stillActive = () => true,
) {
  const guard = () => {
    signal.throwIfAborted();
    if (!stillActive()) throw new EditorError("cancelled");
    if (!matchesMailContext(account))
      throw new EditorError("context_unavailable");
  };
  await waitFor(
    () => matchesMailContext(account),
    signal,
    20000,
    "context_unavailable",
  );
  guard();
  if ([...document.querySelectorAll(bodies[account.provider])].some(visible))
    throw new EditorError("existing_editor");
  const button = await waitFor(
    () => composeButton(account.provider),
    signal,
    20000,
    "compose_button_missing",
  );
  guard();
  button.click(); // Preparing a letter only opens Compose; sending is a separate action.
  const body = await waitFor(
    () => one(bodies[account.provider]),
    signal,
    20000,
    "body_missing",
  );
  guard();
  const root =
    account.provider === "gmail"
      ? body.closest('[role="dialog"]') || body.closest("form")
      : body.closest(
          '.ComposePopup, .composeReact, .compose, [data-testid="compose"]',
        );
  if (!(root instanceof HTMLElement))
    throw new EditorError("editor_root_missing");
  const subject = one(
    account.provider === "gmail"
      ? 'input[name="subjectbox"]'
      : 'input[name="subject"], .composeTextField[name="subj"], input[name="subj"]',
    root,
  );
  if (!(subject instanceof HTMLInputElement))
    throw new EditorError("subject_missing");
  if (subject.value.trim()) throw new EditorError("existing_subject");
  if (recipientAddresses(root, account.provider).length)
    throw new EditorError("existing_recipients");
  // Signature-only content is allowed only in the provider's explicitly marked signature block.
  const signature = body.querySelector(
    ".gmail_signature, .mail-Signature, .compose-signature",
  );
  if (
    body.textContent?.trim() &&
    body.textContent.trim() !== signature?.textContent?.trim()
  )
    throw new EditorError("existing_body");
  const originalSignature = signature?.textContent?.trim() || "";
  const findRecipient = () =>
    account.provider === "yandex"
      ? resolveYandexTo(root, visible)
      : one(
          'input[name="to"], textarea[name="to"], input[role="combobox"][aria-label="To recipients"], input[role="combobox"][aria-label="Получатели"]',
          root,
        );
  // Recipient widgets can mount after the message body. Wait before any writes.
  await waitFor(findRecipient, signal, 10000, "recipients_missing");
  guard();
  // Recheck after waiting: the user or the mail client may have restored a draft.
  if (subject.value.trim()) throw new EditorError("existing_subject");
  if (recipientAddresses(root, account.provider).length)
    throw new EditorError("existing_recipients");
  if (body.textContent?.trim() && body.textContent.trim() !== originalSignature)
    throw new EditorError("existing_body");
  if (account.provider === "yandex" && yandexHasPendingRecipient(root, visible))
    throw new EditorError("existing_recipients");
  // Yandex must receive the full recipient set in one editing transaction.
  // Multiple individual blur commits can paint all chips while its saved
  // recipient model retains only the first address.
  const recipientBatches =
    account.provider === "yandex"
      ? [letter.to]
      : letter.to.map((address) => [address]);
  for (const [index, addresses] of recipientBatches.entries()) {
    guard();
    const recipient = await waitFor(
      findRecipient,
      signal,
      10000,
      "recipients_missing",
    );
    guard();
    recipient.focus();
    // A mail client may leave a prior address as pending text after Enter.
    // Preserve it when inserting the next batch instead of replacing it.
    const pending =
      index > 0 &&
      (recipient instanceof HTMLInputElement ||
        recipient instanceof HTMLTextAreaElement)
        ? recipient.value.trim()
        : "";
    insertRecipient(
      recipient,
      [pending, addresses.join(", ")].filter(Boolean).join(", "),
    );
    // Finish the input transaction with Enter and a real focus transition.
    // The mail client validates recipients when sending; chip markup is not a gate.
    await new Promise((resolve) => setTimeout(resolve, 0));
    guard();
    enter(recipient);
    subject.focus();
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  guard();
  setInput(subject, letter.subject);
  const text =
    letter.body + (originalSignature ? `\n\n${originalSignature}` : "");
  try {
    await writeMailBody(body, text, signal);
  } catch {
    guard();
    throw new EditorError("body_write_failed");
  }
  body.blur();
  subject.blur();
  const assertActive = () => {
    guard();
    if (!root.isConnected || !root.contains(body) || !visible(body))
      throw new EditorError("body_missing");
  };
  assertActive();
  return {
    root,
    body,
    provider: account.provider,
    assertActive,
  } satisfies PreparedLetter;
}
