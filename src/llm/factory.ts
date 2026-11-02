import type { Kysely } from "kysely";
import type { Database } from "../db/types.js";
import type { LlmConfig, LlmProvider } from "./types.js";
import { LlmClient } from "./client.js";
import { HttpOpenAiProvider, MockLlmProvider } from "./provider.js";
import { resolveRoleConfig, type RoleConfigInput } from "./config.js";

export interface CreateLlmClientOptions {
  cheap?: RoleConfigInput | undefined;
  strong?: RoleConfigInput | undefined;
  defaultApiKey?: string | undefined;
  monthlyBudgetUsd?: number | undefined;
}

export function createLlmClient(
  db: Kysely<Database>,
  options: CreateLlmClientOptions = {},
): LlmClient {
  const cheapResolved = resolveRoleConfig("cheap", options.cheap, options.defaultApiKey);
  const strongResolved = resolveRoleConfig("strong", options.strong, options.defaultApiKey);

  const createProviderForRole = (cfg: typeof cheapResolved): LlmProvider => {
    if (cfg.provider === "mock" || (!cfg.apiKey && !cfg.baseUrl.includes("localhost"))) {
      return new MockLlmProvider();
    }
    return new HttpOpenAiProvider(cfg.apiKey, cfg.baseUrl);
  };

  const cheapProvider = createProviderForRole(cheapResolved);
  const strongProvider = createProviderForRole(strongResolved);

  const llmConfig: LlmConfig = {
    monthlyBudgetUsd: options.monthlyBudgetUsd ?? 10,
    models: {
      cheap: cheapResolved.pricing,
      strong: strongResolved.pricing,
    },
  };

  return new LlmClient(
    db,
    {
      cheap: cheapProvider,
      strong: strongProvider,
    },
    llmConfig,
  );
}
