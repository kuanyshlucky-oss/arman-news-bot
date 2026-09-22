import 'dotenv/config';
import http from 'http';
import cron from 'node-cron';
import { Telegraf } from 'telegraf';
import { fetchLatestPosts } from './scraper.js';
import { loadStore, saveStore } from './store.js';

const {
  BOT_TOKEN,
  ADMIN_CHAT_ID,
  TARGET_CHANNEL,
  SOURCE_CHANNEL = 'uto92',
  POLL_CRON = '*/5 * * * *',
  PORT = 3000,
} = process.env;

if (!BOT_TOKEN || !ADMIN_CHAT_ID || !TARGET_CHANNEL) {
  throw new Error('BOT_TOKEN, ADMIN_CHAT_ID and TARGET_CHANNEL must be set in the environment');
}

const bot = new Telegraf(BOT_TOKEN);

// Any error thrown inside a handler must never take down the polling loop —
// without this, one bad update (e.g. a stale callback query) kills the bot
// silently and every click after it stops working.
bot.catch((err) => console.error('Unhandled bot error:', err.message));

bot.start((ctx) => {
  ctx.reply(`Привет! Твой chat_id: ${ctx.chat.id}`);
});

// Telegram invalidates a callback query if it's not answered quickly enough
// ("query is too old"); that's expected for stale/queued clicks and must
// never throw past this point.
async function safeAnswerCbQuery(ctx, text) {
  try {
    await ctx.answerCbQuery(text);
  } catch (err) {
    console.error('answerCbQuery failed:', err.message);
  }
}

const TEXT_LIMIT = 4096;
const CAPTION_LIMIT = 1024;

// Telegram rejects messages/captions over its length limits, so the post
// body is trimmed to leave room for the source link (and an optional status
// line appended after a publish/reject decision).
function composeText(post, limit, suffix = '') {
  const tail = `\n\n🔗 Источник: ${post.link}${suffix}`;
  const body = post.text || '[пост без текста — см. источник]';
  const maxBody = Math.max(0, limit - tail.length);
  const truncated = body.length > maxBody ? `${body.slice(0, Math.max(0, maxBody - 1))}…` : body;
  return `${truncated}${tail}`;
}

function limitFor(post) {
  return post.photoUrl ? CAPTION_LIMIT : TEXT_LIMIT;
}

// Telegram's own servers often fail to fetch their own CDN URLs
// ("failed to get HTTP URL content") when passed straight to sendPhoto,
// so images are downloaded here and uploaded as a file instead.
async function downloadBuffer(url) {
  const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
  if (!res.ok) throw new Error(`Failed to download image: ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

async function finalizeMessage(ctx, post, statusLine) {
  const newText = composeText(post, limitFor(post), `\n\n${statusLine}`);
  const opts = { reply_markup: { inline_keyboard: [] } };
  try {
    if (post.photoUrl) {
      await ctx.editMessageCaption(newText, opts);
    } else {
      await ctx.editMessageText(newText, opts);
    }
  } catch (err) {
    console.error('finalizeMessage failed:', err.message);
  }
}

async function checkForNews() {
  const store = loadStore();
  try {
    const posts = await fetchLatestPosts(SOURCE_CHANNEL, store.lastSeenId);

    if (!store.initialized) {
      // First run ever: don't flood the admin with the channel's existing
      // history, just remember what's already there and start clean.
      if (posts.length) store.lastSeenId = Math.max(...posts.map((p) => p.id));
      store.initialized = true;
      saveStore(store);
      return;
    }

    for (const post of posts) {
      store.pending[post.id] = post;
      store.lastSeenId = Math.max(store.lastSeenId, post.id);

      const caption = composeText(post, limitFor(post));
      const keyboard = {
        inline_keyboard: [[
          { text: '✅ Опубликовать', callback_data: `pub:${post.id}` },
          { text: '❌ Отклонить', callback_data: `rej:${post.id}` },
        ]],
      };

      let sent;
      if (post.photoUrl) {
        try {
          const buffer = await downloadBuffer(post.photoUrl);
          sent = await bot.telegram.sendPhoto(
            ADMIN_CHAT_ID,
            { source: buffer, filename: `${post.id}.jpg` },
            { caption, reply_markup: keyboard }
          );
          const photos = sent.photo || [];
          if (photos.length) post.photoFileId = photos[photos.length - 1].file_id;
        } catch (err) {
          console.error(`Photo download/send failed for post ${post.id}, sending as text:`, err.message);
          post.photoUrl = null;
          await bot.telegram.sendMessage(ADMIN_CHAT_ID, composeText(post, TEXT_LIMIT), {
            reply_markup: keyboard,
          });
        }
      } else {
        await bot.telegram.sendMessage(ADMIN_CHAT_ID, caption, {
          reply_markup: keyboard,
        });
      }
    }
  } catch (err) {
    console.error('checkForNews failed:', err.message);
  }
  saveStore(store);
}

bot.action(/pub:(\d+)/, async (ctx) => {
  const id = ctx.match[1];
  const store = loadStore();
  const post = store.pending[id];
  if (!post) {
    await safeAnswerCbQuery(ctx, 'Пост уже обработан или не найден');
    return;
  }
  try {
    const publishedText = composeText(post, limitFor(post));
    if (post.photoFileId) {
      await bot.telegram.sendPhoto(TARGET_CHANNEL, post.photoFileId, { caption: publishedText });
    } else if (post.photoUrl) {
      const buffer = await downloadBuffer(post.photoUrl);
      await bot.telegram.sendPhoto(
        TARGET_CHANNEL,
        { source: buffer, filename: `${post.id}.jpg` },
        { caption: publishedText }
      );
    } else {
      await bot.telegram.sendMessage(TARGET_CHANNEL, publishedText);
    }
    delete store.pending[id];
    saveStore(store);
    await safeAnswerCbQuery(ctx, 'Опубликовано ✅');
    await finalizeMessage(ctx, post, '✅ Опубликовано');
  } catch (err) {
    console.error('publish failed:', err.message);
    await safeAnswerCbQuery(ctx, 'Ошибка публикации');
  }
});

bot.action(/rej:(\d+)/, async (ctx) => {
  const id = ctx.match[1];
  const store = loadStore();
  const post = store.pending[id];
  delete store.pending[id];
  saveStore(store);
  await safeAnswerCbQuery(ctx, 'Отклонено');
  if (post) {
    await finalizeMessage(ctx, post, '❌ Отклонено');
  }
});

cron.schedule(POLL_CRON, checkForNews);

bot.launch().catch((err) => console.error('bot.launch failed:', err.message));
console.log('Bot started, polling', SOURCE_CHANNEL, 'every', POLL_CRON);
checkForNews();

// Minimal HTTP server so Railway health checks (if enabled) have something to hit.
http.createServer((_, res) => res.end('ok')).listen(PORT);

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
