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

  if (text.includes('threads.net')) {
    replyText = `✅ 收到連結！\n${text}\n\n（儲存功能開發中）`;
  } else if (text === '/help' || text === '說明') {
    replyText = `📌 使用說明\n\n直接貼上 Threads 連結 → 自動儲存\n/分類 科技 → 查詢分類\n/搜尋 關鍵字 → 搜尋文章\n/說明 → 顯示此選單`;
  } else {
    replyText = `收到：${text}\n\n貼上 Threads 連結來收藏文章 🧵`;
  }

  await client.replyMessage({
    replyToken: event.replyToken,
    messages: [{ type: 'text', text: replyText }],
  });
}

app.get('/', (req, res) => res.send('LINE Bot is running!'));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
