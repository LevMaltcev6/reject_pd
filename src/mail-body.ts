/** CKEditor's DOM and the mail application's saved body are separate states. */
declare const unsafeWindow: Window | undefined;

interface CKEditorInstance {
  status: string;
  readOnly?: boolean;
  editable(): { $: unknown } | null;
  setData(html: string, options: { callback: () => void }): void;
  getData(): string;
  fire(event: string): unknown;
}
interface EditorWindow {
  CKEDITOR?: { instances?: Record<string, CKEditorInstance> };
}
const messages = {
  unavailable:
    "Не удалось подключиться к редактору текста почты. Письмо не отправлено.",
  write_failed:
    "Редактор почты не подтвердил сохранение текста. Письмо не отправлено.",
  mismatch:
    "Сохранённый текст письма отличается от подготовленного. Письмо не отправлено.",
  cancelled: "Заполнение текста остановлено. Письмо не отправлено.",
} as const;
export class MailBodyError extends Error {
  constructor(public readonly code: keyof typeof messages) {
    super(messages[code]);
    this.name = "MailBodyError";
  }
}

function guard(body: HTMLElement, signal: AbortSignal) {
  if (signal.aborted) throw new MailBodyError("cancelled");
  if (!body.isConnected) throw new MailBodyError("unavailable");
}
function canonical(text: string) {
  return text
    .replace(/\r\n?/g, "\n")
    .replace(/\u00a0/g, " ")
    .trim();
}

/** Read actual line/paragraph boundaries; textContent loses every <br> boundary. */
function renderedText(root: Element): string {
  let result = "";
  const appendBreak = (count: number) => {
    if (!result) return;
    const existing = result.match(/\n*$/)![0].length;
    if (existing < count) result += "\n".repeat(count - existing);
  };
  const visit = (node: Node, preserve: boolean) => {
    if (node.nodeType === 3) {
      const value = node.textContent || "";
      if (
        !preserve &&
        /^[\t\r\n\f ]*$/.test(value) &&
        (!result || result.endsWith("\n"))
      )
        return;
      result += preserve ? value : value.replace(/[\t\r\n\f ]+/g, " ");
      return;
    }
    if (node.nodeType !== 1) return;
    const element = node as HTMLElement;
    const tag = element.tagName.toLowerCase();
    if (["script", "style", "template", "noscript"].includes(tag)) return;
    if (element.hidden || element.getAttribute("aria-hidden") === "true")
      return;
    if (
      element.getAttribute("data-cke-filler") !== null ||
      element.getAttribute("data-cke-bogus") !== null
    )
      return;
    if (tag === "br") {
      result += "\n";
      return;
    }
    const paragraph = /^(p|h[1-6]|blockquote)$/.test(tag);
    const block =
      paragraph || /^(div|section|article|header|footer|li|tr|pre)$/.test(tag);
    if (block) appendBreak(paragraph ? 2 : 1);
    const literal =
      preserve ||
      tag === "pre" ||
      /^(pre|pre-wrap|break-spaces)$/.test(element.style?.whiteSpace || "");
    for (const child of element.childNodes) visit(child, literal);
    if (block) appendBreak(paragraph ? 2 : 1);
  };
  const preserve = /^(pre|pre-wrap|break-spaces)$/.test(
    (root as HTMLElement).style?.whiteSpace || "",
  );
  for (const child of root.childNodes) visit(child, preserve);
  // Whitespace introduced by pretty-printed HTML is not visible around a <br>.
  // Literal spaces are encoded as NBSP in our HTML, and stay intact here.
  return canonical(result.replace(/ *\n */g, "\n"));
}
function htmlText(html: string, body: HTMLElement) {
  const Parser = body.ownerDocument.defaultView?.DOMParser;
  if (!Parser) throw new MailBodyError("unavailable");
  const parsed = new Parser().parseFromString(html, "text/html");
  return renderedText(parsed.body);
}
function textHtml(text: string) {
  const escaped = text
    .replace(/\r\n?/g, "\n")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
  // Keep ordinary word spaces breakable so a long letter wraps naturally.
  // Only indentation/repeated spaces need NBSP to survive HTML whitespace rules.
  const html = escaped
    .split("\n")
    .map((line) =>
      line
        .replace(/ {2,}/g, (spaces) => ` ${"&nbsp;".repeat(spaces.length - 1)}`)
        .replace(/^ | $/g, "&nbsp;"),
    )
    .join("<br>");
  return `<p>${html}</p>`;
}
function editorWindow(body: HTMLElement): EditorWindow {
  // Only page-owned APIs can update the mail application's editor instance.
  return (
    typeof unsafeWindow !== "undefined" && unsafeWindow
      ? unsafeWindow
      : body.ownerDocument.defaultView || {}
  ) as EditorWindow;
}
function matchingEditor(body: HTMLElement): CKEditorInstance | undefined {
  const instances = editorWindow(body).CKEDITOR?.instances;
  if (!instances) return;
  const matches = Object.values(instances).filter((instance) => {
    try {
      return instance.editable?.()?.$ === body;
    } catch {
      return false;
    }
  });
  if (matches.length > 1) throw new MailBodyError("unavailable");
  const instance = matches[0];
  if (!instance || instance.status !== "ready" || instance.readOnly) return;
  if (
    typeof instance.setData !== "function" ||
    typeof instance.getData !== "function" ||
    typeof instance.fire !== "function"
  )
    throw new MailBodyError("unavailable");
  return instance;
}
async function readyEditor(body: HTMLElement, signal: AbortSignal) {
  const until = Date.now() + 5000;
  while (Date.now() < until) {
    guard(body, signal);
    const instance = matchingEditor(body);
    if (instance) return instance;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new MailBodyError("unavailable");
}
async function setEditorData(
  instance: CKEditorInstance,
  html: string,
  body: HTMLElement,
  signal: AbortSignal,
) {
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const finish = (error?: MailBodyError) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      signal.removeEventListener("abort", abort);
      if (error) reject(error);
      else resolve();
    };
    const abort = () => finish(new MailBodyError("cancelled"));
    const timeout = setTimeout(
      () => finish(new MailBodyError("write_failed")),
      5000,
    );
    signal.addEventListener("abort", abort, { once: true });
    try {
      guard(body, signal);
      instance.setData(html, { callback: () => finish() });
    } catch {
      finish(new MailBodyError(signal.aborted ? "cancelled" : "write_failed"));
    }
  });
}

/** Write through the editor's supported editing API, then retain its checkpoint. */
export async function writeMailBody(
  body: HTMLElement,
  text: string,
  signal: AbortSignal,
): Promise<{ verify(): void }> {
  try {
    guard(body, signal);
    const expected = canonical(text);
    if (!expected) throw new MailBodyError("write_failed");
    const hostname = body.ownerDocument.location?.hostname || "";
    const managed =
      !!editorWindow(body).CKEDITOR ||
      /^mail\.yandex\.(ru|com|by|kz)$/.test(hostname) ||
      body.matches(".cke_editable, .cke_wysiwyg_div, [data-cke-editor-id]");
    if (managed) {
      const instance = await readyEditor(body, signal);
      guard(body, signal);
      await setEditorData(instance, textHtml(text), body, signal);
      guard(body, signal);
      if (matchingEditor(body) !== instance)
        throw new MailBodyError("unavailable");
      // CKEditor change is a library event. A DOM InputEvent/change event is not
      // equivalent: the application's subscription must see the completed data.
      instance.fire("change");
      const verify = () => {
        try {
          guard(body, signal);
          if (matchingEditor(body) !== instance)
            throw new MailBodyError("unavailable");
          const stored = instance.getData(); // Never getData(true): that returns cached data.
          if (
            typeof stored !== "string" ||
            htmlText(stored, body) !== expected ||
            renderedText(body) !== expected
          )
            throw new MailBodyError("mismatch");
        } catch (error) {
          if (error instanceof MailBodyError) throw error;
          throw new MailBodyError("mismatch");
        }
      };
      verify();
      return { verify };
    }
    const doc = body.ownerDocument;
    if (typeof doc.execCommand !== "function")
      throw new MailBodyError("unavailable");
    const selection = doc.getSelection();
    if (!selection) throw new MailBodyError("unavailable");
    body.focus();
    const range = doc.createRange();
    range.selectNodeContents(body);
    selection.removeAllRanges();
    selection.addRange(range);
    guard(body, signal);
    // Native editing updates the browser's editing transaction and input events.
    // A direct DOM replacement would only paint text and is never a fallback.
    body.style.whiteSpace = "pre-wrap";
    if (!doc.execCommand("insertText", false, text))
      throw new MailBodyError("write_failed");
    const verify = () => {
      guard(body, signal);
      if (renderedText(body) !== expected) throw new MailBodyError("mismatch");
    };
    verify();
    return { verify };
  } catch (error) {
    if (error instanceof MailBodyError) throw error;
    throw new MailBodyError(signal.aborted ? "cancelled" : "write_failed");
  }
}
