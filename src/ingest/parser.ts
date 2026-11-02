export interface ParsedModifiers {
  channelHint?: string | undefined;
  formatHint?: string | undefined;
  force: boolean;
  priority: 'normal' | 'high';
  cleanText: string;
}

const URL_REGEX = /https?:\/\/[^\s<>"{}|\^`\\[\]]+/gi;

export function extractUrls(text: string): string[] {
  const matches = text.match(URL_REGEX);
  if (!matches) return [];
  // Очистка от знаков препинания на конце ссылки
  return matches.map((u) => u.replace(/[.,;!?)]+$/, ''));
}

export function parseModifiers(input: string): ParsedModifiers {
  let text = input;
  let channelHint: string | undefined = undefined;
  let formatHint: string | undefined = undefined;
  let force = false;
  let priority: 'normal' | 'high' = 'normal';

  // --channel=slug или --channel slug
  const channelMatch = /--channel(?:=|\s+)([a-zA-Z0-9_-]+)/i.exec(text);
  if (channelMatch && channelMatch[1]) {
    channelHint = channelMatch[1];
    text = text.replace(channelMatch[0], '');
  }

  // --format=slug
  const formatMatch = /--format(?:=|\s+)([a-zA-Z0-9_-]+)/i.exec(text);
  if (formatMatch && formatMatch[1]) {
    formatHint = formatMatch[1];
    text = text.replace(formatMatch[0], '');
  }

  // --force
  if (/--force\b/i.test(text)) {
    force = true;
    text = text.replace(/--force\b/gi, '');
  }

  // --priority=high / --high
  if (/--priority(?:=|\s+)high\b/i.test(text) || /--high\b/i.test(text)) {
    priority = 'high';
    text = text.replace(/--priority(?:=|\s+)high\b/gi, '').replace(/--high\b/gi, '');
  }

  // Удаляем лишние пробелы и команду /ingest если она была
  const cleanText = text.replace(/^\/ingest\b/i, '').trim();

  return {
    channelHint,
    formatHint,
    force,
    priority,
    cleanText,
  };
}

export type PayloadType = 'url' | 'forward' | 'text' | 'file';

export function detectPayloadType(options: {
  text?: string | undefined;
  isForward?: boolean | undefined;
  isFile?: boolean | undefined;
}): { payloadType: PayloadType; urls: string[] } {
  if (options.isFile) {
    const urls = options.text ? extractUrls(options.text) : [];
    return { payloadType: 'file', urls };
  }

  if (options.isForward) {
    const urls = options.text ? extractUrls(options.text) : [];
    return { payloadType: 'forward', urls };
  }

  const text = options.text?.trim() ?? '';
  const urls = extractUrls(text);

  if (urls.length > 0) {
    return { payloadType: 'url', urls };
  }

  return { payloadType: 'text', urls };
}
