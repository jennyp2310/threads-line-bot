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
        // 新增：貼文發佈時間
        'Post Date': {
          date: postDate ? { start: postDate } : null,
        },
      },
    });

    return { success: true, pageId: response.id };
  } catch (err) {
    console.error('Notion save error:', err.message);
    return { success: false, error: err.message };
  }
}
