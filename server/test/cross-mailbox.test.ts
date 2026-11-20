/**
 * 同一封邮件收到多个邮箱（issue #9）：AI 分析结果跨邮箱复用、重新分析同步到副本、推送只发一次、日报周报只算一次。
 * AI 用本机的假 OpenAI 兼容接口，只统计分类调用次数；推送只统计排进队列的 notify 任务，不真正投递。
 */
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { and, eq } from 'drizzle-orm';
import { after, before, beforeEach, describe, test } from 'node:test';
import { setup, type Env } from './helpers.js';

let env: Env;
let jobsMod: typeof import('../src/services/jobs.js');
let reportsMod: typeof import('../src/services/reports.js');
let aiServer: http.Server;
let channelId: number;
const folderIds: Record<'work' | 'home', number> = { work: 0, home: 0 };

// ---- 假 AI：每次分类调用返回不同的摘要，便于分辨是复用的还是重新调用的 ----
const ai = { calls: 0, priority: 'high', needsReply: true };
function startFakeAi() {
  aiServer = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      ai.calls++;
      const out = {
        category: 'work',
        priority: ai.priority,
        summary: `摘要 #${ai.calls}`,
        needs_reply: ai.needsReply,
        verification_codes: [],
        amounts: [],
        due_date: null,
        tracking_numbers: [],
        action_items: [`待办 #${ai.calls}`],
        labels: [],
      };
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(out) } }], usage: { prompt_tokens: 10, completion_tokens: 10 } }));
    });
  });
  return new Promise<number>((r) => aiServer.listen(0, '127.0.0.1', () => r((aiServer.address() as AddressInfo).port)));
}

let uid = 1000;
async function addCopy(account: 'work' | 'home', o: { messageId: string; from?: string; subject?: string; date?: Date }) {
  const [m] = await env.db
    .insert(env.schema.messages)
    .values({
      accountId: env.accounts[account].id,
      folderId: folderIds[account],
      uid: uid++,
      threadId: `t-${uid}`,
      messageId: o.messageId,
      subject: o.subject ?? '季度预算评审',
      fromAddress: o.from ?? 'boss@corp.example',
      fromName: 'Boss',
      textBody: '请周五前回复',
      date: o.date ?? new Date(Date.now() - 3600_000),
    })
    .returning();
  return m!;
}

async function waitFor<T>(fn: () => Promise<T | null | undefined | false>, what: string, ms = 15000): Promise<T> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = await fn();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`等待超时：${what}`);
}

/** 排一个 process_message 任务，等它跑完，返回任务结果 */
async function processMessage(id: number, payload: Record<string, unknown> = {}) {
  const before = await env.db.select({ id: env.schema.jobs.id }).from(env.schema.jobs);
  const seen = new Set(before.map((j) => j.id));
  await jobsMod.enqueue('process_message', { messageId: id, ...payload });
  return waitFor(async () => {
    const rows = await env.db
      .select()
      .from(env.schema.jobs)
      .where(and(eq(env.schema.jobs.type, 'process_message'), eq(env.schema.jobs.status, 'done')));
    const job = rows.find((j) => !seen.has(j.id) && Number(j.payload.messageId) === id);
    return job && (job.result as Record<string, unknown>);
  }, `邮件 ${id} 处理完成`);
}

const insightOf = (id: number) => env.db.query.messageInsights.findFirst({ where: (i, { eq }) => eq(i.messageId, id) });
const notifyJobs = async () =>
  (await env.db.select().from(env.schema.jobs).where(eq(env.schema.jobs.type, 'notify'))).filter((j) => Number(j.payload.channelId) === channelId);

before(async () => {
  env = await setup();
  const port = await startFakeAi();
  const aiMod = await import('../src/services/ai.js');
  jobsMod = await import('../src/services/jobs.js');
  reportsMod = await import('../src/services/reports.js');
  await import('../src/services/pipeline.js');
  await aiMod.saveAiSettings({
    enabled: true,
    channels: [
      {
        id: 't',
        name: 'fake',
        provider: 'openai',
        baseUrl: `http://127.0.0.1:${port}/v1`,
        apiKey: 'x',
        models: ['fake'],
        modelsSyncedAt: null,
        prices: {},
        priceRate: 1,
      },
    ],
    channelId: 't',
    model: 'fake',
    effort: 'low',
    assistantChannelId: null,
    assistantModel: null,
    assistantEffort: null,
    translateChannelId: null,
    translateModel: null,
    translateLanguage: '',
    analysisEnabled: true,
    accountIds: null,
  });
  const { encryptChannelConfig } = await import('../src/services/notify.js');
  const [ch] = await env.db
    .insert(env.schema.channels)
    .values({
      name: 'test',
      type: 'dingtalk',
      configEnc: encryptChannelConfig({ webhook: 'http://127.0.0.1:9/robot' }),
      events: ['message.important', 'message.received'],
    })
    .returning();
  channelId = ch!.id;
  for (const k of ['work', 'home'] as const) {
    const f = await env.db.query.folders.findFirst({ where: (f, { eq }) => eq(f.accountId, env.accounts[k].id) });
    folderIds[k] = f!.id;
  }
  await jobsMod.startJobs();
});

after(async () => {
  jobsMod?.stopJobs();
  aiServer?.close();
  await env?.close();
});

beforeEach(() => {
  ai.calls = 0;
  ai.priority = 'high';
  ai.needsReply = true;
});

describe('AI 分析跨邮箱复用', () => {
  test('另一个邮箱的副本已分析过：复用结果，不再调用 AI，推送只发一次', async () => {
    const a = await addCopy('work', { messageId: '<same-1@corp.example>' });
    const b = await addCopy('home', { messageId: '<same-1@corp.example>' });
    const notifyBefore = (await notifyJobs()).length;

    const ra = await processMessage(a.id);
    assert.equal(ai.calls, 1);
    assert.deepEqual(ra.notified, [channelId]);

    const rb = await processMessage(b.id);
    assert.equal(ai.calls, 1, '第二份不调用 AI');
    assert.equal(rb.copiedFrom, a.id);
    assert.equal(rb.notified, undefined, '已经为第一份推送过，不再推送');
    assert.deepEqual(rb.notifiedByCopy, [channelId]);

    const [ia, ib] = [await insightOf(a.id), await insightOf(b.id)];
    assert.equal(ib?.summary, ia?.summary);
    assert.deepEqual(ib?.extracted.actionItems, ia?.extracted.actionItems);
    assert.equal((await notifyJobs()).length, notifyBefore + 1);
  });

  test('两份同时到达：串行处理，只调用一次 AI、推送一次', async () => {
    const a = await addCopy('work', { messageId: '<same-2@corp.example>' });
    const b = await addCopy('home', { messageId: '<same-2@corp.example>' });
    const notifyBefore = (await notifyJobs()).length;
    await Promise.all([processMessage(a.id), processMessage(b.id)]);
    assert.equal(ai.calls, 1);
    assert.equal((await notifyJobs()).length, notifyBefore + 1);
  });

  test('Message-ID 相同但发件人或主题不同：不复用', async () => {
    const a = await addCopy('work', { messageId: '<forged@corp.example>' });
    const b = await addCopy('home', { messageId: '<forged@corp.example>', from: 'attacker@evil.example' });
    const c = await addCopy('home', { messageId: '<forged@corp.example>', subject: '别的主题' });
    await processMessage(a.id);
    const rb = await processMessage(b.id);
    const rc = await processMessage(c.id);
    assert.equal(ai.calls, 3);
    assert.equal(rb.copiedFrom, undefined);
    assert.equal(rc.copiedFrom, undefined);
    assert.notEqual((await insightOf(b.id))?.summary, (await insightOf(a.id))?.summary);
  });

  test('发件人地址大小写不同仍算同一封', async () => {
    const a = await addCopy('work', { messageId: '<case@corp.example>', from: 'Boss@Corp.Example' });
    const b = await addCopy('home', { messageId: '<case@corp.example>', from: 'boss@corp.example' });
    await processMessage(a.id, { analyzeOnly: true });
    const rb = await processMessage(b.id, { analyzeOnly: true });
    assert.equal(ai.calls, 1);
    assert.equal(rb.copiedFrom, a.id);
  });

  test('重新分析同步更新已分析过的副本', async () => {
    const a = await addCopy('work', { messageId: '<re@corp.example>' });
    const b = await addCopy('home', { messageId: '<re@corp.example>' });
    await processMessage(a.id, { analyzeOnly: true });
    await processMessage(b.id, { analyzeOnly: true });
    assert.equal(ai.calls, 1);

    const r = await processMessage(a.id, { analyzeOnly: true, reanalyze: true });
    assert.equal(ai.calls, 2);
    assert.deepEqual(r.syncedCopies, [b.id]);
    const [ia, ib] = [await insightOf(a.id), await insightOf(b.id)];
    assert.equal(ia?.summary, '摘要 #2');
    assert.equal(ib?.summary, '摘要 #2');
  });
});

describe('日报周报跨邮箱去重', () => {
  test('同一封邮件只算一次，按邮箱的统计各算各的；任何一份回复过就不算待回复', async () => {
    const day = new Date(Date.now() - 400 * 86400_000);
    const start = reportsMod.startOfDay(day);
    const until = reportsMod.addDays(start, 1);
    const at = new Date(start.getTime() + 10 * 3600_000);

    const a = await addCopy('work', { messageId: '<report@corp.example>', date: at });
    const b = await addCopy('home', { messageId: '<report@corp.example>', date: at });
    // 伪造的 Message-ID（发件人不同）单独算
    await addCopy('home', { messageId: '<report@corp.example>', date: at, from: 'other@else.example' });
    await processMessage(a.id, { analyzeOnly: true });
    await processMessage(b.id, { analyzeOnly: true });

    let data = await reportsMod.collectReportData(start, until, reportsMod.addDays(start, -1));
    assert.equal(data.received, 2);
    assert.equal(data.important.filter((i) => i.subject === '季度预算评审' && i.from === 'Boss').length, 1);
    assert.equal(data.needsReply.filter((i) => i.subject === '季度预算评审' && i.from === 'Boss').length, 1);
    const byAccount = Object.fromEntries(data.byAccount.map((r) => [r.accountId, r.received]));
    assert.equal(byAccount[env.accounts.work.id], 1);
    assert.equal(byAccount[env.accounts.home.id], 2);

    // 从另一个邮箱回复过
    await env.db.update(env.schema.messages).set({ answered: true }).where(eq(env.schema.messages.id, b.id));
    data = await reportsMod.collectReportData(start, until, reportsMod.addDays(start, -1));
    assert.equal(data.needsReply.filter((i) => i.subject === '季度预算评审' && i.from === 'Boss').length, 0);
  });
});
