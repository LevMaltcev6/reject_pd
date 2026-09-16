export interface YandexSendFailure {
  code?: string;
  message?: string;
  httpStatus?: number;
}

export interface YandexSendResponseObserver {
  start(): void;
  getFailure(): YandexSendFailure | undefined;
  stop(): void;
}

function responseText(value: unknown): string | undefined {
  if (typeof value !== "string") return;
  const text = value
    .replace(
      /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/g,
      " ",
    )
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 512);
  return text || undefined;
}

function responseCode(value: unknown): string | undefined {
  const text = responseText(value);
  return text && /^[a-z0-9][a-z0-9_-]{0,79}$/i.test(text) ? text : undefined;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

const pendingStatuses = new Set([
  "undo_message_saved",
  "delayed_message_saved",
  "undo_paused",
]);

function failureFromResponse(
  data: unknown,
  httpStatus: number,
): YandexSendFailure | undefined {
  const httpFailure = httpStatus >= 400 ? { httpStatus } : undefined;
  const body = record(data);
  if (!body) return httpFailure;

  const error = record(body.error);
  const status = responseText(body.status);
  const serverError = responseText(body.error);
  const message = responseText(error?.message) || responseText(body.message);
  // These replies acknowledge storage/undo handling, not a rejected send.
  if (
    [status, serverError, message, responseText(error?.code)].some(
      (value) => value && pendingStatuses.has(value),
    )
  )
    return;

  // Match Yandex's do-send parser: `limited` is accepted like `status: ok`,
  // but an explicit error on that response still takes precedence.
  if ((body.status === "ok" || body.limited) && !body.error) return httpFailure;

  const code =
    responseCode(error?.code) ||
    responseCode(serverError) ||
    responseCode(message) ||
    responseCode(status);
  const reason = responseText(error?.message) || message || serverError;
  if (!code && !reason) return httpFailure;
  return {
    ...(code ? { code } : {}),
    ...(reason ? { message: reason } : {}),
    ...httpFailure,
  };
}

function isSendRequest(
  doc: Document,
  input: RequestInfo | URL,
  init?: RequestInit,
): boolean {
  try {
    // No request body, headers, or credentials are inspected or retained.
    const request =
      typeof input === "object" && "url" in input ? input : undefined;
    const address = request ? request.url : String(input);
    const url = new URL(address, doc.baseURI);
    const method = init?.method || request?.method || "GET";
    return (
      method.toUpperCase() === "POST" &&
      url.origin === doc.location.origin &&
      /(?:^|\/)do-send(?:\/|$)/.test(url.pathname) &&
      url.searchParams.get("_send") === "true" &&
      url.searchParams.get("_save") !== "true"
    );
  } catch {
    return false;
  }
}

/** Observe one send attempt without changing the page's request or response. */
export function observeYandexSendResponse(
  doc: Document,
): YandexSendResponseObserver {
  let active = false;
  let generation = 0;
  let failure: YandexSendFailure | undefined;
  let restore: (() => void) | undefined;

  return {
    start() {
      if (active) return;
      active = true;
      failure = undefined;
      const token = ++generation;
      try {
        // Tampermonkey's page window owns the fetch used by Yandex itself.
        const page =
          typeof unsafeWindow !== "undefined" && unsafeWindow
            ? unsafeWindow
            : doc.defaultView;
        if (!page || typeof page.fetch !== "function") return;
        const original = page.fetch;
        const descriptor = Object.getOwnPropertyDescriptor(page, "fetch");
        // Avoid invoking a foreign accessor/setter or replacing a locked API.
        if (descriptor && (!("value" in descriptor) || !descriptor.writable))
          return;
        let captured = false;
        const wrapped: typeof fetch = function (this: unknown, ...args) {
          const result = Reflect.apply(original, this, args) as ReturnType<
            typeof fetch
          >;
          try {
            if (
              active &&
              generation === token &&
              !captured &&
              isSendRequest(doc, ...args)
            ) {
              captured = true;
              // Return the original promise below; our branch only reads a clone.
              void result
                .then(async (response) => {
                  if (!active || generation !== token || response.status === 0)
                    return;
                  let data: unknown;
                  try {
                    data = await response.clone().json();
                  } catch {
                    // A malformed/unreadable response cannot establish rejection.
                  }
                  const observed = failureFromResponse(data, response.status);
                  if (active && generation === token) failure = observed;
                })
                .catch(() => {
                  // Network failures do not establish whether the mail was sent.
                });
            }
          } catch {
            // Observation must never interfere with the page's fetch call.
          }
          return result;
        };
        Object.defineProperty(page, "fetch", {
          ...(descriptor || {
            configurable: true,
            enumerable: true,
            writable: true,
          }),
          value: wrapped,
        });
        restore = () => {
          // Another extension may have installed a wrapper after ours.
          if (page.fetch !== wrapped) return;
          if (descriptor) Object.defineProperty(page, "fetch", descriptor);
          else Reflect.deleteProperty(page, "fetch");
        };
      } catch {
        // Missing page access or a locked fetch API leaves acknowledgement unknown.
      }
    },
    getFailure() {
      return failure ? { ...failure } : undefined;
    },
    stop() {
      active = false;
      ++generation;
      failure = undefined;
      try {
        restore?.();
      } catch {
        // Cleanup must not replace the result of the send attempt.
      }
      restore = undefined;
    },
  };
}
