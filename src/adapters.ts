import type { Account, Letter } from "./types";
import { yandexAccount } from "./yandex-account";
import { EditorError, type EditorErrorCode } from "./editor-errors";
import { MailBodyError, writeMailBody } from "./mail-body";
import {
  resolveYandexTo,
  yandexRecipientAddresses,
  yandexHasPendingRecipient,
  yandexHasCopyRecipients,
  yandexPendingRecipientText,
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
  /** Recheck the exact editor immediately before a send action. */
  verify(): void;
}

function hasPendingGmailRecipient(root: HTMLElement) {
  return [
    ...root.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>(
      'input[name="to"], textarea[name="to"], input[name="cc"], textarea[name="cc"], input[name="bcc"], textarea[name="bcc"], input[role="combobox"][aria-label="To recipients"], input[role="combobox"][aria-label="Получатели"]',
    ),
  ].some(
    (input) =>
      visible(input) &&
      input.type !== "hidden" &&
      input.value.trim().length > 0,
  );
}

/** CC/BCC must stay empty, even when their addresses also occur in To. */
function hasCopyRecipients(root: HTMLElement, provider: Account["provider"]) {
  if (provider === "yandex") return yandexHasCopyRecipients(root);
  const copyFields = root.querySelectorAll<HTMLElement>(
    'input[name="cc"], input[name="bcc"], textarea[name="cc"], textarea[name="bcc"], [data-name="cc"], [data-name="bcc"], [aria-label="Cc recipients"], [aria-label="Bcc recipients"], [aria-label="Получатели копии"], [aria-label="Получатели скрытой копии"]',
  );
  return [...copyFields].some((field) => {
    if (
      (field instanceof HTMLInputElement ||
        field instanceof HTMLTextAreaElement) &&
      field.value.trim()
    )
      return true;
    const region =
      field.closest("tr") ||
      (field.parentElement !== root ? field.parentElement : null) ||
      field;
    if (recipientAddresses(region, provider).length) return true;
    return false;
  });
}

async function commitYandexRecipients(
  root: HTMLElement,
  recipient: HTMLElement,
  subject: HTMLInputElement,
  body: HTMLElement,
  originalBodyText: string,
  addresses: string[],
  findRecipient: () => HTMLElement | null,
  guard: () => void,
) {
  const expected = [
    ...new Set(addresses.map((value) => value.toLowerCase())),
  ].sort();
  const normalizePending = (value: string) =>
    value
      .replace(/[\u200B-\u200D\u2060\uFEFF]/g, "")
      .replace(/\u00a0/g, " ")
      .trim();
  const insertedText = normalizePending(addresses.join(", "));
  const checkEditor = () => {
    guard();
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
  // Yandex processes the input asynchronously. A blur in the same call stack
  // can leave the address as plain text, even after the editor has mounted.
  await new Promise((resolve) => setTimeout(resolve, 0));
  if (!checkEditor().actual.length) enter(recipient);
  const until = Date.now() + 5000;
  while (Date.now() < until) {
    const { actual, pending } = checkEditor();
    if (JSON.stringify(actual) === JSON.stringify(expected) && !pending) return;
    if (!actual.length) {
      // Retry only the focus transition, never the insertion. Once any chip
      // exists, wait for that batch to finish without another editing commit.
      recipient.focus();
      const afterFocus = checkEditor();
      if (!afterFocus.actual.length) subject.focus();
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  checkEditor();
  throw new EditorError("recipient_unconfirmed");
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
  const originalBodyText = body.textContent?.trim() || "";
  // Yandex must receive the full recipient set in one editing transaction.
  // Multiple individual blur commits can paint all chips while its saved
  // recipient model retains only the first address.
  const recipientBatches =
    account.provider === "yandex"
      ? [letter.to]
      : letter.to.map((address) => [address]);
  for (const addresses of recipientBatches) {
    guard();
    const recipient = await waitFor(
      findRecipient,
      signal,
      10000,
      "recipients_missing",
    );
    guard();
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
        guard,
      );
    } else {
      enter(recipient);
      await waitFor(
        () =>
          addresses.every((address) =>
            recipientAddresses(root, account.provider).includes(
              address.toLowerCase(),
            ),
          ),
        signal,
        5000,
        "recipient_unconfirmed",
      );
    }
  }
  guard();
  setInput(subject, letter.subject);
  const text =
    letter.body + (originalSignature ? `\n\n${originalSignature}` : "");
  let bodyCheckpoint: { verify(): void };
  try {
    bodyCheckpoint = await writeMailBody(body, text, signal);
  } catch (cause) {
    guard();
    throw new EditorError(
      cause instanceof MailBodyError && cause.code === "mismatch"
        ? "body_mismatch"
        : "body_not_committed",
    );
  }
  body.blur();
  subject.blur();
  // Let controlled editors process input before checking actual state.
  await new Promise((r) => setTimeout(r, 500));
  const expected = [...new Set(letter.to.map((s) => s.toLowerCase()))].sort();
  const expectedSubject = letter.subject;
  const verify = () => {
    guard();
    if (!root.isConnected || !root.contains(body) || !visible(body))
      throw new EditorError("body_missing");
    if (!root.contains(subject) || !visible(subject))
      throw new EditorError("subject_missing");
    const actual = recipientAddresses(root, account.provider);
    if (
      JSON.stringify(actual) !== JSON.stringify(expected) ||
      hasCopyRecipients(root, account.provider)
    )
      throw new EditorError("recipients_mismatch");
    if (
      account.provider === "yandex"
        ? yandexHasPendingRecipient(root, visible)
        : hasPendingGmailRecipient(root)
    )
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
    verify,
  } satisfies PreparedLetter;
}
