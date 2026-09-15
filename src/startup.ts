import { cleanExpired } from "./queue";
import { runWorker, store } from "./transport";
import { mountUI } from "./ui";

export function startApplication() {
  // Always mount first, even on worker tabs or when storage is unavailable.
  const ui = mountUI();
  const cleanup = () => {
    try {
      cleanExpired(store);
    } catch {
      ui.report(
        "Кнопка готова, но хранилище Tampermonkey недоступно. Автоматическая подготовка писем может быть недоступна.",
      );
    }
  };
  cleanup();
  const timer = setInterval(cleanup, 60000);
  const ready = runWorker().catch(() => {
    ui.report(
      "Не удалось восстановить задание этой вкладки. Панель доступна по кнопке ниже.",
    );
  });
  return {
    ready,
    dispose() {
      clearInterval(timer);
      ui.dispose();
    },
  };
}
