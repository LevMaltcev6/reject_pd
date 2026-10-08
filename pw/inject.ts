import { gmShimSource, MAIL_HOSTS } from "./gm-shim";

/** Compose the Playwright init script (design §3 "Инъекция"):
 * guard (top frame + mail host, mirrors @noframes/@match) → GM shim →
 * deferred bundle start (Tampermonkey's @run-at document-idle equivalent:
 * init scripts run before the DOM exists, the bundle expects document.body). */
export function buildInitScript(bundle: string): string {
  return [
    "(function () {",
    // @noframes: the panel creates its own about:blank iframe; loading the
    // plugin there would recurse.
    "  try {",
    "    if (window.self !== window.top) return;",
    "  } catch (error) {",
    "    return;",
    "  }",
    // @match mirror: MAIL_HOSTS must stay in sync with scripts/build.mjs.
    '  var host = (window.location.hostname || "").toLowerCase();',
    `  var allowedHosts = ${JSON.stringify([...MAIL_HOSTS])};`,
    "  if (allowedHosts.indexOf(host) === -1) return;",
    gmShimSource.trim(),
    // @run-at document-idle equivalent: defer until the DOM is parsed.
    "  function start() {",
    "    try {",
    '      if (typeof window.__pdActivated === "function") window.__pdActivated();',
    "    } catch (error) {",
    "      // Activation reporting must never block the plugin.",
    "    }",
    bundle,
    "  }",
    '  if (document.readyState === "loading") {',
    '    document.addEventListener("DOMContentLoaded", start);',
    "  } else {",
    "    start();",
    "  }",
    "})();",
  ].join("\n");
}
