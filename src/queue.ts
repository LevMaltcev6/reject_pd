import type { Account, DeliveryMode, Item, Letter } from "./types";
export interface Transport {
  prepare(
    letter: Letter,
    signal: AbortSignal,
    progress?: (stage: "waiting" | "sending") => void,
  ): Promise<void | "sent">;
}
export class Queue {
  items: Item[];
  running = false;
  private controller = new AbortController();
  constructor(
    letters: Letter[],
    private transport: Transport,
    private changed: () => void,
    private pauseAfterDraft = false,
  ) {
    this.items = letters.map((letter) => ({
      id: crypto.randomUUID(),
      letter,
      status: "queued",
    }));
  }
  private notify() {
    try {
      this.changed();
    } catch {
      // Rendering a status must not control delivery or strand a running queue.
      // The next update can restore the UI; never surface native DOM exceptions.
    }
  }
  stop() {
    this.controller.abort();
  }
  async run(retry = false) {
    if (this.running) return;
    this.running = true;
    this.controller = new AbortController();
    this.notify();
    try {
      for (const item of this.items) {
        if (this.controller.signal.aborted) break;
        if (
          item.status !== "queued" &&
          !(retry && item.status === "error" && !item.attempted)
        )
          continue;
        item.status = "opening";
        item.error = undefined;
        this.notify();
        try {
          const result = await this.transport.prepare(
            item.letter,
            this.controller.signal,
            (stage) => {
              item.status = stage;
              this.notify();
            },
          );
          item.status =
            result === "sent"
              ? "sent"
              : item.letter.missing.length || item.letter.actions.length
                ? "manual"
                : "filled";
        } catch (error) {
          item.status = error instanceof UncertainError ? "uncertain" : "error";
          item.error =
            error instanceof Error
              ? error.message
              : "Не удалось подготовить письмо.";
          item.attempted = error instanceof AttemptedError;
          // A failure may indicate an account change: always pause the remaining queue.
          this.notify();
          break;
        }
        this.notify();
        if (this.pauseAfterDraft && item.status !== "sent") break;
      }
    } finally {
      this.running = false;
      this.notify();
    }
  }
}
export class AttemptedError extends Error {}
export class UncertainError extends AttemptedError {
  constructor() {
    super(
      "Письмо могло быть отправлено, но подтверждение не получено. Проверьте «Отправленные» и не запускайте это письмо повторно, пока не проверите результат.",
    );
    this.name = "UncertainError";
  }
}
export const PREFIX = "return-pd:job:";
export const RECEIPT_PREFIX = "return-pd:receipt:";
export const TTL = 24 * 60 * 60 * 1000;
export interface SendReceipt {
  id: string;
  expires: number;
  state: "sending" | "sent" | "uncertain";
}
export interface Job {
  id: string;
  owner: string;
  created: number;
  expires: number;
  account: Account;
  letter: Letter;
  deliveryMode?: DeliveryMode;
  state: "waiting" | "claimed" | "sending" | "done" | "error" | "uncertain";
  result?: "draft" | "sent";
  error?: string;
}
export interface Store {
  get<T>(key: string): T | undefined;
  set(key: string, value: unknown): void;
  delete(key: string): void;
  keys(): string[];
}
export function cleanExpired(store: Store, now = Date.now()) {
  for (const key of store
    .keys()
    .filter((k) => k.startsWith(PREFIX) || k.startsWith(RECEIPT_PREFIX))) {
    const job = store.get<Job | SendReceipt>(key);
    if (!job || !Number.isFinite(job.expires) || job.expires <= now)
      store.delete(key);
  }
}
