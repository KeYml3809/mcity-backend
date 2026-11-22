const express = require('express');
const cors = require('cors');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { Pool } = require('pg');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// --- Подключение к PostgreSQL / Supabase ---
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL
    ? { rejectUnauthorized: false }
    : undefined,
});

// --- Папка для загруженных баннеров и статика ---
const uploadsRoot = path.join(__dirname, 'uploads');
const bannersDir = path.join(uploadsRoot, 'banners');
fs.mkdirSync(bannersDir, { recursive: true });

app.use(cors());
// Увеличьте лимит тела запроса для загрузки видео/GIF (например, до 15 МБ)
app.use(express.json({ limit: '15mb' }));
app.use(express.urlencoded({ extended: true, limit: '15mb' }));

pool.query(`
  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    url TEXT,
    type TEXT,
    updated_at TIMESTAMPTZ DEFAULT NOW()
  )
`).catch((err) => console.error('Ошибка создания таблицы settings:', err));
app.use('/uploads', express.static(uploadsRoot));

// --- Настройка Multer ---
const ALLOWED_MIMES = {
  'image/gif': 'gif',
  'image/webp': 'image',
  'image/png': 'image',
  'image/jpeg': 'image',
  'video/mp4': 'video',
  'video/webm': 'video',
};

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, bannersDir),
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase() || '.bin';
    const unique = `${Date.now()}-${Math.round(Math.random() * 1e9)}${ext}`;
    cb(null, unique);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: 25 * 1024 * 1024 }, // до 25 МБ
  fileFilter: (_req, file, cb) => {
    if (ALLOWED_MIMES[file.mimetype]) {
      cb(null, true);
    } else {
      cb(new Error('Допускаются только GIF, изображения (PNG/JPG/WEBP) и видео (MP4/WEBM)'));
    }
  },
});

function uploadBannerMiddleware(req, res, next) {
  upload.single('bannerFile')(req, res, (err) => {
    if (!err) return next();
    if (err instanceof multer.MulterError) {
      if (err.code === 'LIMIT_FILE_SIZE') {
        return res.status(400).json({ error: 'Файл слишком большой (максимум 25 МБ)' });
      }
      return res.status(400).json({ error: `Ошибка загрузки файла: ${err.message}` });
    }
    return res.status(400).json({ error: err.message || 'Ошибка загрузки файла' });
  });
}

// --- Проверка статуса сервиса ---
app.get('/health', async (_req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({ ok: true });
  } catch (err) {
    console.error('GET /health:', err);
    res.status(500).json({ ok: false, error: 'Database connection error' });
  }
});

// --- Прокси для внешних API (MangaDex) ---
const ALLOWED_PROXY_HOSTS = new Set([
  'api.mangadex.org',
  'uploads.mangadex.org',
]);

app.get('/api/external/proxy', async (req, res) => {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 12000);

  try {
    const rawUrl = String(req.query.url || '').trim();
    if (!rawUrl) {
      return res.status(400).json({ error: 'Missing url parameter' });
    }

    let parsedUrl;
    try {
      parsedUrl = new URL(rawUrl);
    } catch {
      return res.status(400).json({ error: 'Invalid url parameter' });
    }

    if (!['https:', 'http:'].includes(parsedUrl.protocol)) {
      return res.status(400).json({ error: 'Unsupported protocol' });
    }

    if (!ALLOWED_PROXY_HOSTS.has(parsedUrl.hostname)) {
      return res.status(403).json({ error: 'Host is not allowed' });
    }

    const upstreamRes = await fetch(parsedUrl.toString(), {
      signal: controller.signal,
      headers: {
        'User-Agent': 'McityMangaLibrary/1.0 (contact@mcity.local)',
        'Accept': 'application/json, text/plain, */*',
      },
    });

    const contentType = upstreamRes.headers.get('content-type') || 'application/json; charset=utf-8';
    const bodyText = await upstreamRes.text();

    res.status(upstreamRes.status);
    res.set('Content-Type', contentType);
    return res.send(bodyText);
  } catch (err) {
    console.error('GET /api/external/proxy:', err);
    return res.status(502).json({ error: 'External proxy request failed' });
  } finally {
    clearTimeout(timeout);
  }
});

// --- Синхронизация друзей и заявок из таблицы friends / friend_requests ---
app.get('/api/friends', async (req, res) => {
  try {
    const userId = String(req.query.userId || '').trim();
    if (!userId) {
      return res.json({ friends: [], incoming: [], outgoing: [] });
    }

    const friendsRes = await pool.query(
      `SELECT user_id, friend_id, created_at
       FROM friends
       WHERE user_id = $1 OR friend_id = $1
       ORDER BY created_at DESC NULLS LAST`,
      [userId]
    );

    const friendIds = Array.from(
      new Set(
        friendsRes.rows.map((row) =>
          String(row.user_id) === userId ? String(row.friend_id) : String(row.user_id)
        )
      )
    );

    const incomingRes = await pool.query(
      `SELECT id, sender_id, sender_nickname, sender_avatar, sender_public_id,
              receiver_id, receiver_nickname, receiver_avatar, receiver_public_id,
              status, created_at
       FROM friend_requests
       WHERE receiver_id = $1 AND status = 'pending'
       ORDER BY created_at DESC NULLS LAST`,
      [userId]
    );

    const outgoingRes = await pool.query(
      `SELECT id, sender_id, sender_nickname, sender_avatar, sender_public_id,
              receiver_id, receiver_nickname, receiver_avatar, receiver_public_id,
              status, created_at
       FROM friend_requests
       WHERE sender_id = $1 AND status = 'pending'
       ORDER BY created_at DESC NULLS LAST`,
      [userId]
    );

    return res.json({
      friends: friendIds,
      incoming: incomingRes.rows,
      outgoing: outgoingRes.rows,
    });
  } catch (err) {
    console.error('GET /api/friends:', err);
    return res.status(500).json({ error: 'Ошибка загрузки списка друзей' });
  }
});

// --- Загрузка медиа через Telegram Bot API (с запасным сохранением на диск) ---
const TG_BOT_TOKEN = String(process.env.TELEGRAM_BOT_TOKEN || process.env.BOT_TOKEN || '').trim();
const TG_STORAGE_CHAT_ID = String(process.env.TELEGRAM_STORAGE_CHAT_ID || process.env.TELEGRAM_CHAT_ID || process.env.CHAT_ID || '').trim();
const tgMediaDir = path.join(uploadsRoot, 'tg-media');
fs.mkdirSync(tgMediaDir, { recursive: true });

function parseBase64Payload(rawInput) {
  const raw = String(rawInput || '').trim();
  if (!raw) return null;
  const match = raw.match(/^data:([^;]+);base64,(.+)$/s);
  if (match) {
    return {
      mimeType: match[1].trim(),
      buffer: Buffer.from(match[2], 'base64'),
    };
  }
  return {
    mimeType: 'application/octet-stream',
    buffer: Buffer.from(raw, 'base64'),
  };
}

function getFileIdFromUrlOrValue(val) {
  const s = String(val || '').trim();
  if (!s) return '';
  if (s.includes('file_id=')) {
    try {
      const u = new URL(s);
      return String(u.searchParams.get('file_id') || '').trim();
    } catch (_) {
      const m = s.match(/file_id=([^&]+)/);
      return m ? decodeURIComponent(m[1]) : '';
    }
  }
  if (!s.startsWith('http://') && !s.startsWith('https://') && !s.startsWith('/')) {
    return s;
  }
  return '';
}

async function uploadBufferToTelegram(buffer, fileName, mimeType) {
  if (!TG_BOT_TOKEN || !TG_STORAGE_CHAT_ID) return null;

  const isVideo = /^video\//i.test(mimeType || '') || /\.(mp4|webm|mov)$/i.test(fileName || '');
  const isImage = /^image\//i.test(mimeType || '') && !/gif/i.test(mimeType || '');
  const endpoint = isVideo ? 'sendVideo' : (isImage ? 'sendPhoto' : 'sendDocument');
  const fieldName = isVideo ? 'video' : (isImage ? 'photo' : 'document');

  const form = new FormData();
  form.append('chat_id', TG_STORAGE_CHAT_ID);
  const blob = new Blob([buffer], { type: mimeType || 'application/octet-stream' });
  form.append(fieldName, blob, fileName || 'upload.bin');

  const tgRes = await fetch(`https://api.telegram.org/bot${TG_BOT_TOKEN}/${endpoint}`, {
    method: 'POST',
    body: form,
  });
  const tgJson = await tgRes.json().catch(() => null);
  if (!tgRes.ok || !tgJson || !tgJson.ok || !tgJson.result) {
    throw new Error((tgJson && tgJson.description) || `Telegram ${endpoint} failed`);
  }

  const r = tgJson.result;
  if (r.video && r.video.file_id) return r.video.file_id;
  if (r.document && r.document.file_id) return r.document.file_id;
  if (r.animation && r.animation.file_id) return r.animation.file_id;
  if (Array.isArray(r.photo) && r.photo.length > 0) {
    return r.photo[r.photo.length - 1].file_id;
  }
  return null;
}

app.post('/api/upload-page', async (req, res) => {
  try {
    const { imageBase64, fileName } = req.body || {};
    if (!imageBase64) {
      return res.status(400).json({ error: 'Missing imageBase64' });
    }

    const parsed = parseBase64Payload(imageBase64);
    if (!parsed || !parsed.buffer || parsed.buffer.length === 0) {
      return res.status(400).json({ error: 'Invalid imageBase64 data' });
    }

    const safeName = path.basename(String(fileName || `media_${Date.now()}.png`)).replace(/[^a-zA-Z0-9._-]/g, '_');

    let telegramFileId = null;
    if (TG_BOT_TOKEN && TG_STORAGE_CHAT_ID) {
      try {
        telegramFileId = await uploadBufferToTelegram(parsed.buffer, safeName, parsed.mimeType);
      } catch (tgErr) {
        console.warn('POST /api/upload-page Telegram fallback:', tgErr.message || tgErr);
      }
    }

    if (telegramFileId) {
      return res.json({
        success: true,
        file_id: telegramFileId,
        fileId: telegramFileId,
        fileName: safeName,
        url: `/api/proxy-image?file_id=${encodeURIComponent(telegramFileId)}`,
      });
    }

    const diskName = `${Date.now()}-${Math.round(Math.random() * 1e9)}-${safeName}`;
    const diskPath = path.join(tgMediaDir, diskName);
    await fs.promises.writeFile(diskPath, parsed.buffer);
    const localUrl = `/uploads/tg-media/${diskName}`;

    return res.json({
      success: true,
      fileName: diskName,
      url: localUrl,
    });
  } catch (err) {
    console.error('POST /api/upload-page:', err);
    return res.status(500).json({ error: err.message || 'Ошибка загрузки файла' });
  }
});

app.get('/api/proxy-image', async (req, res) => {
  try {
    const rawFileId = String(req.query.file_id || req.query.url || '').trim();
    if (!rawFileId) {
      return res.status(400).json({ error: 'Missing file_id parameter' });
    }

    if (rawFileId.startsWith('/uploads/')) {
      const rel = rawFileId.replace(/^\/uploads\//, '');
      const resolvedRoot = path.resolve(uploadsRoot);
      const fullPath = path.resolve(uploadsRoot, rel);
      if (fullPath.startsWith(resolvedRoot + path.sep) && fs.existsSync(fullPath)) {
        return res.sendFile(fullPath);
      }
      return res.status(404).json({ error: 'Local file not found' });
    }

    if (!TG_BOT_TOKEN) {
      return res.status(404).json({ error: 'Telegram bot token is not configured on backend' });
    }

    const infoRes = await fetch(`https://api.telegram.org/bot${TG_BOT_TOKEN}/getFile?file_id=${encodeURIComponent(rawFileId)}`);
    const infoJson = await infoRes.json().catch(() => null);
    if (!infoRes.ok || !infoJson || !infoJson.ok || !infoJson.result || !infoJson.result.file_path) {
      return res.status(404).json({
        error: 'File not found in Telegram',
        description: (infoJson && infoJson.description) || undefined,
      });
    }

    const tgFileUrl = `https://api.telegram.org/file/bot${TG_BOT_TOKEN}/${infoJson.result.file_path}`;
    const fileRes = await fetch(tgFileUrl);
    if (!fileRes.ok) {
      return res.status(404).json({ error: 'Failed to download file from Telegram' });
    }

    const contentType = fileRes.headers.get('content-type') || 'application/octet-stream';
    const arrBuf = await fileRes.arrayBuffer();
    res.set('Content-Type', contentType);
    res.set('Cache-Control', 'public, max-age=86400');
    return res.send(Buffer.from(arrBuf));
  } catch (err) {
    console.error('GET /api/proxy-image:', err);
    return res.status(502).json({ error: 'Proxy image error' });
  }
});

// --- Профили и пользователи (работа с таблицей profiles в PostgreSQL / Supabase) ---
async function findProfileRow({ userId, publicId, email }) {
  if (userId) {
    const r = await pool.query('SELECT * FROM profiles WHERE id::text = $1 LIMIT 1', [String(userId).trim()]);
    if (r.rows[0]) return r.rows[0];
  }
  if (publicId) {
    const r = await pool.query('SELECT * FROM profiles WHERE public_id::text = $1 LIMIT 1', [String(publicId).trim()]);
    if (r.rows[0]) return r.rows[0];
  }
  if (email) {
    const r = await pool.query('SELECT * FROM profiles WHERE lower(email) = lower($1) LIMIT 1', [String(email).trim()]);
    if (r.rows[0]) return r.rows[0];
  }
  return null;
}

function formatProfileRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    userId: row.id,
    publicId: row.public_id || '',
    nickname: row.nickname || 'Пользователь',
    email: row.email || '',
    avatar: row.avatar_url || '',
    banner: row.banner_url || '',
    bio: row.bio || '',
    favoriteTitles: row.favorite_titles || '',
    likesCount: Number(row.likes_count || 0),
    equippedAvatarFrameId: row.equipped_avatar_frame || 'auto',
    avatarFrameShape: row.avatar_frame_shape || 'circle',
    cards: Array.isArray(row.cards) ? row.cards : [],
    showcase: Array.isArray(row.showcase) ? row.showcase : [],
  };
}

app.get('/api/user', async (req, res) => {
  try {
    const { userId, publicId, email } = req.query || {};
    const row = await findProfileRow({ userId, publicId, email });
    if (!row) {
      return res.status(404).json({
        success: false,
        error: 'User profile not found',
        query: { userId, publicId, email },
      });
    }
    return res.json({ success: true, user: formatProfileRow(row) });
  } catch (err) {
    console.error('GET /api/user:', err);
    return res.status(500).json({ success: false, error: 'Database error loading user' });
  }
});

app.get('/api/users', async (_req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM profiles ORDER BY updated_at DESC NULLS LAST, id DESC LIMIT 200');
    return res.json(rows.map(formatProfileRow));
  } catch (err) {
    console.error('GET /api/users:', err);
    return res.json([]);
  }
});

app.patch('/api/profile', async (req, res) => {
  try {
    const body = req.body || {};
    const uid = String(body.userId || body.id || '').trim();
    const avatarVal = body.avatarUrl !== undefined ? body.avatarUrl : body.avatar;
    const bannerVal = body.bannerUrl !== undefined ? body.bannerUrl : body.banner;

    const existing = await findProfileRow({
      userId: uid,
      publicId: body.publicId,
      email: body.email,
    });

    const targetId = existing ? existing.id : uid;
    if (!targetId) {
      return res.status(400).json({ error: 'Missing userId' });
    }

    const nextNickname = body.nickname !== undefined ? String(body.nickname) : (existing?.nickname || 'Пользователь');
    const nextAvatar = avatarVal !== undefined ? String(avatarVal) : (existing?.avatar_url || '');
    const nextBanner = bannerVal !== undefined ? String(bannerVal) : (existing?.banner_url || '');
    const nextBio = body.bio !== undefined ? String(body.bio) : (existing?.bio || '');
    const nextFav = body.favoriteTitles !== undefined ? String(body.favoriteTitles) : (existing?.favorite_titles || '');
    const nextFrame = body.equippedAvatarFrameId !== undefined ? String(body.equippedAvatarFrameId) : (existing?.equipped_avatar_frame || 'auto');
    const nextShape = body.avatarFrameShape !== undefined ? String(body.avatarFrameShape) : (existing?.avatar_frame_shape || 'circle');

    if (existing) {
      const upd = await pool.query(
        `UPDATE profiles
         SET nickname = $1,
             avatar_url = $2,
             banner_url = $3,
             bio = $4,
             favorite_titles = $5,
             equipped_avatar_frame = $6,
             avatar_frame_shape = $7
         WHERE id = $8
         RETURNING *`,
        [nextNickname, nextAvatar, nextBanner, nextBio, nextFav, nextFrame, nextShape, existing.id]
      );
      return res.json({ success: true, user: formatProfileRow(upd.rows[0]) });
    }

    const ins = await pool.query(
      `INSERT INTO profiles (id, nickname, email, avatar_url, banner_url, bio, favorite_titles, equipped_avatar_frame, avatar_frame_shape)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       ON CONFLICT (id) DO UPDATE SET
         nickname = EXCLUDED.nickname,
         avatar_url = EXCLUDED.avatar_url,
         banner_url = EXCLUDED.banner_url,
         bio = EXCLUDED.bio,
         favorite_titles = EXCLUDED.favorite_titles,
         equipped_avatar_frame = EXCLUDED.equipped_avatar_frame,
         avatar_frame_shape = EXCLUDED.avatar_frame_shape
       RETURNING *`,
      [targetId, nextNickname, body.email || null, nextAvatar, nextBanner, nextBio, nextFav, nextFrame, nextShape]
    );

    return res.json({ success: true, user: formatProfileRow(ins.rows[0]) });
  } catch (err) {
    console.error('PATCH /api/profile:', err);
    return res.status(500).json({ error: err.message || 'Ошибка обновления профиля' });
  }
});

app.post('/api/profile/:targetId/like', async (req, res) => {
  try {
    const targetId = String(req.params.targetId || '').trim();
    if (!targetId) {
      return res.status(400).json({ error: 'Missing targetId' });
    }
    const upd = await pool.query(
      `UPDATE profiles
       SET likes_count = COALESCE(likes_count, 0) + 1
       WHERE id::text = $1
       RETURNING likes_count`,
      [targetId]
    );
    const likesCount = upd.rows[0] ? Number(upd.rows[0].likes_count || 0) : 1;
    return res.json({ success: true, likesCount });
  } catch (err) {
    console.error('POST /api/profile/:targetId/like:', err);
    return res.status(500).json({ error: 'Ошибка постановки лайка' });
  }
});

// --- Получить текущий баннер для лавки и админки ---
app.get('/api/shop/banner', async (_req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT id, media_type, media_url, link_url, is_active, updated_at
       FROM shop_banners
       WHERE is_active = true
       ORDER BY id DESC
       LIMIT 1`
    );
    res.json(rows[0] || null);
  } catch (err) {
    console.error('GET /api/shop/banner:', err);
    res.status(500).json({ error: 'Ошибка загрузки баннера' });
  }
});

// --- Обновить баннер из админки ---
app.put(
  '/api/admin/shop/banner',
  uploadBannerMiddleware,
  async (req, res) => {
    try {
      const linkUrl = String(req.body?.linkUrl ?? '').trim();

      const currentRes = await pool.query(
        `SELECT id, media_type, media_url
         FROM shop_banners
         WHERE is_active = true
         ORDER BY id DESC
         LIMIT 1`
      );
      const current = currentRes.rows[0];

      let mediaType = current?.media_type || 'image';
      let mediaUrl = current?.media_url || '';

      if (req.file) {
        mediaType = ALLOWED_MIMES[req.file.mimetype];
        mediaUrl = `/uploads/banners/${req.file.filename}`;

        if (current?.media_url && current.media_url.startsWith('/uploads/banners/')) {
          const relativeFile = current.media_url.replace(/^\/uploads\/banners\//, '');
          const resolvedBannersDir = path.resolve(bannersDir);
          const oldPath = path.resolve(bannersDir, relativeFile);
          if (oldPath.startsWith(resolvedBannersDir + path.sep)) {
            fs.promises.unlink(oldPath).catch(() => {});
          }
        }
      }

      if (!mediaUrl) {
        return res.status(400).json({ error: 'Сначала загрузите GIF, картинку или видео' });
      }

      let saved;
      if (current) {
        const upd = await pool.query(
          `UPDATE shop_banners
           SET media_type = $1, media_url = $2, link_url = $3, updated_at = NOW()
           WHERE id = $4
           RETURNING id, media_type, media_url, link_url, is_active, updated_at`,
          [mediaType, mediaUrl, linkUrl, current.id]
        );
        saved = upd.rows[0];
      } else {
        const ins = await pool.query(
          `INSERT INTO shop_banners (media_type, media_url, link_url, is_active)
           VALUES ($1, $2, $3, true)
           RETURNING id, media_type, media_url, link_url, is_active, updated_at`,
          [mediaType, mediaUrl, linkUrl]
        );
        saved = ins.rows[0];
      }

      res.json(saved);
    } catch (err) {
      console.error('PUT /api/admin/shop/banner:', err);
      res.status(400).json({ error: err.message || 'Ошибка сохранения баннера' });
    }
  }
);


// 1. Получение текущего баннера лавки
app.get('/api/shop-banner', async (_req, res) => {
  try {
    const { rows } = await pool.query(
      "SELECT url, type FROM settings WHERE key = 'shop_banner' LIMIT 1"
    );

    if (!rows[0]) {
      return res.json({ url: null, type: null });
    }
    res.json({ url: rows[0].url, type: rows[0].type });
  } catch (err) {
    console.error('GET /api/shop-banner:', err);
    res.status(500).json({ error: 'Ошибка получения баннера' });
  }
});

// 2. Сохранение нового баннера из админки
app.post('/api/admin/shop-banner', async (req, res) => {
  try {
    const { fileData, mimeType } = req.body || {};

    if (!fileData || !mimeType) {
      return res.status(400).json({ error: 'Файл не передан' });
    }

    await pool.query(
      `INSERT INTO settings (key, url, type, updated_at)
       VALUES ('shop_banner', $1, $2, NOW())
       ON CONFLICT (key)
       DO UPDATE SET url = EXCLUDED.url, type = EXCLUDED.type, updated_at = NOW()`,
      [fileData, mimeType]
    );

    res.json({ success: true });
  } catch (err) {
    console.error('POST /api/admin/shop-banner:', err);
    res.status(500).json({ error: 'Ошибка сохранения баннера в БД' });
  }
});

// --- JSON 404 для всех неизвестных /api/* маршрутов ---
app.use('/api', (_req, res) => {
  res.status(404).json({ error: 'API endpoint not found' });
});

// --- Глобальный обработчик ошибок в JSON ---
app.use((err, _req, res, _next) => {
  console.error('Unhandled error:', err);
  res.status(500).json({ error: 'Internal server error' });
});

app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});
