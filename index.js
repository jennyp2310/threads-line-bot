const express = require('express');
const line = require('@line/bot-sdk');

const config = {
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.LINE_CHANNEL_SECRET,
};

const client = new line.messagingApi.MessagingApiClient({
  channelAccessToken: config.channelAccessToken,
});

const app = express();

// 判斷是否為 Threads 連結
function isThreadsUrl(text) {
  return text.includes('threads.com') && text.includes('/post/');
}

// 解析 Threads URL，取出乾淨連結、用戶名、post ID
function parseThreadsUrl(text) {
  // 從訊息中擷取 URL（訊息可能夾雜其他文字）
  const urlMatch = text.match(/https:\/\/www\.threads\.com\/@([\w.]+)\/post\/([\w]+)/);
  if (!urlMatch) return null;

  return {
    cleanUrl: `https://www.threads.com/@${urlMatch[1]}/post/${urlMatch[2]}`,
    username: urlMatch[1],
    postId: urlMatch[2],
  };
}

// 用 fetch 抓 Threads 頁面的 og meta tag 取得文章內容
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

    // 抓 og:description（通常是文章正文）
    const descMatch = html.match(/<meta\s+property="og:description"\s+content="([^"]+)"/i)
      || html.match(/<meta\s+content="([^"]+)"\s+property="og:description"/i);

    const titleMatch = html.match(/<meta\s+property="og:title"\s+content="([^"]+)"/i)
      || html.match(/<meta\s+content="([^"]+)"\s+property="og:title"/i);

    const content = descMatch ? decodeHtmlEntities(descMatch[1]) : null;
    const title = titleMatch ? decodeHtmlEntities(titleMatch[1]) : null;

    return { content, title };
  } catch (err) {
    console.error('Fetch Threads error:', err.message);
    return { content: null, title: null };
  }
}

// 處理 HTML 特殊字元（&amp; &quot; 等）
function decodeHtmlEntities(str) {
  return str
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
}

app.post('/webhook', line.middleware(config), async (req, res) => {
  res.sendStatus(200);
  const events = req.body.events;
  for (const event of events) {
    if (event.type === 'message' && event.message.type === 'text') {
      await handleMessage(event);
    }
  }
});

async function handleMessage(event) {
  const text = event.message.text.trim();
  let replyText = '';

  if (isThreadsUrl(text)) {
    const parsed = parseThreadsUrl(text);

    if (!parsed) {
      replyText = '❌ 無法解析這個 Threads 連結，請確認格式是否正確。';
    } else {
      // 先回一則「處理中」讓用戶知道有反應
      await client.replyMessage({
        replyToken: event.replyToken,
        messages: [{ type: 'text', text: '⏳ 正在讀取文章內容...' }],
      });

      const { content, title } = await fetchThreadsContent(parsed.cleanUrl);

      // 用 push 因為 replyToken 只能用一次
      if (content) {
        replyText = `✅ 成功讀取！\n\n👤 @${parsed.username}\n\n📝 內容：\n${content}\n\n🔗 ${parsed.cleanUrl}\n\n（AI 分類與 Notion 儲存開發中）`;
      } else {
        replyText = `⚠️ 連結有效，但無法讀取文章內容。\n\n👤 @${parsed.username}\n🔗 ${parsed.cleanUrl}\n\n可能是私人帳號或需要登入。`;
      }

      await client.pushMessage({
        to: event.source.userId,
        messages: [{ type: 'text', text: replyText }],
      });

      return; // 已用 push 回覆，不往下執行
    }

  } else if (text === '/help' || text === '說明') {
    replyText = `📌 使用說明\n\n直接貼上 Threads 連結 → 自動儲存\n/分類 科技 → 查詢分類\n/搜尋 關鍵字 → 搜尋文章\n說明 → 顯示此選單`;

  } else {
    replyText = `貼上 Threads 連結來收藏文章 🧵\n\n傳「說明」查看使用方式`;
  }

  await client.replyMessage({
    replyToken: event.replyToken,
    messages: [{ type: 'text', text: replyText }],
  });
}

app.get('/', (req, res) => res.send('LINE Bot is running!'));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
