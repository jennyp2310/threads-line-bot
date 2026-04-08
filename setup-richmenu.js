const axios = require('axios');

const TOKEN = process.env.LINE_CHANNEL_ACCESS_TOKEN;
const headers = {
  Authorization: `Bearer ${TOKEN}`,
  'Content-Type': 'application/json',
};

async function createRichMenu() {
  const { data } = await axios.post(
    'https://api.line.me/v2/bot/richmenu',
    {
      size: { width: 2500, height: 1686 },
      selected: true,
      name: 'Threads 收藏機器人',
      chatBarText: '收集好文！',
      areas: [
        // 上排：說明（整排）
        {
          bounds: { x: 0, y: 0, width: 2500, height: 843 },
          action: { type: 'message', text: '說明' },
        },
        // 下排：四格
        {
          bounds: { x: 0, y: 843, width: 625, height: 843 },
          action: { type: 'message', text: '/近10筆' },
        },
        {
          bounds: { x: 625, y: 843, width: 625, height: 843 },
          action: { type: 'message', text: '/找分類' },
        },
        {
          bounds: { x: 1250, y: 843, width: 625, height: 843 },
          action: { type: 'message', text: '/搜尋' },
        },
        {
          bounds: { x: 1875, y: 843, width: 625, height: 843 },
          action: { type: 'message', text: '我的收藏' },
        },
      ],
    },
    { headers }
  );

  const richMenuId = data.richMenuId;
  console.log('✅ Step 1 建立成功：', richMenuId);

  const imageRes = await axios.get(
    'https://upload.cc/i1/2026/04/09/gqDwa5.png', // 待換新圖
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

  await axios.post(
    `https://api.line.me/v2/bot/user/all/richmenu/${richMenuId}`,
    {},
    { headers }
  );
  console.log('✅ Step 3 設為預設完成');

  return richMenuId;
}

module.exports = { createRichMenu };
