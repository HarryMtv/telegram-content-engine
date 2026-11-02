# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Мультиканальная контент-система с человеком в цикле: собирает материалы из источников (RSS, HN, Reddit, HF Papers, GitHub Trending, Telegram-каналы), нормализует, дедуплицирует, кластеризует в Story, ранжирует под канал, генерирует черновики постов (FactSheet → Draft) и отдаёт владельцу на утверждение через Telegram-бота. **Ничего не публикуется без явного решения человека.**

Проект spec-driven: исходная спецификация — `docs/telegram-content-engine-spec.md` (внутренние ссылки «§N»), архитектурные решения — `openspec/changes/implement-content-engine/design.md` (ссылки «D1»–«D7»). Комментарии в коде ссылаются на эти документы — сохраняй эту практику. Этапы M1–M3 реализованы; M4 (агенты, `worker-agents`) и M5 — нет: скрипт `start:worker-agents` в package.json указывает на несуществующий entrypoint.

## Commands

```bash
npm run build          # tsc → dist/ (ОБЯЗАТЕЛЬНО перед migrate/seed/start:*)
npm run typecheck      # tsc --noEmit
npm run lint           # eslint src tests
npm test               # vitest run (все unit-тесты; integration skipped без TEST_DATABASE_URL)

# Один файл / один тест:
npm test -- tests/unit/mmr.test.ts
npx vitest run -t "имя теста"

# Интеграционные тесты (нужен Postgres+pgvector):
docker compose up -d db        # поднимает postgres на localhost:54329
TEST_DATABASE_URL=postgresql://tce:tce@localhost:54329/tce npm test -- tests/integration

npm run migrate        # применяет db/migrations/NNN_*.sql (раннер свой, в src/db/migrate.ts)
npm run seed           # канал + профиль + форматы + источники (нужен для loadChannelTuning)

npm run start:api      # вебхук бота + health + HTTP /ingest
npm run start:scheduler        # ставит периодические джобы (tick раз в минуту)
npm run start:worker-light     # исполняет джобы конвейера
npm run start:worker-mtproto   # чтение TG-каналов (строго 1 экземпляр)

node scripts/check-connections.mjs   # проверка БД/Telegram по .env
```

Все скрипты запускаются с `--env-file=.env`. Конфиг валидируется zod-схемой в `src/config.ts`; полный справочник переменных — `docs/CONFIGURATION.md`, шаблон — `.env.example`. Провайдеры LLM/эмбеддингов выбираются env-ом (`LLM_CHEAP_*`, `LLM_STRONG_*`, `EMBEDDING_*`); при наличии `OPENROUTER_API_KEY`/`DEEPSEEK_API_KEY` дефолтный провайдер подставляется автоматически.

## Architecture

**Один пакет, пять процессов** (design D1): `src/process/*.ts` — разные entrypoints одного приложения (api / scheduler / worker-light / worker-mtproto / worker-agents), один Docker-образ, разница только в команде запуска.

**Очередь** (design D3, D7): pg-boss v10 поверх того же Postgres, работает через Supabase transaction pooler (v10 поллит, LISTEN/NOTIFY нет). Джобы отправляются с `singletonKey` — один poll/fetch/batch не исполняется параллельно сам себе; все обработчики идемпотентны, ретраи безопасны. Имена джоб и полезные нагрузки — `src/queue/index.ts`, обработчики — `src/queue/handlers.ts`.

**Поток данных** (цепочка джоб):
1. `tick` (scheduler) → выставляет `poll-source` для источников, у которых истёк `poll_interval_s`
2. `poll-source` → adapter `discover()` (дёшево) → stage0-фильтры (`pipeline/stage0.ts`) → insert в `items` с дедупом (два слоя: `url_hash` канонизированного URL + `content_hash`) → выставляет `fetch-item`
3. `fetch-item` → adapter `fetch()` (дорого) → `fetch_status=ok` → эмбеддинг → инкрементальная кластеризация в `stories` (pgvector top-1 к центроиду, порог ~0.82, центроид бегущим средним — design D6)
4. `build-batch` → стадия 1 (числовой скоринг: relevance к profile_vector, trust, freshness, importance) → стадия 2 (LLM-триаж дешёвой моделью против `selection_rules` канала) → MMR-диверсификация → FactSheet → fact-check → черновик → `send-batch` владельцу
5. Владелец жмёт кнопку в боте → `editorial_decisions` (отказ требует причину из таксономии — каждая причина чинит свою подсистему)

**LLM-слой** (`src/llm/`): две роли моделей — `cheap` (триаж, FactSheet, черновики) и `strong` (кнопка «переписать лучше»), выбираются конфигом. `LlmClient` сам пишет аудит каждого вызова в `llm_calls` (токены, стоимость, латентность) — учёт встроен в клиент, а не в callers. `HttpOpenAiProvider` — один OpenAI-совместимый HTTP-клиент для openai/openrouter/deepseek/groq; `MockLlmProvider` — для тестов. Бюджетный guard (`llm/budget.ts`) блокирует стадию 3 при исчерпании месячного лимита ($10/мес).

**Эмбеддинги** (`src/embeddings/`): обязательны мультиязычные (кросс-языковой дедуп — ядро системы). Провайдер за интерфейсом: cohere (дефолт) / openai / mock. Размерность 1024 зафиксирована в схеме БД.

**БД**: Kysely + чистые SQL-миграции (`db/migrations/NNN_*.sql`, каждая в транзакции — design D2). pgvector; векторы хранятся только у материалов моложе 90 дней (еженедельная очистка `pipeline/cleanup.ts`). Ключ `service_role`, RLS не используется.

**Бот** (`src/bot/`): grammY, батч-интерфейс с inline-кнопками, 6 действий редактора, дифы правок, таксономия отказов, предложка/ручной ингест (`ingest/service.ts` — общий путь для бота и HTTP `/ingest`, с мгновенной обратной связью о дублях).

**Тесты**: unit-тесты (`tests/unit/`) используют моки (`MockLlmProvider`, mock-эмбеддинги); интеграционные (`tests/integration/`) ходят в реальный Postgres из `TEST_DATABASE_URL` и автоматически пропускаются без неё.

**Язык**: комментарии и пользовательские сообщения в коде — на русском. Соответствуй этому в новом коде.

---

## Behavioral Guidelines

Behavioral guidelines to reduce common LLM coding mistakes. Merge with project-specific instructions as needed.

**Tradeoff:** These guidelines bias toward caution over speed. For trivial tasks, use judgment.

### 1. Think Before Coding

**Don't assume. Don't hide confusion. Surface tradeoffs.**

Before implementing:
- State your assumptions explicitly. If uncertain, ask.
- If multiple interpretations exist, present them - don't pick silently.
- If a simpler approach exists, say so. Push back when warranted.
- If something is unclear, stop. Name what's confusing. Ask.

### 2. Simplicity First

**Minimum code that solves the problem. Nothing speculative.**

- No features beyond what was asked.
- No abstractions for single-use code.
- No "flexibility" or "configurability" that wasn't requested.
- No error handling for impossible scenarios.
- If you write 200 lines and it could be 50, rewrite it.

Ask yourself: "Would a senior engineer say this is overcomplicated?" If yes, simplify.

### 3. Surgical Changes

**Touch only what you must. Clean up only your own mess.**

When editing existing code:
- Don't "improve" adjacent code, comments, or formatting.
- Don't refactor things that aren't broken.
- Match existing style, even if you'd do it differently.
- If you notice unrelated dead code, mention it - don't delete it.

When your changes create orphans:
- Remove imports/variables/functions that YOUR changes made unused.
- Don't remove pre-existing dead code unless asked.

The test: Every changed line should trace directly to the user's request.

### 4. Goal-Driven Execution

**Define success criteria. Loop until verified.**

Transform tasks into verifiable goals:
- "Add validation" → "Write tests for invalid inputs, then make them pass"
- "Fix the bug" → "Write a test that reproduces it, then make it pass"
- "Refactor X" → "Ensure tests pass before and after"

For multi-step tasks, state a brief plan:
```
1. [Step] → verify: [check]
2. [Step] → verify: [check]
3. [Step] → verify: [check]
```

Strong success criteria let you loop independently. Weak criteria ("make it work") require constant clarification.

---

**These guidelines are working if:** fewer unnecessary changes in diffs, fewer rewrites due to overcomplication, and clarifying questions come before implementation rather than after mistakes.
