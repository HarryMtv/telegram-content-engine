import { describe, expect, it } from 'vitest';
import { buildTemplateDraft, isValidDraft, TELEGRAM_MESSAGE_LIMIT } from '../../src/generation/template-draft.js';
import { encodeCallback, decodeCallback } from '../../src/bot/callbacks.js';
import { formatCandidateMessage, candidateKeyboard } from '../../src/bot/batch.js';

describe('buildTemplateDraft (M1)', () => {
  const input = {
    title: 'Anthropic open-sources tokenizer',
    snippet: 'Компания выложила код токенизатора.',
    url: 'https://example.com/a',
  };

  it('содержит заголовок, сниппет и ссылку', () => {
    const text = buildTemplateDraft(input);
    expect(text).toContain(input.title);
    expect(text).toContain(input.snippet);
    expect(isValidDraft(text, input.url)).toBe(true);
  });

  it('влезает в лимит 4096 даже с гигантским телом', () => {
    const text = buildTemplateDraft({ ...input, snippet: 'x'.repeat(20_000) });
    expect(text.length).toBeLessThanOrEqual(TELEGRAM_MESSAGE_LIMIT);
    expect(text).toContain(input.url);
    expect(text).toContain('…');
  });
});

describe('callback_data', () => {
  it('кодирует и декодирует publish/reject', () => {
    const draftId = '11111111-2222-3333-4444-555555555555';
    expect(decodeCallback(encodeCallback(draftId, 'publish'))).toEqual({ draftId, action: 'publish' });
    expect(decodeCallback(encodeCallback(draftId, 'reject'))).toEqual({ draftId, action: 'reject' });
  });

  it('не длиннее 64 байт', () => {
    expect(encodeCallback('11111111-2222-3333-4444-555555555555', 'publish').length).toBeLessThanOrEqual(64);
  });

  it('мусор не декодируется', () => {
    expect(decodeCallback('random-garbage')).toBeNull();
  });
});

describe('сообщение батча', () => {
  it('показывает скор с компонентами и кнопки двух действий', () => {
    const view = {
      draftId: '11111111-2222-3333-4444-555555555555',
      text: 'Пост',
      url: 'https://example.com/a',
      scoreTotal: 0.71,
      components: { trust: 0.9, freshness: 0.52 },
    };
    const msg = formatCandidateMessage(view);
    expect(msg).toContain('0.71');
    expect(msg).toContain('источник');
    expect(msg).toContain('свежесть');
    const kb = candidateKeyboard(view.draftId);
    expect(kb.length).toBeGreaterThanOrEqual(1);
    expect(kb[0]!.map((b) => b.text)).toContain('✅ Опубликовать');
  });
});
