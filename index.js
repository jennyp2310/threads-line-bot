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
  updateArticleCategory,
  deleteArticle,
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

// ── 暫存等待分類的文章 ────────────────────────────────────
const pendingArticles = new Map(); // userId → { url, title, content, username }

// ── URL 工具函式 ──────────────────────────────────────────

function isThreadsUrl(text) {
  return text.includes('threads.com') && text.includes('/post/');
}

function parseThreadsUrl(text) {
  const urlMatch = text.match(/https:\/\/www\.threads\.com\/@([\w.]+)\/post\/([\w-]+)/);
  if (!urlMatch) return null;
  return {
    cleanUrl: `https://www.threads.com/@${urlMatch[1]}/post/${urlMatch[2]}`,
    username: urlMatch[1],
    postId: urlMatch[2],
  };
}

// ── IG URL 工具函式 ───────────────────────────────────────

function isInstagramUrl(text) {
  return text.includes('instagram.com/p/') || text.includes('instagram.com/reel/');
}

function parseInstagramUrl(text) {
  const urlMatch = text.match(/https:\/\/www\.instagram\.com\/(p|reel)\/([\w-]+)/);
  if (!urlMatch) return null;
  return {
    cleanUrl: `https://www.instagram.com/${urlMatch[1]}/${urlMatch[2]}/`,
    postId: urlMatch[2],
  };
}

async function fetchInstagramContent(cleanUrl) {
  try {
    const res = await fetch(cleanUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; Googlebot/2.1)',
        'Accept-Language': 'zh-TW,zh;q=0.9',
      },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const html = await res.text();

    // 抓 og:description
    const descMatch =
      html.match(/<meta\s+property="og:description"\s+content="([^"]+)"/i) ||
      html.match(/<meta\s+content="([^"]+)"\s+property="og:description"/i);

    // 抓作者（og:title 通常是 "姓名 (@帳號) • Instagram"）
    const titleMatch =
      html.match(/<meta\s+property="og:title"\s+content="([^"]+)"/i) ||
      html.match(/<meta\s+content="([^"]+)"\s+property="og:title"/i);

    const content = descMatch ? decodeHtmlEntities(descMatch[1]) : null;

    // 從 title 抓 @username
    let username = '';
    if (titleMatch) {
      const usernameMatch = titleMatch[1].match(/@([\w.]+)/);
      if (usernameMatch) username = usernameMatch[1];
    }

    return { content, username };
  } catch (err) {
    console.error('Fetch Instagram error:', err.message);
    return { content: null, username: '' };
  }
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

// ── FB URL 工具函式 ───────────────────────────────────────

function isFacebookUrl(text) {
  return text.includes('facebook.com/share/p/') || 
         text.includes('facebook.com/permalink') ||
         text.includes('facebook.com/photo') ||
         (text.includes('facebook.com') && text.includes('/posts/'));
}

function parseFacebookUrl(text) {
  // 支援 share/p/ 格式
  const shareMatch = text.match(/https:\/\/www\.facebook\.com\/share\/p\/([\w]+)/);
  if (shareMatch) {
    return {
      cleanUrl: `https://www.facebook.com/share/p/${shareMatch[1]}/`,
      postId: shareMatch[1],
    };
  }
  // 支援 /posts/ 格式
  const postMatch = text.match(/https:\/\/www\.facebook\.com\/[^/]+\/posts\/([\w]+)/);
  if (postMatch) {
    return {
      cleanUrl: text.split('?')[0],
      postId: postMatch[1],
    };
  }
  return null;
}

async function fetchFacebookContent(cleanUrl) {
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

    const titleMatch =
      html.match(/<meta\s+property="og:title"\s+content="([^"]+)"/i) ||
      html.match(/<meta\s+content="([^"]+)"\s+property="og:title"/i);

    const content = descMatch ? decodeHtmlEntities(descMatch[1]) : null;

    // FB 的 og:title 通常是「名稱 - Facebook」或直接是名字
    let username = '';
    if (titleMatch) {
      const raw = decodeHtmlEntities(titleMatch[1]);
      username = raw.replace(/\s*[-|]\s*Facebook.*$/i, '').trim();
    }

    return { content, username };
  } catch (err) {
    console.error('Fetch Facebook error:', err.message);
    return { content: null, username: '' };
  }
}

// ── 小紅書 URL 工具函式 ───────────────────────────────────

function isXhsUrl(text) {
  return text.includes('xhslink.com') || text.includes('xiaohongshu.com');
}

function extractXhsUrl(text) {
  // 從混合文字中抓出網址
  const match = text.match(/https?:\/\/(xhslink\.com\/[^\s]+|www\.xiaohongshu\.com\/[^\s]+)/);
  if (!match) return null;
  return match[0];
}

async function fetchXhsContent(url) {
  try {
    let html = '';
    let finalUrl = url;

    // 只讀短網址頁面本身，不追蹤重新導向
    const res = await fetch(url, {
      headers: {
        'User-Agent': 'facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)',
        'Accept-Language': 'zh-CN,zh;q=0.9',
      },
      redirect: 'manual',
    });

    html = await res.text();

    // 記錄重新導向目標作為 finalUrl（存檔用）
    const location = res.headers.get('location');
    if (location) finalUrl = location;

    if (!html) return { content: null, username: '', finalUrl, ogTitle: '' };

    const descMatch =
      html.match(/<meta\s+property="og:description"\s+content="([^"]+)"/i) ||
      html.match(/<meta\s+content="([^"]+)"\s+property="og:description"/i);

    const titleMatch =
      html.match(/<meta\s+property="og:title"\s+content="([^"]+)"/i) ||
      html.match(/<meta\s+content="([^"]+)"\s+property="og:title"/i);

    const content = descMatch ? decodeHtmlEntities(descMatch[1]) : null;
    const ogTitle = titleMatch ? decodeHtmlEntities(titleMatch[1]).replace(/\s*[-|]\s*小红书.*$/i, '').trim() : '';
    const username = ogTitle || '';

    return { content, username, finalUrl, ogTitle };
  } catch (err) {
    console.error('Fetch XHS error:', err.message);
    return { content: null, username: '', finalUrl: url, ogTitle: '' };
  }
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

// ── 分類自動配色 ──────────────────────────────────────────
function getCatColor(name) {
  const colors = [
    { bg: '#A89088', text: '#F5F1EE' },
    { bg: '#96A490', text: '#F5F1EE' },
    { bg: '#8A9EAA', text: '#F5F1EE' },
    { bg: '#A098AC', text: '#F5F1EE' },
    { bg: '#A8A080', text: '#F5F1EE' },
    { bg: '#9AA0AE', text: '#F5F1EE' },
    { bg: '#B09890', text: '#F5F1EE' },
    { bg: '#8AA898', text: '#F5F1EE' },
  ];
  let hash = 0;
  for (const c of name) hash += c.charCodeAt(0);
  return colors[hash % colors.length];
}

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

  // ── IG 收藏流程 ──
if (isInstagramUrl(text)) {
  const parsed = parseInstagramUrl(text);
  if (!parsed) {
    return replyText(event.replyToken, '❌ 無法解析 IG 連結，請確認格式是否正確。');
  }
  await replyText(event.replyToken, '⏳ 讀取中，請稍候...');
  try {
    const { content, username } = await fetchInstagramContent(parsed.cleanUrl);
    if (!content) {
      return pushText(userId, '⚠️ 無法讀取 IG 內容，可能是私人帳號或需要登入。\n\n連結已記錄：' + parsed.cleanUrl);
    }
    const userCats = await getCategories(userId);
    const aiResult = await classifyContent(content, username, userCats);
    const saved = await saveArticle(userId, {
      title: aiResult.title,
      url: parsed.cleanUrl,
      username: username,
      content,
      summary: aiResult.summary,
      category: aiResult.category,
    });
    
    if (saved.success) {
      const msg =
        `✅ IG 貼文已儲存！\n\n` +
        `📂 分類：${aiResult.category}\n` +
        `📌 標題：${aiResult.title}\n` +
        `📝 摘要：${aiResult.summary}\n` +
        `👤 作者：@${username}\n` +
        `🔗 ${parsed.cleanUrl}`;
      await pushText(userId, msg);
    } else {
      await pushText(userId, `⚠️ AI 分類完成，但儲存失敗。\n錯誤：${saved.error}`);
    }
  } catch (err) {
    console.error('IG 收藏流程錯誤:', err);
    await pushText(userId, `❌ 處理時發生錯誤：${err.message}`);
  }
  return;
}

// ── FB 收藏流程 ──
if (isFacebookUrl(text)) {
  const parsed = parseFacebookUrl(text);
  if (!parsed) {
    return replyText(event.replyToken, '❌ 無法解析 FB 連結，請確認格式是否正確。');
  }
  await replyText(event.replyToken, '⏳ 讀取中，請稍候...');
  try {
    const { content, username } = await fetchFacebookContent(parsed.cleanUrl);
    if (!content) {
      return pushText(userId, '⚠️ 無法讀取 FB 內容，可能是私人貼文或需要登入。\n\n連結已記錄：' + parsed.cleanUrl);
    }
    const userCats = await getCategories(userId);
    const aiResult = await classifyContent(content, username, userCats);
    const saved = await saveArticle(userId, {
      title: aiResult.title,
      url: parsed.cleanUrl,
      username: username,
      content,
      summary: aiResult.summary,
      category: aiResult.category,
    });
    if (saved.success) {
      const msg =
        `✅ FB 貼文已儲存！\n\n` +
        `📂 分類：${aiResult.category}\n` +
        `📌 標題：${aiResult.title}\n` +
        `📝 摘要：${aiResult.summary}\n` +
        `👤 作者：${username}\n` +
        `🔗 ${parsed.cleanUrl}`;
      await pushText(userId, msg);
    } else {
      await pushText(userId, `⚠️ AI 分類完成，但儲存失敗。\n錯誤：${saved.error}`);
    }
  } catch (err) {
    console.error('FB 收藏流程錯誤:', err);
    await pushText(userId, `❌ 處理時發生錯誤：${err.message}`);
  }
  return;
}

// ── 小紅書收藏流程 ──
if (isXhsUrl(text)) {
  const rawUrl = extractXhsUrl(text);
  if (!rawUrl) {
    return replyText(event.replyToken, '❌ 無法解析小紅書連結，請確認格式是否正確。');
  }
  await replyText(event.replyToken, '⏳ 讀取中，請稍候...');
  try {
    // 先從用戶傳的文字提取內容（不依賴網路抓取）
    const textPart = text
      .replace(rawUrl, '')
      .replace(/Copy and open rednote to view the note/gi, '')
      .replace(/http\S+/g, '')
      .trim();

    // 再嘗試抓網頁（可能成功也可能失敗）
    const { content, username, finalUrl, ogTitle } = await fetchXhsContent(rawUrl);
    const cleanUrl = finalUrl || rawUrl;

    const bestContent = content || ogTitle || textPart || null;
    const bestTitle = ogTitle || textPart.slice(0, 30) || '小紅書貼文';

    if (bestContent) {
      const userCats = await getCategories(userId);
      const aiResult = await classifyContent(bestContent, username, userCats);
      const saved = await saveArticle(userId, {
        title: aiResult.title || bestTitle,
        url: cleanUrl,
        username: username,
        content: bestContent,
        summary: aiResult.summary || bestContent.slice(0, 50),
        category: aiResult.category,
      });
      if (saved.success) {
        const msg =
          `✅ 小紅書貼文已儲存！\n\n` +
          `📂 分類：${aiResult.category}\n` +
          `📌 標題：${aiResult.title || bestTitle}\n` +
          `📝 摘要：${aiResult.summary || ''}\n` +
          `🔗 ${cleanUrl}`;
        await pushText(userId, msg);
      } else {
        await pushText(userId, `⚠️ 儲存失敗。\n錯誤：${saved.error}`);
      }
    } else {
      // 完全沒有任何文字
      pendingArticles.set(userId, {
        url: cleanUrl,
        title: '小紅書貼文',
        content: '小紅書貼文',
        username: '',
        summary: '小紅書貼文',
      });
      const cats = await getCategories(userId);
      return client.pushMessage({
        to: userId,
        messages: [{
          type: 'text',
          text: `📌 連結已讀取！\n無法自動讀取內容，請選擇分類後儲存：\n\n${cleanUrl}`,
          quickReply: {
            items: cats.slice(0, 13).map(cat => ({
              type: 'action',
              action: { type: 'message', label: cat, text: `/xhs分類 ${cat}` },
            })),
          },
        }],
      });
    }
  } catch (err) {
    console.error('小紅書收藏流程錯誤:', err);
    await pushText(userId, `❌ 處理時發生錯誤：${err.message}`);
  }
  return;
}

// ── 小紅書手動選分類 ──
if (text.startsWith('/xhs分類')) {
  const category = text.replace('/xhs分類', '').trim();
  const pending = pendingArticles.get(userId);

  if (!pending) {
    return replyText(event.replyToken, '❌ 找不到待儲存的貼文，請重新貼上連結。');
  }

  const saved = await saveArticle(userId, {
    title: pending.title,
    url: pending.url,
    username: pending.username,
    content: pending.content,
    summary: pending.summary,
    category: category,
  });

  pendingArticles.delete(userId);

  if (saved.success) {
    return pushText(userId,
      `✅ 小紅書貼文已儲存！\n\n` +
      `📂 分類：${category}\n` +
      `📌 標題：${pending.title}\n` +
      `🔗 ${pending.url}`
    );
  } else {
    return pushText(userId, `⚠️ 儲存失敗。\n錯誤：${saved.error}`);
  }
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
    `👋 嗨！我是你的 Threads 串串 搜集怪😈\n\n` +
    `━━━━━\n` +
    `📥 收藏文章\n` +
    `直接貼上或分享 Threads 連結給我\n` +
    `→ 自動幫你分類、整理、存檔\n\n` +
    `━━━━━\n` +
    `📱 下方選單功能\n\n` +
    `📋 近10筆　查看最新收藏\n` +
    `📂 找分類　依分類瀏覽近 10 筆文章\n` +
    `🔍 指定文章　輸入關鍵字搜尋\n` +
    `　　例如：輸入 *AI 搜尋近 10 筆文章\n` +
    `📚 我的收藏　開啟你專屬的個人網頁收藏頁\n\n` +
    `━━━━━\n` +
    `🗂 分類管理\n\n` +
    `我的分類　　　查看所有分類\n` +
    `/新增分類 名稱　新增分類\n` +
    `/刪除分類 名稱　刪除分類\n\n` +
    `💡 小提示\n` +
    `在網頁收藏頁可以直接修改分類、\n` +
    `新增好的分類也會自動幫你整理存檔唷！、\n` +
    `刪除文章，更方便整理！`;
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

app.use('/api', express.json());

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

app.post('/api/articles/update-category', async (req, res) => {
  const { token, articleId, category } = req.body;
  if (!token || !articleId || !category) return res.status(400).json({ error: '缺少參數' });
  const user = await getUserByToken(token);
  if (!user) return res.status(403).json({ error: '無效 token' });
  const result = await updateArticleCategory(user.id, articleId, category);
  res.json(result);
});

app.post('/api/articles/delete', async (req, res) => {
  const { token, articleId } = req.body;
  if (!token || !articleId) return res.status(400).json({ error: '缺少參數' });
  const user = await getUserByToken(token);
  if (!user) return res.status(403).json({ error: '無效 token' });
  const result = await deleteArticle(user.id, articleId);
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

  const categoryOptions = categories.map(c =>
    `<option value="${c}" ${category === c ? 'selected' : ''}>${c}</option>`
  ).join('');

  // 首頁：最新 10 筆橫向卡片
  const recentCards = articles.slice(0, 10).map(a => `
    <div class="h-card" id="card-${a.id}">
      <div class="h-card-cat">${a.category || ''}</div>
      <div class="h-card-title">${a.title || '無標題'}</div>
      <div class="h-card-summary">${a.summary || ''}</div>
      <div class="h-card-meta">👤 ${a.username || ''}　${a.saved_at ? a.saved_at.slice(0,10) : ''}</div>
      <div class="h-card-actions">
        <select class="cat-select" onchange="updateCat('${a.id}', this)">
          ${categories.map(c => `<option value="${c}" ${a.category === c ? 'selected' : ''}>${c}</option>`).join('')}
        </select>
        <button class="delete-btn" onclick="deleteArticleById('${a.id}')">刪除</button>
      </div>
      <a class="h-card-link" href="${a.url}" target="_blank">閱讀全文 →</a>
    </div>
  `).join('');

  // 搜尋結果：格線卡片
  const gridCards = articles.map(a => `
    <div class="card" id="card-${a.id}">
      <div class="card-cat">${a.category || ''}</div>
      <div class="card-title">${a.title || '無標題'}</div>
      <div class="card-summary">${a.summary || ''}</div>
      <div class="card-footer">
        <span class="meta-text">👤 ${a.username || ''}　${a.saved_at ? a.saved_at.slice(0,10) : ''}</span>
        <a class="read-link-sm" href="${a.url}" target="_blank">閱讀 →</a>
      </div>
      <div class="card-actions">
        <select class="cat-select" onchange="updateCat('${a.id}', this)">
          ${categories.map(c => `<option value="${c}" ${a.category === c ? 'selected' : ''}>${c}</option>`).join('')}
        </select>
        <button class="delete-btn" onclick="deleteArticleById('${a.id}')">刪除</button>
      </div>
    </div>
  `).join('');

  const isFiltered = category || keyword;

  res.send(`<!DOCTYPE html>
<html lang="zh-TW">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>MY.FEED</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link href="https://fonts.googleapis.com/css2?family=Cormorant+Garamond:wght@400;500&family=Nunito:wght@300;400;500&display=swap" rel="stylesheet">
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: 'Nunito', sans-serif; background: #E8E2DC; color: #302825; min-height: 100vh; }

    /* Header */
    .header { background: #EDE8E3; border-bottom: 1.5px solid #B8ADA5; padding: 20px 24px 14px; display: flex; align-items: flex-end; justify-content: space-between; max-width: 720px; margin: 0 auto; }
    .logo { font-family: 'Cormorant Garamond', serif; font-size: 28px; font-weight: 500; letter-spacing: 4px; text-decoration: none; color: #3A2F2A; }
    .logo span { color: #9A8678; }
    .header-meta { font-size: 10px; color: #9A8678; letter-spacing: 2px; text-transform: uppercase; text-align: right; line-height: 2; }

    /* Search */
    .search-wrap { background: #E2DBD4; border-bottom: 0.5px solid #CEC6BE; padding: 12px 24px; }
    .search-inner { max-width: 720px; margin: 0 auto; }
    .search-form { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }
    .search-form input { flex: 1; min-width: 140px; padding: 8px 16px; border: 0.5px solid #B8ADA5; background: #EDE8E3; border-radius: 20px; font-family: 'Nunito', sans-serif; font-size: 12px; color: #6A5E58; outline: none; }
    .search-form input:focus { border-color: #9A8678; }
    .search-form select { padding: 8px 14px; border: 0.5px solid #B8ADA5; background: #EDE8E3; border-radius: 20px; font-family: 'Nunito', sans-serif; font-size: 12px; color: #6A5E58; outline: none; }
    .search-form button { background: #3A2F2A; color: #EDE8E3; border: none; padding: 8px 20px; border-radius: 20px; font-family: 'Nunito', sans-serif; font-size: 11px; letter-spacing: 2px; text-transform: uppercase; cursor: pointer; }
    .search-form button:hover { background: #A89088; }

    /* Section */
    .section { max-width: 720px; margin: 0 auto; padding: 22px 24px 0; }
    .section-title { font-size: 10px; color: #9A8678; letter-spacing: 3px; text-transform: uppercase; margin-bottom: 12px; display: flex; align-items: center; gap: 10px; }
    .section-title::after { content: ''; flex: 1; height: 0.5px; background: #B8ADA5; }

    /* 分類橫向滑動 */
    .cat-scroll { display: flex; gap: 7px; overflow-x: auto; padding-bottom: 8px; flex-wrap: wrap; scrollbar-width: none; }
    .cat-scroll::-webkit-scrollbar { display: none; }
    .cat-pill { flex-shrink: 0; padding: 5px 16px; border-radius: 20px; font-size: 11px; cursor: pointer; text-decoration: none; white-space: nowrap; transition: opacity 0.15s; border: none; }
    .cat-pill:hover { opacity: 0.8; }
    .cat-pill-inactive { background: #EDE8E3; color: #6A5E58; border: 0.5px solid #B8ADA5; padding: 5px 16px; border-radius: 20px; font-size: 11px; text-decoration: none; white-space: nowrap; flex-shrink: 0; }
    .cat-pill-inactive:hover { background: #E2DBD4; }

    /* 橫向卡片 */
    .h-scroll { display: flex; gap: 12px; overflow-x: auto; padding: 4px 24px 20px; scrollbar-width: none; }
    .h-scroll::-webkit-scrollbar { display: none; }
    .h-card { flex-shrink: 0; width: 210px; background: #F5F1EE; border: 0.5px solid #CEC6BE; border-radius: 18px; padding: 16px; display: flex; flex-direction: column; gap: 7px; }
    .h-card-accent { width: 20px; height: 2px; border-radius: 4px; margin-bottom: 2px; }
    .h-card-cat { font-size: 9px; letter-spacing: 2px; text-transform: uppercase; }
    .h-card-title { font-family: 'Cormorant Garamond', serif; font-size: 15px; font-weight: 500; line-height: 1.4; color: #302825; }
    .h-card-summary { font-size: 11px; color: #7A6F68; line-height: 1.6; flex: 1; }
    .h-card-meta { font-size: 10px; color: #AEA49C; }
    .h-card-actions { display: flex; gap: 6px; margin-top: 4px; }
    .h-card-actions .cat-select { flex: 1; font-size: 11px; }
    .h-card-bot { border-top: 0.5px solid #DDD6CE; padding-top: 8px; margin-top: 4px; }
    .h-card-link { display: inline-block; font-size: 10px; letter-spacing: 1px; text-transform: uppercase; color: #9A8678; text-decoration: none; }
    .h-card-link:hover { color: #A89088; }

    /* 格線卡片 */
    .container { max-width: 720px; margin: 0 auto; padding: 16px 24px; }
    .result-label { font-size: 10px; color: #9A8678; letter-spacing: 2px; text-transform: uppercase; margin-bottom: 14px; }
    .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
    @media (max-width: 500px) { .grid { grid-template-columns: 1fr; } }
    .card { background: #F5F1EE; border: 0.5px solid #CEC6BE; border-radius: 18px; padding: 18px; }
    .card-accent { width: 20px; height: 2px; border-radius: 4px; margin-bottom: 8px; }
    .card-cat { font-size: 9px; letter-spacing: 2px; text-transform: uppercase; margin-bottom: 6px; }
    .card-title { font-family: 'Cormorant Garamond', serif; font-size: 16px; font-weight: 500; line-height: 1.4; margin-bottom: 8px; color: #302825; }
    .card-summary { font-size: 12px; color: #7A6F68; line-height: 1.6; margin-bottom: 12px; }
    .card-footer { display: flex; justify-content: space-between; align-items: center; border-top: 0.5px solid #DDD6CE; padding-top: 10px; gap: 8px; flex-wrap: wrap; }
    .meta-text { font-size: 10px; color: #AEA49C; }
    .read-link-sm { font-size: 10px; letter-spacing: 1px; text-transform: uppercase; color: #9A8678; text-decoration: none; }
    .read-link-sm:hover { color: #A89088; }
    .card-actions { display: flex; gap: 8px; margin-top: 10px; border-top: 0.5px solid #E8E3DF; padding-top: 10px; }
    .card-actions .cat-select { flex: 1; }

    /* 共用 */
    .cat-select { padding: 5px 10px; border: 0.5px solid #B8ADA5; background: #EDE8E3; border-radius: 12px; font-family: 'Nunito', sans-serif; font-size: 11px; outline: none; cursor: pointer; color: #6A5E58; }
    .cat-select:focus { border-color: #9A8678; }
    .delete-btn { background: none; border: 0.5px solid #CEC6BE; padding: 5px 12px; border-radius: 12px; font-size: 10px; letter-spacing: 1px; text-transform: uppercase; cursor: pointer; color: #AEA49C; font-family: 'Nunito', sans-serif; white-space: nowrap; }
    .delete-btn:hover { background: #A89088; color: #F5F1EE; border-color: #A89088; }

    /* 分類管理 */
    .cat-manage-wrap { max-width: 720px; margin: 20px auto 0; padding: 0 16px 20px; }
    .cat-manage { background: #E2DBD4; border-radius: 18px; padding: 20px; border: 0.5px solid #CEC6BE; }
    .cat-manage-title { font-size: 10px; letter-spacing: 3px; text-transform: uppercase; color: #9A8678; margin-bottom: 14px; display: flex; align-items: center; gap: 10px; }
    .cat-manage-title::after { content: ''; flex: 1; height: 0.5px; background: #B8ADA5; }
    .cat-hint { font-size: 11px; color: #AEA49C; margin-bottom: 12px; }
    .cat-list { display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: 14px; }
    .cat-item { display: flex; align-items: center; gap: 6px; background: #F5F1EE; border: 0.5px solid #CEC6BE; border-radius: 20px; padding: 5px 14px; font-size: 11px; color: #5A5050; }
    .cat-item-name { cursor: pointer; }
    .cat-item-name:hover { color: #A89088; }
    .cat-item button { background: none; border: none; cursor: pointer; font-size: 11px; color: #AEA49C; padding: 0; line-height: 1; }
    .cat-item button:hover { color: #A89088; }
    .cat-add { display: flex; gap: 8px; margin-bottom: 8px; }
    .cat-add input { flex: 1; padding: 8px 16px; border: 0.5px solid #B8ADA5; background: #F5F1EE; border-radius: 20px; font-family: 'Nunito', sans-serif; font-size: 12px; outline: none; color: #6A5E58; }
    .cat-add input:focus { border-color: #9A8678; }
    .cat-add button { background: #3A2F2A; color: #EDE8E3; border: none; padding: 8px 18px; border-radius: 20px; font-size: 11px; letter-spacing: 1.5px; text-transform: uppercase; cursor: pointer; font-family: 'Nunito', sans-serif; }
    .cat-add button:hover { background: #A89088; }
    .cat-msg { font-size: 11px; min-height: 18px; margin-top: 4px; }

    .empty { text-align: center; padding: 60px 20px; color: #AEA49C; font-size: 14px; line-height: 2; }
    .empty strong { display: block; font-family: 'Cormorant Garamond', serif; font-size: 22px; color: #B8ADA5; margin-bottom: 8px; font-weight: 400; }
  </style>
</head>
<body>

  <div style="background:#EDE8E3;">
    <div class="header">
      <a class="logo" href="/me?token=${token}">MY<span>.</span>FEED</a>
      <div class="header-meta">Threads ✦ Instagram ✦ Facebook<br>共 ${articles.length} 篇收藏</div>
    </div>
  </div>

  <div style="background:#E2DBD4;">
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
  </div>

  ${!isFiltered ? `
  <div style="background:#EDE8E3; padding-bottom: 8px;">
    <div class="section">
      <div class="section-title">分類</div>
      <div class="cat-scroll">
        ${categories.map(c => {
          const col = getCatColor(c);
          return `<a class="cat-pill" href="/me?token=${token}&category=${encodeURIComponent(c)}"
            style="background:${col.bg};color:${col.text};">${c}</a>`;
        }).join('')}
      </div>
    </div>

    <div class="section" style="padding-top:20px;">
      <div class="section-title">最新收藏</div>
      ${articles.length === 0 ? `
        <div class="empty"><strong>尚無收藏文章</strong>回到 LINE 貼上連結開始收藏！</div>
      ` : ''}
    </div>
    ${articles.length > 0 ? `
      <div class="h-scroll">
        ${articles.slice(0, 10).map(a => {
          const col = getCatColor(a.category || '');
          return `
          <div class="h-card" id="card-${a.id}">
            <div class="h-card-accent" style="background:${col.bg}"></div>
            <div class="h-card-cat" style="color:${col.bg}">${a.category || ''}</div>
            <div class="h-card-title">${a.title || '無標題'}</div>
            <div class="h-card-summary">${a.summary || ''}</div>
            <div class="h-card-meta">👤 ${a.username || ''}　${a.saved_at ? a.saved_at.slice(0,10) : ''}</div>
            <div class="h-card-actions">
              <select class="cat-select" onchange="updateCat('${a.id}', this)">
                ${categories.map(c => `<option value="${c}" ${a.category === c ? 'selected' : ''}>${c}</option>`).join('')}
              </select>
              <button class="delete-btn" onclick="deleteArticleById('${a.id}')">刪除</button>
            </div>
            <div class="h-card-bot">
              <a class="h-card-link" href="${a.url}" target="_blank">閱讀全文 →</a>
            </div>
          </div>`;
        }).join('')}
      </div>
    ` : ''}
  </div>
  ` : `
  <div style="background:#EDE8E3; min-height: 60vh;">
    <div class="container">
      <div class="result-label">
        ${category ? `📂 ${category}` : keyword ? `🔍 "${keyword}"` : ''} — 共 ${articles.length} 篇
        　<a href="/me?token=${token}" style="font-size:11px;color:#A89088;text-decoration:none;">← 回首頁</a>
      </div>
      ${articles.length === 0 ? `
        <div class="empty"><strong>找不到文章</strong>試試其他關鍵字或分類</div>
      ` : `
        <div class="grid">
          ${articles.map(a => {
            const col = getCatColor(a.category || '');
            return `
            <div class="card" id="card-${a.id}">
              <div class="card-accent" style="background:${col.bg}"></div>
              <div class="card-cat" style="color:${col.bg}">${a.category || ''}</div>
              <div class="card-title">${a.title || '無標題'}</div>
              <div class="card-summary">${a.summary || ''}</div>
              <div class="card-footer">
                <span class="meta-text">👤 ${a.username || ''}　${a.saved_at ? a.saved_at.slice(0,10) : ''}</span>
                <a class="read-link-sm" href="${a.url}" target="_blank">閱讀 →</a>
              </div>
              <div class="card-actions">
                <select class="cat-select" onchange="updateCat('${a.id}', this)">
                  ${categories.map(c => `<option value="${c}" ${a.category === c ? 'selected' : ''}>${c}</option>`).join('')}
                </select>
                <button class="delete-btn" onclick="deleteArticleById('${a.id}')">刪除</button>
              </div>
            </div>`;
          }).join('')}
        </div>
      `}
    </div>
  </div>
  `}

  <div class="cat-manage-wrap">
    <div class="cat-manage">
      <div class="cat-manage-title">分類管理</div>
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

    const COLORS = [
      { bg: '#A89088', text: '#F5F1EE' },
      { bg: '#96A490', text: '#F5F1EE' },
      { bg: '#8A9EAA', text: '#F5F1EE' },
      { bg: '#A098AC', text: '#F5F1EE' },
      { bg: '#A8A080', text: '#F5F1EE' },
      { bg: '#9AA0AE', text: '#F5F1EE' },
      { bg: '#B09890', text: '#F5F1EE' },
      { bg: '#8AA898', text: '#F5F1EE' },
    ];
    function getCatColor(name) {
      let hash = 0;
      for (const c of name) hash += c.charCodeAt(0);
      return COLORS[hash % COLORS.length];
    }

    async function updateCat(articleId, selectEl) {
      const category = selectEl.value;
      const res = await fetch('/api/articles/update-category', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: TOKEN, articleId, category }),
      });
      const data = await res.json();
      showMsg(data.success ? '✅ 分類已更新為「' + category + '」' : '❌ ' + data.error, !data.success);
    }

    async function deleteArticleById(articleId) {
      if (!confirm('確定刪除這篇文章？')) return;
      const res = await fetch('/api/articles/delete', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: TOKEN, articleId }),
      });
      const data = await res.json();
      if (data.success) {
        document.getElementById('card-' + articleId)?.remove();
        showMsg('🗑 文章已刪除');
      } else { showMsg('❌ ' + data.error, true); }
    }

    function renderCats() {
      const list = document.getElementById('catList');
      list.innerHTML = cats.map(c => {
        const col = getCatColor(c);
        return \`<div class="cat-item">
          <span style="width:8px;height:8px;border-radius:50%;background:\${col.bg};display:inline-block;flex-shrink:0;"></span>
          <span class="cat-item-name" onclick="renameCat('\${c}')">\${c}</span>
          <button onclick="deleteCat('\${c}')" title="刪除">✕</button>
        </div>\`;
      }).join('');
    }

    function showMsg(msg, isError) {
      const el = document.getElementById('catMsg');
      el.textContent = msg;
      el.style.color = isError ? '#A89088' : '#96A490';
      setTimeout(() => el.textContent = '', 3000);
    }

    async function addCat() {
      const input = document.getElementById('newCatInput');
      const name = input.value.trim();
      if (!name) return showMsg('請輸入分類名稱', true);
      const res = await fetch('/api/categories/add', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: TOKEN, name }),
      });
      const data = await res.json();
      if (data.success) { cats.push(name); renderCats(); input.value = ''; showMsg('✅ 已新增「' + name + '」'); }
      else { showMsg('❌ ' + data.error, true); }
    }

    async function deleteCat(name) {
      if (!confirm('確定刪除分類「' + name + '」？')) return;
      const res = await fetch('/api/categories/delete', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: TOKEN, name }),
      });
      const data = await res.json();
      if (data.success) { cats = cats.filter(c => c !== name); renderCats(); showMsg('🗑 已刪除「' + name + '」'); }
      else { showMsg('❌ ' + data.error, true); }
    }

    async function renameCat(oldName) {
      const newName = prompt('將「' + oldName + '」改名為：', oldName);
      if (!newName || newName.trim() === oldName) return;
      const res = await fetch('/api/categories/rename', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: TOKEN, oldName, newName: newName.trim() }),
      });
      const data = await res.json();
      if (data.success) { cats = cats.map(c => c === oldName ? newName.trim() : c); renderCats(); showMsg('✅ 已改名為「' + newName.trim() + '」'); }
      else { showMsg('❌ ' + data.error, true); }
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
