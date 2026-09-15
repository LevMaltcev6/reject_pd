type Visibility = (element: Element) => boolean;

const editableSelector =
  'input, textarea, [contenteditable="true"], [contenteditable="plaintext-only"]';
const chipSelector =
  '.yabble-compose, .js-yabble, .composeYabble, .composeYabbles .nb-yabble, [data-testid="recipient-chip"]';
const toWrapper = ".ComposeRecipients-ToField, .tst-field-to";
const copyWrapper =
  ".ComposeRecipients-CcField, .ComposeRecipients-BccField, .tst-field-cc, .tst-field-bcc";
const fromWrapper =
  ".ComposeAddressFrom, .ComposeRecipients-FromField, .tst-field-from";
const bodySelector =
  '.composeReact-MBody, .ComposeMbody, .cke_wysiwyg_div, [aria-label="Message Body"], [aria-label="Текст письма"]';
const emailPattern = /[A-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
const normalize = (text: string | null | undefined) =>
  (text || "")
    .trim()
    .replace(/[:：]\s*$/, "")
    .toLowerCase();
const toNames = new Set(["to", "кому"]);
const copyNames = new Set(["cc", "bcc", "копия", "скрытая копия"]);
const unrelatedNames = new Set([
  "from",
  "от",
  "от кого",
  "отправитель",
  "subject",
  "subjectbox",
  "subj",
  "тема",
]);

function names(element: Element, root: ParentNode): string[] {
  const values = [
    element.getAttribute("name"),
    element.getAttribute("aria-label"),
    element.getAttribute("title"),
  ];
  for (const id of (element.getAttribute("aria-labelledby") || "").split(
    /\s+/,
  )) {
    if (id)
      values.push(
        element.ownerDocument.getElementById(id)?.textContent || null,
      );
  }
  const labelledBy = (element.getAttribute("aria-labelledby") || "")
    .split(/\s+/)
    .filter(Boolean)
    .map((id) => element.ownerDocument.getElementById(id)?.textContent || "")
    .join(" ");
  if (labelledBy) values.push(labelledBy);
  if (element.id) {
    for (const label of root.querySelectorAll("label[for]")) {
      if (label.getAttribute("for") === element.id)
        values.push(label.textContent);
    }
  }
  const parentLabel = element.closest("label");
  if (parentLabel) values.push(parentLabel.textContent);
  return values.map(normalize).filter(Boolean);
}

function excluded(element: Element): boolean {
  return !!element.closest(`${bodySelector}, ${fromWrapper}`);
}

function editable(
  element: Element,
  isVisible: Visibility,
): element is HTMLElement {
  if (!isVisible(element) || excluded(element)) return false;
  if (
    element.closest(
      '[hidden], [aria-hidden="true"], [aria-disabled="true"], [aria-readonly="true"], [inert]',
    ) ||
    element.hasAttribute("disabled") ||
    element.hasAttribute("readonly") ||
    element.matches(":disabled")
  )
    return false;
  if (element.tagName === "INPUT") {
    const type = (element.getAttribute("type") || "text").toLowerCase();
    return ["text", "email", "search"].includes(type);
  }
  return (
    element.tagName === "TEXTAREA" ||
    ["true", "plaintext-only"].includes(
      element.getAttribute("contenteditable") || "",
    )
  );
}

function candidates(root: ParentNode, isVisible: Visibility) {
  return [...root.querySelectorAll(editableSelector)]
    .filter((element): element is HTMLElement => editable(element, isVisible))
    .map((element) => ({ element, names: names(element, root) }))
    .filter(
      (candidate) => !candidate.names.some((name) => unrelatedNames.has(name)),
    );
}

/** Resolve the To control independently from optional CC/BCC controls. */
export function resolveYandexTo(
  root: ParentNode,
  isVisible: Visibility,
): HTMLElement | null {
  const eligible = candidates(root, isVisible).filter(
    (candidate) =>
      !candidate.element.closest(copyWrapper) &&
      !candidate.names.some((name) => copyNames.has(name)),
  );
  const precise = eligible.filter(
    (candidate) =>
      candidate.names.some((name) => toNames.has(name)) ||
      candidate.element.closest(toWrapper),
  );
  if (precise.length) return precise.length === 1 ? precise[0].element : null;
  const fallback = eligible.filter((candidate) =>
    candidate.element.closest(".composeYabbles"),
  );
  return fallback.length === 1 ? fallback[0].element : null;
}

/** Read committed chips only; an address still in the editable field is pending. */
export function yandexRecipientAddresses(root: ParentNode): string[] {
  const addresses = new Set<string>();
  for (const chip of root.querySelectorAll(chipSelector)) {
    if (excluded(chip)) continue;
    const outerChip = chip.parentElement?.closest(chipSelector);
    if (outerChip && root.contains(outerChip)) continue;
    for (const value of [
      chip.getAttribute("data-email"),
      chip.getAttribute("email"),
      chip.getAttribute("data-hovercard-id"),
      chip.getAttribute("data-value"),
      chip.getAttribute("title"),
      chip.textContent,
    ]) {
      const matches = value?.match(emailPattern) || [];
      if (!matches.length) continue;
      for (const address of matches) addresses.add(address.toLowerCase());
      // A chip's data attributes are authoritative. Display text can include
      // adjacent action labels; never parse it as another recipient as well.
      break;
    }
  }
  return [...addresses].sort();
}

function pendingText(node: Node): string {
  if (node.nodeType === 3) return node.textContent || "";
  if (node.nodeType === 1 && (node as Element).matches(chipSelector)) return "";
  return [...node.childNodes].map(pendingText).join("");
}

/** Pending text only, excluding already committed address chips. */
export function yandexPendingRecipientText(element: HTMLElement): string {
  return element.tagName === "INPUT" || element.tagName === "TEXTAREA"
    ? (element as HTMLInputElement | HTMLTextAreaElement).value
    : pendingText(element);
}

/** Protect even uncommitted recipient edits before inserting any new address. */
export function yandexHasPendingRecipient(
  root: ParentNode,
  isVisible: Visibility,
): boolean {
  return candidates(root, isVisible).some((candidate) => {
    const element = candidate.element;
    const recipientField =
      candidate.names.some(
        (name) => toNames.has(name) || copyNames.has(name),
      ) || element.closest(`${toWrapper}, ${copyWrapper}, .composeYabbles`);
    if (!recipientField) return false;
    const text = yandexPendingRecipientText(element);
    return text.replace(/[\s\u200B-\u200D\u2060\uFEFF]/g, "").length > 0;
  });
}

/** Copy fields may be labelled through <label for> / aria-labelledby and may be
 * collapsed after committing a chip. Neither labels nor hidden state change the
 * recipient's delivery role, so this check deliberately ignores visibility. */
export function yandexHasCopyRecipients(root: ParentNode): boolean {
  for (const wrapper of root.querySelectorAll(copyWrapper)) {
    if (yandexRecipientAddresses(wrapper).length) return true;
  }
  const fields = [...root.querySelectorAll(editableSelector)]
    .filter((element) => !excluded(element))
    .map((element) => ({ element, names: names(element, root) }))
    .filter(
      (candidate) =>
        !candidate.names.some((name) => unrelatedNames.has(name)) &&
        (candidate.names.some(
          (name) => toNames.has(name) || copyNames.has(name),
        ) ||
          !!candidate.element.closest(
            `${toWrapper}, ${copyWrapper}, .composeYabbles`,
          )),
    );
  for (const candidate of fields) {
    if (
      !candidate.names.some((name) => copyNames.has(name)) &&
      !candidate.element.closest(copyWrapper)
    )
      continue;
    const field = candidate.element;
    if (
      (field.tagName === "INPUT" || field.tagName === "TEXTAREA") &&
      (field as HTMLInputElement | HTMLTextAreaElement).value.trim()
    )
      return true;
    if (yandexRecipientAddresses(field).length) return true;
    // Older widgets keep chips next to an input. Walk only within a container
    // dedicated to this field; crossing another recipient field would mix To/Cc.
    for (
      let region = field.parentElement;
      region && region !== root;
      region = region.parentElement
    ) {
      if (
        fields.some(
          (other) => other.element !== field && region!.contains(other.element),
        )
      )
        break;
      if (yandexRecipientAddresses(region).length) return true;
    }
  }
  return false;
}
