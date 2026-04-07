const Anthropic = require('@anthropic-ai/sdk');

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

// 各分類對應的關鍵字
const CATEGORY_RULES = [
  {
    category: '各種科技',
    keywords: [
      'AI', '人工智慧', '機器學習', '深度學習', '程式', '程式碼', '開發', '工程師',
      'app', 'App', '軟體', '硬體', 'iPhone', 'Android', '手機', '電腦', 'MacBook',
      'ChatGPT', 'Claude', 'Gemini', '大模型', 'LLM', 'API', '資料庫', '雲端',
      'GitHub', 'Python', 'JavaScript', 'React', '前端', '後端', '網頁',
      '晶片', '半導體', '台積電', '輝達', 'NVIDIA', '科技', '新創', '新技術',
    ],
  },
  {
    category: '給我錢',
    keywords: [
      '股票', '基金', 'ETF', '債券', '投資', '報酬', '殖利率', '股利', '除息',
      '美股', '台股', '指數', '大盤', '漲跌', '0050', '0056',
      '理財', '資產配置', '複利', '儲蓄', '存錢', '被動收入',
      '房地產', '房貸', '租金', '買房', '保險', '年金', '退休金',
      '加密貨幣', '比特幣', 'BTC', 'ETH', '虛擬貨幣', '幣圈',
      '銀行', '利率', '通膨', '匯率', '外幣', '美元', '日幣',
    ],
  },
  {
    category: '漂亮美眉',
    keywords: [
      '保養', '護膚', '精華', '乳液', '防曬', '卸妝', '洗臉', '面膜', '精華液',
      '化妝', '彩妝', '口紅', '粉底', '眼影', '睫毛', '眉毛', '腮紅',
      '香水', '護髮', '洗髮', '染髮', '護唇', '美甲',
      '美白', '保濕', '抗老', '抗皺', '毛孔', '痘痘', '粉刺',
      'skincare', 'makeup', 'SKII', '雅詩蘭黛', '蘭蔻', '資生堂', 'La Mer',
      '美妝', '美容', '開架', '專櫃',
    ],
  },
  {
    category: '各種商業',
    keywords: [
      '創業', '商業模式', '品牌', '策略', '管理', '領導', '團隊', '人才',
      'B2B', 'B2C', '電商', '平台', '商業', '企業', '公司', '市場',
      '用戶', '客戶', '顧客', '產品', '服務', '競爭', '差異化',
      'CEO', '創辦人', '商業思維', '商業洞察', '獲利',
    ],
  },
  {
    category: '各種行銷',
    keywords: [
      '行銷', '廣告', '文案', '內容行銷', '社群', 'SEO', 'IG', 'Instagram',
      'YouTube', 'TikTok', 'Threads', '流量', '曝光', '轉換率', '點擊',
      'KOL', 'KOC', '網紅', '業配', '置入', '推廣', '品牌行銷',
      '受眾', '目標族群', '行銷策略', '數位行銷', '成效',
    ],
  },
  {
    category: '健康寶寶',
    keywords: [
      '健康', '運動', '健身', '肌肉', '增肌', '減脂', '減重', '體重', '體態',
      '跑步', '重訓', '瑜伽', '有氧', '飲食', '營養', '蛋白質', '熱量',
      '睡眠', '作息', '壓力', '心理健康', '焦慮', '正念', '冥想',
      '醫療', '看診', '藥物', '病症', '復健',
    ],
  },
  {
    category: '好吃的',
    keywords: [
      '美食', '餐廳', '咖啡', '甜點', '料理', '食譜', '烹飪', '下廚',
      '燒肉', '火鍋', '拉麵', '壽司', '早午餐', '下午茶', '蛋糕',
      '好吃', '必吃', '推薦', '開箱', '試吃', '米其林',
      '台北美食', '台中美食', '高雄美食', '食記',
    ],
  },
  {
    category: '我要出去玩！',
    keywords: [
      '旅遊', '旅行', '出國', '自由行', '背包客', '機票', '飯店', '住宿',
      '日本', '韓國', '歐洲', '東南亞', '泰國', '巴黎', '紐約', '東京', '首爾',
      '景點', '打卡', '行程', '攻略', '簽證', '換匯', '伴手禮',
      '國內旅遊', '台灣景點', '花蓮', '墾丁',
    ],
  },
  {
    category: '好看的',
    keywords: [
      '電影', '影集', '動漫', '漫畫', '遊戲', '音樂', '演唱會', '展覽',
      'Netflix', 'Disney+', 'YouTube', '追劇', '推薦劇', '好看',
      '歌手', '偶像', '演員', '明星', '八卦', '娛樂',
      'K-pop', '韓劇', '日劇', '台劇', 'Marvel', '寶可夢',
    ],
  },
  {
    category: '學到2',
    keywords: [
      '學習', '讀書', '閱讀', '書單', '推薦書', '課程', '線上課', '學校',
      '考試', '英文', '語言學習', '技能', '成長', '自我提升',
      '筆記', '方法論', '思維', '邏輯', '知識', '教育',
    ],
  },
  {
    category: '各種時事',
    keywords: [
      '新聞', '政治', '政府', '政策', '法律', '選舉', '國際', '戰爭',
      '經濟', 'GDP', '通膨', '失業', '勞工', '薪資', '物價',
      '環境', '氣候', '地震', '颱風', '災害', '社會議題',
      '台灣', '中國', '美國', '日本', '時事', '輿論',
    ],
  },
  {
    category: '生活2266',
    keywords: [
      '生活', '日常', '分享', '心情', '感受', '想法', '觀察',
      '家居', '收納', '整理', '裝潢', '購物', '好物', '推薦',
      '親子', '寵物', '貓', '狗', '植物',
      '人際', '感情', '愛情', '友情', '家庭',
    ],
  },
];

// 關鍵字規則分類
function scoreContent(content) {
  const lowerContent = content.toLowerCase();
  const scores = CATEGORY_RULES.map(({ category, keywords }) => {
    const hits = keywords.filter(kw => lowerContent.includes(kw.toLowerCase()));
    return { category, score: hits.length, hits };
  });
  return scores.sort((a, b) => b.score - a.score);
}

// Claude API 產生標題與摘要
async function generateTitleAndSummary(content) {
  try {
    const response = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001', // 用 Haiku 速度快、費用低
      max_tokens: 200,
      messages: [{
        role: 'user',
        content: `請根據以下文章內容，以 JSON 格式回傳（只回傳 JSON，不要加任何說明或 markdown）：
{
  "title": "10個字以內的繁體中文標題，精準捕捉文章核心",
  "summary": "30個字以內的繁體中文摘要，說明文章重點"
}

文章內容：${content}`,
      }],
    });

    const raw = response.content[0].text.trim();
    const clean = raw.replace(/```json|```/g, '').trim();
    const parsed = JSON.parse(clean);

    // 防呆：超過字數就截斷
    return {
      title: parsed.title?.slice(0, 10) || content.slice(0, 10),
      summary: parsed.summary?.slice(0, 30) || content.slice(0, 30),
    };
  } catch (err) {
    console.error('Claude API error:', err.message);
    // API 失敗時回退到截斷版本
    return {
      title: content.replace(/\n+/g, ' ').trim().slice(0, 10),
      summary: content.replace(/\n+/g, ' ').trim().slice(0, 30),
    };
  }
}

async function classifyContent(content, username) {
  // 分類：關鍵字規則（不需要 API）
  const scores = scoreContent(content);
  const best = scores[0];
  const category = best.score > 0 ? best.category : '其他';
  console.log(`[分類] @${username} → ${category}（命中 ${best.score} 個關鍵字：${best.hits.slice(0, 3).join('、')}）`);

  // 標題 & 摘要：Claude API
  const { title, summary } = await generateTitleAndSummary(content);
  console.log(`[AI] 標題：${title}／摘要：${summary}`);

  return { title, summary, category };
}

module.exports = { classifyContent };
