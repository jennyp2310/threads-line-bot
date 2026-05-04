const { Client } = require('@notionhq/client');
const notion = new Client({ auth: process.env.NOTION_TOKEN });
const { createClient } = require('@supabase/supabase-js');

console.log('SUPABASE_URL:', process.env.SUPABASE_URL);
console.log('SUPABASE_KEY 前10碼:', process.env.SUPABASE_KEY?.slice(0, 10));

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

const DEFAULT_CATEGORIES = [
  '各種科技','給我錢','漂亮美眉','各種商業','各種行銷',
  '健康寶寶','好吃的','我要出去玩！','好看的',
  '學到2','各種時事','生活2266','其他',
];

// ── 用戶：找不到就自動建立 ────────────────────────────────
async function getOrCreateUser(lineUserId) {
  const { data: existingUser } = await supabase
    .from('users')
    .select('*')
    .eq('line_user_id', lineUserId)
    .maybeSingle();

  if (existingUser) return existingUser;

  const token = Math.random().toString(36).slice(2) + Date.now().toString(36);
  const slug = Math.random().toString(36).substring(2, 10);
  const { data: newUser, error } = await supabase
    .from('users')
    .insert({ line_user_id: lineUserId, token, slug })
    .select()
    .single();

  if (error) {
    console.error('建立用戶失敗:', error.message);
    throw new Error('建立用戶失敗：' + error.message);
  }

  await initDefaultCategories(newUser.id);
  return newUser;
}

// ── 初始化預設分類 ────────────────────────────────────────
async function initDefaultCategories(userId) {
  const rows = DEFAULT_CATEGORIES.map(name => ({ user_id: userId, name }));
  await supabase.from('categories').insert(rows);
}

// ── 取得用戶分類清單（LINE 用）───────────────────────────
async function getCategories(lineUserId) {
  const user = await getOrCreateUser(lineUserId);
  const { data } = await supabase
    .from('categories')
    .select('name')
    .eq('user_id', user.id)
    .order('created_at', { ascending: true });

  if (!data || data.length === 0) {
    await initDefaultCategories(user.id);
    return DEFAULT_CATEGORIES;
  }

  return data.map(c => c.name);
}

// ── 新增分類（LINE 用）───────────────────────────────────
async function addCategory(lineUserId, name) {
  const user = await getOrCreateUser(lineUserId);
  const { error } = await supabase
    .from('categories')
    .insert({ user_id: user.id, name });
  if (error) {
    if (error.code === '23505') return { success: false, error: '分類已存在' };
    return { success: false, error: error.message };
  }
  return { success: true };
}

// ── 刪除分類（LINE 用）───────────────────────────────────
async function deleteCategory(lineUserId, name) {
  const user = await getOrCreateUser(lineUserId);
  const { error } = await supabase
    .from('categories')
    .delete()
    .eq('user_id', user.id)
    .eq('name', name);
  if (error) return { success: false, error: error.message };
  return { success: true };
}

// ── 儲存文章 ─────────────────────────────────────────────
async function saveArticle(lineUserId, article) {
  try {
    const user = await getOrCreateUser(lineUserId);
    const { error } = await supabase.from('articles').insert({
      user_id: user.id,
      title: article.title,
      url: article.url,
      username: article.username,
      content: article.content?.slice(0, 2000),
      summary: article.summary,
      category: article.category,
    });
    if (error) throw error;
    return { success: true };
  } catch (err) {
    console.error('Save error:', err.message);
    return { success: false, error: err.message };
  }
}

// ── 查詢分類 ─────────────────────────────────────────────
async function queryByCategory(lineUserId, category) {
  const user = await getOrCreateUser(lineUserId);
  const { data } = await supabase
    .from('articles')
    .select('*')
    .eq('user_id', user.id)
    .eq('category', category)
    .order('saved_at', { ascending: false })
    .limit(5);
  return data || [];
}

// ── 搜尋關鍵字 ───────────────────────────────────────────
async function queryByKeyword(lineUserId, keyword) {
  const user = await getOrCreateUser(lineUserId);
  const { data } = await supabase
    .from('articles')
    .select('*')
    .eq('user_id', user.id)
    .or(`title.ilike.%${keyword}%,summary.ilike.%${keyword}%,content.ilike.%${keyword}%,username.ilike.%${keyword}%`)
    .order('saved_at', { ascending: false })
    .limit(5);
  return data || [];
}

// ── 最新 N 筆 ────────────────────────────────────────────
async function queryRecent(lineUserId, limit = 10) {
  const user = await getOrCreateUser(lineUserId);
  const { data } = await supabase
    .from('articles')
    .select('*')
    .eq('user_id', user.id)
    .order('saved_at', { ascending: false })
    .limit(limit);
  return data || [];
}

// ── 用 token 查詢用戶（網頁用）──────────────────────────
async function getUserByToken(token) {
  const { data } = await supabase
    .from('users')
    .select('*')
    .eq('token', token)
    .maybeSingle();
  return data;
}

// ── 用 userId 查詢文章（網頁用）─────────────────────────
async function getArticlesByUserId(userId, { category, keyword } = {}) {
  let query = supabase
    .from('articles')
    .select('*')
    .eq('user_id', userId)
    .order('saved_at', { ascending: false });

  if (category) query = query.eq('category', category);
  if (keyword) query = query.or(`title.ilike.%${keyword}%,summary.ilike.%${keyword}%`);

  const { data } = await query.limit(50);
  return data || [];
}

// ── 用 userId 取得分類（網頁用）─────────────────────────
async function getCategoriesByUserId(userId) {
  const { data } = await supabase
    .from('categories')
    .select('name')
    .eq('user_id', userId)
    .order('created_at', { ascending: true });
  return (data || []).map(c => c.name);
}

// ── 新增分類（網頁用）────────────────────────────────────
async function addCategoryByUserId(userId, name) {
  const { error } = await supabase
    .from('categories')
    .insert({ user_id: userId, name });
  if (error) {
    if (error.code === '23505') return { success: false, error: '分類已存在' };
    return { success: false, error: error.message };
  }
  return { success: true };
}

// ── 刪除分類（網頁用）────────────────────────────────────
async function deleteCategoryByUserId(userId, name) {
  const { error } = await supabase
    .from('categories')
    .delete()
    .eq('user_id', userId)
    .eq('name', name);
  if (error) return { success: false, error: error.message };
  return { success: true };
}

// ── 改名分類（網頁用）────────────────────────────────────
async function renameCategoryById(userId, oldName, newName) {
  const { error } = await supabase
    .from('categories')
    .update({ name: newName })
    .eq('user_id', userId)
    .eq('name', oldName);
  if (error) return { success: false, error: error.message };
  return { success: true };
}

// ── 更新文章分類（網頁用）────────────────────────────────
async function updateArticleCategory(userId, articleId, category) {
  const { error } = await supabase
    .from('articles')
    .update({ category })
    .eq('id', articleId)
    .eq('user_id', userId);
  if (error) return { success: false, error: error.message };
  return { success: true };
}

// ── 刪除文章（網頁用）────────────────────────────────────
async function deleteArticle(userId, articleId) {
  const { error } = await supabase
    .from('articles')
    .delete()
    .eq('id', articleId)
    .eq('user_id', userId);
  if (error) return { success: false, error: error.message };
  return { success: true };
}

async function saveToNotion({ title, url, content, summary }) {
  try {
    // 先讀取現有所有 Tags
    const db = await notion.databases.retrieve({
      database_id: process.env.NOTION_DATABASE_ID
    });
    const existingTags = db.properties.Tags.multi_select.options.map(o => o.name);

    // 請 Claude 從現有 Tags 選出最符合的（最多3個）
    const Anthropic = require('@anthropic-ai/sdk');
    const anthropic = new Anthropic();
    const tagResponse = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 100,
      messages: [{
        role: 'user',
        content: `你是文章分類助手。
現有標籤清單：${existingTags.join('、')}
文章標題：${title}
文章摘要：${summary}

請從現有標籤中選出最符合的 1~3 個，如果都不適合可以新增 1 個新標籤。
只回傳標籤，用逗號分隔，不要其他文字。`
      }]
    });

    const tags = tagResponse.content[0].text
      .split(',')
      .map(t => t.trim())
      .filter(Boolean);

    // 寫入 Notion
    await notion.pages.create({
      parent: { database_id: process.env.NOTION_DATABASE_ID },
      properties: {
        Name: {
          title: [{ text: { content: title } }]
        },
        URL: { url: url },
        Tags: {
          multi_select: tags.map(name => ({ name }))
        }
      },
      children: content ? [
        {
          object: 'block',
          type: 'paragraph',
          paragraph: {
            rich_text: [{ text: { content: content } }]
          }
        }
      ] : []
    });

    console.log('✅ Notion 儲存成功');
  } catch (err) {
    // Notion 失敗不影響主流程
    console.error('⚠️ Notion 儲存失敗:', err.message);
  }
}

module.exports = {
  getUserBySlug,
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
  saveToNotion,
};

async function getUserBySlug(slug) {
  const { data, error } = await supabase
    .from('users')
    .select('*')
    .eq('slug', slug)
    .single();
  if (error) return null;
  return data;
}
