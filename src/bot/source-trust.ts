import type { Kysely } from "kysely";
import type { Database } from "../db/types.js";
import type { RejectReasonKey } from "./taxonomy.js";

/**
 * Скользящее обновление trust_score источника по редакторским решениям (спека §8.3, §10.2).
 */
export async function updateSourceTrustOnDecision(
  db: Kysely<Database>,
  sourceId: string,
  action: "publish" | "reject",
  rejectReason?: RejectReasonKey | null,
): Promise<{ oldTrust: number; newTrust: number }> {
  const source = await db
    .selectFrom("sources")
    .select(["id", "trust_score"])
    .where("id", "=", sourceId)
    .executeTakeFirst();

  if (!source) return { oldTrust: 0.5, newTrust: 0.5 };

  const currentTrust = Number(source.trust_score);
  let newTrust = currentTrust;

  if (action === "publish") {
    // Небольшое поощрение за одобренную публикацию (+0.02)
    newTrust = Math.min(1.0, currentTrust + 0.02);
  } else if (action === "reject" && rejectReason === "unreliable_source") {
    // Штраф за отказ по причине «сомнительный источник» (-0.10)
    newTrust = Math.max(0.05, currentTrust - 0.10);
  }

  newTrust = Number(newTrust.toFixed(2));

  if (newTrust !== currentTrust) {
    await db
      .updateTable("sources")
      .set({ trust_score: newTrust as never })
      .where("id", "=", sourceId)
      .execute();
  }

  return { oldTrust: currentTrust, newTrust };
}
