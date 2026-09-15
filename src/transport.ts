import {
  AttemptedError,
  UncertainError,
  PREFIX,
  RECEIPT_PREFIX,
  TTL,
  type SendReceipt,
  type Store,
  type Transport,
} from "./queue";
import { fillLetter, matchesMailContext } from "./adapters";
import { sendLetter, SendError, SendUncertainError } from "./send-letter";
import type { Account, DeliveryMode, Letter } from "./types";
import { EditorError, workerErrorMessage } from "./editor-errors";

export const store: Store = {
  get: (key) => GM_getValue(key),
  set: (key, value) => GM_setValue(key, value),
  delete: (key) => GM_deleteValue(key),
  keys: () => GM_listValues(),
};

/** Letters live only in this document's memory; the current mail UI does all work. */
export class CurrentTabTransport implements Transport {
  private active: { controller: AbortController; token: object } | undefined;
  constructor(
    private account: Account,
    private deliveryMode: DeliveryMode = "send",
  ) {}

  clear() {
    this.active?.controller.abort();
  }

  async prepare(
    letter: Letter,
    signal: AbortSignal,
    progress?: (stage: "waiting" | "sending") => void,
  ): Promise<void | "sent"> {
    if (signal.aborted) throw new Error(workerErrorMessage(undefined, signal));
    if (this.active)
      throw new Error(
        "Предыдущее письмо ещё обрабатывается. Дождитесь завершения.",
      );
    let contextMatches = false;
    try {
      contextMatches = matchesMailContext(this.account);
    } catch (cause) {
      throw new Error(workerErrorMessage(cause, signal));
    }
    if (!contextMatches)
      throw new Error(
        "Страница почты изменилась. Откройте панель в нужной почте заново.",
      );
    const operation = { controller: new AbortController(), token: {} };
    this.active = operation;
    const abort = () => operation.controller.abort();
    signal.addEventListener("abort", abort, { once: true });
    const view = document.defaultView;
    view?.addEventListener("pagehide", abort, { once: true });
    const localSignal = operation.controller.signal;
    const isLive = () =>
      this.active?.token === operation.token && !localSignal.aborted;
    const guard = () => {
      localSignal.throwIfAborted();
      if (!isLive()) throw new EditorError("cancelled");
      if (!matchesMailContext(this.account))
        throw new EditorError("context_unavailable");
    };
    const id = crypto.randomUUID();
    const receiptKey = RECEIPT_PREFIX + id;
    const expires = Date.now() + TTL;
    let committed = false;
    try {
      const prepared = await fillLetter(
        this.account,
        letter,
        localSignal,
        isLive,
      );
      guard();
      if (this.deliveryMode === "draft") return;
      const onWaiting = () => {
        guard();
        try {
          progress?.("waiting");
        } catch {
          // Waiting is a display state, not evidence that Send was clicked.
        }
        guard();
      };
      await sendLetter(
        prepared,
        localSignal,
        () => {
          guard();
          if (store.get(receiptKey)) throw new Error("Send already claimed");
          // Persist only an opaque attempt marker, never an account or letter.
          // It is written before the single click and survives cancellation/reload.
          committed = true;
          store.set(receiptKey, {
            id,
            expires,
            state: "sending",
          } satisfies SendReceipt);
          const receipt = store.get<SendReceipt>(receiptKey);
          if (receipt?.id !== id || receipt.state !== "sending")
            throw new Error("Send receipt unavailable");
          try {
            progress?.("sending");
          } catch {
            // A display callback is not part of the durable send claim. Its
            // failure cannot invalidate a correctly prepared and claimed letter.
          }
          guard();
        },
        onWaiting,
      );
      guard();
      store.set(receiptKey, {
        id,
        expires,
        state: "sent",
      } satisfies SendReceipt);
      return "sent";
    } catch (cause) {
      if (
        committed ||
        cause instanceof SendUncertainError ||
        cause instanceof UncertainError
      ) {
        try {
          store.set(receiptKey, {
            id,
            expires,
            state: "uncertain",
          } satisfies SendReceipt);
        } catch {
          // A failed acknowledgement never makes this attempt retryable.
        }
        throw new UncertainError();
      }
      const message =
        cause instanceof SendError
          ? new SendError(cause.code).message
          : workerErrorMessage(cause, localSignal);
      // These adapter failures happen before it clicks Compose. The user can
      // close an existing draft and explicitly retry the untouched queue item.
      if (
        cause instanceof EditorError &&
        ["existing_editor", "compose_button_missing"].includes(cause.code)
      )
        throw new Error(message);
      throw new AttemptedError(message);
    } finally {
      signal.removeEventListener("abort", abort);
      view?.removeEventListener("pagehide", abort);
      if (this.active?.token === operation.token) this.active = undefined;
    }
  }
}

/** Old tab URLs are inert after upgrading; never consume a stored mail job. */
export async function runWorker(): Promise<boolean> {
  const url = new URL(location.href);
  const id = url.searchParams.get("pd_task");
  if (!id) return false;
  url.searchParams.delete("pd_task");
  history.replaceState(history.state, "", url.href);
  if (/^[\da-f-]{36}$/.test(id)) {
    try {
      store.delete(PREFIX + id);
    } catch {
      // Even if legacy storage cannot be cleared, this version never runs it.
    }
  }
  return true;
}
