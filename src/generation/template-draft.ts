/**
 * Шаблонный черновик M1 (без LLM, спека §14 M1): сборка поста из материала.
 * LLM-контур FactSheet→Draft приходит в M2. Пост обязан содержать
 * ссылку на первоисточник и влезать в лимит сообщения Telegram (4096).
 */
export const TELEGRAM_MESSAGE_LIMIT = 4096;

export interface TemplateInput {
  title: string;
  snippet: string;
  url: string;
  sourceLabel?: string;
}

export function buildTemplateDraft(input: TemplateInput): string {
  const header = input.title.trim();
  const body = input.snippet.trim();
  const source = input.sourceLabel ? `\n\n— ${input.sourceLabel}` : '';

  const parts = [header];
  if (body) parts.push(body);
  parts.push(input.url + source);

  let text = parts.join('\n\n');
  if (text.length > TELEGRAM_MESSAGE_LIMIT) {
    // ужимаем тело, ссылка и заголовок неприкосновенны
    const fixed = header.length + '\n\n'.length + `\n\n${input.url}${source}`.length;
    const room = TELEGRAM_MESSAGE_LIMIT - fixed - 1; // 1 на …
    text = `${header}\n\n${body.slice(0, Math.max(0, room))}…\n\n${input.url}${source}`;
  }
  return text;
}

/** Проверка контрактных свойств поста M1: ссылка есть, лимит соблюдён. */
export function isValidDraft(text: string, url: string): boolean {
  return text.includes(url) && text.length <= TELEGRAM_MESSAGE_LIMIT;
}
