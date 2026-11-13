import fs from "node:fs";
import { NodeReadonlySqliteFactory } from "../engine/platform/sqlite";
import type { TeamsUsageDay } from "../shared/desktop-api";

/**
 * Reads the local history the app already keeps and reduces it to what a team
 * is allowed to see: per day, a token count, an estimated cost and the split
 * per tool.
 *
 * The database is opened read-only, so a Teams sync can never disturb the
 * engine's writes, and only the `usage_record` day rows are touched — the same
 * rows the engine sums for its own dashboard. Prompts, models used inside a
 * session and project names never leave this function.
 */
export function readUsageDays(databasePath: string, windowDays = 30): TeamsUsageDay[] {
  if (!databasePath || !fs.existsSync(databasePath)) return [];

  const since = new Date(Date.now() - (windowDays - 1) * 86_400_000).toISOString().slice(0, 10);
  const factory = new NodeReadonlySqliteFactory();
  let database: ReturnType<NodeReadonlySqliteFactory["open"]> | null = null;

  try {
    database = factory.open(databasePath);
    const rows = database.all("SELECT provider, payload FROM usage_record WHERE day >= ?", [since]);
    const byDay = new Map<string, { tokens: number; costMicros: number; tools: Record<string, number> }>();

    for (const row of rows) {
      const provider = typeof row.provider === "string" ? row.provider : "";
      let record: unknown = null;
      try {
        record = JSON.parse(String(row.record));
      } catch {
        continue;
      }
      if (!record || typeof record !== "object") continue;
      const day = record as {
        kind?: unknown;
        localDay?: unknown;
        totals?: { totalTokens?: unknown; estimatedCostMicrosUSD?: unknown };
      };
      if (day.kind !== "usage_day" || typeof day.localDay !== "string") continue;

      const tokens = Number(day.totals?.totalTokens ?? 0);
      const cost = Number(day.totals?.estimatedCostMicrosUSD ?? 0);
      if (!Number.isFinite(tokens) && !Number.isFinite(cost)) continue;

      const bucket = byDay.get(day.localDay) ?? { tokens: 0, costMicros: 0, tools: {} };
      bucket.tokens += Number.isFinite(tokens) ? Math.max(0, Math.round(tokens)) : 0;
      bucket.costMicros += Number.isFinite(cost) ? Math.max(0, Math.round(cost)) : 0;
      // A provider with no name only counts toward the day total.
      if (provider) {
        bucket.tools[provider] = (bucket.tools[provider] ?? 0) + (Number.isFinite(tokens) ? Math.max(0, Math.round(tokens)) : 0);
      }
      byDay.set(day.localDay, bucket);
    }

    return [...byDay.entries()]
      .map(([day, totals]) => ({
        day,
        tokens: totals.tokens,
        costMicros: totals.costMicros,
        tools: totals.tools
      }))
      .filter((entry) => entry.tokens > 0)
      .sort((a, b) => a.day.localeCompare(b.day));
  } catch {
    // A locked or missing database is not an error worth showing: the Teams
    // window simply says there is nothing to share yet.
    return [];
  } finally {
    database?.close();
  }
}
