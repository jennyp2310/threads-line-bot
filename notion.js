const { Client } = require('@notionhq/client');

const notion = new Client({ auth: process.env.NOTION_TOKEN });
const DATABASE_ID = process.env.NOTION_DATABASE_ID;

async function saveToNotion({ title, url, username, content, summary, category, postDate }) {
  try {
    const response = await notion.pages.create({
      parent: { database_id: DATABASE_ID },
      properties: {
        'Title': {
          title: [{ text: { content: title } }],
        },
        'URL': {
          url: url,
        },
        'Author': {
          rich_text: [{ text: { content: `@${username}` } }],
        },
        'Content': {
          rich_text: [{ text: { content: content.slice(0, 2000) } }],
        },
        'Category': {
          select: { name: category },
        },
        'Summary': {
          rich_text: [{ text: { content: summary } }],
        },
        'Date': {
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

async function queryByCategory(category) {
  try {
    const response = await notion.databases.query({
      database_id: DATABASE_ID,
      filter: {
        property: 'Category',
        select: { equals: category },
      },
      sorts: [{ property: 'Date', direction: 'descending' }],
      page_size: 5,
    });

    return response.results.map(formatPage);
  } catch (err) {
    console.error('Notion query error:', err.message);
    return [];
  }
}

async function queryByKeyword(keyword) {
  try {
    const response = await notion.databases.query({
      database_id: DATABASE_ID,
      filter: {
        or: [
          { property: 'Title', title: { contains: keyword } },
          { property: 'Summary', rich_text: { contains: keyword } },
          { property: 'Content', rich_text: { contains: keyword } },
          { property: 'Author', rich_text: { contains: keyword } },
        ],
      },
      sorts: [{ property: 'Date', direction: 'descending' }],
      page_size: 5,
    });

    return response.results.map(formatPage);
  } catch (err) {
    console.error('Notion keyword query error:', err.message);
    return [];
  }
}

function formatPage(page) {
  const props = page.properties;
  return {
    title: props['Title']?.title?.[0]?.text?.content || '無標題',
    url: props['URL']?.url || '',
    username: props['Author']?.rich_text?.[0]?.text?.content || '',
    summary: props['Summary']?.rich_text?.[0]?.text?.content || '',
    category: props['Category']?.select?.name || '其他',
    savedAt: props['Date']?.date?.start || '',
  };
}

module.exports = { saveToNotion, queryByCategory, queryByKeyword };
