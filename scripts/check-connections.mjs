#!/usr/bin/env node
/**
 * Проверка внешних связей M1: БД (pooler + direct) и Telegram.
 * Читает .env из корня, печатает только статусы — секреты не выводит.
 * Запуск: node scripts/check-connections.mjs [--send-test-message]
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { Pool } from 'pg';

const env = {};
for (const line of readFileSync(path.resolve('.env'), 'utf8').split('\n')) {
  const m = /^([A-Z_]+)=(.*)$/.exec(line.trim());
  if (m && !line.trim().startsWith('#')) env[m[1]] = m[2];
}

const results = [];
const ok = (name, detail) => results.push(`✅ ${name}${detail ? `: ${detail}` : ''}`);
const fail = (name, detail) => results.push(`❌ ${name}${detail ? `: ${detail}` : ''}`);

function parseUrl(u) {
  try {
    const x = new URL(u);
    return { user: decodeURIComponent(x.username), pass: decodeURIComponent(x.password), host: x.hostname, port: x.port, db: x.pathname.slice(1) };
  } catch {
    return null;
  }
}

async function checkDb(label, url) {
  const p = parseUrl(url);
  if (!p || /placeholder|xxx/.test(url)) {
    fail(label, 'URL не заполнен (плейсхолдер)');
    return null;
  }
  const pool = new Pool({ connectionString: url, max: 1, connectionTimeoutMillis: 10_000 });
  try {
    const v = await pool.query('select version()');
    const tables = await pool.query(
      `select table_name from information_schema.tables where table_schema='public' and table_name in ('channels','items','sources','_migrations') order by 1`,
    );
    const ext = await pool.query(`select extname from pg_extension where extname='vector'`);
    ok(
      label,
      `${v.rows[0].version.split(',')[0]}, таблиц: ${tables.rowCount}/4, pgvector: ${ext.rowCount ? 'есть' : 'НЕТ'}`,
    );
    return true;
  } catch (e) {
    fail(label, e.message);
    return false;
  } finally {
    await pool.end().catch(() => {});
  }
}

// --- БД ---
const directOk = await checkDb('БД direct (DATABASE_URL_DIRECT)', env.DATABASE_URL_DIRECT ?? '');

let poolerUrl = env.DATABASE_URL ?? '';
if (/placeholder|xxx/.test(poolerUrl)) {
  // выводим pooler-URL из direct: postgres.<ref>@aws-0-<region>.pooler.supabase.com:6543/postgres
  const p = parseUrl(env.DATABASE_URL_DIRECT ?? '');
  if (p) {
    const ref = p.host.replace(/^db\./, '').split('.')[0];
    const regions = ['eu-west-1', 'eu-central-1', 'eu-west-2'];
    for (const region of regions) {
      const candidate = `postgresql://${encodeURIComponent(p.user)}.${ref}:${encodeURIComponent(p.pass)}@aws-0-${region}.pooler.supabase.com:6543/postgres`;
      const pool = new Pool({ connectionString: candidate, max: 1, connectionTimeoutMillis: 8000 });
      try {
        await pool.query('select 1');
        await pool.end();
        poolerUrl = candidate;
        ok('БД pooler (выведен из direct, т.к. в .env плейсхолдер)', `${region}, порт 6543`);
        break;
      } catch (e) {
        await pool.end().catch(() => {});
        if (region === regions[regions.length - 1]) {
          fail('БД pooler (DATABASE_URL)', `плейсхолдер в .env, автоподбор не удался: ${e.message}`);
        }
      }
    }
  }
} else {
  await checkDb('БД pooler (DATABASE_URL)', poolerUrl);
}

// --- Telegram ---
const token = env.TELEGRAM_BOT_TOKEN ?? '';
if (!token || token.includes('123456')) {
  fail('Telegram', 'TELEGRAM_BOT_TOKEN не заполнен');
} else {
  const api = (method, body) =>
    fetch(`https://api.telegram.org/bot${token}/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body ?? {}),
    }).then(async (r) => ({ status: r.status, json: await r.json().catch(() => ({})) }));

  try {
    const me = await api('getMe');
    if (me.json.ok) ok('Telegram getMe', `@${me.json.result.username} (${me.json.result.first_name})`);
    else fail('Telegram getMe', JSON.stringify(me.json.description ?? me.json));

    const chatId = env.TELEGRAM_CHANNEL_CHAT_ID;
    if (chatId) {
      const chat = await api('getChat', { chat_id: chatId });
      if (chat.json.ok) {
        const c = chat.json.result;
        const type = c.type === 'private' ? 'ЛИЧНЫЙ ЧАТ (не канал!)' : c.type;
        ok('Telegram getChat(CHANNEL_CHAT_ID)', `${type}${c.title ? ` «${c.title}»` : ''}${c.username ? ` @${c.username}` : ''}`);
        if (c.type === 'private') {
          results.push('   ⚠️ CHANNEL_CHAT_ID указывает на пользователя: публикация уйдёт в личку, для канала нужен id вида -100…');
        }
      } else {
        fail('Telegram getChat(CHANNEL_CHAT_ID)', JSON.stringify(chat.json.description ?? chat.json));
      }
    } else {
      fail('Telegram', 'TELEGRAM_CHANNEL_CHAT_ID не заполнен');
    }

    if (!env.TELEGRAM_OWNER_CHAT_ID) {
      results.push('   ⚠️ TELEGRAM_OWNER_CHAT_ID отсутствует — api/scheduler/worker-light не стартуют (loadConfig требует)');
    }

    const wh = await api('getWebhookInfo');
    if (wh.json.ok) {
      const w = wh.json.result;
      ok('Telegram webhook', w.url ? `${w.url} (pending ${w.pending_update_count})` : 'не установлен');
    }

    if (process.argv.includes('--send-test-message')) {
      const sent = await api('sendMessage', { chat_id: chatId, text: '🔧 tce: проверка доступа прошла' });
      if (sent.json.ok) ok('Telegram sendMessage', `message_id=${sent.json.result.message_id}`);
      else fail('Telegram sendMessage', JSON.stringify(sent.json.description ?? sent.json));
    }
  } catch (e) {
    fail('Telegram', e.message);
  }
}

console.log(results.join('\n'));
if (directOk && poolerUrl && !/placeholder|xxx/.test(poolerUrl)) {
  console.log('\nDATABASE_URL для .env (pooler, transaction mode):');
  console.log(poolerUrl.replace(/:[^:@]*@/, ':***@'));
}
