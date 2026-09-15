/** A separate document keeps even host-window capture listeners away from editing.
 * Stopping propagation inside Shadow DOM is too late for those listeners.
 * This frame is local about:blank; no messages, URLs or remote resources are used.
 */
export async function createSurface(doc = document) {
  const frame = doc.createElement("iframe");
  frame.id = "return-pd-ui";
  frame.title = "Обращения по ПД";
  frame.setAttribute("referrerpolicy", "no-referrer");
  frame.style.cssText =
    "position:fixed!important;bottom:0!important;right:0!important;width:260px!important;height:84px!important;border:0!important;margin:0!important;padding:0!important;background:transparent!important;z-index:2147483647!important;display:block!important;color-scheme:light!important;";
  // In a userscript the initial about:blank document can still be initializing.
  // Wait for the frame load instead of immediately writing into a transient body.
  await new Promise<void>((resolve) => {
    const timeout = setTimeout(resolve, 1500);
    frame.addEventListener(
      "load",
      () => {
        clearTimeout(timeout);
        resolve();
      },
      { once: true },
    );
    doc.body.append(frame);
  });
  const inner = frame.contentDocument;
  if (!inner?.body) {
    frame.remove();
    throw new Error("Не удалось открыть локальную панель.");
  }
  inner.documentElement.lang = "ru";
  inner.body.style.cssText = "margin:0;background:transparent;";
  const host = inner.createElement("div");
  inner.body.append(host);
  const root = host.attachShadow({ mode: "open" });
  return {
    frame,
    root,
    expand(open: boolean) {
      frame.style.setProperty("display", open ? "block" : "none", "important");
      frame.style.setProperty("width", open ? "100%" : "260px", "important");
      frame.style.setProperty("height", open ? "100%" : "84px", "important");
      frame.style.setProperty("bottom", "0", "important");
      frame.style.setProperty("right", "0", "important");
    },
    compact() {
      frame.style.setProperty("display", "block", "important");
      frame.style.setProperty("width", "min(380px, 100vw)", "important");
      frame.style.setProperty("height", "192px", "important");
      frame.style.setProperty("bottom", "84px", "important");
      frame.style.setProperty("right", "0", "important");
    },
  };
}
