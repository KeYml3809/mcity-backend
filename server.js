const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const crypto = require('crypto');

const app = express();
app.use(cors());
app.use(express.json({ limit: '50mb' }));

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

function hashPassword(password) {
  const salt = 'mcity_secure_salt_key';
  return crypto.createHash('sha256').update(password + salt).digest('hex');
}

/**
 * Универсальный резолвер пользователя.
 * Ищет реальный системный UUID в БД по любому переданному идентификатору или набору параметров:
 * { userId, id, publicId, email } или примитивной строке/числу.
 */
async function resolveUserId(clientOrPool, identifier) {
  if (!identifier) return null;

  let candidates = [];

  if (typeof identifier === 'object' && identifier !== null) {
    // Собираем все возможные поля в порядке приоритета
    if (identifier.id) candidates.push({ type: 'id', val: String(identifier.id).trim() });
    if (identifier.userId) candidates.push({ type: 'any', val: String(identifier.userId).trim() });
    if (identifier.publicId) candidates.push({ type: 'public_id', val: String(identifier.publicId).trim() });
    if (identifier.public_id) candidates.push({ type: 'public_id', val: String(identifier.public_id).trim() });
    if (identifier.email) candidates.push({ type: 'email', val: String(identifier.email).trim().toLowerCase() });
  } else {
    candidates.push({ type: 'any', val: String(identifier).trim() });
  }

  for (const item of candidates) {
    if (!item.val) continue;

    // 1. Поиск по public_id (MC-...)
    if (item.type === 'public_id' || (item.type === 'any' && item.val.startsWith('MC-'))) {
      const res = await clientOrPool.query('SELECT id FROM users WHERE public_id = $1', [item.val]);
      if (res.rows.length > 0) return res.rows[0].id;
    }

    // 2. Поиск по email
    if (item.type === 'email' || (item.type === 'any' && item.val.includes('@'))) {
      const res = await clientOrPool.query('SELECT id FROM users WHERE LOWER(email) = $1', [item.val.toLowerCase()]);
      if (res.rows.length > 0) return res.rows[0].id;
    }

    // 3. Поиск по системному id (UUID или число) с приведением к text для защиты от ошибок типов
    if (item.type === 'id' || item.type === 'any') {
      try {
        const res = await clientOrPool.query('SELECT id FROM users WHERE id::text = $1', [item.val]);
        if (res.rows.length > 0) return res.rows[0].id;
      } catch (e) {
        // Игнорируем синтаксическую ошибку при несовпадении формата
      }
    }
  }

  return null;
}

app.post('/api/register', async (req, res) => {
  const { email, password, nickname } = req.body;
  if (!email || !password || !nickname) {
    return res.status(400).json({ error: 'Заполните все обязательные поля' });
  }

  try {
    const passwordHash = hashPassword(password);
    const publicId = 'MC-' + Math.floor(100000 + Math.random() * 900000);
    const result = await pool.query(
      `INSERT INTO users (username, email, password_hash, public_id) 
       VALUES ($1, $2, $3, $4) 
       RETURNING id, username as nickname, email, public_id as "publicId"`,
      [nickname.trim(), email.trim().toLowerCase(), passwordHash, publicId]
    );
    res.json({ success: true, user: result.rows[0] });
  } catch (err) {
    if (err.code === '23505') {
      return res.status(400).json({ error: 'Пользователь с таким email или никнеймом уже существует' });
    }
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/login', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) {
    return res.status(400).json({ error: 'Введите email и пароль' });
  }

  try {
    const passwordHash = hashPassword(password);
    const result = await pool.query(
      `SELECT id, username as nickname, email, avatar_url, banner_url, likes_count, public_id 
       FROM users 
       WHERE email = $1 AND password_hash = $2`,
      [email.trim().toLowerCase(), passwordHash]
    );

    if (result.rows.length === 0) {
      return res.status(401).json({ error: 'Неверный email или пароль' });
    }

    const user = result.rows[0];
    res.json({
      success: true,
      user: {
        id: user.id,
        email: user.email,
        nickname: user.nickname,
        publicId: user.public_id || ('MC-' + (Math.abs(parseInt(String(user.id).replace(/-/g, ''), 16)) % 900000 + 100000)),
        avatar: user.avatar_url || '',
        banner: user.banner_url || '',
        likesCount: user.likes_count || 0
      }
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/users', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id as "userId", username as nickname, email, avatar_url as avatar, banner_url as banner, COALESCE(likes_count, 0) as "likesCount", public_id as "publicId", COALESCE(cards, '[]'::jsonb) as cards FROM users`
    );
    const rows = result.rows.map(r => ({
      ...r,
      cards: Array.isArray(r.cards) ? r.cards : [],
      cardsCount: Array.isArray(r.cards) ? r.cards.length : 0
    }));
    res.json(rows);
  } catch (err) {
    try {
      const fallback = await pool.query(
        `SELECT id as "userId", username as nickname, email, avatar_url as avatar, banner_url as banner, COALESCE(likes_count, 0) as "likesCount", public_id as "publicId" FROM users`
      );
      res.json(fallback.rows.map(r => ({ ...r, cards: [], cardsCount: 0 })));
    } catch (e2) {
      res.status(500).json({ error: e2.message });
    }
  }
});

// Точечный запрос конкретного пользователя по любому из параметров: userId, id, publicId, email
app.get('/api/user', async (req, res) => {
  const { userId, id, publicId, email } = req.query;
  try {
    const realUserId = await resolveUserId(pool, { userId, id, publicId, email });
    if (!realUserId) {
      return res.status(404).json({ error: 'Пользователь не найден по переданным параметрам' });
    }

    const result = await pool.query(
      `SELECT id as "userId", id, username as nickname, email, avatar_url as avatar, banner_url as banner, COALESCE(likes_count, 0) as "likesCount", public_id as "publicId", COALESCE(cards, '[]'::jsonb) as cards 
       FROM users 
       WHERE id = $1`,
      [realUserId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Пользователь не найден' });
    }

    const user = result.rows[0];
    res.json({
      success: true,
      user: {
        ...user,
        cards: Array.isArray(user.cards) ? user.cards : [],
        cardsCount: Array.isArray(user.cards) ? user.cards.length : 0
      }
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Вспомогательная отправка буфера в Telegram через sendDocument
async function sendBufferToTelegramDocument(botToken, chatId, buffer, safeFileName, mimeType) {
  const formData = new FormData();
  formData.append('chat_id', chatId);
  formData.append('document', new Blob([buffer], { type: mimeType }), safeFileName);

  console.log(`[UPLOAD] Отправка файла ${safeFileName} (${mimeType}) как документ в Telegram (chat_id: ${chatId})...`);

  const tgRes = await fetch(`https://api.telegram.org/bot${botToken}/sendDocument`, {
    method: 'POST',
    body: formData
  });

  const tgData = await tgRes.json();
  console.log('[TELEGRAM RAW RESPONSE]:', JSON.stringify(tgData));

  if (!tgData.ok) {
    console.error('[TELEGRAM API ERROR]:', tgData);
    throw new Error(`Ошибка Telegram (${tgData.error_code}): ${tgData.description}`);
  }

  const r = tgData.result || {};
  const fileId = (r.document && r.document.file_id)
    || (r.animation && r.animation.file_id)
    || (r.video && r.video.file_id)
    || (Array.isArray(r.photo) && r.photo.length > 0 ? r.photo[r.photo.length - 1].file_id : null)
    || null;
  if (!fileId) {
    throw new Error('Telegram принял файл, но не вернул file_id.');
  }

  console.log(`[UPLOAD SUCCESS] Файл успешно отправлен. file_id: ${fileId}`);
  return fileId;
}

// Отдельное правило загрузки ТОЛЬКО для анимаций стадий (сохраняется как .mp4 / анимация)
app.post('/api/upload-animation', async (req, res) => {
  const { animationBase64, imageBase64, fileName, fileType, mediaType } = req.body;
  const rawPayload = animationBase64 || imageBase64;
  if (!rawPayload) {
    return res.status(400).json({ error: 'Файл анимации не передан' });
  }

  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;

  if (!botToken || !chatId) {
    console.error('[UPLOAD ANIMATION ERROR] TELEGRAM_BOT_TOKEN или TELEGRAM_CHAT_ID не заданы в переменных окружения!');
    return res.status(500).json({ error: 'Telegram не настроен на сервере (нет ключей)' });
  }

  try {
    let detectedMime = '';
    const dataUriMatch = /^data:([^;]+);base64,/.exec(rawPayload);
    if (dataUriMatch && dataUriMatch[1]) {
      detectedMime = dataUriMatch[1].trim().toLowerCase();
    }

    const base64Data = rawPayload.replace(/^data:[^;]+;base64,/, '');
    const buffer = Buffer.from(base64Data, 'base64');

    const rawName = String(fileName || ('animation_' + Date.now())).trim();
    const dotIdx = rawName.lastIndexOf('.');
    const rawBase = dotIdx > 0 ? rawName.substring(0, dotIdx) : rawName;
    const cleanBase = rawBase.replace(/[^a-zA-Z0-9_-]/g, '_') || ('animation_' + Date.now());

    // Для анимаций всегда сохраняем имя с расширением .mp4
    const safeFileName = `${cleanBase}.mp4`;
    const isGif = mediaType === 'gif' || fileType === 'image/gif' || detectedMime === 'image/gif' || /\.gif$/i.test(rawName);
    const mimeType = isGif
      ? 'image/gif'
      : ((detectedMime && detectedMime.startsWith('video/'))
        ? detectedMime
        : ((fileType && String(fileType).startsWith('video/')) ? String(fileType).toLowerCase() : 'video/mp4'));

    const fileId = await sendBufferToTelegramDocument(botToken, chatId, buffer, safeFileName, mimeType);
    res.json({ success: true, url: fileId, fileName: safeFileName, mediaType: isGif ? 'gif' : 'mp4' });
  } catch (err) {
    console.error('[SERVER EXCEPTION during animation upload]:', err);
    res.status(500).json({ error: 'Внутренняя ошибка сервера при загрузке анимации: ' + err.message });
  }
});

// Загрузка всех остальных файлов/карточек в Telegram строго как .jpg и image/jpeg
app.post('/api/upload-page', async (req, res) => {
  const { imageBase64, fileName } = req.body;
  if (!imageBase64) {
    return res.status(400).json({ error: 'Изображение не передано' });
  }

  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;

  if (!botToken || !chatId) {
    console.error('[UPLOAD ERROR] TELEGRAM_BOT_TOKEN или TELEGRAM_CHAT_ID не заданы в переменных окружения!');
    return res.status(500).json({ error: 'Telegram не настроен на сервере (нет ключей)' });
  }

  try {
    const base64Data = imageBase64.replace(/^data:[^;]+;base64,/, '');
    const buffer = Buffer.from(base64Data, 'base64');

    let safeFileName = 'card_' + Date.now() + '.jpg';
    if (fileName) {
      const dotIdx = fileName.lastIndexOf('.');
      const baseName = dotIdx > 0 ? fileName.substring(0, dotIdx) : fileName;
      safeFileName = `${baseName.replace(/[^a-zA-Z0-9_-]/g, '_')}.jpg`;
    }

    const mimeType = 'image/jpeg';
    const fileId = await sendBufferToTelegramDocument(botToken, chatId, buffer, safeFileName, mimeType);
    res.json({ success: true, url: fileId });
  } catch (err) {
    console.error('[SERVER EXCEPTION during upload]:', err);
    res.status(500).json({ error: 'Внутренняя ошибка сервера при загрузке: ' + err.message });
  }
});

// Обновление профиля: принимает userId, id, publicId и/или email одновременно для безошибочной идентификации
app.patch('/api/profile', async (req, res) => {
  let { userId, id, publicId, email, avatarUrl, bannerUrl, nickname, cards } = req.body;
  try {
    const realUserId = await resolveUserId(pool, { userId, id, publicId, email });
    if (!realUserId) {
      return res.status(404).json({ error: 'Пользователь не найден ни по одному из идентификаторов (userId, publicId, email)' });
    }

    if (cards !== undefined) {
      try {
        await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS cards JSONB DEFAULT '[]'::jsonb`);
      } catch (e) {}
    }

    const result = await pool.query(
      `UPDATE users 
       SET avatar_url = COALESCE($1, avatar_url), 
           banner_url = COALESCE($2, banner_url),
           username = COALESCE($3, username),
           cards = COALESCE($4::jsonb, cards)
       WHERE id = $5 
       RETURNING id, id as "userId", username as nickname, email, avatar_url as avatar, banner_url as banner, COALESCE(likes_count, 0) as "likesCount", public_id as "publicId", COALESCE(cards, '[]'::jsonb) as cards`,
      [avatarUrl ?? null, bannerUrl ?? null, nickname ?? null, cards !== undefined ? JSON.stringify(cards) : null, realUserId]
    );

    if (result.rowCount === 0) {
      return res.status(404).json({ error: 'Пользователь не найден при обновлении' });
    }

    res.json({ success: true, user: result.rows[0] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Лайк профиля: поддерживает передачу как через URL, так и через тело запроса (userId, publicId, email)
app.post('/api/profile/:targetUserId/like', async (req, res) => {
  let { fromUserId, fromPublicId, fromEmail, targetPublicId, targetEmail } = req.body;
  let { targetUserId } = req.params;

  try {
    const realFromId = await resolveUserId(pool, {
      userId: fromUserId,
      publicId: fromPublicId,
      email: fromEmail
    });
    const realTargetId = await resolveUserId(pool, {
      userId: targetUserId,
      publicId: targetPublicId,
      email: targetEmail
    });

    if (!realFromId || !realTargetId) {
      return res.status(404).json({ error: 'Отправитель или получатель лайка не найден' });
    }

    if (String(realFromId) === String(realTargetId)) {
      return res.status(400).json({ error: 'Нельзя ставить лайк самому себе' });
    }

    const lastLikeRes = await pool.query(
      `SELECT created_at FROM profile_likes_log 
       WHERE from_user_id = $1 AND to_user_id = $2 
       ORDER BY created_at DESC LIMIT 1`,
      [realFromId, realTargetId]
    );

    if (lastLikeRes.rows.length > 0) {
      const lastLikeTime = new Date(lastLikeRes.rows[0].created_at).getTime();
      const threeHoursInMs = 3 * 60 * 60 * 1000;
      const timePassed = Date.now() - lastLikeTime;

      if (timePassed < threeHoursInMs) {
        const remainingMinutes = Math.ceil((threeHoursInMs - timePassed) / (1000 * 60));
        return res.status(429).json({ 
          error: `Повторный лайк можно поставить через ${remainingMinutes} мин.` 
        });
      }
    }

    await pool.query('BEGIN');
    await pool.query(
      `INSERT INTO profile_likes_log (from_user_id, to_user_id) VALUES ($1, $2)`,
      [realFromId, realTargetId]
    );
    await pool.query(
      `UPDATE users SET likes_count = likes_count + 1 WHERE id = $1`,
      [realTargetId]
    );
    await pool.query('COMMIT');

    res.json({ success: true, message: 'Лайк успешно поставлен!' });
  } catch (err) {
    await pool.query('ROLLBACK');
    res.status(500).json({ error: err.message });
  }
});

// Проксирование изображений из Telegram по file_id
app.get('/api/proxy-image', async (req, res) => {
  const fileId = req.query.file_id;
  if (!fileId) {
    return res.status(400).send('file_id is required');
  }

  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  if (!botToken) {
    return res.status(500).send('TELEGRAM_BOT_TOKEN not configured');
  }

  try {
    const fileRes = await fetch(`https://api.telegram.org/bot${botToken}/getFile?file_id=${fileId}`);
    const fileData = await fileRes.json();
    if (!fileData.ok || !fileData.result.file_path) {
      return res.status(404).send('File not found in Telegram');
    }

    const filePath = fileData.result.file_path;
    const imageRes = await fetch(`https://api.telegram.org/file/bot${botToken}/${filePath}`);
    if (!imageRes.ok) {
      return res.status(500).send('Failed to fetch file from Telegram servers');
    }

    const arrayBuffer = await imageRes.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);

    const lowerPath = String(filePath || '').toLowerCase();
    let outContentType = 'application/octet-stream';
    if (lowerPath.endsWith('.mp4')) outContentType = 'video/mp4';
    else if (lowerPath.endsWith('.webm')) outContentType = 'video/webm';
    else if (lowerPath.endsWith('.mov')) outContentType = 'video/quicktime';
    else if (lowerPath.endsWith('.gif')) outContentType = 'image/gif';
    else if (lowerPath.endsWith('.png')) outContentType = 'image/png';
    else if (lowerPath.endsWith('.webp')) outContentType = 'image/webp';
    else if (lowerPath.endsWith('.jpg') || lowerPath.endsWith('.jpeg')) outContentType = 'image/jpeg';
    else if (imageRes.headers.get('content-type')) outContentType = imageRes.headers.get('content-type');

    res.setHeader('Content-Type', outContentType);
    res.setHeader('Cache-Control', 'public, max-age=31536000');
    res.send(buffer);
  } catch (err) {
    console.error('[PROXY ERROR]:', err);
    res.status(500).send('Error proxying image: ' + err.message);
  }
});


// Получить актуальный список друзей с их свежими никами, аватарами и баннерами
app.get('/api/friends', async (req, res) => {
  const { userId, id, publicId, email } = req.query;
  try {
    const realUserId = await resolveUserId(pool, { userId, id, publicId, email });
    if (!realUserId) {
      return res.status(404).json({ error: 'Пользователь не найден' });
    }

    const result = await pool.query(
      `SELECT u.id as "userId", u.username as nickname, u.avatar_url as avatar, 
              u.banner_url as banner, u.public_id as "publicId"
       FROM friends f
       JOIN users u ON u.id::text = f.friend_id
       WHERE f.user_id = $1
       ORDER BY f.created_at DESC`,
      [String(realUserId)]
    );

    res.json({ success: true, friends: result.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Двустороннее добавление в друзья (при принятии заявки)
app.post('/api/friends/accept', async (req, res) => {
  const { userId, publicId, email, friendId } = req.body;
  try {
    const realUserId = await resolveUserId(pool, { userId, publicId, email });
    const realFriendId = await resolveUserId(pool, { userId: friendId });

    if (!realUserId || !realFriendId) {
      return res.status(404).json({ error: 'Один из пользователей не найден' });
    }
    if (String(realUserId) === String(realFriendId)) {
      return res.status(400).json({ error: 'Нельзя добавить самого себя' });
    }

    await pool.query('BEGIN');
    await pool.query(
      `INSERT INTO friends (user_id, friend_id) VALUES ($1, $2), ($2, $1) ON CONFLICT DO NOTHING`,
      [String(realUserId), String(realFriendId)]
    );
    await pool.query('COMMIT');

    res.json({ success: true });
  } catch (err) {
    await pool.query('ROLLBACK');
    res.status(500).json({ error: err.message });
  }
});

// Двустороннее удаление из друзей
app.delete('/api/friends/:friendId', async (req, res) => {
  const { userId, publicId, email } = req.body || req.query;
  const { friendId } = req.params;
  try {
    const realUserId = await resolveUserId(pool, { userId, publicId, email });
    const realFriendId = await resolveUserId(pool, { userId: friendId });

    if (!realUserId || !realFriendId) {
      return res.status(404).json({ error: 'Пользователь не найден' });
    }

    await pool.query(
      `DELETE FROM friends 
       WHERE (user_id = $1 AND friend_id = $2) OR (user_id = $2 AND friend_id = $1)`,
      [String(realUserId), String(realFriendId)]
    );

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 5000;

async function initDatabase() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS chapters (
          id SERIAL PRIMARY KEY,
          manga_id TEXT NOT NULL,
          chapter_number NUMERIC NOT NULL,
          title TEXT,
          pages JSONB,
          created_at TIMESTAMPTZ DEFAULT NOW(),
          CONSTRAINT unique_manga_chapter UNIQUE (manga_id, chapter_number)
      );
      CREATE INDEX IF NOT EXISTS idx_chapters_manga_id ON chapters(manga_id);

      CREATE TABLE IF NOT EXISTS friends (
          user_id TEXT NOT NULL,
          friend_id TEXT NOT NULL,
          created_at TIMESTAMPTZ DEFAULT NOW(),
          PRIMARY KEY (user_id, friend_id)
      );
      CREATE INDEX IF NOT EXISTS idx_friends_user_id ON friends(user_id);

      CREATE TABLE IF NOT EXISTS jester_stage_animations (
          stage INTEGER PRIMARY KEY CHECK (stage IN (1, 2, 3)),
          media_url TEXT,
          media_type TEXT NOT NULL DEFAULT 'mp4',
          file_name TEXT,
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);
    console.log('[DB] Таблицы chapters, friends и jester_stage_animations успешно проверены / созданы.');
  } catch (err) {
    console.error('[DB ERROR] Ошибка инициализации таблиц:', err.message);
  }
}

app.listen(PORT, async () => {
  console.log(`Server listening on port ${PORT}`);
  await initDatabase();
});
