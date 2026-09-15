export interface PanelHandle {
  open(): void;
  isAlive(): boolean;
  dispose(): void;
}

/** Keep the entry point independent of storage, account detection and frames. */
export function createLauncher(
  createPanel: (onClose: () => void) => Promise<PanelHandle>,
  doc = document,
) {
  const host = doc.createElement("div");
  host.id = "return-pd-launcher";
  host.style.cssText =
    "all:initial!important;position:fixed!important;right:20px!important;bottom:20px!important;z-index:2147483647!important;display:block!important;visibility:visible!important;opacity:1!important;pointer-events:auto!important;";
  const root = host.attachShadow({ mode: "open" });
  const style = doc.createElement("style");
  style.textContent =
    "button{font:14px system-ui;cursor:pointer;background:#204c3c;color:white;border:1px solid #93b6a3;border-radius:9px;padding:12px 16px;box-shadow:0 4px 20px #0003}button:focus-visible{outline:3px solid #9bd6b9}p{font:13px/1.5 system-ui;max-width:320px;padding:12px;background:white;color:#8d2929;border:1px solid #d6b3b3;border-radius:8px}[hidden]{display:none!important}";
  const trigger = doc.createElement("button");
  trigger.type = "button";
  const label = "↗ Обращения по ПД · 0.2.6";
  trigger.textContent = label;
  const failure = doc.createElement("p");
  failure.hidden = true;
  failure.setAttribute("role", "alert");
  root.append(style, failure, trigger);
  let disposed = false;
  let panel: PanelHandle | undefined;
  let pending: Promise<void> | undefined;
  function dropPanel() {
    const previous = panel;
    panel = undefined;
    try {
      previous?.dispose();
    } catch {
      /* Cleanup failures must never disable recovery. */
    }
  }
  function attach() {
    if (disposed || !doc.body) return;
    if (host.parentNode !== doc.body) doc.body.append(host);
    if (panel && !panel.isAlive()) {
      dropPanel();
      failure.textContent =
        "Почта перезагрузила форму. Подготовка остановлена; панель можно открыть снова.";
      failure.hidden = false;
    }
  }
  attach();
  // Mail SPAs may replace their root or the entire body after the userscript starts.
  const observer = new doc.defaultView!.MutationObserver(attach);
  observer.observe(doc.documentElement, { childList: true, subtree: true });
  function report(message: string) {
    if (disposed) return;
    failure.textContent = message;
    failure.hidden = false;
    attach();
  }
  async function openPanel() {
    trigger.textContent = "Открываю…";
    failure.hidden = true;
    try {
      if (panel && !panel.isAlive()) {
        dropPanel();
      }
      if (!panel) panel = await createPanel(() => trigger.focus());
      if (disposed) {
        dropPanel();
        return;
      }
      panel.open();
      // Remain above the newly appended frame. Never hide the recovery entry point.
      doc.body.append(host);
    } catch {
      dropPanel();
      doc.querySelector("iframe#return-pd-ui")?.remove();
      report(
        "Не удалось открыть форму. Кнопка работает — можно повторить запуск. Изоляция ввода от почты сохранена.",
      );
    } finally {
      trigger.textContent = label;
    }
  }
  function open() {
    if (disposed) return Promise.resolve();
    pending ??= openPanel().finally(() => {
      pending = undefined;
    });
    return pending;
  }
  trigger.onclick = () => void open();
  // A missing menu API must not remove the on-page button.
  try {
    GM_registerMenuCommand(
      "Обращения по ПД · 0.2.6 — открыть",
      () => void open(),
    );
  } catch {
    /* Button remains usable. */
  }
  return {
    open,
    report,
    dispose() {
      disposed = true;
      observer.disconnect();
      dropPanel();
      host.remove();
    },
  };
}
