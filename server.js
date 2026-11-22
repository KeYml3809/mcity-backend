const express = require('express');
const cors = require('cors');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
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

pool.query(`
  CREATE TABLE IF NOT EXISTS public.shop_banner (
    id text PRIMARY KEY DEFAULT 'active',
    url text,
    mime_type text NOT NULL DEFAULT 'image/gif',
    updated_at timestamptz NOT NULL DEFAULT now()
  )
`).catch((err) => console.error('Ошибка создания таблицы shop_banner:', err));

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
  limits: { fileSize: 25 * 1024 * 1024 },
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

async function uploadBufferToTelegram(buffer, fileName, mimeType, options = {}) {
  if (!TG_BOT_TOKEN || !TG_STORAGE_CHAT_ID) return null;

  const forceDocument = Boolean(options && options.asDocument);
  const isVideo = !forceDocument && (/^video\//i.test(mimeType || '') || /\.(mp4|webm|mov)$/i.test(fileName || ''));
  const isImage = !forceDocument && /^image\//i.test(mimeType || '') && !/gif/i.test(mimeType || '');
  const endpoint = forceDocument ? 'sendDocument' : (isVideo ? 'sendVideo' : (isImage ? 'sendPhoto' : 'sendDocument'));
  const fieldName = forceDocument ? 'document' : (isVideo ? 'video' : (isImage ? 'photo' : 'document'));

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
    const { imageBase64, fileName, asDocument, sendAsDocument } = req.body || {};
    if (!imageBase64) {
      return res.status(400).json({ error: 'Missing imageBase64' });
    }

    const parsed = parseBase64Payload(imageBase64);
    if (!parsed || !parsed.buffer || parsed.buffer.length === 0) {
      return res.status(400).json({ error: 'Invalid imageBase64 data' });
    }

    let safeName = path.basename(String(fileName || `media_${Date.now()}.png`)).replace(/[^a-zA-Z0-9._-]/g, '_');
    if (parsed.mimeType === 'image/png' && !/\.png$/i.test(safeName)) {
      safeName = `${safeName}.png`;
    } else if (parsed.mimeType === 'image/webp' && !/\.webp$/i.test(safeName)) {
      safeName = `${safeName}.webp`;
    }

    // Подарки, рамки (аватара, карточек, категорий) и запросы с asDocument отправляем в Telegram как файл (sendDocument), чтобы сохранить PNG и прозрачный фон
    const shouldSendAsDocument =
      Boolean(asDocument || sendAsDocument) ||
      /^(gift|avatar_frame|card_frame|frame)_/i.test(safeName);

    let telegramFileId = null;
    if (TG_BOT_TOKEN && TG_STORAGE_CHAT_ID) {
      try {
        telegramFileId = await uploadBufferToTelegram(parsed.buffer, safeName, parsed.mimeType, {
          asDocument: shouldSendAsDocument,
        });
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

app.post('/api/upload-animation', async (req, res) => {
  try {
    const body = req.body || {};
    const rawData = body.animationBase64 || body.imageBase64 || body.videoBase64 || body.fileBase64 || '';
    const fileName = body.fileName || body.name || `anim_${Date.now()}.mp4`;

    if (!rawData) {
      return res.status(400).json({ error: 'Missing animationBase64 / imageBase64' });
    }

    const parsed = parseBase64Payload(rawData);
    if (!parsed || !parsed.buffer || parsed.buffer.length === 0) {
      return res.status(400).json({ error: 'Invalid animation data' });
    }

    const safeName = path.basename(String(fileName)).replace(/[^a-zA-Z0-9._-]/g, '_');

    let telegramFileId = null;
    if (TG_BOT_TOKEN && TG_STORAGE_CHAT_ID) {
      try {
        telegramFileId = await uploadBufferToTelegram(parsed.buffer, safeName, parsed.mimeType);
      } catch (tgErr) {
        console.warn('POST /api/upload-animation Telegram fallback:', tgErr.message || tgErr);
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
    console.error('POST /api/upload-animation:', err);
    return res.status(500).json({ error: err.message || 'Ошибка загрузки анимации' });
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

    let contentType = fileRes.headers.get('content-type') || 'application/octet-stream';
    if (!contentType || contentType === 'application/octet-stream') {
      const ext = path.extname(String(infoJson.result.file_path || '')).toLowerCase();
      const extMimeMap = {
        '.png': 'image/png',
        '.webp': 'image/webp',
        '.gif': 'image/gif',
        '.jpg': 'image/jpeg',
        '.jpeg': 'image/jpeg',
        '.svg': 'image/svg+xml',
        '.mp4': 'video/mp4',
        '.webm': 'video/webm',
      };
      if (extMimeMap[ext]) contentType = extMimeMap[ext];
    }
    const arrBuf = await fileRes.arrayBuffer();
    res.set('Content-Type', contentType);
    res.set('Cache-Control', 'public, max-age=86400');
    return res.send(Buffer.from(arrBuf));
  } catch (err) {
    console.error('GET /api/proxy-image:', err);
    return res.status(502).json({ error: 'Proxy image error' });
  }
});

// --- Согласование users + profiles и авторизация ---
function hashPasswordServer(plain) {
  return crypto.createHash('sha256').update(String(plain || '')).digest('hex');
}

function generatePublicIdServer(seed) {
  const h = crypto.createHash('sha256').update(String(seed || Date.now())).digest('hex');
  const num = parseInt(h.slice(0, 8), 16) % 900000;
  return 'MC-' + String(100000 + num);
}

function normalizeUserAuthRecord(row) {
  if (!row) return null;
  const uid = String(row.id || row.user_id || '');
  const nick = row.nickname || row.username || (row.email ? String(row.email).split('@')[0] : 'Пользователь');
  return {
    id: uid,
    userId: uid,
    username: row.username || nick,
    nickname: nick,
    email: row.email || '',
    publicId: row.public_id || generatePublicIdServer(uid || row.email),
    avatar: row.avatar_url || row.avatar || '/avatars/default.png',
    banner: row.banner_url || row.banner || '/banners/default.png',
    bio: row.bio || '',
    favoriteTitles: row.favorite_titles || '',
    role: row.role || 'user',
    likesCount: Number(row.likes_count || 0),
    equippedAvatarFrameId: row.equipped_avatar_frame || 'auto',
    avatarFrameShape: row.avatar_frame_shape || 'circle',
    cards: Array.isArray(row.cards) ? row.cards : [],
    showcase: Array.isArray(row.showcase) ? row.showcase : [],
    _passwordHash: row.password_hash || row.password || null,
    _sourceTable: row._sourceTable || 'users',
  };
}

async function safeSelectOne(queryText, params, tableName) {
  try {
    const { rows } = await pool.query(queryText, params);
    if (rows && rows[0]) {
      return { ...rows[0], _sourceTable: tableName };
    }
    return null;
  } catch (err) {
    if (err && (err.code === '42P01' || err.code === '42703')) {
      return null;
    }
    throw err;
  }
}

async function findAuthUserAcrossTables({ email, username, nickname, userId, publicId }) {
  const cleanEmail = String(email || '').trim().toLowerCase();
  const cleanUser = String(username || '').trim().toLowerCase();
  const cleanNick = String(nickname || '').trim().replace(/^@+/, '');
  const cleanUid = String(userId || '').trim();
  const cleanPubId = String(publicId || '').trim();

  const candidates = [];

  if (cleanEmail) {
    const u1 = await safeSelectOne('SELECT * FROM public.users WHERE lower(email) = $1 LIMIT 1', [cleanEmail], 'users');
    if (u1) candidates.push(u1);
    const p1 = await safeSelectOne('SELECT * FROM public.profiles WHERE lower(email) = $1 LIMIT 1', [cleanEmail], 'profiles');
    if (p1) candidates.push(p1);
  }

  if (cleanUid) {
    const u2 = await safeSelectOne('SELECT * FROM public.users WHERE id::text = $1 LIMIT 1', [cleanUid], 'users');
    if (u2 && !candidates.some((c) => String(c.id) === String(u2.id) && c._sourceTable === 'users')) candidates.push(u2);
    const p2 = await safeSelectOne('SELECT * FROM public.profiles WHERE id::text = $1 LIMIT 1', [cleanUid], 'profiles');
    if (p2 && !candidates.some((c) => String(c.id) === String(p2.id) && c._sourceTable === 'profiles')) candidates.push(p2);
  }

  if (cleanPubId) {
    const uPub = await safeSelectOne('SELECT * FROM public.users WHERE public_id::text = $1 LIMIT 1', [cleanPubId], 'users');
    if (uPub) candidates.push(uPub);
    const pPub = await safeSelectOne('SELECT * FROM public.profiles WHERE public_id::text = $1 LIMIT 1', [cleanPubId], 'profiles');
    if (pPub) candidates.push(pPub);
  }

  if (cleanUser || cleanNick) {
    if (cleanUser) {
      const u3 = await safeSelectOne('SELECT * FROM public.users WHERE lower(username) = $1 LIMIT 1', [cleanUser], 'users');
      if (u3) candidates.push(u3);
    }
    if (cleanNick) {
      const u4 = await safeSelectOne('SELECT * FROM public.users WHERE lower(nickname) = lower($1) LIMIT 1', [cleanNick], 'users');
      if (u4) candidates.push(u4);
      const p3 = await safeSelectOne('SELECT * FROM public.profiles WHERE lower(nickname) = lower($1) LIMIT 1', [cleanNick], 'profiles');
      if (p3) candidates.push(p3);
    }
  }

  if (cleanEmail) {
    const au = await safeSelectOne(
      'SELECT id, email, raw_user_meta_data FROM auth.users WHERE lower(email) = $1 LIMIT 1',
      [cleanEmail],
      'auth.users'
    );
    if (au) {
      const meta = au.raw_user_meta_data && typeof au.raw_user_meta_data === 'object' ? au.raw_user_meta_data : {};
      candidates.push({
        id: au.id,
        email: au.email,
        nickname: meta.nickname || meta.username || cleanEmail.split('@')[0],
        username: meta.username || meta.nickname || cleanEmail.split('@')[0],
        public_id: meta.publicId || meta.public_id || generatePublicIdServer(au.id),
        _sourceTable: 'auth.users',
      });
    }
  }

  if (candidates.length === 0) return null;

  const fromUsers = candidates.find((c) => c._sourceTable === 'users');
  const fromProfiles = candidates.find((c) => c._sourceTable === 'profiles');
  const fromAuth = candidates.find((c) => c._sourceTable === 'auth.users');

  const merged = {
    ...(fromAuth || {}),
    ...(fromProfiles || {}),
    ...(fromUsers || {}),
    id: (fromUsers && fromUsers.id) || (fromProfiles && fromProfiles.id) || (fromAuth && fromAuth.id),
    email: (fromUsers && fromUsers.email) || (fromProfiles && fromProfiles.email) || (fromAuth && fromAuth.email) || cleanEmail,
    nickname: (fromUsers && fromUsers.nickname) || (fromProfiles && fromProfiles.nickname) || (fromAuth && fromAuth.nickname),
    username: (fromUsers && fromUsers.username) || (fromProfiles && fromProfiles.nickname) || (fromAuth && fromAuth.username),
    public_id: (fromUsers && fromUsers.public_id) || (fromProfiles && fromProfiles.public_id) || (fromAuth && fromAuth.public_id),
    avatar_url: (fromUsers && fromUsers.avatar_url) || (fromProfiles && fromProfiles.avatar_url),
    banner_url: (fromUsers && fromUsers.banner_url) || (fromProfiles && fromProfiles.banner_url),
    cards: (Array.isArray(fromUsers?.cards) && fromUsers.cards.length > 0)
      ? fromUsers.cards
      : (Array.isArray(fromProfiles?.cards) ? fromProfiles.cards : []),
    showcase: Array.isArray(fromProfiles?.showcase) ? fromProfiles.showcase : [],
    password_hash: (fromUsers && fromUsers.password_hash) || (fromProfiles && fromProfiles.password_hash) || null,
    _sourceTable: fromUsers ? 'users' : (fromProfiles ? 'profiles' : 'auth.users'),
  };

  return normalizeUserAuthRecord(merged);
}

function verifyPasswordMatch(plainPassword, storedHash) {
  if (!storedHash) return true;
  const plain = String(plainPassword || '');
  const stored = String(storedHash).trim();
  if (stored === plain) return true;
  const sha256Hex = hashPasswordServer(plain);
  if (stored.toLowerCase() === sha256Hex.toLowerCase()) return true;
  return false;
}

async function syncUserAndProfileRecord(baseRec, plainPassword) {
  const uid = String(baseRec.id || baseRec.userId || crypto.randomUUID()).trim();
  const cleanEmail = String(baseRec.email || '').trim().toLowerCase();
  const cleanNick = String(
    baseRec.nickname || baseRec.username || (cleanEmail ? cleanEmail.split('@')[0] : 'Пользователь')
  ).trim();
  const baseUser = String(baseRec.username || cleanNick)
    .toLowerCase()
    .replace(/[^a-z0-9_.-]/g, '_') || 'user';
  const username = baseUser.slice(0, 46);
  const publicId = String(baseRec.publicId || baseRec.public_id || generatePublicIdServer(uid || cleanEmail)).trim();

  const existingUsers = await safeSelectOne('SELECT * FROM public.users WHERE id::text = $1 LIMIT 1', [uid], 'users');
  const existingProfiles = await safeSelectOne('SELECT * FROM public.profiles WHERE id::text = $1 LIMIT 1', [uid], 'profiles');

  const passwordHash =
    baseRec._passwordHash ||
    existingUsers?.password_hash ||
    existingProfiles?.password_hash ||
    (plainPassword ? hashPasswordServer(plainPassword) : hashPasswordServer(crypto.randomUUID()));

  const avatarUrl =
    baseRec.avatar ||
    baseRec.avatar_url ||
    existingUsers?.avatar_url ||
    existingProfiles?.avatar_url ||
    '/avatars/default.png';

  const bannerUrl =
    baseRec.banner ||
    baseRec.banner_url ||
    existingUsers?.banner_url ||
    existingProfiles?.banner_url ||
    '/banners/default.png';

  const bio = baseRec.bio !== undefined ? String(baseRec.bio) : (existingProfiles?.bio || '');
  const favoriteTitles =
    baseRec.favoriteTitles !== undefined
      ? String(baseRec.favoriteTitles)
      : (existingProfiles?.favorite_titles || '');
  const equippedFrame =
    baseRec.equippedAvatarFrameId !== undefined
      ? String(baseRec.equippedAvatarFrameId)
      : (existingProfiles?.equipped_avatar_frame || 'auto');
  const avatarShape =
    baseRec.avatarFrameShape !== undefined
      ? String(baseRec.avatarFrameShape)
      : (existingProfiles?.avatar_frame_shape || 'circle');

  const cardsArr = Array.isArray(baseRec.cards)
    ? baseRec.cards
    : (Array.isArray(existingUsers?.cards) && existingUsers.cards.length > 0
      ? existingUsers.cards
      : (Array.isArray(existingProfiles?.cards) ? existingProfiles.cards : []));

  const showcaseArr = Array.isArray(baseRec.showcase)
    ? baseRec.showcase
    : (Array.isArray(existingProfiles?.showcase) ? existingProfiles.showcase : []);

  const likesCount =
    typeof baseRec.likesCount === 'number'
      ? baseRec.likesCount
      : Number(existingUsers?.likes_count || 0);

  const role = baseRec.role || existingUsers?.role || 'user';

  let savedUserRow = null;
  try {
    const uRes = await pool.query(
      `INSERT INTO public.users
         (id, username, email, password_hash, avatar_url, banner_url, role, likes_count, nickname, public_id, cards)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb)
       ON CONFLICT (id) DO UPDATE SET
         username = EXCLUDED.username,
         email = COALESCE(NULLIF(EXCLUDED.email, ''), public.users.email),
         password_hash = COALESCE(NULLIF(EXCLUDED.password_hash, ''), public.users.password_hash),
         avatar_url = EXCLUDED.avatar_url,
         banner_url = EXCLUDED.banner_url,
         role = COALESCE(NULLIF(EXCLUDED.role, ''), public.users.role),
         likes_count = EXCLUDED.likes_count,
         nickname = EXCLUDED.nickname,
         public_id = COALESCE(NULLIF(EXCLUDED.public_id, ''), public.users.public_id),
         cards = EXCLUDED.cards
       RETURNING *`,
      [uid, username, cleanEmail, passwordHash, avatarUrl, bannerUrl, role, likesCount, cleanNick, publicId, JSON.stringify(cardsArr)]
    );
    savedUserRow = uRes.rows[0] || null;
  } catch (e) {
    console.warn('syncUserAndProfileRecord users upsert:', e.message || e);
  }

  let savedProfileRow = null;
  try {
    const pRes = await pool.query(
      `INSERT INTO public.profiles
         (id, nickname, email, avatar_url, banner_url, bio, favorite_titles, equipped_avatar_frame, avatar_frame_shape, cards, showcase)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11::jsonb)
       ON CONFLICT (id) DO UPDATE SET
         nickname = EXCLUDED.nickname,
         email = COALESCE(NULLIF(EXCLUDED.email, ''), public.profiles.email),
         avatar_url = EXCLUDED.avatar_url,
         banner_url = EXCLUDED.banner_url,
         bio = EXCLUDED.bio,
         favorite_titles = EXCLUDED.favorite_titles,
         equipped_avatar_frame = EXCLUDED.equipped_avatar_frame,
         avatar_frame_shape = EXCLUDED.avatar_frame_shape,
         cards = EXCLUDED.cards,
         showcase = EXCLUDED.showcase
       RETURNING *`,
      [uid, cleanNick, cleanEmail || null, avatarUrl, bannerUrl, bio, favoriteTitles, equippedFrame, avatarShape, JSON.stringify(cardsArr), JSON.stringify(showcaseArr)]
    );
    savedProfileRow = pRes.rows[0] || null;
  } catch (e) {
    if (e && e.code !== '42P01') {
      console.warn('syncUserAndProfileRecord profiles upsert:', e.message || e);
    }
  }

  return normalizeUserAuthRecord({
    ...(savedProfileRow || {}),
    ...(savedUserRow || {}),
    id: uid,
    username: savedUserRow?.username || username,
    nickname: savedUserRow?.nickname || savedProfileRow?.nickname || cleanNick,
    email: savedUserRow?.email || savedProfileRow?.email || cleanEmail,
    public_id: savedUserRow?.public_id || publicId,
    avatar_url: savedUserRow?.avatar_url || savedProfileRow?.avatar_url || avatarUrl,
    banner_url: savedUserRow?.banner_url || savedProfileRow?.banner_url || bannerUrl,
    bio: savedProfileRow?.bio ?? bio,
    favorite_titles: savedProfileRow?.favorite_titles ?? favoriteTitles,
    equipped_avatar_frame: savedProfileRow?.equipped_avatar_frame ?? equippedFrame,
    avatar_frame_shape: savedProfileRow?.avatar_frame_shape ?? avatarShape,
    cards: Array.isArray(savedUserRow?.cards) ? savedUserRow.cards : (Array.isArray(savedProfileRow?.cards) ? savedProfileRow.cards : cardsArr),
    showcase: Array.isArray(savedProfileRow?.showcase) ? savedProfileRow.showcase : showcaseArr,
    password_hash: savedUserRow?.password_hash || passwordHash,
  });
}

function toPublicSessionUser(rec) {
  if (!rec) return null;
  const { _passwordHash, _sourceTable, ...pub } = rec;
  return pub;
}

app.post('/api/register', async (req, res) => {
  try {
    const body = req.body || {};
    const email = String(body.email || '').trim().toLowerCase();
    const password = String(body.password || '');
    const rawNick = String(body.nickname || body.username || '').trim().replace(/^@+/, '');

    if (!email || !password) {
      return res.status(400).json({ success: false, error: 'Укажите email и пароль' });
    }

    const nickname = rawNick || email.split('@')[0];
    const username = (String(body.username || nickname).toLowerCase().replace(/[^a-z0-9_.-]/g, '_') || ('user_' + Date.now())).slice(0, 46);

    const existing = await findAuthUserAcrossTables({ email, username, nickname });
    if (existing) {
      return res.status(409).json({
        success: false,
        error: 'Пользователь с такими данными уже зарегистрирован',
      });
    }

    const uid = crypto.randomUUID();
    const publicId = 'MC-' + Math.floor(100000 + Math.random() * 900000);
    const passwordHash = hashPasswordServer(password);

    const synced = await syncUserAndProfileRecord(
      {
        id: uid,
        username,
        email,
        nickname,
        publicId,
        avatar: '/avatars/default.png',
        banner: '/banners/default.png',
        role: 'user',
        likesCount: 0,
        cards: [],
        showcase: [],
        _passwordHash: passwordHash,
      },
      password
    );

    return res.status(201).json({
      success: true,
      user: toPublicSessionUser(synced),
    });
  } catch (err) {
    console.error('POST /api/register:', err);
    if (err && err.code === '23505') {
      return res.status(409).json({ success: false, error: 'Пользователь уже существует' });
    }
    return res.status(500).json({ success: false, error: err.message || 'Ошибка регистрации' });
  }
});

app.post('/api/login', async (req, res) => {
  try {
    const body = req.body || {};
    const loginInput = String(body.email || body.login || body.username || '').trim();
    const password = String(body.password || '');

    if (!loginInput || !password) {
      return res.status(400).json({ success: false, error: 'Введите email/логин и пароль' });
    }

    const isEmail = loginInput.includes('@');
    const found = await findAuthUserAcrossTables({
      email: isEmail ? loginInput.toLowerCase() : '',
      username: !isEmail ? loginInput.toLowerCase() : '',
      nickname: !isEmail ? loginInput : '',
    });

    if (!found) {
      return res.status(404).json({
        success: false,
        code: 'USER_NOT_FOUND',
        error: 'Пользователь с таким email/логином не найден',
      });
    }

    if (!verifyPasswordMatch(password, found._passwordHash)) {
      return res.status(401).json({
        success: false,
        code: 'INVALID_PASSWORD',
        error: 'Неверный пароль',
      });
    }

    const syncedUser = await syncUserAndProfileRecord(found, password);
    return res.json({
      success: true,
      user: toPublicSessionUser(syncedUser),
    });
  } catch (err) {
    console.error('POST /api/login:', err);
    return res.status(500).json({ success: false, error: err.message || 'Ошибка входа' });
  }
});

app.get('/api/user', async (req, res) => {
  try {
    const row = await findAuthUserAcrossTables(req.query || {});
    if (!row) {
      return res.status(404).json({
        success: false,
        error: 'User profile not found',
        query: req.query || {},
      });
    }
    return res.json({ success: true, user: toPublicSessionUser(row) });
  } catch (err) {
    console.error('GET /api/user:', err);
    return res.status(500).json({ success: false, error: 'Database error loading user' });
  }
});

app.get('/api/users', async (_req, res) => {
  try {
    const byId = new Map();

    try {
      const { rows: uRows } = await pool.query('SELECT * FROM public.users ORDER BY created_at DESC NULLS LAST LIMIT 200');
      for (const r of uRows) {
        const norm = normalizeUserAuthRecord({ ...r, _sourceTable: 'users' });
        if (norm && norm.id) byId.set(String(norm.id), norm);
      }
    } catch (_) {}

    try {
      const { rows: pRows } = await pool.query('SELECT * FROM public.profiles ORDER BY updated_at DESC NULLS LAST, id DESC LIMIT 200');
      for (const r of pRows) {
        const uid = String(r.id || '');
        if (!uid) continue;
        const prev = byId.get(uid);
        if (prev) {
          byId.set(uid, {
            ...prev,
            nickname: prev.nickname || r.nickname || prev.username,
            avatar: (prev.avatar && prev.avatar !== '/avatars/default.png') ? prev.avatar : (r.avatar_url || prev.avatar),
            banner: (prev.banner && prev.banner !== '/banners/default.png') ? prev.banner : (r.banner_url || prev.banner),
            bio: r.bio || prev.bio || '',
            favoriteTitles: r.favorite_titles || prev.favoriteTitles || '',
            equippedAvatarFrameId: r.equipped_avatar_frame || prev.equippedAvatarFrameId || 'auto',
            avatarFrameShape: r.avatar_frame_shape || prev.avatarFrameShape || 'circle',
            cards: (Array.isArray(prev.cards) && prev.cards.length > 0) ? prev.cards : (Array.isArray(r.cards) ? r.cards : []),
            showcase: Array.isArray(r.showcase) ? r.showcase : (prev.showcase || []),
          });
        } else {
          byId.set(uid, normalizeUserAuthRecord({ ...r, _sourceTable: 'profiles' }));
        }
      }
    } catch (_) {}

    return res.json(Array.from(byId.values()).map(toPublicSessionUser));
  } catch (err) {
    console.error('GET /api/users:', err);
    return res.json([]);
  }
});

app.patch('/api/profile', async (req, res) => {
  try {
    const body = req.body || {};
    const uid = String(body.userId || body.id || '').trim();
    const existing = await findAuthUserAcrossTables({ userId: uid, publicId: body.publicId, email: body.email });
    const targetId = existing ? existing.id : uid;
    if (!targetId) return res.status(400).json({ error: 'Missing userId' });

    const synced = await syncUserAndProfileRecord({
      ...(existing || {}),
      id: targetId,
      nickname: body.nickname !== undefined ? String(body.nickname) : (existing?.nickname || 'Пользователь'),
      email: body.email !== undefined ? String(body.email) : (existing?.email || ''),
      avatar: (body.avatarUrl !== undefined ? body.avatarUrl : body.avatar) ?? (existing?.avatar || '/avatars/default.png'),
      banner: (body.bannerUrl !== undefined ? body.bannerUrl : body.banner) ?? (existing?.banner || '/banners/default.png'),
      bio: body.bio !== undefined ? String(body.bio) : (existing?.bio || ''),
      favoriteTitles: body.favoriteTitles !== undefined ? String(body.favoriteTitles) : (existing?.favoriteTitles || ''),
      equippedAvatarFrameId: body.equippedAvatarFrameId !== undefined ? String(body.equippedAvatarFrameId) : (existing?.equippedAvatarFrameId || 'auto'),
      avatarFrameShape: body.avatarFrameShape !== undefined ? String(body.avatarFrameShape) : (existing?.avatarFrameShape || 'circle'),
      cards: Array.isArray(body.cards) ? body.cards : (existing?.cards || []),
      showcase: Array.isArray(body.showcase) ? body.showcase : (existing?.showcase || []),
    });

    return res.json({ success: true, user: toPublicSessionUser(synced) });
  } catch (err) {
    console.error('PATCH /api/profile:', err);
    return res.status(500).json({ error: err.message || 'Ошибка обновления профиля' });
  }
});

app.post('/api/profile/:targetId/like', async (req, res) => {
  try {
    const targetId = String(req.params.targetId || '').trim();
    if (!targetId) return res.status(400).json({ error: 'Missing targetId' });
    const upd = await pool.query(
      `UPDATE public.users
       SET likes_count = COALESCE(likes_count, 0) + 1
       WHERE id::text = $1
       RETURNING likes_count`,
      [targetId]
    );
    return res.json({ success: true, likesCount: upd.rows[0] ? Number(upd.rows[0].likes_count || 0) : 1 });
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
    const sbRes = await safeSelectOne(
      "SELECT url, mime_type AS type FROM public.shop_banner WHERE id = 'active' LIMIT 1",
      [],
      'shop_banner'
    );
    if (sbRes && sbRes.url) {
      return res.json({ url: sbRes.url, type: sbRes.type || 'image/gif' });
    }

    const { rows } = await pool.query(
      "SELECT url, type FROM public.settings WHERE key = 'shop_banner' LIMIT 1"
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

    try {
      await pool.query(
        `INSERT INTO public.shop_banner (id, url, mime_type, updated_at)
         VALUES ('active', $1, $2, NOW())
         ON CONFLICT (id)
         DO UPDATE SET url = EXCLUDED.url, mime_type = EXCLUDED.mime_type, updated_at = NOW()`,
        [fileData, mimeType]
      );
    } catch (_) {}

    await pool.query(
      `INSERT INTO public.settings (key, url, type, updated_at)
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

// --- Безопасный сброс пароля с подтверждением по 6-значному коду через Brevo API ---
const RESET_CODE_TTL_MS = 15 * 60 * 1000;
const RESET_MAX_ATTEMPTS = 5;

const BREVO_API_KEY = String(process.env.BREVO_API_KEY || '').trim();
const BREVO_SENDER_EMAIL = String(
  process.env.BREVO_SENDER_EMAIL || process.env.MAIL_FROM_EMAIL || process.env.GMAIL_USER || ''
).trim();
const BREVO_SENDER_NAME = String(process.env.BREVO_SENDER_NAME || 'Mcity').trim();

function parseSenderFromEnv() {
  const rawFrom = String(process.env.MAIL_FROM || '').trim();
  const match = rawFrom.match(/^"?([^"<]+?)"?\s*<([^>]+)>$/);
  if (match) {
    return {
      name: BREVO_SENDER_NAME || match[1].trim() || 'Mcity',
      email: BREVO_SENDER_EMAIL || match[2].trim(),
    };
  }
  return {
    name: BREVO_SENDER_NAME || 'Mcity',
    email: BREVO_SENDER_EMAIL || rawFrom,
  };
}

async function sendResetCodeViaBrevo(toEmail, code) {
  if (!BREVO_API_KEY) {
    throw new Error('Brevo не настроен: укажите BREVO_API_KEY в переменных окружения');
  }

  const sender = parseSenderFromEnv();
  if (!sender.email || !sender.email.includes('@')) {
    throw new Error('Не указан email отправителя: задайте BREVO_SENDER_EMAIL (подтверждённый отправитель в Brevo)');
  }

  const response = await fetch('https://api.brevo.com/v3/smtp/email', {
    method: 'POST',
    headers: {
      'api-key': BREVO_API_KEY,
      'Content-Type': 'application/json',
      'Accept': 'application/json',
    },
    body: JSON.stringify({
      sender: {
        name: sender.name,
        email: sender.email,
      },
      to: [{ email: toEmail }],
      subject: 'Код подтверждения сброса пароля — Mcity',
      textContent: `Ваш код подтверждения для смены пароля на Mcity: ${code}\n\nКод действителен 15 минут. Если вы не запрашивали сброс пароля, просто проигнорируйте это письмо.`,
      htmlContent: `
        <div style="font-family: Inter, Arial, sans-serif; max-width: 480px; margin: 0 auto; padding: 24px; background: #0f172a; color: #f8fafc; border-radius: 16px;">
          <h2 style="margin: 0 0 12px; color: #ef4444; font-size: 20px;">Mcity — Сброс пароля</h2>
          <p style="margin: 0 0 16px; color: #cbd5e1; font-size: 14px; line-height: 1.5;">
            Вы запросили восстановление пароля. Введите этот 6-значный код подтверждения в окне на сайте:
          </p>
          <div style="font-size: 28px; font-weight: 800; letter-spacing: 6px; text-align: center; padding: 14px; margin: 16px 0; background: #1e293b; border: 1px solid #334155; border-radius: 12px; color: #fbbf24;">
            ${code}
          </div>
          <p style="margin: 0; color: #94a3b8; font-size: 12px; line-height: 1.5;">
            Код действует <strong>15 минут</strong>. Если это были не вы — просто проигнорируйте письмо.
          </p>
        </div>
      `,
    }),
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(data.message || data.error || `Ошибка Brevo API (${response.status})`);
  }
}

async function ensurePasswordResetTable() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS public.password_reset_tokens (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      email text NOT NULL,
      user_id text,
      code_hash text NOT NULL,
      expires_at timestamptz NOT NULL,
      attempts integer NOT NULL DEFAULT 0,
      used boolean NOT NULL DEFAULT false,
      created_at timestamptz NOT NULL DEFAULT now()
    )
  `);
}

async function dispatchResetCodeToTelegramIfEnabled(email, code) {
  const tgToken = String(process.env.TELEGRAM_BOT_TOKEN || process.env.BOT_TOKEN || '').trim();
  const tgChat = String(process.env.TELEGRAM_STORAGE_CHAT_ID || process.env.TELEGRAM_CHAT_ID || process.env.CHAT_ID || '').trim();
  if (tgToken && tgChat && process.env.SEND_RESET_CODE_TO_TG === 'true') {
    try {
      await fetch(`https://api.telegram.org/bot${tgToken}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: tgChat,
          text: `🔐 Код подтверждения сброса пароля для ${email}: ${code} (действует 15 мин)`,
        }),
      });
    } catch (_) {}
  }
}

app.post('/api/auth/forgot-password', async (req, res) => {
  try {
    await ensurePasswordResetTable();
    const email = String((req.body && req.body.email) || '').trim().toLowerCase();
    if (!email || !email.includes('@')) {
      return res.status(400).json({ success: false, error: 'Введите корректный email' });
    }

    const found = await findAuthUserAcrossTables({ email });
    if (!found) {
      return res.status(404).json({
        success: false,
        code: 'USER_NOT_FOUND',
        error: 'Аккаунт с таким email не найден',
      });
    }

    const code = String(crypto.randomInt(100000, 1000000));
    const codeHash = hashPasswordServer(code);
    const expiresAt = new Date(Date.now() + RESET_CODE_TTL_MS).toISOString();

    await sendResetCodeViaBrevo(email, code);

    await pool.query(
      `UPDATE public.password_reset_tokens
       SET used = true
       WHERE lower(email) = $1 AND used = false`,
      [email]
    );

    await pool.query(
      `INSERT INTO public.password_reset_tokens (email, user_id, code_hash, expires_at, attempts, used)
       VALUES ($1, $2, $3, $4, 0, false)`,
      [email, String(found.id || found.userId || ''), codeHash, expiresAt]
    );

    await dispatchResetCodeToTelegramIfEnabled(email, code);

    const responsePayload = {
      success: true,
      message: 'Код подтверждения отправлен на ваш email (действует 15 минут)',
      expiresInSeconds: 900,
    };
    if (process.env.RESET_CODE_DEBUG === 'true') {
      responsePayload.debugCode = code;
    }

    return res.json(responsePayload);
  } catch (err) {
    console.error('POST /api/auth/forgot-password:', err);
    return res.status(500).json({
      success: false,
      error: err.message || 'Ошибка отправки кода подтверждения на email',
    });
  }
});

app.post('/api/auth/reset-password', async (req, res) => {
  try {
    await ensurePasswordResetTable();
    const body = req.body || {};
    const email = String(body.email || '').trim().toLowerCase();
    const code = String(body.code || '').trim();
    const newPassword = String(body.newPassword || body.password || '');

    if (!email || !code || !newPassword) {
      return res.status(400).json({ success: false, error: 'Укажите email, код подтверждения и новый пароль' });
    }
    if (newPassword.length < 4) {
      return res.status(400).json({ success: false, error: 'Новый пароль должен быть не короче 4 символов' });
    }

    const tokenRes = await pool.query(
      `SELECT * FROM public.password_reset_tokens
       WHERE lower(email) = $1 AND used = false
       ORDER BY created_at DESC
       LIMIT 1`,
      [email]
    );

    const tokenRow = tokenRes.rows[0];
    if (!tokenRow) {
      return res.status(400).json({ success: false, error: 'Активный код не найден. Запросите код заново.' });
    }

    if (new Date(tokenRow.expires_at).getTime() < Date.now()) {
      await pool.query('UPDATE public.password_reset_tokens SET used = true WHERE id = $1', [tokenRow.id]);
      return res.status(400).json({ success: false, error: 'Срок действия кода истёк. Запросите новый код.' });
    }

    if (Number(tokenRow.attempts || 0) >= RESET_MAX_ATTEMPTS) {
      await pool.query('UPDATE public.password_reset_tokens SET used = true WHERE id = $1', [tokenRow.id]);
      return res.status(429).json({ success: false, error: 'Превышено количество попыток. Запросите новый код.' });
    }

    if (String(tokenRow.code_hash) !== hashPasswordServer(code)) {
      const nextAttempts = Number(tokenRow.attempts || 0) + 1;
      await pool.query('UPDATE public.password_reset_tokens SET attempts = $1 WHERE id = $2', [nextAttempts, tokenRow.id]);
      return res.status(401).json({
        success: false,
        error: `Неверный код подтверждения. Осталось попыток: ${Math.max(0, RESET_MAX_ATTEMPTS - nextAttempts)}`,
      });
    }

    const found = await findAuthUserAcrossTables({ email, userId: tokenRow.user_id });
    if (!found) {
      return res.status(404).json({ success: false, error: 'Пользователь не найден' });
    }

    const newPasswordHash = hashPasswordServer(newPassword);
    await pool.query('UPDATE public.password_reset_tokens SET used = true WHERE id = $1', [tokenRow.id]);

    try {
      await pool.query(
        'UPDATE public.users SET password_hash = $1 WHERE id::text = $2 OR lower(email) = $3',
        [newPasswordHash, String(found.id), email]
      );
    } catch (_) {}

    try {
      await pool.query(
        `INSERT INTO public.profiles (id, nickname, email, avatar_url, banner_url, cards, showcase)
         VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb)
         ON CONFLICT (id) DO UPDATE SET
           nickname = COALESCE(NULLIF(EXCLUDED.nickname, ''), public.profiles.nickname),
           email = COALESCE(NULLIF(EXCLUDED.email, ''), public.profiles.email)`,
        [
          String(found.id),
          found.nickname || found.username || email.split('@')[0],
          email,
          found.avatar || '/avatars/default.png',
          found.banner || '/banners/default.png',
          JSON.stringify(found.cards || []),
          JSON.stringify(found.showcase || []),
        ]
      );
    } catch (_) {}

    return res.json({
      success: true,
      message: 'Пароль успешно изменён! Теперь вы можете войти с новым паролем.',
    });
  } catch (err) {
    console.error('POST /api/auth/reset-password:', err);
    return res.status(500).json({ success: false, error: 'Ошибка смены пароля' });
  }
});

// --- Синхронизация подарков пользователей через БД (public.user_gifts) ---
let userGiftsTableReady = false;
async function ensureUserGiftsTable() {
  if (userGiftsTableReady) return;
  await pool.query(`
    CREATE TABLE IF NOT EXISTS public.user_gifts (
      id TEXT PRIMARY KEY,
      target_user_id TEXT NOT NULL,
      from_user_id TEXT DEFAULT '',
      from_nickname TEXT DEFAULT 'Читатель',
      item JSONB NOT NULL DEFAULT '{}'::jsonb,
      note TEXT DEFAULT '',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_user_gifts_target_created
    ON public.user_gifts (target_user_id, created_at DESC)
  `);
  userGiftsTableReady = true;
}

function normalizeGiftRow(row) {
  if (!row) return null;
  let itemObj = row.item;
  if (typeof itemObj === 'string') {
    try { itemObj = JSON.parse(itemObj); } catch (_) { itemObj = {}; }
  }
  return {
    id: String(row.id),
    targetUserId: String(row.target_user_id || ''),
    fromUserId: String(row.from_user_id || ''),
    fromNickname: row.from_nickname || 'Читатель',
    item: (itemObj && typeof itemObj === 'object') ? itemObj : {},
    note: row.note || '',
    createdAt: row.created_at ? new Date(row.created_at).toISOString() : new Date().toISOString(),
  };
}

app.get('/api/gifts/:userId', async (req, res) => {
  try {
    await ensureUserGiftsTable();
    const userId = String(req.params.userId || '').trim();
    if (!userId) {
      return res.json({ success: true, gifts: [] });
    }
    const { rows } = await pool.query(
      `SELECT id, target_user_id, from_user_id, from_nickname, item, note, created_at
       FROM public.user_gifts
       WHERE target_user_id = $1
       ORDER BY created_at DESC
       LIMIT 200`,
      [userId]
    );
    return res.json({
      success: true,
      gifts: rows.map(normalizeGiftRow).filter(Boolean),
    });
  } catch (err) {
    console.error('GET /api/gifts/:userId:', err);
    return res.status(500).json({ success: false, error: 'Ошибка загрузки подарков пользователя' });
  }
});

app.post('/api/gifts', async (req, res) => {
  try {
    await ensureUserGiftsTable();
    const body = req.body || {};
    const targetUserId = String(body.targetUserId || body.target_user_id || '').trim();
    const fromUserId = String(body.fromUserId || body.from_user_id || '').trim();
    const fromNickname = String(body.fromNickname || body.from_nickname || 'Читатель').trim();
    const item = body.item && typeof body.item === 'object' ? body.item : null;
    const note = String(body.note || '').trim().slice(0, 300);
    const id = String(body.id || `gift_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`).trim();
    const createdAt = body.createdAt || body.created_at || new Date().toISOString();

    if (!targetUserId || !item) {
      return res.status(400).json({ success: false, error: 'Не указан получатель или предмет подарка' });
    }

    const { rows } = await pool.query(
      `INSERT INTO public.user_gifts (id, target_user_id, from_user_id, from_nickname, item, note, created_at)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7)
       ON CONFLICT (id) DO UPDATE SET
         item = EXCLUDED.item,
         note = EXCLUDED.note
       RETURNING id, target_user_id, from_user_id, from_nickname, item, note, created_at`,
      [id, targetUserId, fromUserId, fromNickname, JSON.stringify(item), note, createdAt]
    );

    return res.status(201).json({
      success: true,
      gift: normalizeGiftRow(rows[0]),
    });
  } catch (err) {
    console.error('POST /api/gifts:', err);
    return res.status(500).json({ success: false, error: 'Ошибка сохранения подарка в БД' });
  }
});

app.delete('/api/gifts/:giftId', async (req, res) => {
  try {
    await ensureUserGiftsTable();
    const giftId = String(req.params.giftId || '').trim();
    if (!giftId) return res.status(400).json({ success: false, error: 'Missing giftId' });
    await pool.query('DELETE FROM public.user_gifts WHERE id = $1', [giftId]);
    return res.json({ success: true });
  } catch (err) {
    console.error('DELETE /api/gifts/:giftId:', err);
    return res.status(500).json({ success: false, error: 'Ошибка удаления подарка' });
  }
});

// --- Синхронизация рамок аватара (включая прикреплённую форму аватарки avatar_shape) ---
let avatarFramesTableReady = false;
async function ensureAvatarFramesTable() {
  if (avatarFramesTableReady) return;
  await pool.query(`
    CREATE TABLE IF NOT EXISTS public.avatar_frames (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL DEFAULT 'Рамка',
      category TEXT NOT NULL DEFAULT 'levels',
      min_level INTEGER NOT NULL DEFAULT 1,
      rule TEXT DEFAULT '',
      badge TEXT DEFAULT '',
      image_url TEXT DEFAULT '',
      frame_class TEXT DEFAULT '',
      vfx_html TEXT DEFAULT '',
      avatar_shape TEXT DEFAULT '',
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  try {
    await pool.query(`ALTER TABLE public.avatar_frames ADD COLUMN IF NOT EXISTS avatar_shape TEXT DEFAULT ''`);
  } catch (_) {}
  avatarFramesTableReady = true;
}

app.get('/api/avatar-frames', async (_req, res) => {
  try {
    await ensureAvatarFramesTable();
    const { rows } = await pool.query(
      `SELECT id, title, category, min_level, rule, badge, image_url, frame_class, vfx_html, avatar_shape, updated_at
       FROM public.avatar_frames
       ORDER BY min_level ASC, id ASC`
    );
    return res.json({
      success: true,
      frames: rows.map((row) => ({
        id: String(row.id),
        title: row.title || 'Рамка',
        category: row.category || 'levels',
        minLevel: Number(row.min_level || 1),
        rule: row.rule || '',
        badge: row.badge || '',
        image: row.image_url || '',
        frameClass: row.frame_class || '',
        vfxHTML: row.vfx_html || '',
        avatarShape: row.avatar_shape || '',
      })),
    });
  } catch (err) {
    console.error('GET /api/avatar-frames:', err);
    return res.status(500).json({ success: false, error: 'Ошибка загрузки рамок аватара' });
  }
});

app.put('/api/admin/avatar-frames', async (req, res) => {
  try {
    await ensureAvatarFramesTable();
    const frames = Array.isArray(req.body?.frames) ? req.body.frames : [];
    const validShapes = new Set(['', 'circle', 'heart', 'star', 'square', 'cat']);
    const cleanRows = frames
      .filter((f) => f && f.id && String(f.id) !== 'auto')
      .map((fr) => {
        const shape = validShapes.has(String(fr.avatarShape || '')) ? String(fr.avatarShape || '') : '';
        return {
          id: String(fr.id),
          title: String(fr.title || 'Рамка').trim(),
          category: String(fr.category || 'levels').trim(),
          min_level: Math.max(1, Math.min(100, Number(fr.minLevel || 1))),
          rule: String(fr.rule || '').trim(),
          badge: String(fr.badge || '').trim(),
          image_url: String(fr.image || '').trim(),
          frame_class: String(fr.frameClass || '').trim(),
          vfx_html: String(fr.vfxHTML || ''),
          avatar_shape: shape,
        };
      });

    const keepIds = cleanRows.map((r) => r.id);
    if (keepIds.length > 0) {
      await pool.query('DELETE FROM public.avatar_frames WHERE NOT (id = ANY($1::text[]))', [keepIds]);
    } else {
      await pool.query('DELETE FROM public.avatar_frames');
    }

    for (const r of cleanRows) {
      await pool.query(
        `INSERT INTO public.avatar_frames
           (id, title, category, min_level, rule, badge, image_url, frame_class, vfx_html, avatar_shape, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, NOW())
         ON CONFLICT (id) DO UPDATE SET
           title = EXCLUDED.title,
           category = EXCLUDED.category,
           min_level = EXCLUDED.min_level,
           rule = EXCLUDED.rule,
           badge = EXCLUDED.badge,
           image_url = EXCLUDED.image_url,
           frame_class = EXCLUDED.frame_class,
           vfx_html = EXCLUDED.vfx_html,
           avatar_shape = EXCLUDED.avatar_shape,
           updated_at = NOW()`,
        [r.id, r.title, r.category, r.min_level, r.rule, r.badge, r.image_url, r.frame_class, r.vfx_html, r.avatar_shape]
      );
    }

    return res.json({ success: true, count: cleanRows.length });
  } catch (err) {
    console.error('PUT /api/admin/avatar-frames:', err);
    return res.status(500).json({ success: false, error: 'Ошибка сохранения рамок аватара в БД' });
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
