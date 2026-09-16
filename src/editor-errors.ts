// Only these static messages may leave the editor. Native exceptions can contain
// addresses or letter text, so they must never be shown or stored verbatim.
const messages = {
  cancelled:
    "Задание отменено. Уже внесённые в письмо данные остались в редакторе.",
  context_unavailable:
    "Страница почты изменилась или недоступна для этого задания. Подготовка остановлена.",
  compose_button_missing:
    "Не найдена единственная кнопка «Написать». Скрипт не смог открыть новое письмо.",
  body_missing:
    "После нажатия «Написать» не найдено поле текста письма. Скрипт не распознал редактор почты.",
  editor_root_missing:
    "Поле текста найдено, но не удалось определить границы редактора письма.",
  subject_missing: "Не найдено единственное поле темы письма.",
  recipients_missing: "Не найдено единственное поле «Кому».",
  existing_editor: "Во вкладке уже открыт редактор. Он не будет изменён.",
  existing_recipients:
    "В новом редакторе уже есть получатели. Скрипт остановился, чтобы не изменить ваше письмо.",
  existing_subject:
    "В новом редакторе уже заполнена тема. Скрипт остановился, чтобы не изменить ваше письмо.",
  existing_body:
    "Редактор уже содержит текст или нераспознанную подпись. Скрипт остановился, чтобы не стереть их.",
  body_write_failed:
    "Не удалось вставить текст в редактор почты. Отправка не запускалась. Текст можно скопировать из панели.",
  input_unavailable:
    "Найденный элемент почты не поддерживает ввод текста. Скрипт не смог заполнить поле.",
  interface_timeout: "Нужный элемент почтового интерфейса не появился вовремя.",
  unexpected:
    "Заполнение остановилось из-за внутренней ошибки скрипта. Подготовку письма подтвердить не удалось.",
} as const;

export type EditorErrorCode = keyof typeof messages;

export class EditorError extends Error {
  constructor(public readonly code: EditorErrorCode) {
    super(messages[code]);
    this.name = "EditorError";
  }
}

export function workerErrorMessage(
  error: unknown,
  signal: AbortSignal,
): string {
  if (signal.aborted) return messages.cancelled;
  return error instanceof EditorError
    ? messages[error.code]
    : messages.unexpected;
}
