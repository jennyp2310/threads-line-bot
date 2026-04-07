const express = require('express');
const line = require('@line/bot-sdk');
const { classifyContent } = require('./ai');
const { saveToNotion, queryByCategory, queryByKeyword } = require('./notion');

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

    // 抓文章內容
    const descMatch =
      html.match(/<meta\s+property="og:description"\s+content="([^"]+)"/i) ||
      html.match(/<meta\s+content="([^"]+)"\s+property="og:description"/i);
    const content = descMatch ? decodeHtmlEntities(descMatch[1]) : null;

    // 抓發佈時間，依序嘗試多種來源
    let postDate = null;

    // 方法 1：article:published_time
    const publishedMatch =
      html.match(/<meta\s+property="article:published_time"\s+content="([^"]+)"/i) ||
      html.match(/<meta\s+content="([^"]+)"\s+property="article:published_time"/i);
    if (publishedMatch) {
      postDate = publishedMatch[1];
    }

    // 方法 2：JSON-LD datePublished
    if (!postDate) {
      const jsonLdMatches = html.matchAll(/<script[^>]+type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/gi);
      for (const match of jsonLdMatches) {
        try {
          const jsonLd = JSON.parse(match[1]);
          const dateStr = jsonLd.datePublished || jsonLd.uploadDate || jsonLd.dateCreated;
          if (dateStr) { postDate = dateStr; break; }
        } catch (_) {}
      }
    }

    // 方法 3：HTML 裡任何 ISO 日期格式（最後手段）
    if (!postDate) {
      const isoMatch = html.match(/"datePublished"\s*:\s*"(\d{4}-\d{2}-\d{2}[^"]+)"/);
      if (isoMatch) postDate = isoMatch[1];
    }

    // 方法 4：HTML 裡任何 YYYY-MM-DD 格式
    if (!postDate) {
      const dateMatch = html.match(/(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})/);
      if (dateMatch) postDate = dateMatch[1];
    }

    // 格式化為 YYYY-MM-DD
    if (postDate) {
      postDate = postDate.slice(0, 10);
      console.log(`[日期] 抓到發佈時間：${postDate}`);
    } else {
      console.log(`[日期] 找不到發佈時間`);
    }

    return { content, postDate };
  } catch (err) {
    console.error('Fetch Threads error:', err.message);
    return { content: null, postDate: null };
  }
}

// ── 查詢結果格式化 ────────────────────────────────────────

function formatResults(items, label) {
  if (items.length === 0) return `找不到「${label}」相關文章 😢`;

  return items
    .map((item, i) => {
      const date = item.savedAt ? item.savedAt.slice(0, 10) : '';
      return `${i + 1}. 【${item.category}】${item.title}\n   ${item.summary}\n   ${item.url}\n   ${item.username}  ${date}`;
    })
    .join('\n\n');
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
    const { content, postDate } = await fetchThreadsContent(parsed.cleanUrl);

    if (!content) {
      return pushText(userId, '⚠️ 無法讀取文章內容，可能是私人帳號或 Threads 擋爬蟲。\n\n連結已記錄：' + parsed.cleanUrl);
    }

    const aiResult = await classifyContent(content, parsed.username);

    const saved = await saveToNotion({
      title: aiResult.title,
      url: parsed.cleanUrl,
      username: parsed.username,
      content,
      summary: aiResult.summary,
      category: aiResult.category,
      postDate,
    });

    if (saved.success) {
      const dateInfo = postDate ? `\n📅 發佈時間：${postDate}` : '';
      const msg =
        `✅ 已儲存到 Notion！\n\n` +
        `📂 分類：${aiResult.category}\n` +
        `📌 標題：${aiResult.title}\n` +
        `📝 摘要：${aiResult.summary}\n` +
        `👤 作者：@${parsed.username}` +
        `${dateInfo}\n` +
        `🔗 ${parsed.cleanUrl}`;
      await pushText(userId, msg);
    } else {
      await pushText(userId, `⚠️ AI 分類完成，但 Notion 儲存失敗。\n錯誤：${saved.error}`);
    }

  } catch (err) {
    console.error('收藏流程錯誤:', err);
    await pushText(userId, `❌ 處理時發生錯誤：${err.message}`);
  }

  return;
}

  // ── 查詢分類 /分類 科技 ──
  if (text.startsWith('/分類')) {
    const category = text.replace('/分類', '').trim();
    if (!category) return replyText(event.replyToken, '請指定分類，例如：/分類 科技');

    await replyText(event.replyToken, `🔍 搜尋「${category}」分類中...`);
    const results = await queryByCategory(category);
    return pushText(userId, formatResults(results, category));
  }

  // ── 關鍵字搜尋 /搜尋 React ──
  if (text.startsWith('/搜尋')) {
    const keyword = text.replace('/搜尋', '').trim();
    if (!keyword) return replyText(event.replyToken, '請輸入關鍵字，例如：/搜尋 React');

    await replyText(event.replyToken, `🔍 搜尋「${keyword}」中...`);
    const results = await queryByKeyword(keyword);
    return pushText(userId, formatResults(results, keyword));
  }
  
// ── 說明 ──
if (text === '說明' || text === '/help') {
  const help =
    `📌 使用說明\n\n` +
    `🧵 貼上 Threads 連結\n→ 自動分類並儲存到 Notion\n\n` +
    `📂 /分類 好吃的\n→ 查詢指定分類的文章\n\n` +
    `🔍 /搜尋 關鍵字\n→ 關鍵字搜尋文章\n\n` +
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

app.get('/', (req, res) => res.send('LINE Bot is running!'));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
