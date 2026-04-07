const { Client } = require('@notionhq/client');

const notion = new Client({ auth: process.env.NOTION_TOKEN });
const DATABASE_ID = process.env.NOTION_DATABASE_ID;

async function saveToNotion({ title, url, username, content, summary, category }) {
  try {
    const response = await notion.pages.create({
      parent: { database_id: DATABASE_ID },
      properties: {
        // Title 欄位
        '標題': {
          title: [{ text: { content: title } }],
        },
        '連結': {
          url: url,
        },
        '作者': {
          rich_text: [{ text: { content: `@${username}` } }],
        },
        '內容': {
          rich_text: [{ text: { content: content.slice(0, 2000) } }],
        },
        '分類': {
          select: { name: category },
        },
        '摘要': {
          rich_text: [{ text: { content: summary } }],
        },
        '儲存時間': {
          date: { start: new Date().toISOString() },
        },
      },
    });

    return { success: true, pageId: response.id };
  } catch (err) {
    console.error('Notion save error:', err.message);
    return { success: false, error: err.message };
  }
}

// 查詢：依分類
async function queryByCategory(category) {
  try {
    const response = await notion.databases.query({
      database_id: DATABASE_ID,
      filter: {
        property: '分類',
        select: { equals: category },
      },
      sorts: [{ property: '儲存時間', direction: 'descending' }],
      page_size: 5,
    });

    return response.results.map(formatPage);
  } catch (err) {
    console.error('Notion query error:', err.message);
    return [];
  }
}

// 查詢：依關鍵字（搜尋標題 + 摘要）
async function queryByKeyword(keyword) {
  try {
    const response = await notion.databases.query({
      database_id: DATABASE_ID,
      filter: {
        or: [
          { property: '標題', rich_text: { contains: keyword } },
          { property: '摘要', rich_text: { contains: keyword } },
          { property: '內容', rich_text: { contains: keyword } },
          { property: '作者', rich_text: { contains: keyword } },
        ],
      },
      sorts: [{ property: '儲存時間', direction: 'descending' }],
      page_size: 5,
    });

    return response.results.map(formatPage);
  } catch (err) {
    console.error('Notion keyword query error:', err.message);
    return [];
  }
}

// 統一格式化 Notion page 結果
function formatPage(page) {
  const props = page.properties;
  return {
    title: props['標題']?.title?.[0]?.text?.content || '無標題',
    url: props['連結']?.url || '',
    username: props['作者']?.rich_text?.[0]?.text?.content || '',
    summary: props['摘要']?.rich_text?.[0]?.text?.content || '',
    category: props['分類']?.select?.name || '其他',
    savedAt: props['儲存時間']?.date?.start || '',
  };
}

module.exports = { saveToNotion, queryByCategory, queryByKeyword };
