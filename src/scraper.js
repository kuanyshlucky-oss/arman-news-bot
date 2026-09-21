import * as cheerio from 'cheerio';

const WIDGET_BASE = 'https://t.me/s/';

// Reads the public web preview of a Telegram channel (no API key needed)
// and returns posts newer than afterId, oldest first.
export async function fetchLatestPosts(channel, afterId = 0) {
  const res = await fetch(`${WIDGET_BASE}${channel}`, {
    headers: { 'User-Agent': 'Mozilla/5.0' },
  });
  if (!res.ok) {
    throw new Error(`Failed to fetch t.me/s/${channel}: ${res.status}`);
  }
  const html = await res.text();
  const $ = cheerio.load(html);

  const posts = [];

  $('.tgme_widget_message[data-post]').each((_, el) => {
    const message = $(el);
    const dataPost = message.attr('data-post');
    if (!dataPost) return;

    const id = Number(dataPost.split('/').pop());
    if (!id || id <= afterId) return;

    const textEl = message.find('.tgme_widget_message_text').first();
    textEl.find('br').replaceWith('\n');
    const text = textEl.text().trim();

    let photoUrl = null;
    const photoEl = message.find('.tgme_widget_message_photo_wrap').first();
    if (photoEl.length) {
      const style = photoEl.attr('style') || '';
      const match = style.match(/url\(['"]?(.*?)['"]?\)/);
      if (match) photoUrl = match[1];
    }

    posts.push({
      id,
      text,
      photoUrl,
      link: `https://t.me/${channel}/${id}`,
    });
  });

  return posts.sort((a, b) => a.id - b.id);
}
