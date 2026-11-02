import { z } from 'zod';
import type { Kysely } from 'kysely';
import type { Database } from '../db/types.js';
import type { LlmClient } from '../llm/client.js';
import type { ChatMessage, LlmStage } from '../llm/types.js';

export interface AgentTool<TInput = unknown, TResult = unknown> {
  name: string;
  description: string;
  schema: z.ZodType<TInput>;
  execute: (input: TInput, db: Kysely<Database>) => Promise<TResult>;
}

export interface AgentRunOptions<TOutput> {
  agentName: 'resolver' | 'scout' | 'analyst' | string;
  idempotencyKey: string;
  systemPrompt: string;
  inputPayload: Record<string, unknown>;
  tools: AgentTool<any, any>[];
  outputSchema: z.ZodType<TOutput>;
  maxSteps?: number | undefined;
  maxTimeoutMs?: number | undefined;
  maxBudgetUsd?: number | undefined;
  llm: LlmClient;
  db: Kysely<Database>;
}

export interface AgentRunResult<TOutput> {
  ok: boolean;
  status: 'ok' | 'timeout' | 'budget_exceeded' | 'failed';
  output?: TOutput | undefined;
  error?: string | undefined;
  steps: number;
  costUsd: number;
  trace: Array<{ step: number; tool?: string; args?: unknown; result?: unknown; error?: string }>;
}

/**
 * Чистый агентный рантайм без фреймворков (спека §11, Task 4.2).
 * Цикл while(steps < maxSteps) с проверкой потолков, tool-calling и валидацией Zod-выхода.
 */
export async function runAgent<TOutput>(
  options: AgentRunOptions<TOutput>,
): Promise<AgentRunResult<TOutput>> {
  const {
    agentName,
    idempotencyKey,
    systemPrompt,
    inputPayload,
    tools,
    outputSchema,
    maxSteps = 10,
    maxTimeoutMs = 60000,
    maxBudgetUsd = 0.5,
    llm,
    db,
  } = options;

  // 1. Проверка идемпотентности
  const existingRun = await db
    .selectFrom('agent_runs')
    .selectAll()
    .where('idempotency_key', '=', idempotencyKey)
    .executeTakeFirst();

  if (existingRun && existingRun.status === 'ok') {
    return {
      ok: true,
      status: 'ok',
      output: existingRun.output as TOutput,
      steps: existingRun.steps ?? 0,
      costUsd: Number(existingRun.cost_usd ?? 0),
      trace: (existingRun.trace as any) ?? [],
    };
  }

  const startTime = Date.now();
  let steps = 0;
  let totalCostUsd = 0;
  const trace: Array<{ step: number; tool?: string; args?: unknown; result?: unknown; error?: string }> = [];

  const toolsMap = new Map(tools.map((t) => [t.name, t]));
  const toolsDescription = tools
    .map((t) => `- ${t.name}: ${t.description}`)
    .join('\n');

  const messages: ChatMessage[] = [
    {
      role: 'system',
      content: `${systemPrompt}\n\nДоступные инструменты:\n${toolsDescription}\n\n` +
        `Формат ответа на каждом шаге:\n` +
        `Если нужен инструмент, ответь в формате:\n` +
        `TOOL: <имя_инструмента>\nARGS: <json_аргументы>\n\n` +
        `Когда готов финальный ответ, ответь строго в формате JSON без разметки:\n` +
        `FINAL_ANSWER: <json_ответ_по_схеме>`,
    },
    {
      role: 'user',
      content: `Входные данные:\n${JSON.stringify(inputPayload, null, 2)}`,
    },
  ];

  let finalOutput: TOutput | undefined = undefined;
  let runStatus: 'ok' | 'timeout' | 'budget_exceeded' | 'failed' = 'failed';
  let runError: string | undefined = undefined;

  const stage = (['resolver', 'scout', 'analyst'].includes(agentName) ? agentName : 'analyst') as LlmStage;

  while (steps < maxSteps) {
    // Проверка таймаута
    if (Date.now() - startTime > maxTimeoutMs) {
      runStatus = 'timeout';
      runError = `Превышен таймаут выполнения (${maxTimeoutMs} мс)`;
      break;
    }

    // Проверка бюджета
    if (totalCostUsd > maxBudgetUsd) {
      runStatus = 'budget_exceeded';
      runError = `Превышен бюджет агента ($${maxBudgetUsd})`;
      break;
    }

    steps++;

    try {
      const response = await llm.call({
        role: 'strong',
        stage,
        messages,
        temperature: 0.1,
      });

      totalCostUsd += response.costUsd ?? 0.0001;
      const text = response.raw.trim();

      // Проверка на финальный ответ
      if (text.includes('FINAL_ANSWER:')) {
        const jsonStr = text.split('FINAL_ANSWER:')[1]?.trim() ?? '';
        const cleanJson = jsonStr.replace(/^```(json)?\n?/, '').replace(/\n?```$/, '').trim();

        try {
          const parsed = JSON.parse(cleanJson);
          const validated = outputSchema.parse(parsed);
          finalOutput = validated;
          runStatus = 'ok';
          trace.push({ step: steps, result: 'Completed with valid schema' });
          break;
        } catch (schemaErr) {
          trace.push({ step: steps, error: `Invalid final output schema: ${schemaErr}` });
          messages.push({
            role: 'assistant',
            content: text,
          });
          messages.push({
            role: 'user',
            content: `Ошибка валидации JSON: ${schemaErr instanceof Error ? schemaErr.message : String(schemaErr)}. Исправь и верни корректный FINAL_ANSWER.`,
          });
          continue;
        }
      }

      // Проверка на вызов инструмента
      const toolMatch = text.match(/TOOL:\s*(\w+)\s*\nARGS:\s*(\{[\s\S]*\})/i);
      if (toolMatch) {
        const toolName = toolMatch[1]!;
        const rawArgs = toolMatch[2]!;
        const tool = toolsMap.get(toolName);

        if (!tool) {
          trace.push({ step: steps, tool: toolName, error: 'Инструмент не найден' });
          messages.push({ role: 'assistant', content: text });
          messages.push({ role: 'user', content: `Ошибка: неизвестный инструмент ${toolName}` });
          continue;
        }

        try {
          const parsedArgs = tool.schema.parse(JSON.parse(rawArgs));
          const toolResult = await tool.execute(parsedArgs, db);
          trace.push({ step: steps, tool: toolName, args: parsedArgs, result: toolResult });

          messages.push({ role: 'assistant', content: text });
          messages.push({
            role: 'user',
            content: `Результат инструмента ${toolName}:\n${JSON.stringify(toolResult, null, 2)}`,
          });
          continue;
        } catch (toolExecErr) {
          trace.push({ step: steps, tool: toolName, error: String(toolExecErr) });
          messages.push({ role: 'assistant', content: text });
          messages.push({ role: 'user', content: `Ошибка выполнения инструмента: ${toolExecErr}` });
          continue;
        }
      }

      // Если нет ни TOOL, ни FINAL_ANSWER
      messages.push({ role: 'assistant', content: text });
      messages.push({
        role: 'user',
        content: `Пожалуйста, используй TOOL: <имя> ARGS: <json> или верни FINAL_ANSWER: <json>`,
      });
    } catch (stepErr) {
      runError = `Ошибка на шаге ${steps}: ${stepErr instanceof Error ? stepErr.message : String(stepErr)}`;
      trace.push({ step: steps, error: runError });
      break;
    }
  }

  if (runStatus === 'failed' && !runError) {
    runError = `Превышено максимальное число шагов (${maxSteps})`;
  }

  // Запись трассы в базу данных
  await db
    .insertInto('agent_runs')
    .values({
      agent: agentName,
      idempotency_key: idempotencyKey,
      input: inputPayload as never,
      trace: trace as never,
      output: finalOutput as never,
      steps,
      cost_usd: totalCostUsd as never,
      status: runStatus,
    })
    .onConflict((oc) =>
      oc.column('idempotency_key').doUpdateSet({
        trace: trace as never,
        output: finalOutput as never,
        steps,
        cost_usd: totalCostUsd as never,
        status: runStatus,
      }),
    )
    .execute();

  return {
    ok: runStatus === 'ok',
    status: runStatus,
    output: finalOutput,
    error: runError,
    steps,
    costUsd: totalCostUsd,
    trace,
  };
}
