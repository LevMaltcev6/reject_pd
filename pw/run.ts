// Isolated Playwright runner for the return-pd userscript (design:
// .ai/sdd/specs/001-playwright-isolated-launch/design.md §3).
// Launches a persistent-context browser with its own profile, injects the
// GM shim + bundle via an init script, waits through manual Yandex login,
// and stays alive while the user works in the panel.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { chromium } from "@playwright/test";
import { buildInitScript } from "./inject";

const PROFILE_DIR = ".pw-profile/yandex";
const BUNDLE_PATH = "dist/return-pd.user.js";
const MAIL_URL = "https://mail.yandex.ru";
const LOGIN_HEARTBEAT_MS = 60_000;

function stage(message: string) {
  console.log(`[pw] ${message}`);
}

export function isMailUrl(url: string): boolean {
  return /^https:\/\/mail\.yandex\.(ru|com|by|kz)\//.test(url);
}

/** Classify a launch failure: a Russian hint for the two known cases, or
 * undefined so the caller prints the original message unchanged. Never match
 * the "browserType.launchPersistentContext:" prefix itself — ALL Playwright
 * launch errors carry it (that misclassified a locked profile as a missing
 * Chromium download). */
export function friendlyLaunchError(error: unknown): string | undefined {
  const message = error instanceof Error ? error.message : String(error);
  if (
    /Executable doesn't exist|playwright install|was just installed or updated/i.test(
      message,
    )
  ) {
    return "Не установлен Chromium для Playwright. Выполните один раз: npx playwright install chromium";
  }
  if (
    /ProcessSingleton|SingletonLock|user data directory.*(?:in use|locked)|Browser closed unexpectedly|Target page, context or browser has been closed/i.test(
      message,
    )
  ) {
    return `Профиль «${PROFILE_DIR}» уже используется или не освободился — закройте окно и терминал предыдущего запуска, затем повторите.`;
  }
  return undefined;
}

async function main() {
  let bundle: string;
  try {
    bundle = readFileSync(BUNDLE_PATH, "utf8");
  } catch {
    console.error(
      `[pw] Не найден ${BUNDLE_PATH}. Скрипт «npm run pw» собирает его автоматически; вручную: npm run build`,
    );
    process.exitCode = 1;
    return;
  }

  stage("Запускаю изолированный браузер (профиль .pw-profile/yandex)…");
  let context;
  try {
    context = await chromium.launchPersistentContext(PROFILE_DIR, {
      headless: false,
      viewport: null,
    });
  } catch (error) {
    const hint = friendlyLaunchError(error);
    if (hint) console.error(`[pw] ${hint}`);
    console.error(
      "[pw] Ошибка запуска:",
      error instanceof Error ? error.message : String(error),
    );
    process.exitCode = 1;
    return;
  }

  // Ctrl+C closes the browser; the context "close" event then ends main().
  let closing = false;
  // Login-wait heartbeat; also stopped the moment the plugin activates so
  // "Ожидаю вход…" never appears after «Плагин активирован» (FR-008).
  let loginHeartbeat: ReturnType<typeof setInterval> | undefined;
  process.on("SIGINT", () => {
    if (closing) return;
    closing = true;
    stage("Закрываю браузер (Ctrl+C)…");
    void context.close().catch(() => {});
  });

  try {
    await context.exposeFunction("__pdActivated", () => {
      stage("Плагин активирован — работайте в панели как обычно.");
      if (loginHeartbeat) {
        clearInterval(loginHeartbeat);
        loginHeartbeat = undefined;
      }
    });

    const page = context.pages()[0] ?? (await context.newPage());
    await context.addInitScript(buildInitScript(bundle));

    stage("Открываю Яндекс Почту…");
    await page
      .goto(MAIL_URL, { waitUntil: "domcontentloaded" })
      .catch(() => {});

    if (isMailUrl(page.url())) {
      stage("Сессия найдена.");
    } else {
      stage(
        "Требуется вход в Яндекс. Выполните его в открывшемся браузере — после входа всё продолжится автоматически.",
      );
      const heartbeat = setInterval(
        () => stage("Ожидаю вход…"),
        LOGIN_HEARTBEAT_MS,
      );
      loginHeartbeat = heartbeat;
      try {
        await page.waitForURL((url: URL) => isMailUrl(url.toString()), {
          timeout: 0,
        });
      } finally {
        clearInterval(heartbeat);
        loginHeartbeat = undefined;
      }
      stage("Сессия найдена.");
    }

    stage("Браузер готов. Закройте окно или нажмите Ctrl+C для завершения.");
    await new Promise<void>((resolve) => context.on("close", () => resolve()));
    stage("Готово.");
  } catch (error) {
    if (closing || !context.pages) return; // shutdown path: quiet exit
    throw error;
  }
}

// Run only as a direct script (tsx pw/run.ts); imports for tests are side-effect free.
if (import.meta.url === pathToFileURL(resolve(process.argv[1] ?? "")).href) {
  void main();
}
