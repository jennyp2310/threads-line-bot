const express = require('express');
const line = require('@line/bot-sdk');
const { classifyContent } = require('./ai');
const {
  getOrCreateUser,
  saveArticle,
  queryByCategory,
  queryByKeyword,
  queryRecent,
  getUserByToken,
  getArticlesByUserId,
} = require('./db');
const { createRichMenu } = require('./setup-richmenu');

const config = {
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.LINE_CHANNEL_SECRET,
};

const client = new line.messagingApi.MessagingApiClient({
  channelAccessToken: config.channelAccessToken,
});

const app = express();

// ── URL 工具函式 ──────────────────────────────────────────

function isThreadsUrl(text) {
  return text.includes('threads.com') && text.includes('/post/');
}

function parseThreadsUrl(text) {
  const urlMatch = text.match(/https:\/\/www\.threads\.com\/@([\w.]+)\/post\/([\w]+)/);
  if (!urlMatch) return null;
  return {
    cleanUrl: `https://www.threads.com/@${urlMatch[1]}/post/${urlMatch[2]}`,
    username: urlMatch[1],
    postId: urlMatch[2],
  };
}

// ── Threads 內容抓取 ──────────────────────────────────────

async function fetchThreadsContent(cleanUrl) {
  try {
    const res = await fetch(cleanUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; Googlebot/2.1)',
        'Accept-Language': 'zh-TW,zh;q=0.9',
      },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const html = await res.text();

    const descMatch =
      html.match(/<meta\s+property="og:description"\s+content="([^"]+)"/i) ||
      html.match(/<meta\s+content="([^"]+)"\s+property="og:description"/i);

    const content = descMatch ? decodeHtmlEntities(descMatch[1]) : null;
    return { content };
  } catch (err) {
    console.error('Fetch Threads error:', err.message);
    return { content: null };
  }
}

function decodeHtmlEntities(str) {
  return str
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
}

// ── Webhook 主入口 ────────────────────────────────────────

app.post('/webhook', line.middleware(config), async (req, res) => {
  res.sendStatus(200);
  for (const event of req.body.events) {
    if (event.type === 'message' && event.message.type === 'text') {
      await handleMessage(event);
    }
  }
});

async function handleMessage(event) {
  const text = event.message.text.trim();
  const userId = event.source.userId;

  // ── 收藏流程 ──
  if (isThreadsUrl(text)) {
    const parsed = parseThreadsUrl(text);

    if (!parsed) {
      return replyText(event.replyToken, '❌ 無法解析連結，請確認格式是否正確。');
    }

    await replyText(event.replyToken, '⏳ 讀取中，請稍候...');

    try {
      const { content } = await fetchThreadsContent(parsed.cleanUrl);

      if (!content) {
        return pushText(userId, '⚠️ 無法讀取文章內容，可能是私人帳號或 Threads 擋爬蟲。\n\n連結已記錄：' + parsed.cleanUrl);
      }

      const aiResult = await classifyContent(content, parsed.username);

      const saved = await saveArticle(userId, {
        title: aiResult.title,
        url: parsed.cleanUrl,
        username: parsed.username,
        content,
        summary: aiResult.summary,
        category: aiResult.category,
      });

      if (saved.success) {
        const msg =
          `✅ 已儲存！\n\n` +
          `📂 分類：${aiResult.category}\n` +
          `📌 標題：${aiResult.title}\n` +
          `📝 摘要：${aiResult.summary}\n` +
          `👤 作者：@${parsed.username}\n` +
          `🔗 ${parsed.cleanUrl}`;
        await pushText(userId, msg);
      } else {
        await pushText(userId, `⚠️ AI 分類完成，但儲存失敗。\n錯誤：${saved.error}`);
      }

    } catch (err) {
      console.error('收藏流程錯誤:', err);
      await pushText(userId, `❌ 處理時發生錯誤：${err.message}`);
    }

    return;
  }

  // ── 近 10 筆 ──
  if (text === '/近10筆') {
    await replyText(event.replyToken, '📋 讀取最新 10 筆...');
    const results = await queryRecent(userId, 10);
    if (results.length === 0) return pushText(userId, '目前還沒有收藏文章 😢');
    return pushFlex(userId, '📋 最新收藏', buildCards(results));
  }

  // ── 找分類（Quick Reply）──
  if (text === '/找分類') {
    return client.replyMessage({
      replyToken: event.replyToken,
      messages: [{
        type: 'text',
        text: '請選擇要查看的分類：',
        quickReply: {
          items: [
            '各種科技','給我錢','漂亮美眉','各種商業','各種行銷',
            '健康寶寶','好吃的','我要出去玩！','好看的',
            '學到2','各種時事','生活2266','其他',
          ].map(cat => ({
            type: 'action',
            action: { type: 'message', label: cat, text: `/分類 ${cat}` },
          })),
        },
      }],
    });
  }

  // ── /搜尋（單獨觸發，提示輸入）──
  if (text === '/搜尋') {
    return replyText(event.replyToken, '請輸入搜尋關鍵字，例如：\n*AI\n\n（在關鍵字前加 * 開始搜尋）');
  }

  // ── *關鍵字 搜尋 ──
  if (text.startsWith('*') && text.length > 1) {
    const keyword = text.slice(1).trim();
    await replyText(event.replyToken, `🔍 搜尋「${keyword}」中...`);
    const results = await queryByKeyword(userId, keyword);
    if (results.length === 0) return pushText(userId, `找不到包含「${keyword}」的文章 😢`);
    return pushFlex(userId, `🔍 ${keyword}`, buildCards(results));
  }

  // ── 查詢分類 /分類 好吃的 ──
  if (text.startsWith('/分類')) {
    const category = text.replace('/分類', '').trim();
    if (!category) return replyText(event.replyToken, '請指定分類，例如：/分類 好吃的');
    await replyText(event.replyToken, `🔍 搜尋「${category}」分類中...`);
    const results = await queryByCategory(userId, category);
    if (results.length === 0) return pushText(userId, `「${category}」目前沒有收藏文章 😢`);
    return pushFlex(userId, `📂 ${category}`, buildCards(results));
  }

  // ── 關鍵字搜尋 /搜尋 關鍵字 ──
  if (text.startsWith('/搜尋')) {
    const keyword = text.replace('/搜尋', '').trim();
    if (!keyword) return replyText(event.replyToken, '請輸入關鍵字，例如：/搜尋 投資');
    await replyText(event.replyToken, `🔍 搜尋「${keyword}」中...`);
    const results = await queryByKeyword(userId, keyword);
    if (results.length === 0) return pushText(userId, `找不到包含「${keyword}」的文章 😢`);
    return pushFlex(userId, `🔍 ${keyword}`, buildCards(results));
  }

  // ── 我的收藏頁 ──
  if (text === '我的收藏' || text === '/我的收藏') {
    const user = await getOrCreateUser(userId);
    const url = `${process.env.APP_URL}/me?token=${user.token}`;
    return replyText(event.replyToken,
      `📚 你的專屬收藏頁：\n${url}\n\n書籤起來方便隨時查看！`
    );
  }

  // ── 說明 ──
  if (text === '說明' || text === '/help') {
    const help =
      `📌 使用說明\n\n` +
      `🧵 貼上 Threads 連結\n→ 自動分類並儲存\n\n` +
      `📋 近10筆\n→ 查看最新收藏的 10 篇\n\n` +
      `📂 找分類\n→ 選擇分類瀏覽文章\n\n` +
      `🔍 *關鍵字\n→ 例如輸入 *AI 搜尋文章\n\n` +
      `📚 我的收藏\n→ 取得專屬網頁收藏頁\n\n` +
      `可用分類：各種科技、給我錢、漂亮美眉、各種商業、各種行銷、健康寶寶、好吃的、我要出去玩！、好看的、學到2、各種時事、生活2266、其他`;
    return replyText(event.replyToken, help);
  }

  // ── 預設 ──
  await replyText(event.replyToken, '貼上 Threads 連結來收藏文章 🧵\n傳「說明」查看使用方式');
}

// ── 回覆工具 ─────────────────────────────────────────────

function replyText(replyToken, text) {
  return client.replyMessage({
    replyToken,
    messages: [{ type: 'text', text }],
  });
}

function pushText(userId, text) {
  return client.pushMessage({
    to: userId,
    messages: [{ type: 'text', text }],
  });
}

// ── Flex 卡片 ─────────────────────────────────────────────

function buildCards(items) {
  return items.map(item => ({
    type: 'bubble',
    size: 'kilo',
    body: {
      type: 'box',
      layout: 'vertical',
      spacing: 'sm',
      contents: [
        {
          type: 'text',
          text: item.title || '無標題',
          weight: 'bold',
          size: 'md',
          wrap: true,
        },
        {
          type: 'text',
          text: item.category || '',
          size: 'sm',
          color: '#ff69b4',
        },
        {
          type: 'text',
          text: item.summary || '（無摘要）',
          size: 'sm',
          wrap: true,
          color: '#555555',
        },
        {
          type: 'text',
          text: `👤 ${item.username || ''}　📅 ${item.saved_at ? item.saved_at.slice(0, 10) : ''}`,
          size: 'xs',
          color: '#aaaaaa',
          wrap: true,
        },
      ],
    },
    footer: {
      type: 'box',
      layout: 'vertical',
      contents: [{
        type: 'button',
        style: 'link',
        height: 'sm',
        action: {
          type: 'uri',
          label: '開啟連結',
          uri: item.url,
        },
      }],
    },
  }));
}

function pushFlex(userId, altText, bubbles) {
  return client.pushMessage({
    to: userId,
    messages: [{
      type: 'flex',
      altText,
      contents: {
        type: 'carousel',
        contents: bubbles,
      },
    }],
  });
}

// ── Web 收藏頁 ────────────────────────────────────────────

app.get('/me', async (req, res) => {
  const { token, category, keyword } = req.query;
  if (!token) return res.status(403).send('找不到你的收藏頁');

  const user = await getUserByToken(token);
  if (!user) return res.status(403).send('無效的連結');

  const articles = await getArticlesByUserId(user.id, { category, keyword });

  const categories = [
    '各種科技','給我錢','漂亮美眉','各種商業','各種行銷',
    '健康寶寶','好吃的','我要出去玩！','好看的',
    '學到2','各種時事','生活2266','其他',
  ];

  const cards = articles.map(a => `
    <div class="card">
      <div class="card-category">${a.category || ''}</div>
      <div class="card-title">${a.title || '無標題'}</div>
      <div class="card-summary">${a.summary || ''}</div>
      <div class="card-meta">👤 ${a.username || ''}　📅 ${a.saved_at ? a.saved_at.slice(0,10) : ''}</div>
      <a class="card-link" href="${a.url}" target="_blank">開啟文章 →</a>
    </div>
  `).join('');

  const categoryOptions = categories.map(c =>
    `<option value="${c}" ${category === c ? 'selected' : ''}>${c}</option>`
  ).join('');

  res.send(`<!DOCTYPE html>
<html lang="zh-TW">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>我的 Threads 收藏</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: -apple-system, sans-serif; background: #f5f5f5; color: #333; }
    header { background: #ff69b4; color: white; padding: 20px; text-align: center; }
    header h1 { font-size: 1.4rem; }
    header p { font-size: 0.85rem; opacity: 0.85; margin-top: 4px; }
    .search-bar { background: white; padding: 16px; display: flex; gap: 8px; flex-wrap: wrap; border-bottom: 1px solid #eee; }
    .search-bar input { flex: 1; min-width: 150px; padding: 8px 12px; border: 1px solid #ddd; border-radius: 8px; font-size: 0.9rem; }
    .search-bar select { padding: 8px 12px; border: 1px solid #ddd; border-radius: 8px; font-size: 0.9rem; }
    .search-bar button { padding: 8px 16px; background: #ff69b4; color: white; border: none; border-radius: 8px; cursor: pointer; font-size: 0.9rem; }
    .container { max-width: 680px; margin: 0 auto; padding: 16px; }
    .card { background: white; border-radius: 12px; padding: 16px; margin-bottom: 12px; box-shadow: 0 1px 4px rgba(0,0,0,0.08); }
    .card-category { font-size: 0.75rem; color: #ff69b4; font-weight: bold; margin-bottom: 6px; }
    .card-title { font-size: 1rem; font-weight: bold; margin-bottom: 6px; line-height: 1.4; }
    .card-summary { font-size: 0.875rem; color: #555; margin-bottom: 8px; line-height: 1.5; }
    .card-meta { font-size: 0.75rem; color: #aaa; margin-bottom: 10px; }
    .card-link { display: inline-block; font-size: 0.85rem; color: #ff69b4; text-decoration: none; font-weight: bold; }
    .empty { text-align: center; padding: 60px 20px; color: #aaa; font-size: 0.95rem; }
  </style>
</head>
<body>
  <header>
    <h1>🧵 我的 Threads 收藏</h1>
    <p>共 ${articles.length} 篇文章</p>
  </header>
  <div class="search-bar">
    <form method="get" action="/me" style="display:flex;gap:8px;flex-wrap:wrap;width:100%">
      <input type="hidden" name="token" value="${token}">
      <input type="text" name="keyword" placeholder="搜尋關鍵字..." value="${keyword || ''}">
      <select name="category">
        <option value="">全部分類</option>
        ${categoryOptions}
      </select>
      <button type="submit">搜尋</button>
    </form>
  </div>
  <div class="container">
    ${articles.length > 0 ? cards : '<div class="empty">還沒有收藏文章 😢<br>回到 LINE 貼上 Threads 連結開始收藏！</div>'}
  </div>
</body>
</html>`);
});

// ── 一次性 Rich Menu 設定路由 ─────────────────────────────

app.get('/setup', async (req, res) => {
  if (req.query.secret !== 'threads-setup') {
    return res.status(403).send('❌ 禁止存取');
  }
  try {
    const id = await createRichMenu();
    res.send(`✅ Rich Menu 建立成功！ID：${id}`);
  } catch (err) {
    console.error(err);
    res.status(500).send(`❌ 失敗：${err.message}`);
  }
});

app.get('/', (req, res) => res.send('LINE Bot is running!'));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
