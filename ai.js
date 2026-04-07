const Anthropic = require('@anthropic-ai/sdk');

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

const CATEGORIES = [
  '科技', '美妝保養', '商業', '行銷',
  '健康', '美食', '旅遊', '娛樂',
  '教育', '生活', '時事', '其他',
];

async function classifyContent(content, username) {
  const prompt = `你是一個文章分類助手。請分析以下 Threads 文章，以 JSON 格式回傳結果。

作者：@${username}
內容：${content}

請回傳以下 JSON（只回傳 JSON，不要加任何說明）：
{
  "title": "15字以內的繁體中文標題",
  "summary": "60字以內的繁體中文摘要，說明文章重點",
  "category": "從以下選一個最符合的：${CATEGORIES.join('、')}"
}`;

  try {
    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 500,
      messages: [{ role: 'user', content: prompt }],
    });

    const raw = response.content[0].text.trim();
    // 清除可能的 markdown code block
    const clean = raw.replace(/```json|```/g, '').trim();
    return JSON.parse(clean);
  } catch (err) {
    console.error('AI classify error:', err.message);
    return {
      title: content.slice(0, 15),
      summary: content.slice(0, 60),
      category: '其他',
    };
  }
}

module.exports = { classifyContent };
