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
  getCategories,
  addCategory,
  deleteCategory,
  getCategoriesByUserId,
  addCategoryByUserId,
  deleteCategoryByUserId,
  renameCategoryById,
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
app.use(express.json());

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

  console.log('收到訊息:', text, '來自:', userId);

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
      const userCats = await getCategories(userId);
      const aiResult = await classifyContent(content, parsed.username, userCats);
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
    const cats = await getCategories(userId);
    return client.replyMessage({
      replyToken: event.replyToken,
      messages: [{
        type: 'text',
        text: '請選擇要查看的分類：',
        quickReply: {
          items: cats.slice(0, 13).map(cat => ({
            type: 'action',
            action: { type: 'message', label: cat, text: `/分類 ${cat}` },
          })),
        },
      }],
    });
  }

  // ── /搜尋（單獨觸發）──
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

  // ── 查詢分類 ──
  if (text.startsWith('/分類')) {
    const category = text.replace('/分類', '').trim();
    if (!category) return replyText(event.replyToken, '請指定分類，例如：/分類 好吃的');
    await replyText(event.replyToken, `🔍 搜尋「${category}」分類中...`);
    const results = await queryByCategory(userId, category);
    if (results.length === 0) return pushText(userId, `「${category}」目前沒有收藏文章 😢`);
    return pushFlex(userId, `📂 ${category}`, buildCards(results));
  }

  // ── 關鍵字搜尋 ──
  if (text.startsWith('/搜尋')) {
    const keyword = text.replace('/搜尋', '').trim();
    if (!keyword) return replyText(event.replyToken, '請輸入關鍵字，例如：/搜尋 投資');
    await replyText(event.replyToken, `🔍 搜尋「${keyword}」中...`);
    const results = await queryByKeyword(userId, keyword);
    if (results.length === 0) return pushText(userId, `找不到包含「${keyword}」的文章 😢`);
    return pushFlex(userId, `🔍 ${keyword}`, buildCards(results));
  }

  // ── 我的分類 ──
  if (text === '/我的分類' || text === '我的分類') {
    const cats = await getCategories(userId);
    return replyText(event.replyToken,
      `📋 你的分類清單（共 ${cats.length} 個）：\n\n${cats.join('、')}\n\n` +
      `➕ 新增：/新增分類 分類名稱\n` +
      `🗑 刪除：/刪除分類 分類名稱`
    );
  }

  // ── 新增分類 ──
  if (text.startsWith('/新增分類')) {
    const name = text.replace('/新增分類', '').trim();
    if (!name) return replyText(event.replyToken, '請輸入分類名稱，例如：/新增分類 我的最愛');
    const result = await addCategory(userId, name);
    return replyText(event.replyToken,
      result.success ? `✅ 已新增分類「${name}」` : `❌ 新增失敗：${result.error}`
    );
  }

  // ── 刪除分類 ──
  if (text.startsWith('/刪除分類')) {
    const name = text.replace('/刪除分類', '').trim();
    if (!name) return replyText(event.replyToken, '請輸入要刪除的分類名稱，例如：/刪除分類 其他');
    const result = await deleteCategory(userId, name);
    return replyText(event.replyToken,
      result.success ? `🗑 已刪除分類「${name}」` : `❌ 刪除失敗：${result.error}`
    );
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
      `────────────────\n` +
      `下方選單快速操作：\n\n` +
      `📋 近10筆\n→ 查看最新收藏的 10 篇\n\n` +
      `📂 找分類\n→ 選擇分類瀏覽文章\n\n` +
      `🔍 指定文章\n→ 輸入 *關鍵字 搜尋，例如：*AI\n\n` +
      `📚 我的收藏\n→ 開啟專屬網頁收藏頁\n\n` +
      `────────────────\n` +
      `分類管理：\n\n` +
      `📋 我的分類\n→ 查看目前所有分類\n\n` +
      `➕ /新增分類 名稱\n→ 例如：/新增分類 工作靈感\n\n` +
      `🗑 /刪除分類 名稱\n→ 例如：/刪除分類 其他\n\n` +
      `✏️ /改名分類 舊名稱 新名稱\n→ 例如：/改名分類 生活2266 日常生活`;
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
        { type: 'text', text: item.title || '無標題', weight: 'bold', size: 'md', wrap: true },
        { type: 'text', text: item.category || '', size: 'sm', color: '#C8522A' },
        { type: 'text', text: item.summary || '（無摘要）', size: 'sm', wrap: true, color: '#555555' },
        { type: 'text', text: `👤 ${item.username || ''}　📅 ${item.saved_at ? item.saved_at.slice(0, 10) : ''}`, size: 'xs', color: '#aaaaaa', wrap: true },
      ],
    },
    footer: {
      type: 'box',
      layout: 'vertical',
      contents: [{
        type: 'button',
        style: 'link',
        height: 'sm',
        action: { type: 'uri', label: '開啟連結', uri: item.url },
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
      contents: { type: 'carousel', contents: bubbles },
    }],
  });
}

// ── 分類管理 API（給網頁用）──────────────────────────────

app.post('/api/categories/add', async (req, res) => {
  const { token, name } = req.body;
  if (!token || !name) return res.status(400).json({ error: '缺少參數' });
  const user = await getUserByToken(token);
  if (!user) return res.status(403).json({ error: '無效 token' });
  const result = await addCategoryByUserId(user.id, name);
  res.json(result);
});

app.post('/api/categories/delete', async (req, res) => {
  const { token, name } = req.body;
  if (!token || !name) return res.status(400).json({ error: '缺少參數' });
  const user = await getUserByToken(token);
  if (!user) return res.status(403).json({ error: '無效 token' });
  const result = await deleteCategoryByUserId(user.id, name);
  res.json(result);
});

app.post('/api/categories/rename', async (req, res) => {
  const { token, oldName, newName } = req.body;
  if (!token || !oldName || !newName) return res.status(400).json({ error: '缺少參數' });
  const user = await getUserByToken(token);
  if (!user) return res.status(403).json({ error: '無效 token' });
  const result = await renameCategoryById(user.id, oldName, newName);
  res.json(result);
});

// ── Web 收藏頁（雜誌風格）────────────────────────────────

app.get('/me', async (req, res) => {
  const { token, category, keyword } = req.query;
  if (!token) return res.status(403).send('找不到你的收藏頁');

  const user = await getUserByToken(token);
  if (!user) return res.status(403).send('無效的連結');

  const [articles, categories] = await Promise.all([
    getArticlesByUserId(user.id, { category, keyword }),
    getCategoriesByUserId(user.id),
  ]);

  const featuredCard = articles[0] ? `
    <div class="featured">
      <div class="featured-label">最新收藏</div>
      <div class="featured-title">${articles[0].title || '無標題'}</div>
      <div class="featured-summary">${articles[0].summary || ''}</div>
      <div class="featured-footer">
        <div class="featured-meta">
          <span class="cat-tag">${articles[0].category || ''}</span>
          <span class="meta-text">👤 ${articles[0].username || ''}　📅 ${articles[0].saved_at ? articles[0].saved_at.slice(0,10) : ''}</span>
        </div>
        <a class="read-link" href="${articles[0].url}" target="_blank">閱讀全文 →</a>
      </div>
    </div>
    <div class="divider"></div>
  ` : '';

  const restCards = articles.slice(1).map(a => `
    <div class="card">
      <div class="card-cat">${a.category || ''}</div>
      <div class="card-title">${a.title || '無標題'}</div>
      <div class="card-summary">${a.summary || ''}</div>
      <div class="card-footer">
        <span class="meta-text">👤 ${a.username || ''}　${a.saved_at ? a.saved_at.slice(0,10) : ''}</span>
        <a class="read-link-sm" href="${a.url}" target="_blank">閱讀 →</a>
      </div>
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
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link href="https://fonts.googleapis.com/css2?family=Playfair+Display:wght@400;700&family=DM+Sans:wght@300;400;500&display=swap" rel="stylesheet">
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: 'DM Sans', -apple-system, sans-serif; background: #FAFAF7; color: #1a1a18; }
    .header { border-bottom: 3px solid #1a1a18; padding: 20px 20px 14px; display: flex; align-items: flex-end; justify-content: space-between; max-width: 720px; margin: 0 auto; }
    .logo { font-family: 'Playfair Display', serif; font-size: 28px; font-weight: 700; letter-spacing: -1px; line-height: 1; }
    .logo span { color: #C8522A; }
    .header-meta { font-size: 11px; color: #888; letter-spacing: 2px; text-transform: uppercase; text-align: right; line-height: 1.6; }
    .search-wrap { background: #FAFAF7; border-bottom: 0.5px solid #ccc; padding: 12px 20px; }
    .search-inner { max-width: 720px; margin: 0 auto; }
    .search-form { display: flex; gap: 8px; flex-wrap: wrap; }
    .search-form input { flex: 1; min-width: 140px; padding: 7px 12px; border: 0.5px solid #bbb; background: #fff; font-family: 'DM Sans', sans-serif; font-size: 13px; outline: none; }
    .search-form input:focus { border-color: #1a1a18; }
    .search-form select { padding: 7px 12px; border: 0.5px solid #bbb; background: #fff; font-family: 'DM Sans', sans-serif; font-size: 13px; outline: none; }
    .search-form button { background: #1a1a18; color: #FAFAF7; border: none; padding: 7px 18px; font-family: 'DM Sans', sans-serif; font-size: 12px; letter-spacing: 1.5px; text-transform: uppercase; cursor: pointer; }
    .search-form button:hover { background: #C8522A; }
    .container { max-width: 720px; margin: 0 auto; padding: 24px 20px; }
    .featured { padding: 20px 0; }
    .featured-label { font-size: 10px; letter-spacing: 3px; text-transform: uppercase; color: #C8522A; margin-bottom: 10px; }
    .featured-title { font-family: 'Playfair Display', serif; font-size: 26px; font-weight: 700; line-height: 1.3; margin-bottom: 12px; }
    .featured-summary { font-size: 14px; color: #444; line-height: 1.7; margin-bottom: 14px; }
    .featured-footer { display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 8px; }
    .featured-meta { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
    .cat-tag { font-size: 10px; letter-spacing: 1.5px; text-transform: uppercase; background: #1a1a18; color: #FAFAF7; padding: 3px 8px; }
    .meta-text { font-size: 11px; color: #888; }
    .read-link { font-size: 12px; letter-spacing: 1px; text-transform: uppercase; color: #1a1a18; text-decoration: none; font-weight: 500; border-bottom: 1px solid #1a1a18; padding-bottom: 1px; white-space: nowrap; }
    .read-link:hover { color: #C8522A; border-color: #C8522A; }
    .divider { height: 1px; background: #1a1a18; margin: 4px 0 20px; }
    .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 1px; background: #ccc; }
    @media (max-width: 500px) { .grid { grid-template-columns: 1fr; } }
    .card { background: #FAFAF7; padding: 18px; }
    .card-cat { font-size: 10px; letter-spacing: 2px; text-transform: uppercase; color: #C8522A; margin-bottom: 8px; }
    .card-title { font-family: 'Playfair Display', serif; font-size: 16px; font-weight: 700; line-height: 1.4; margin-bottom: 8px; }
    .card-summary { font-size: 12px; color: #555; line-height: 1.6; margin-bottom: 12px; }
    .card-footer { display: flex; justify-content: space-between; align-items: center; border-top: 0.5px solid #ddd; padding-top: 10px; gap: 8px; flex-wrap: wrap; }
    .read-link-sm { font-size: 11px; letter-spacing: 0.5px; text-transform: uppercase; color: #1a1a18; text-decoration: none; font-weight: 500; border-bottom: 1px solid #1a1a18; padding-bottom: 1px; white-space: nowrap; }
    .read-link-sm:hover { color: #C8522A; border-color: #C8522A; }
    .empty { text-align: center; padding: 60px 20px; color: #aaa; font-size: 14px; line-height: 2; }
    .empty strong { display: block; font-family: 'Playfair Display', serif; font-size: 20px; color: #bbb; margin-bottom: 8px; }
    .cat-manage { background: #f0ede8; padding: 24px 20px 40px; margin-top: 32px; }
    .cat-manage-inner { max-width: 720px; margin: 0 auto; }
    .cat-manage-title { font-family: 'Playfair Display', serif; font-size: 18px; font-weight: 700; margin-bottom: 16px; }
    .cat-list { display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: 16px; }
    .cat-item { display: flex; align-items: center; gap: 6px; background: #fff; border: 0.5px solid #ccc; padding: 6px 10px; font-size: 13px; }
    .cat-item-name { cursor: pointer; }
    .cat-item-name:hover { color: #C8522A; }
    .cat-item button { background: none; border: none; cursor: pointer; font-size: 12px; color: #aaa; padding: 0; line-height: 1; }
    .cat-item button:hover { color: #C8522A; }
    .cat-add { display: flex; gap: 8px; margin-bottom: 10px; }
    .cat-add input { flex: 1; padding: 7px 12px; border: 0.5px solid #bbb; font-family: 'DM Sans', sans-serif; font-size: 13px; outline: none; background: #fff; }
    .cat-add input:focus { border-color: #1a1a18; }
    .cat-add button { background: #1a1a18; color: #fff; border: none; padding: 7px 16px; font-size: 12px; letter-spacing: 1px; text-transform: uppercase; cursor: pointer; font-family: 'DM Sans', sans-serif; }
    .cat-add button:hover { background: #C8522A; }
    .cat-msg { font-size: 12px; min-height: 18px; margin-top: 4px; }
    .cat-hint { font-size: 11px; color: #aaa; margin-bottom: 12px; }
  </style>
</head>
<body>
  <div class="header">
    <div class="logo">THREAD<span>S</span></div>
    <div class="header-meta">我的收藏<br>共 ${articles.length} 篇文章</div>
  </div>
  <div class="search-wrap">
    <div class="search-inner">
      <form class="search-form" method="get" action="/me">
        <input type="hidden" name="token" value="${token}">
        <input type="text" name="keyword" placeholder="搜尋關鍵字..." value="${keyword || ''}">
        <select name="category">
          <option value="">全部分類</option>
          ${categoryOptions}
        </select>
        <button type="submit">搜尋</button>
      </form>
    </div>
  </div>
  <div class="container">
    ${articles.length === 0 ? `
      <div class="empty">
        <strong>尚無收藏文章</strong>
        回到 LINE 貼上 Threads 連結開始收藏！
      </div>
    ` : `
      ${featuredCard}
      <div class="grid">${restCards}</div>
    `}
  </div>
  <div class="cat-manage">
    <div class="cat-manage-inner">
      <div class="cat-manage-title">📋 分類管理</div>
      <div class="cat-hint">點分類名稱可改名，點 ✕ 可刪除</div>
      <div class="cat-list" id="catList"></div>
      <div class="cat-add">
        <input type="text" id="newCatInput" placeholder="輸入新分類名稱...">
        <button onclick="addCat()">新增</button>
      </div>
      <div class="cat-msg" id="catMsg"></div>
    </div>
  </div>
  <script>
    const TOKEN = '${token}';
    let cats = ${JSON.stringify(categories)};

    function renderCats() {
      const list = document.getElementById('catList');
      list.innerHTML = cats.map(c => \`
        <div class="cat-item">
          <span class="cat-item-name" onclick="renameCat('\${c}')">\${c}</span>
          <button onclick="deleteCat('\${c}')" title="刪除">✕</button>
        </div>
      \`).join('');
    }

    function showMsg(msg, isError) {
      const el = document.getElementById('catMsg');
      el.textContent = msg;
      el.style.color = isError ? '#C8522A' : '#3a7a3a';
      setTimeout(() => el.textContent = '', 3000);
    }

    async function addCat() {
      const input = document.getElementById('newCatInput');
      const name = input.value.trim();
      if (!name) return showMsg('請輸入分類名稱', true);
      const res = await fetch('/api/categories/add', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: TOKEN, name }),
      });
      const data = await res.json();
      if (data.success) {
        cats.push(name);
        renderCats();
        input.value = '';
        showMsg('✅ 已新增「' + name + '」');
      } else {
        showMsg('❌ ' + data.error, true);
      }
    }

    async function deleteCat(name) {
      if (!confirm('確定刪除分類「' + name + '」？')) return;
      const res = await fetch('/api/categories/delete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: TOKEN, name }),
      });
      const data = await res.json();
      if (data.success) {
        cats = cats.filter(c => c !== name);
        renderCats();
        showMsg('🗑 已刪除「' + name + '」');
      } else {
        showMsg('❌ ' + data.error, true);
      }
    }

    async function renameCat(oldName) {
      const newName = prompt('將「' + oldName + '」改名為：', oldName);
      if (!newName || newName.trim() === oldName) return;
      const res = await fetch('/api/categories/rename', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: TOKEN, oldName, newName: newName.trim() }),
      });
      const data = await res.json();
      if (data.success) {
        cats = cats.map(c => c === oldName ? newName.trim() : c);
        renderCats();
        showMsg('✅ 已改名為「' + newName.trim() + '」');
      } else {
        showMsg('❌ ' + data.error, true);
      }
    }

    renderCats();
  </script>
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
