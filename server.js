const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const pool = require('../db'); // твой pg Pool / client

const router = express.Router();

const uploadDir = path.join(__dirname, '..', 'uploads', 'banners');
fs.mkdirSync(uploadDir, { recursive: true });

const ALLOWED_MIMES = {
  'image/gif': 'gif',
  'image/webp': 'image',
  'image/png': 'image',
  'image/jpeg': 'image',
  'video/mp4': 'video',
  'video/webm': 'video',
};

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, uploadDir),
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

// Получить текущий баннер для лавки и админки
router.get('/api/shop/banner', async (_req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT id, media_type, media_url, link_url, is_active, updated_at FROM shop_banners WHERE is_active = true ORDER BY id DESC LIMIT 1'
    );
    res.json(rows[0] || null);
  } catch (err) {
    console.error('GET /api/shop/banner:', err);
    res.status(500).json({ error: 'Ошибка загрузки баннера' });
  }
});

// Обновить баннер из админки (загрузка нового файла или смена ссылки)
router.put(
  '/api/admin/shop/banner',
  // сюда при необходимости подключи middleware проверки прав админа
  upload.single('bannerFile'),
  async (req, res) => {
    try {
      const { linkUrl = '' } = req.body;

      const currentRes = await pool.query(
        'SELECT id, media_type, media_url FROM shop_banners WHERE is_active = true ORDER BY id DESC LIMIT 1'
      );
      const current = currentRes.rows[0];

      let mediaType = current?.media_type || 'image';
      let mediaUrl = current?.media_url || '';

      if (req.file) {
        mediaType = ALLOWED_MIMES[req.file.mimetype];
        mediaUrl = `/uploads/banners/${req.file.filename}`;

        // Удаляем старый локальный файл, если он лежал в /uploads/banners/
        if (current?.media_url && current.media_url.startsWith('/uploads/banners/')) {
          const oldPath = path.join(__dirname, '..', current.media_url);
          fs.promises.unlink(oldPath).catch(() => {});
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
          [mediaType, mediaUrl, linkUrl.trim(), current.id]
        );
        saved = upd.rows[0];
      } else {
        const ins = await pool.query(
          `INSERT INTO shop_banners (media_type, media_url, link_url, is_active)
           VALUES ($1, $2, $3, true)
           RETURNING id, media_type, media_url, link_url, is_active, updated_at`,
          [mediaType, mediaUrl, linkUrl.trim()]
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

module.exports = router;
