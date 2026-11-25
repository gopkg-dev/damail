/**
 * 验证码常被误判进垃圾邮件：垃圾邮件里的新邮件也做 AI 分析，只推送验证码、不执行规则；
 * 「验证码」分类的数量和列表算上垃圾邮件，其他分类照旧不算。
 */
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { and, eq } from 'drizzle-orm';
import { after, before, describe, test } from 'node:test';
import { setup, type Env } from './helpers.js';

let env: Env;
let jobsMod: typeof import('../src/services/jobs.js');
let mailMod: typeof import('../src/services/mail.js');
let aiServer: http.Server;
let channelId: number;
let inboxId: number;
let junkId: number;

// ---- 假 AI：主题里有 6 位数字就当验证码，否则当营销邮件 ----
function startFakeAi() {
  aiServer = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const code = body.match(/\b(\d{6})\b/)?.[1];
      const out = {
        category: code ? 'verification' : 'marketing',
        priority: 'high',
        summary: code ? `验证码 ${code}` : '促销',
        needs_reply: false,
        verification_codes: code ? [code] : [],
        amounts: [],
        due_date: null,
        tracking_numbers: [],
        action_items: [],
        labels: [],
      };
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(out) } }], usage: { prompt_tokens: 10, completion_tokens: 10 } }));
    });
  });
  return new Promise<number>((r) => aiServer.listen(0, '127.0.0.1', () => r((aiServer.address() as AddressInfo).port)));
}

let uid = 2000;
async function addMessage(folderId: number, subject: string) {
  const n = uid++;
  const [m] = await env.db
    .insert(env.schema.messages)
    .values({
      accountId: env.accounts.work.id,
      folderId,
      uid: n,
      threadId: `junk-t-${n}`,
      messageId: `<junk-${n}@tiktok.example>`,
      subject,
      fromAddress: 'no-reply@tiktok.example',
      fromName: 'TikTok',
      textBody: subject,
      date: new Date(Date.now() - 60_000),
    })
    .returning();
  return m!;
}

async function processMessage(id: number) {
  await jobsMod.enqueue('process_message', { messageId: id });
  const end = Date.now() + 15000;
  while (Date.now() < end) {
    const rows = await env.db
      .select()
      .from(env.schema.jobs)
      .where(and(eq(env.schema.jobs.type, 'process_message'), eq(env.schema.jobs.status, 'done')));
    const job = rows.find((j) => Number(j.payload.messageId) === id);
    if (job) return job.result as Record<string, unknown>;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`等待超时：邮件 ${id} 处理完成`);
}

const notifyEvents = async () =>
  (await env.db.select().from(env.schema.jobs).where(eq(env.schema.jobs.type, 'notify')))
    .filter((j) => Number(j.payload.channelId) === channelId)
    .map((j) => (j.payload.notice as { event: string }).event);

before(async () => {
  env = await setup();
  const port = await startFakeAi();
  const aiMod = await import('../src/services/ai.js');
  jobsMod = await import('../src/services/jobs.js');
  mailMod = await import('../src/services/mail.js');
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
      events: ['message.verification', 'message.important', 'message.received'],
    })
    .returning();
  channelId = ch!.id;
  // 一条匹配所有 TikTok 邮件的规则（推送到另一个渠道，不碰 IMAP）：垃圾邮件里不应执行
  const [ruleCh] = await env.db
    .insert(env.schema.channels)
    .values({ name: 'rule', type: 'dingtalk', configEnc: encryptChannelConfig({ webhook: 'http://127.0.0.1:9/robot' }), events: [] })
    .returning();
  await env.db.insert(env.schema.rules).values({
    name: 'tiktok',
    conditions: [{ field: 'from', op: 'contains', value: 'tiktok' }],
    actions: [{ type: 'notify', channelId: ruleCh!.id }],
  });
  const inbox = await env.db.query.folders.findFirst({ where: (f, { eq }) => eq(f.accountId, env.accounts.work.id) });
  inboxId = inbox!.id;
  const [junk] = await env.db
    .insert(env.schema.folders)
    .values({ accountId: env.accounts.work.id, path: 'Junk', name: 'Junk', specialUse: '\\Junk', syncEnabled: true })
    .returning();
  junkId = junk!.id;
  await jobsMod.startJobs();
});

after(async () => {
  jobsMod?.stopJobs();
  aiServer?.close();
  await env?.close();
});

describe('垃圾邮件里的验证码', () => {
  test('垃圾邮件：分析出验证码只推送验证码，不执行规则', async () => {
    const m = await addMessage(junkId, '837548 es tu código de verificación');
    const before = (await notifyEvents()).length;
    const r = await processMessage(m.id);
    assert.equal(r.category, 'verification');
    assert.equal(r.rules, undefined, '垃圾邮件不执行规则');
    assert.deepEqual(r.notified, [channelId]);
    assert.deepEqual((await notifyEvents()).slice(before), ['message.verification']);
  });

  test('垃圾邮件：没有验证码的分析了也不推送', async () => {
    const m = await addMessage(junkId, '限时促销，全场五折');
    const before = (await notifyEvents()).length;
    const r = await processMessage(m.id);
    assert.equal(r.category, 'marketing');
    assert.equal(r.rules, undefined);
    assert.equal(r.notified, undefined);
    assert.equal((await notifyEvents()).length, before);
  });

  test('收件箱照旧执行规则、推送', async () => {
    const m = await addMessage(inboxId, '255953 es tu código de verificación');
    const r = await processMessage(m.id);
    assert.ok(Array.isArray(r.rules) && r.rules.length === 1);
    assert.ok((r.notified as number[]).includes(channelId));
  });

  test('验证码分类的数量和列表算上垃圾邮件，其他分类不算', async () => {
    const scope = { accountIds: null };
    const stats = await mailMod.getStats(scope);
    assert.equal(stats.categories.verification?.total, 2, '收件箱 1 封 + 垃圾邮件 1 封');
    assert.equal(stats.categories.marketing, undefined, '垃圾邮件里的营销邮件不算');

    const list = await mailMod.listThreads({ scope, view: 'all', q: 'category:verification' });
    assert.equal(list.items.length, 2);
    const marketing = await mailMod.listThreads({ scope, view: 'all', q: 'category:marketing' });
    assert.equal(marketing.items.length, 0);
  });

  test('垃圾邮件视图集中列出所有邮箱的垃圾邮件，「全部邮件」不含', async () => {
    const scope = { accountIds: null };
    const stats = await mailMod.getStats(scope);
    assert.equal(stats.junkTotal, 2);
    const junk = await mailMod.listThreads({ scope, view: 'junk' });
    assert.equal(junk.items.length, 2);
    const all = await mailMod.listThreads({ scope, view: 'all' });
    const junkIds = new Set(junk.items.map((x) => x.threadId));
    assert.ok(all.items.every((x) => !junkIds.has(x.threadId)));
  });

  test('按会话移回收件箱只处理垃圾邮件里的邮件', async () => {
    const { threadMessageIds } = await import('../src/services/actions.js');
    const scope = { accountIds: null };
    const junk = await addMessage(junkId, '111111 es tu código de verificación');
    const inbox = await addMessage(inboxId, '222222 es tu código de verificación');
    assert.deepEqual(await threadMessageIds(scope, [junk.threadId], 'inbox'), [junk.id]);
    assert.deepEqual(await threadMessageIds(scope, [inbox.threadId], 'inbox'), []);
  });
});
