import { visible, type PreparedLetter } from "./adapters";
import { EditorError } from "./editor-errors";

const messages = {
  button_missing:
    "Не найдена доступная кнопка «Отправить» в подготовленном письме. Отправка не запускалась.",
  button_ambiguous:
    "В редакторе найдено несколько кнопок «Отправить». Отправка не запускалась.",
  already_attempted:
    "Для этого письма отправка уже запускалась. Повторная отправка отключена: проверьте «Отправленные».",
  cancelled:
    "Отправка остановлена до нажатия «Отправить». Письмо осталось в редакторе.",
  unexpected:
    "Не удалось запустить отправку. Кнопка «Отправить» не нажималась.",
  previous_notice_timeout:
    "Предыдущее уведомление Яндекса об отправке не исчезло за 12 секунд. Текущее письмо не отправлено. Дождитесь исчезновения уведомления.",
} as const;

export class SendError extends Error {
  constructor(public readonly code: keyof typeof messages) {
    super(messages[code]);
    this.name = "SendError";
  }
}

/** Once the durable send claim starts, no failure proves that nothing was sent. */
export class SendUncertainError extends Error {
  constructor() {
    super(
      "Отправка запускалась, но подтверждение почты не получено. Проверьте «Отправленные» и черновик. Автоматического повтора не будет.",
    );
    this.name = "SendUncertainError";
  }
}

const attempted = new WeakSet<PreparedLetter>();
const composeRoots =
  '.ComposePopup, .composeReact, .compose, [data-testid="compose"], [role="dialog"], form';
const normalize = (value: string | null | undefined) =>
  (value || "")
    .replace(/[\u200B-\u200F\u202A-\u202E\u2060-\u206F\uFEFF]/g, "")
    .replace(/\s+/g, " ")
    .trim();
const sendName = /^(?:Send|Отправить)(?:\s*\([^)]*\))?$/i;
const delayedControl =
  '.ComposeControlPanel-DelayedSendingButton, .qa-Compose-DelayedSendingButton, [aria-haspopup="menu"], [aria-haspopup="true"]';

function shown(element: Element): element is HTMLElement {
  if (!element.isConnected || !visible(element)) return false;
  for (
    let parent: Element | null = element;
    parent;
    parent = parent.parentElement
  ) {
    if (parent.matches('[hidden], [aria-hidden="true"], [inert]')) return false;
    const style = getComputedStyle(parent);
    if (style.display === "none" || style.visibility === "hidden") return false;
  }
  return true;
}
function enabled(button: HTMLElement) {
  return (
    !button.matches(":disabled") &&
    !button.closest('[aria-disabled="true"], [disabled], [inert]')
  );
}
function sendButton(prepared: PreparedLetter): HTMLElement | null {
  const buttons = [
    ...prepared.root.querySelectorAll<HTMLElement>(
      'button, [role="button"], input[type="submit"]',
    ),
  ].filter((button) => {
    if (!shown(button) || button.closest(delayedControl)) return false;
    // An embedded/nested editor is never the prepared editor's send control.
    const nearest = button.closest(composeRoots);
    if (
      nearest &&
      nearest !== prepared.root &&
      prepared.root.contains(nearest) &&
      !nearest.contains(prepared.body)
    )
      return false;
    const labels = [
      button.getAttribute("aria-label"),
      button.getAttribute("data-tooltip"),
      button.getAttribute("title"),
      button.textContent,
      button.getAttribute("value"),
    ]
      .map(normalize)
      .filter(Boolean);
    if (
      labels.some((label) =>
        /schedule|send later|delayed|по таймеру|отложенн|позже/i.test(label),
      )
    )
      return false;
    const observedYandex =
      prepared.provider === "yandex" &&
      !!button.closest(
        ".ComposeControlPanel-SendButton, .qa-Compose-SendButton",
      );
    return observedYandex || labels.some((label) => sendName.test(label));
  });
  if (buttons.length > 1) throw new SendError("button_ambiguous");
  return buttons.length === 1 && enabled(buttons[0]) ? buttons[0] : null;
}

const notices = {
  gmail: '[role="alert"], [role="status"], .bAq',
  yandex:
    '[role="alert"], [role="status"], .mail-Notification, .notification, .Notification, .ComposeSuccess, .ComposeDoneScreen, .ComposeDoneScreen-Title, [data-testid="compose-success"], [data-testid="compose-done"]',
};
const viewedMessageBodies = {
  gmail: ".a3s",
  yandex: ".js-message-body, .react-message-wrapper__body",
};
// Recognise a provider's explicit acknowledgement, including its Undo/View links.
// Draft-saved text, message content and a disappearing editor are not evidence.
const sentNotice =
  /^(?:Message (?:has been )?sent|Your message has been sent|(?:Ваше )?Письмо (?:успешно )?отправлено|(?:Ваше )?Сообщение (?:успешно )?отправлено)(?:[.!…]|\s|$)/i;
const failedNotice =
  /^(?:Message (?:was )?not sent|(?:Could not|Couldn't|Failed to|Unable to) send|Не удалось отправить|(?:Письмо|Сообщение) не отправлено|Ошибка отправки)(?:[.!…:]|\s|$)/i;
function notificationState(prepared: PreparedLetter) {
  const states = new Map<
    Element,
    {
      text: string;
      acknowledgement: string | undefined;
      firstText: Node | null;
    }
  >();
  // Yandex stacks several notifications inside one alert. Reading only the
  // alert's first text would miss the second identical acknowledgement.
  const selector =
    notices[prepared.provider] +
    (prepared.provider === "yandex"
      ? ', [data-testid="statusline_root_container"] *'
      : "");
  for (const element of prepared.root.ownerDocument.querySelectorAll(
    selector,
  )) {
    if (
      prepared.body.contains(element) ||
      element.contains(prepared.body) ||
      element.closest(viewedMessageBodies[prepared.provider]) ||
      element.querySelector(viewedMessageBodies[prepared.provider]) ||
      element.closest(
        '[contenteditable="true"], [contenteditable="plaintext-only"]',
      )
    )
      continue;
    const text = normalize(element.textContent);
    if (
      !element.matches(notices[prepared.provider]) &&
      !sentNotice.test(text) &&
      !failedNotice.test(text)
    )
      continue;
    if (!shown(element)) continue;
    const walker = element.ownerDocument.createTreeWalker(element, 4);
    let firstText: Node | null;
    do {
      firstText = walker.nextNode();
    } while (firstText && !normalize(firstText.textContent));
    states.set(element, {
      text,
      acknowledgement: sentNotice
        .exec(text)?.[0]
        .replace(/[.!…\s]+$/, "")
        .toLowerCase(),
      firstText,
    });
  }
  return states;
}
function editorGone(prepared: PreparedLetter) {
  return !shown(prepared.root) || !shown(prepared.body);
}

async function waitForPreviousYandexNotice(
  prepared: PreparedLetter,
  signal: AbortSignal,
  onWaiting?: () => void,
) {
  if (prepared.provider !== "yandex") return;
  const selector =
    '[data-testid="statusline_root_container"] [data-testid="statusline_item_container"] [name="MessageSent"]';
  const pending = () => prepared.root.ownerDocument.querySelector(selector);
  if (!pending()) return;
  const deadline = Date.now() + 12000;
  try {
    onWaiting?.();
  } catch {
    // A progress display cannot change whether the prepared letter is sent.
  }
  while (pending()) {
    signal.throwIfAborted();
    prepared.verify();
    if (Date.now() >= deadline) throw new SendError("previous_notice_timeout");
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  signal.throwIfAborted();
  prepared.verify();
}

export async function sendLetter(
  prepared: PreparedLetter,
  signal: AbortSignal,
  beforeClick: () => void,
  onWaiting?: () => void,
): Promise<void> {
  let claimed = false;
  let observer: MutationObserver | undefined;
  try {
    signal.throwIfAborted();
    if (attempted.has(prepared)) throw new SendError("already_attempted");
    prepared.verify();
    // Live Yandex reuses/suppresses an identical MessageSent toast while the
    // preceding item is mounted. Wait through its fade-out before the next
    // click, so this send can produce its own observable acknowledgement.
    await waitForPreviousYandexNotice(prepared, signal, onWaiting);
    const deadline = Date.now() + 10000;
    let button: HTMLElement | null = null;
    while (!(button = sendButton(prepared))) {
      signal.throwIfAborted();
      prepared.verify();
      if (Date.now() >= deadline) throw new SendError("button_missing");
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
    const baseline = notificationState(prepared);
    const baselineText = new Map<Node, string>();
    for (const state of baseline.values())
      if (state.firstText && state.acknowledgement)
        baselineText.set(state.firstText, state.acknowledgement);
    let confirmed = false;
    let contradicted = false;
    const refreshedText = new Set<Node>();
    const acknowledgements = new Set<Element>();
    const observeSuccess = (records: MutationRecord[] = []) => {
      if (!claimed) return;
      for (const record of records) {
        // Providers may publish the same acknowledgement into the same text
        // node for consecutive sends. A deliberate equal-value write is fresh;
        // changing an old toast's Undo/View links is not an acknowledgement.
        if (
          record.type === "characterData" &&
          normalize(record.oldValue) === normalize(record.target.textContent)
        )
          refreshedText.add(record.target);
      }
      const current = notificationState(prepared);
      // Toast expiry is normal. Replacing a success with an error/non-success
      // is not expiry and must revoke the previously observed evidence.
      for (const node of acknowledgements) {
        const text = normalize(node.textContent);
        if (text && !sentNotice.test(text)) contradicted = true;
      }
      for (const [node, state] of current) {
        const previous = baseline.get(node);
        if (
          failedNotice.test(state.text) &&
          (previous?.text !== state.text ||
            previous.firstText !== state.firstText)
        )
          contradicted = true;
        if (
          state.acknowledgement &&
          state.firstText &&
          // Wrapping/reordering old toasts changes their ancestor elements, not
          // the acknowledgement itself. Freshness follows its actual text node.
          (baselineText.get(state.firstText) !== state.acknowledgement ||
            refreshedText.has(state.firstText))
        )
          acknowledgements.add(node);
      }
      // The toast may expire before the editor's closing animation finishes.
      // A fresh explicit acknowledgement is still mandatory, with no later failure.
      if (contradicted) confirmed = false;
      else if (acknowledgements.size && editorGone(prepared)) confirmed = true;
    };
    const Observer = prepared.root.ownerDocument.defaultView?.MutationObserver;
    if (!Observer) throw new SendError("unexpected");
    observer = new Observer(observeSuccess);
    observer.observe(prepared.root.ownerDocument.documentElement, {
      subtree: true,
      childList: true,
      characterData: true,
      characterDataOldValue: true,
      attributes: true,
      attributeFilter: ["hidden", "aria-hidden", "style", "class"],
    });
    signal.throwIfAborted();
    prepared.verify();
    // Resolve again after verification: the selected node may have been replaced.
    const ready = sendButton(prepared);
    if (ready !== button) throw new SendError("button_missing");
    claimed = true;
    attempted.add(prepared);
    beforeClick();
    signal.throwIfAborted();
    button.click();
    // No await is allowed between the durable claim and this one click.
    const sentDeadline = Date.now() + 20000;
    while (Date.now() < sentDeadline) {
      signal.throwIfAborted();
      observeSuccess();
      if (confirmed) return;
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
    throw new SendUncertainError();
  } catch (error) {
    if (claimed) throw new SendUncertainError();
    if (signal.aborted) throw new SendError("cancelled");
    if (error instanceof SendError || error instanceof EditorError) throw error;
    throw new SendError("unexpected");
  } finally {
    observer?.disconnect();
  }
}
