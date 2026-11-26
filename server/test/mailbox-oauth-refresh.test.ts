/**
 * 邮箱 OAuth 令牌刷新错误处理与同步停止行为：
 * - invalid_grant / interaction_required / consent_required -> 标记需重新授权，提示重新授权
 * - invalid_client / unauthorized_client -> 提示检查应用配置，不标记需重新授权
 * - 网络错误 / 超时 / 5xx / 非 JSON -> 提示稍后自动重试，不标记需重新授权
 * - GraphWorker / AccountWorker 遇到需重新授权的错误时停止轮询/重连；其他错误保持重试
 * - 重新授权后清掉 tokenCache，不会继续返回旧令牌
 */
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { eq } from 'drizzle-orm';
import { setup, type Env } from './helpers.js';

let env: Env;
let oauthMod: typeof import('../src/services/oauth.js');
let graphMod: typeof import('../src/sync/graph.js');
let imapMod: typeof import('../src/sync/imap.js');
let sendMod: typeof import('../src/services/send.js');
let graphWorkerMod: typeof import('../src/sync/graph-worker.js');
let accountWorkerMod: typeof import('../src/sync/account-worker.js');
let cryptoMod: typeof import('../src/lib/crypto.js');
let i18nMod: typeof import('../src/i18n/index.js');

const origFetch = globalThis.fetch;

async function withMockFetch<T>(handler: typeof globalThis.fetch, fn: () => Promise<T>): Promise<T> {
  globalThis.fetch = handler;
  try {
    return await fn();
  } finally {
    globalThis.fetch = origFetch;
  }
}

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function fakeIdToken(email: string, name = 'Test User') {
  const header = Buffer.from(JSON.stringify({ alg: 'none' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({ email, name })).toString('base64url');
  return `${header}.${payload}.sig`;
}

async function createOAuthAccount(opts: { provider: 'outlook' | 'gmail'; email: string; enabled?: boolean; accessToken?: string; expiresAt?: number }) {
  const isGraph = opts.provider === 'outlook';
  const secretEnc = cryptoMod.encryptSecret(
    JSON.stringify({
      refreshToken: 'rt-initial',
      accessToken: opts.accessToken ?? 'at-expired',
      expiresAt: opts.expiresAt ?? Date.now() - 60_000,
    }),
  );
  const [row] = await env.db
    .insert(env.schema.accounts)
    .values({
      name: opts.email,
      email: opts.email,
      provider: opts.provider,
      protocol: isGraph ? 'graph' : 'imap',
      authType: 'oauth2',
      imapHost: isGraph ? 'outlook.office365.com' : 'imap.gmail.com',
      imapPort: 993,
      imapSecure: true,
      smtpHost: isGraph ? 'smtp.office365.com' : 'smtp.gmail.com',
      smtpPort: isGraph ? 587 : 465,
      smtpSecure: !isGraph,
      username: opts.email,
      secretEnc,
      enabled: opts.enabled ?? false,
      status: opts.enabled ? 'connecting' : 'disabled',
    })
    .returning();
  return row!;
}

async function waitFor<T>(fn: () => Promise<T | null | undefined | false>, timeoutMs = 5_000): Promise<T> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const v = await fn();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error('等待条件超时');
}

before(async () => {
  env = await setup();
  oauthMod = await import('../src/services/oauth.js');
  graphMod = await import('../src/sync/graph.js');
  imapMod = await import('../src/sync/imap.js');
  sendMod = await import('../src/services/send.js');
  graphWorkerMod = await import('../src/sync/graph-worker.js');
  accountWorkerMod = await import('../src/sync/account-worker.js');
  cryptoMod = await import('../src/lib/crypto.js');
  i18nMod = await import('../src/i18n/index.js');

  await oauthMod.saveOAuthConfig('microsoft', { clientId: 'ms-client', clientSecret: 'ms-secret' });
  await oauthMod.saveOAuthConfig('google', { clientId: 'gg-client', clientSecret: 'gg-secret' });
});

after(async () => {
  globalThis.fetch = origFetch;
  await env?.close();
});

describe('OAuth 令牌刷新错误分类', () => {
  test('invalid_grant / interaction_required / consent_required：标记需重新授权并保留原始说明', async () => {
    const msAcc = await createOAuthAccount({ provider: 'outlook', email: 'ms-reauth@example.com' });
    const ggAcc = await createOAuthAccount({ provider: 'gmail', email: 'gg-reauth@example.com' });

    for (const code of ['invalid_grant', 'interaction_required', 'consent_required'] as const) {
      await withMockFetch(
        async () => jsonResponse({ error: code, error_description: 'Token has been expired or revoked.\nMore details' }, 400),
        async () => {
          let caught: unknown;
          try {
            await oauthMod.accountCredentials(msAcc);
          } catch (err) {
            caught = err;
          }
          assert.ok(caught instanceof oauthMod.OAuthRefreshError, code);
          assert.equal(oauthMod.isReauthRequired(caught), true, code);
          assert.ok(caught.cause instanceof oauthMod.OAuthTokenError, code);
          assert.equal(caught.cause.code, code);
          assert.equal(caught.cause.status, 400);
          assert.match(caught.message, /微软授权已失效，请在邮箱管理里重新授权：Token has been expired or revoked\./);
          // 经由各通道 describe*Error 不会改写信息
          assert.equal(graphMod.describeGraphError(caught), caught.message);
          assert.equal(imapMod.describeImapError(caught), caught.message);
          assert.equal(sendMod.describeSmtpError(caught), caught.message);
        },
      );
    }

    // 英文文案 + Google 标签，且包含 authentication failed 字样时不被 describeImapError 误判
    await withMockFetch(
      async () => jsonResponse({ error: 'invalid_grant', error_description: 'authentication failed: revoked' }, 400),
      async () => {
        await i18nMod.withLocale('en', async () => {
          let caught: unknown;
          try {
            await oauthMod.accountCredentials(ggAcc);
          } catch (err) {
            caught = err;
          }
          assert.equal(oauthMod.isReauthRequired(caught), true);
          const msg = (caught as Error).message;
          assert.match(msg, /Google authorization has expired; re-authorize it under Mailboxes: authentication failed: revoked/);
          assert.equal(imapMod.describeImapError(caught), msg);
          assert.equal(sendMod.describeSmtpError(caught), msg);
        });
      },
    );
  });

  test('invalid_client / unauthorized_client：提示检查应用配置，不要求重新授权', async () => {
    const msAcc = await createOAuthAccount({ provider: 'outlook', email: 'ms-client-err@example.com' });

    for (const code of ['invalid_client', 'unauthorized_client'] as const) {
      await withMockFetch(
        async () => jsonResponse({ error: code, error_description: 'Invalid client secret provided.' }, 401),
        async () => {
          let caught: unknown;
          try {
            await oauthMod.accountCredentials(msAcc);
          } catch (err) {
            caught = err;
          }
          assert.ok(caught instanceof oauthMod.OAuthRefreshError, code);
          assert.equal(oauthMod.isReauthRequired(caught), false, code);
          assert.match(caught.message, /设置 → 授权应用/);
          assert.doesNotMatch(caught.message, /重新授权/);
          assert.equal(graphMod.describeGraphError(caught), caught.message);
        },
      );
    }

    await withMockFetch(
      async () => jsonResponse({ error: 'invalid_client', error_description: 'Bad secret' }, 401),
      async () => {
        await i18nMod.withLocale('en', async () => {
          let caught: unknown;
          try {
            await oauthMod.accountCredentials(msAcc);
          } catch (err) {
            caught = err;
          }
          assert.equal(oauthMod.isReauthRequired(caught), false);
          assert.match((caught as Error).message, /Settings → OAuth apps/);
          assert.doesNotMatch((caught as Error).message, /re-authorize/i);
        });
      },
    );
  });

  test('网络错误、超时、5xx、非 JSON 响应：提示稍后自动重试，不标记需重新授权，且不被 describeGraphError 改写', async () => {
    const msAcc = await createOAuthAccount({ provider: 'outlook', email: 'ms-transient@example.com' });

    const cases: Array<{ name: string; fn: typeof globalThis.fetch; expectReason: RegExp }> = [
      {
        name: '网络错误（带 cause.code）',
        fn: async () => {
          const cause = Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:443'), { code: 'ECONNREFUSED' });
          throw new TypeError('fetch failed', { cause });
        },
        expectReason: /ECONNREFUSED/,
      },
      {
        name: '超时（TimeoutError）',
        fn: async () => {
          throw new DOMException('The operation was aborted due to timeout', 'TimeoutError');
        },
        expectReason: /请求超时/,
      },
      {
        name: '5xx JSON 响应',
        fn: async () => jsonResponse({ error: 'server_error', error_description: 'Temporarily unavailable' }, 503),
        expectReason: /Temporarily unavailable/,
      },
      {
        name: '5xx 非 JSON 响应',
        fn: async () => new Response('<html>502 Bad Gateway</html>', { status: 502, headers: { 'content-type': 'text/html' } }),
        expectReason: /502/,
      },
    ];

    for (const c of cases) {
      await withMockFetch(c.fn, async () => {
        let caught: unknown;
        try {
          await oauthMod.accountCredentials(msAcc);
        } catch (err) {
          caught = err;
        }
        assert.ok(caught instanceof oauthMod.OAuthRefreshError, c.name);
        assert.equal(oauthMod.isReauthRequired(caught), false, c.name);
        assert.match(caught.message, /刷新微软授权失败，稍后会自动重试/, c.name);
        assert.match(caught.message, c.expectReason, c.name);
        assert.doesNotMatch(caught.message, /重新授权/, c.name);
        // 即使底层 cause 带有 ECONNREFUSED，describeGraphError 也不应覆盖 OAuthRefreshError 的消息
        assert.equal(graphMod.describeGraphError(caught), caught.message, c.name);
        assert.equal(imapMod.describeImapError(caught), caught.message, c.name);
      });
    }

    // 英文文案检查
    await withMockFetch(
      async () => new Response('bad gateway', { status: 502 }),
      async () => {
        await i18nMod.withLocale('en', async () => {
          let caught: unknown;
          try {
            await oauthMod.accountCredentials(msAcc);
          } catch (err) {
            caught = err;
          }
          assert.equal(oauthMod.isReauthRequired(caught), false);
          assert.match((caught as Error).message, /Failed to refresh Microsoft authorization; will retry automatically:/);
        });
      },
    );
  });
});

describe('Worker 停止重试与重新授权恢复', () => {
  test('GraphWorker 遇到 invalid_grant 时写入错误状态并清除全部轮询定时器；临时错误保持定时器', async () => {
    // 1) invalid_grant -> 停止轮询
    const deadAcc = await createOAuthAccount({ provider: 'outlook', email: 'ms-stop@example.com', enabled: true });
    let tokenHits = 0;
    await withMockFetch(
      async () => {
        tokenHits++;
        return jsonResponse({ error: 'invalid_grant', error_description: 'AADSTS70000: refresh token expired' }, 400);
      },
      async () => {
        const worker = new graphWorkerMod.GraphWorker(deadAcc.id);
        worker.start();
        try {
          const row = await waitFor(async () => {
            const a = await env.db.query.accounts.findFirst({ where: eq(env.schema.accounts.id, deadAcc.id) });
            return a?.status === 'error' ? a : null;
          });
          assert.match(row.lastError ?? '', /微软授权已失效，请在邮箱管理里重新授权/);
          // 等 drain 的 finally 跑完
          await waitFor(async () => Reflect.get(worker, 'draining') === null);
          assert.equal((Reflect.get(worker, 'timers') as unknown[]).length, 0, '定时器应已全部清除');
          assert.equal(Reflect.get(worker, 'running'), false, 'worker 应已停止运行');
          const hitsAfterStop = tokenHits;
          worker.requestSync('inbox');
          worker.requestSync('all');
          await new Promise((r) => setTimeout(r, 50));
          assert.equal(tokenHits, hitsAfterStop, '停止后不应再请求令牌接口');
        } finally {
          await worker.stop();
        }
      },
    );

    // 2) 503 临时错误 -> 保持定时器，允许后续自动重试
    const retryAcc = await createOAuthAccount({ provider: 'outlook', email: 'ms-retry@example.com', enabled: true });
    await withMockFetch(
      async () => new Response('Service Unavailable', { status: 503 }),
      async () => {
        const worker = new graphWorkerMod.GraphWorker(retryAcc.id);
        worker.start();
        try {
          const row = await waitFor(async () => {
            const a = await env.db.query.accounts.findFirst({ where: eq(env.schema.accounts.id, retryAcc.id) });
            return a?.status === 'error' ? a : null;
          });
          assert.match(row.lastError ?? '', /刷新微软授权失败，稍后会自动重试/);
          await waitFor(async () => Reflect.get(worker, 'draining') === null);
          assert.equal((Reflect.get(worker, 'timers') as unknown[]).length, 2, '非失效错误应保留两个轮询定时器');
          assert.equal(Reflect.get(worker, 'running'), true);
        } finally {
          await worker.stop();
        }
      },
    );
  });

  test('AccountWorker 遇到 invalid_grant 时写入错误状态并退出重连循环', async () => {
    const deadGmail = await createOAuthAccount({ provider: 'gmail', email: 'gg-stop@example.com', enabled: true });
    let tokenHits = 0;
    await withMockFetch(
      async () => {
        tokenHits++;
        return jsonResponse({ error: 'invalid_grant', error_description: 'Token has been expired or revoked.' }, 400);
      },
      async () => {
        const worker = new accountWorkerMod.AccountWorker(deadGmail.id);
        // 直接等待 loop() 结束：如果进入 backoff sleep 会等 5 秒以上，直接退出会在毫秒级完成
        const start = Date.now();
        await (Reflect.get(worker, 'loop') as () => Promise<void>).call(worker);
        assert.ok(Date.now() - start < 2_000, 'invalid_grant 应立即退出重连循环而非等待退避');
        assert.equal(tokenHits, 1);
        const row = await env.db.query.accounts.findFirst({ where: eq(env.schema.accounts.id, deadGmail.id) });
        assert.equal(row?.status, 'error');
        assert.match(row?.lastError ?? '', /Google授权已失效，请在邮箱管理里重新授权/);
      },
    );
  });

  test('重新授权后清掉 tokenCache，accountCredentials 立即返回新令牌', async () => {
    const acc = await createOAuthAccount({
      provider: 'outlook',
      email: 'ms-reauth-cache@example.com',
      accessToken: 'at-old-cached',
      expiresAt: Date.now() + 30 * 60_000,
    });
    // 先把旧令牌写入内存 tokenCache
    const beforeCreds = await oauthMod.accountCredentials(acc);
    assert.equal(beforeCreds.accessToken, 'at-old-cached');

    // 发起并完成重新授权
    const authUrl = new URL(await oauthMod.oauthAuthorizeUrl('microsoft', env.users.alice.id, acc.id));
    const state = authUrl.searchParams.get('state')!;
    await withMockFetch(
      async () =>
        jsonResponse({
          access_token: 'at-brand-new',
          refresh_token: 'rt-brand-new',
          expires_in: 3600,
          id_token: fakeIdToken(acc.email),
        }),
      async () => {
        const updated = await oauthMod.completeOAuth('microsoft', env.users.alice.id, state, 'auth-code-1');
        assert.equal(updated.id, acc.id);
        assert.equal(updated.status, 'connecting');
        assert.equal(updated.lastError, null);
        const afterCreds = await oauthMod.accountCredentials(updated);
        assert.equal(afterCreds.accessToken, 'at-brand-new');
      },
    );
  });
});
