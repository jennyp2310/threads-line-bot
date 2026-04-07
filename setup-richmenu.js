// setup-richmenu.js
const axios = require('axios');

const TOKEN = process.env.LINE_CHANNEL_ACCESS_TOKEN;
const headers = {
  Authorization: `Bearer ${TOKEN}`,
  'Content-Type': 'application/json',
};

async function createRichMenu() {
  // 1. 建立 Rich Menu 結構
  const { data } = await axios.post(
    'https://api.line.me/v2/bot/richmenu',
    {
      size: { width: 2500, height: 843 },
      selected: true,
      name: 'Threads 收藏機器人',
      chatBarText: '收集好文！',
      areas: [
        {
          bounds: { x: 0, y: 0, width: 833, height: 843 },
          action: { type: 'message', text: '/近10筆' },
        },
        {
          bounds: { x: 833, y: 0, width: 834, height: 843 },
          action: { type: 'message', text: '/找分類' },
        },
        {
          bounds: { x: 1667, y: 0, width: 833, height: 843 },
          action: { type: 'message', text: '/搜尋' },
        },
      ],
    },
    { headers }
  );

  const richMenuId = data.richMenuId;
  console.log('✅ Step 1 建立成功：', richMenuId);

  // 2. 上傳背景圖
  const imageRes = await axios.get(
    'https://placehold.co/2500x843/ff69b4/ffffff/png?text=近10筆+|+找分類+|+指定文章',
    { responseType: 'arraybuffer' }
  );
  await axios.post(
    `https://api-data.line.me/v2/bot/richmenu/${richMenuId}/content`,
    imageRes.data,
    {
      headers: {
        Authorization: `Bearer ${TOKEN}`,
        'Content-Type': 'image/png',
      },
    }
  );
  console.log('✅ Step 2 圖片上傳成功');

  // 3. 設為預設選單
  await axios.post(
    `https://api.line.me/v2/bot/user/all/richmenu/${richMenuId}`,
    {},
    { headers }
  );
  console.log('✅ Step 3 設為預設完成');

  return richMenuId;
}

module.exports = { createRichMenu };
