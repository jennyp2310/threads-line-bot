const { createClient } = require('@supabase/supabase-js');
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

// ── 用戶：找不到就自動建立 ────────────────────────────────
async function getOrCreateUser(lineUserId) {
  let { data: user } = await supabase
    .from('users')
    .select('*')
    .eq('line_user_id', lineUserId)
    .single();

  if (!user) {
    const token = Math.random().toString(36).slice(2) + Date.now().toString(36);
    const { data: newUser } = await supabase
      .from('users')
      .insert({ line_user_id: lineUserId, token })
      .select()
      .single();
    user = newUser;
  }
  return user;
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

// ── 用 token 查詢用戶（給網頁用）────────────────────────
async function getUserByToken(token) {
  const { data } = await supabase
    .from('users')
    .select('*')
    .eq('token', token)
    .single();
  return data;
}

// ── 用 userId 查詢文章（給網頁用）───────────────────────
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

module.exports = {
  getOrCreateUser,
  saveArticle,
  queryByCategory,
  queryByKeyword,
  queryRecent,
  getUserByToken,
  getArticlesByUserId,
};
