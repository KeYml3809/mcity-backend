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
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
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

// --- Пользователи (JSON-ответы вместо HTML 404) ---
app.get('/api/user', async (req, res) => {
  const { userId, publicId, email } = req.query;
  return res.status(404).json({
    error: 'User profile table is not mapped on backend',
    query: { userId, publicId, email },
  });
});

app.get('/api/users', async (_req, res) => {
  return res.json({ users: [] });
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
