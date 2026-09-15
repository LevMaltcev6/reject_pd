import type { DOMWindow } from "jsdom";

interface FakeInstance {
  status: "ready";
  editable(): { $: HTMLElement };
  setData(html: string, options?: { callback?: () => void }): void;
  fire(event: string): void;
  getData(): string;
}

/** Separate CKEditor state from the host app model: DOM-only edits cannot send. */
export function installMailEditorFixture(
  window: DOMWindow,
  provider: "gmail" | "yandex",
  exposeGlobals = true,
) {
  const document = window.document;
  const instances: Record<string, FakeInstance> = {};
  const models = new WeakMap<Element, string>();
  let nextId = 0;
  const api = { instances };
  Object.assign(window, {
    CKEDITOR: provider === "yandex" ? api : undefined,
    unsafeWindow: window,
  });
  if (exposeGlobals)
    Object.assign(globalThis, {
      CKEDITOR: provider === "yandex" ? api : undefined,
      unsafeWindow: window,
    });

  document.execCommand = (command, _showUI, value) => {
    if (command !== "insertText") return false;
    const selection = document.getSelection();
    if (!selection?.rangeCount) return false;
    const range = selection.getRangeAt(0);
    const parent =
      range.commonAncestorContainer.nodeType === 1
        ? (range.commonAncestorContainer as Element)
        : range.commonAncestorContainer.parentElement;
    const editable = parent?.closest<HTMLElement>(
      '[contenteditable="true"], [contenteditable="plaintext-only"]',
    );
    if (!editable) return false;
    range.deleteContents();
    const text = document.createTextNode(value || "");
    range.insertNode(text);
    range.setStartAfter(text);
    range.collapse(true);
    selection.removeAllRanges();
    selection.addRange(range);
    models.set(editable, editable.innerHTML);
    editable.dispatchEvent(
      new window.InputEvent("input", {
        bubbles: true,
        inputType: "insertText",
        data: value,
      }),
    );
    return true;
  };

  function register(body: HTMLElement) {
    let editorData = body.innerHTML;
    models.set(body, editorData);
    const instance: FakeInstance = {
      status: "ready",
      editable: () => ({ $: body }),
      setData(html, options) {
        window.setTimeout(() => {
          editorData = html;
          body.innerHTML = html;
          options?.callback?.call(instance);
        }, 0);
      },
      fire(event) {
        if (event !== "change") return;
        models.set(body, editorData);
        body.dispatchEvent(
          new window.InputEvent("input", {
            bubbles: true,
            inputType: "insertText",
            data: body.textContent,
          }),
        );
      },
      getData: () => editorData,
    };
    instances[`editor-${++nextId}`] = instance;
    return instance;
  }
  function modelHtml(body: Element) {
    return models.get(body) || "";
  }
  function modelText(body: Element) {
    return htmlText(modelHtml(body), document);
  }
  return { register, modelHtml, modelText, instances };
}

/** Test-side reading of paragraphs and BRs; keep paragraph assertions meaningful. */
export function htmlText(html: string, document: Document) {
  const element = document.createElement("div");
  element.innerHTML = html;
  for (const br of element.querySelectorAll("br")) br.replaceWith("\n");
  for (const block of element.querySelectorAll("p, div")) block.append("\n");
  return (element.textContent || "").replace(/\u00a0/g, " ").replace(/\n$/, "");
}

export function editorText(body: Element) {
  return htmlText(body.innerHTML, body.ownerDocument);
}

/** Model the observed x-bubbles commit boundary, separately from painted chips.
 * A single paste/blur commits its full list. Repeated scripted blur operations
 * can paint more chips while the application still retains the first commit.
 * This fixture represents the observed failure, not Yandex's private internals.
 */
export function installYandexRecipientFixture(
  window: DOMWindow,
  input: HTMLElement,
) {
  const document = window.document;
  let saved: string[] = [];
  let commits = 0;
  let enters = 0;
  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter") enters++;
    // Synthetic Enter has no native action; Yandex commits on focusout.
  });
  input.addEventListener("focusout", () => {
    const field =
      input instanceof window.HTMLInputElement ||
      input instanceof window.HTMLTextAreaElement;
    const nodes = field
      ? []
      : [...input.childNodes].filter(
          (node) => node.nodeType === window.Node.TEXT_NODE,
        );
    const value = field
      ? input.value
      : nodes.map((node) => node.textContent || "").join("");
    const addresses = value
      .split(",")
      .map((address) => address.trim())
      .filter(Boolean);
    if (!addresses.length) return;
    commits++;
    if (field) input.value = "";
    else nodes.forEach((node) => node.remove());
    for (const address of addresses) {
      const chip = document.createElement("span");
      chip.className = "composeYabble js-yabble yabble-compose";
      chip.setAttribute("data-email", address);
      chip.setAttribute("contenteditable", "false");
      chip.textContent = address;
      if (field) input.before(chip);
      else input.append(chip);
    }
    if (commits === 1) saved = addresses;
  });
  return {
    addresses: () => [...saved],
    commits: () => commits,
    enters: () => enters,
  };
}
