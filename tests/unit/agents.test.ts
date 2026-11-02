import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import {
  Kysely,
  DummyDriver,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler,
} from 'kysely';
import { runAgent } from '../../src/agents/runtime.js';
import { runResolverAgent, ResolverOutput } from '../../src/agents/resolver.js';
import { ScoutOutput } from '../../src/agents/scout.js';
import { AnalystOutput } from '../../src/agents/analyst.js';

describe('MCP Tools & Agent Security (M4, §13.1, Task 4.7)', () => {
  it('strictly prohibits direct publishing from agent tools layer', async () => {
    const toolsModule = await import('../../src/agents/tools/index.js');
    // Проверяем, что в слое инструментов нет методов publish / publishDraft
    expect((toolsModule as any).publishDraft).toBeUndefined();
    expect((toolsModule as any).publishPost).toBeUndefined();
  });
});

describe('Agent Runtime Loop (M4, §11, Task 4.2)', () => {
  it('executes tool-calling loop and returns zod-validated final answer', async () => {
    let callCount = 0;
    const mockLlm: any = {
      async call() {
        callCount++;
        if (callCount === 1) {
          return {
            raw: 'TOOL: mock_tool\nARGS: {"query": "deep learning"}',
            inputTokens: 20,
            outputTokens: 10,
            costUsd: 0.0001,
          };
        }
        return {
          raw: 'FINAL_ANSWER: {"found": true, "confidence": 0.95, "summary": "Found ArXiv paper"}',
          inputTokens: 40,
          outputTokens: 20,
          costUsd: 0.0002,
        };
      },
    };

    const mockDb: any = {
      selectFrom() {
        return {
          selectAll: () => ({
            where: () => ({
              executeTakeFirst: async () => null,
            }),
          }),
        };
      },
      insertInto() {
        return {
          values: () => ({
            onConflict: () => ({
              execute: async () => undefined,
            }),
          }),
        };
      },
    };

    const result = await runAgent({
      agentName: 'test-agent',
      idempotencyKey: 'test:key:1',
      systemPrompt: 'Test prompt',
      inputPayload: { foo: 'bar' },
      tools: [
        {
          name: 'mock_tool',
          description: 'A mock tool',
          schema: z.object({ query: z.string() }),
          execute: async (args) => ({ items: [`Result for ${args.query}`] }),
        },
      ],
      outputSchema: ResolverOutput,
      llm: mockLlm,
      db: mockDb,
    });

    expect(result.ok).toBe(true);
    expect(result.status).toBe('ok');
    expect(result.output?.found).toBe(true);
    expect(result.output?.confidence).toBe(0.95);
    expect(result.steps).toBe(2);
    expect(result.trace.length).toBeGreaterThan(0);
  });

  it('aborts when max steps are exceeded without final answer', async () => {
    const infiniteLlm: any = {
      async call() {
        return {
          raw: 'TOOL: mock_tool\nARGS: {"query": "loop"}',
          inputTokens: 10,
          outputTokens: 10,
          costUsd: 0.0001,
        };
      },
    };

    const mockDb: any = {
      selectFrom: () => ({ selectAll: () => ({ where: () => ({ executeTakeFirst: async () => null }) }) }),
      insertInto: () => ({ values: () => ({ onConflict: () => ({ execute: async () => undefined }) }) }),
    };

    const result = await runAgent({
      agentName: 'loop-agent',
      idempotencyKey: 'test:loop:1',
      systemPrompt: 'Test prompt',
      inputPayload: {},
      tools: [
        {
          name: 'mock_tool',
          description: 'A mock tool',
          schema: z.object({ query: z.string() }),
          execute: async () => ({ ok: true }),
        },
      ],
      outputSchema: ResolverOutput,
      maxSteps: 2,
      llm: infiniteLlm,
      db: mockDb,
    });

    expect(result.ok).toBe(false);
    expect(result.status).toBe('failed');
    expect(result.steps).toBe(2);
  });
});

/** Kysely без драйвера: нужен только чтобы скомпилировать sql`` в текст запроса. */
const sqlCompiler = new Kysely<never>({
  dialect: {
    createAdapter: () => new PostgresAdapter(),
    createDriver: () => new DummyDriver(),
    createIntrospector: (db) => new PostgresIntrospector(db),
    createQueryCompiler: () => new PostgresQueryCompiler(),
  },
});

describe('Resolver Agent Execution (M4, §5.3, Task 4.4)', () => {
  it('updates items canonical_url, external_signals and fact_sheets primary_url on discovery', async () => {
    let updatedItem: any = null;
    let updatedFactSheet: any = null;

    const mockDb: any = {
      selectFrom: (table: string) => ({
        selectAll: () => ({
          where: () => ({
            executeTakeFirst: async () => null,
          }),
        }),
        select: () => ({
          where: () => ({
            executeTakeFirst: async () => {
              if (table === 'items') return { story_id: 'story-123' };
              return null;
            },
          }),
        }),
      }),
      updateTable: (table: string) => ({
        set: (val: any) => ({
          where: () => ({
            execute: async () => {
              if (table === 'items') updatedItem = val;
              if (table === 'fact_sheets') updatedFactSheet = val;
            },
          }),
        }),
      }),
      insertInto: () => ({
        values: () => ({
          onConflict: () => ({
            execute: async () => undefined,
          }),
        }),
      }),
    };

    const mockLlm: any = {
      call: async () => ({
        raw: 'FINAL_ANSWER: {"found": true, "primaryUrl": "https://github.com/org/repo", "sourceName": "GitHub", "confidence": 0.95, "summary": "Found repo"}',
        inputTokens: 30,
        outputTokens: 20,
        costUsd: 0.0001,
      }),
    };

    const result = await runResolverAgent(mockDb, mockLlm, {
      itemId: '3f4d99e6-3492-4751-a74a-60d22f3cab15',
      text: 'Пересказ нового открытого проекта на гитхабе',
    });

    expect(result.found).toBe(true);
    expect(result.primaryUrl).toBe('https://github.com/org/repo');
    expect(updatedItem.canonical_url).toBe('https://github.com/org/repo');
    // external_signals дописывается SQL-выражением (jsonb ||), а не перезаписывается
    // объектом: внешние прокси виральности из §15 должны пережить работу Resolver'а.
    const signalsSql = updatedItem.external_signals.compile(sqlCompiler).sql;
    expect(signalsSql).toContain('coalesce(external_signals');
    expect(signalsSql).toContain('resolved_primary_source');
    expect(updatedFactSheet).toEqual({
      primary_url: 'https://github.com/org/repo',
    });
  });
});

describe('Agent Schemas Validation (M4, §13.3)', () => {
  it('validates Resolver output schema', () => {
    const valid = ResolverOutput.safeParse({
      found: true,
      primaryUrl: 'https://arxiv.org/abs/2401.12345',
      sourceName: 'ArXiv',
      confidence: 0.9,
      summary: 'Original research paper',
    });
    expect(valid.success).toBe(true);
  });

  it('validates Scout output schema', () => {
    const valid = ScoutOutput.safeParse({
      foundItems: [
        {
          url: 'https://github.com/cool-ai/tool',
          title: 'Cool AI Tool',
          relevanceScore: 0.88,
          reasoning: 'Matches developer tools category',
        },
      ],
      summary: 'Found 1 new candidate',
    });
    expect(valid.success).toBe(true);
  });

  it('validates Analyst output schema', () => {
    const valid = AnalystOutput.safeParse({
      analysisPeriodDays: 7,
      summary: 'Weekly review: 15 published, 3 rejected',
      proposedDiff: {
        selectionRulesDiff: ['Must be technical', 'No marketing fluff'],
        weightsDiff: { recency: 0.35, quality: 0.65 },
      },
      justification: 'High reject rate on PR posts',
    });
    expect(valid.success).toBe(true);
  });
});
