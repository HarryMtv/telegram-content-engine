import { describe, it, expect } from 'vitest';
import { evaluateShadowDecision } from '../../src/autopublish/shadow.js';
import { checkAutopublishEligibility } from '../../src/autopublish/rules.js';
import { triggerKillSwitch, resetAgreementOnAutoPostRejection } from '../../src/autopublish/kill-switch.js';

describe('Shadow Mode & Agreement (M5, §14.1, Task 5.1)', () => {
  it('correctly determines wouldPublish based on score threshold', () => {
    const high = evaluateShadowDecision(0.82, 0.65);
    expect(high.wouldPublish).toBe(true);

    const low = evaluateShadowDecision(0.45, 0.65);
    expect(low.wouldPublish).toBe(false);
  });
});

describe('Autopublish Eligibility Rules (M5, §14.2, Task 5.2)', () => {
  const DAY_MS = 24 * 3600 * 1000;
  const daysAgo = (n: number) => new Date(Date.now() - n * DAY_MS);

  // 17 согласий и 3 расхождения (85%), растянутые на 14 дней так, чтобы накопленный
  // процент ни в один день не проваливался ниже порога — «≥85% over 14 consecutive days».
  const decisionsOver14Days = [
    ...Array.from({ length: 17 }, (_, i) => ({
      action: 'publish',
      score: 0.85,
      decided_at: daysAgo(13 - (i % 11)),
    })),
    ...Array.from({ length: 3 }, (_, i) => ({
      action: 'reject',
      score: 0.85,
      decided_at: daysAgo(2 - i),
    })),
  ];

  const createMockDb = (latestRejection: any = null, decisions: any[] = decisionsOver14Days) => {
    const mockDb: any = {
      selectFrom: (table: string) => {
        if (table === 'editorial_decisions') {
          const queryObj: any = {
            innerJoin: () => queryObj,
            select: () => queryObj,
            where: () => queryObj,
            orderBy: () => queryObj,
            limit: () => queryObj,
            executeTakeFirst: async () => latestRejection,
            execute: async () => decisions,
          };
          return queryObj;
        }
        if (table === 'posts') {
          return {
            select: () => ({
              where: () => ({
                where: () => ({
                  executeTakeFirst: async () => ({ count: '2' }),
                }),
              }),
            }),
          };
        }
        return {};
      },
    };
    return mockDb;
  };

  it('allows autopublish when all 5 conditions are satisfied', async () => {
    const mockDb = createMockDb();
    const res = await checkAutopublishEligibility(mockDb, {
      channelId: '3f4d99e6-3492-4751-a74a-60d22f3cab15',
      sourceType: 'rss',
      formatSlug: 'digest',
      currentHourUtc: 12, // within 06-20 UTC
      dailyCap: 5,
    });

    expect(res.allowed).toBe(true);
    expect(res.checks.agreementRateOk).toBe(true);
    expect(res.checks.sourceWhitelisted).toBe(true);
    expect(res.checks.formatAllowed).toBe(true);
    expect(res.checks.withinTimeWindow).toBe(true);
    expect(res.checks.dailyCapNotExceeded).toBe(true);
  });

  it('rejects autopublish when the 85% agreement spans less than 14 days', async () => {
    // Те же 20 решений с тем же процентом, но все за один день: серии нет.
    const sameDay = decisionsOver14Days.map((d) => ({ ...d, decided_at: daysAgo(0) }));
    const res = await checkAutopublishEligibility(createMockDb(null, sameDay), {
      channelId: '3f4d99e6-3492-4751-a74a-60d22f3cab15',
      sourceType: 'rss',
      formatSlug: 'digest',
      currentHourUtc: 12,
      dailyCap: 5,
    });

    expect(res.allowed).toBe(false);
    expect(res.checks.agreementRateOk).toBe(false);
    expect(res.reason).toContain('согласия');
  });

  it('rejects autopublish when source is not whitelisted', async () => {
    const mockDb = createMockDb();
    const res = await checkAutopublishEligibility(mockDb, {
      channelId: '3f4d99e6-3492-4751-a74a-60d22f3cab15',
      sourceType: 'untrusted_crawler',
      formatSlug: 'digest',
      currentHourUtc: 12,
    });

    expect(res.allowed).toBe(false);
    expect(res.checks.sourceWhitelisted).toBe(false);
    expect(res.reason).toContain('whitelist');
  });

  it('rejects autopublish outside allowed time window', async () => {
    const mockDb = createMockDb();
    const res = await checkAutopublishEligibility(mockDb, {
      channelId: '3f4d99e6-3492-4751-a74a-60d22f3cab15',
      sourceType: 'rss',
      formatSlug: 'digest',
      currentHourUtc: 3, // 03:00 UTC (outside 06-20)
    });

    expect(res.allowed).toBe(false);
    expect(res.checks.withinTimeWindow).toBe(false);
    expect(res.reason).toContain('окна публикации');
  });
});

describe('Kill Switch & Emergency Handlers (M5, §14.4, Task 5.3)', () => {
  it('triggers kill switch and cancels pending candidate drafts', async () => {
    const mockDb: any = {
      updateTable: () => ({
        set: () => ({
          where: () => ({
            where: () => ({
              returning: () => ({
                execute: async () => [{ id: '1' }, { id: '2' }, { id: '3' }],
              }),
            }),
          }),
        }),
      }),
    };

    const res = await triggerKillSwitch(mockDb, 'channel-123', 'Owner panic button');
    expect(res.activated).toBe(true);
    expect(res.cancelledAutoDraftsCount).toBe(3);
    expect(res.message).toContain('Kill switch активирован');
  });

  it('resets agreement counter when owner rejects an autopost', async () => {
    let insertedDecision: any = null;
    const mockDb: any = {
      selectFrom: () => ({
        select: () => ({
          where: () => ({
            executeTakeFirst: async () => ({ id: 'post-1', draft_id: 'draft-1', channel_id: 'ch-1', autopublished: true }),
          }),
        }),
      }),
      insertInto: () => ({
        values: (val: any) => ({
          execute: async () => {
            insertedDecision = val;
          },
        }),
      }),
    };

    const res = await resetAgreementOnAutoPostRejection(mockDb, 'post-1', 'Not aligned with tone');
    expect(res.reset).toBe(true);
    expect(res.message).toContain('сброшен в 0');
    expect(insertedDecision).not.toBeNull();
    expect(insertedDecision.draft_id).toBe('draft-1');
    expect(insertedDecision.action).toBe('reject');
    expect(insertedDecision.reject_reason).toBe('Not aligned with tone');
  });
});
