const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { Pool } = require('pg');

const router = express.Router();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

const UPLOAD_DIR = path.join(process.cwd(), 'uploads', 'banners');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const ALLOWED_MIMES = {
  'image/gif': 'gif',
  'video/mp4': 'video',
  'video/webm': 'video',
};

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, UPLOAD_DIR),
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase() || (file.mimetype === 'image/gif' ? '.gif' : '.mp4');
    cb(null, `banner-${Date.now()}${ext}`);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: 20 * 1024 * 1024 }, // 20 MB
  fileFilter: (_req, file, cb) => {
    if (!ALLOWED_MIMES[file.mimetype]) {
      return cb(new Error('Разрешены только GIF, MP4 и WebM'));
    }
    cb(null, true);
  },
});

// Получить активный баннер лавки
router.get('/api/shop/banner', async (_req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT slot_key, media_type, mime_type, media_url, poster_url, updated_at FROM shop_banners WHERE slot_key = $1',
      ['main_shop']
    );
    res.json(rows[0] || null);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Ошибка загрузки баннера из БД' });
  }
});

// Обновить баннер из админки (добавь сюда middleware проверки прав админа)
router.put('/api/admin/shop/banner', upload.single('banner'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'Файл баннера не передан' });
    }

    const mediaType = ALLOWED_MIMES[req.file.mimetype];
    const mediaUrl = `/uploads/banners/${req.file.filename}`;

    const { rows } = await pool.query(
      `INSERT INTO shop_banners (slot_key, media_type, mime_type, media_url, updated_at)
       VALUES ($1, $2, $3, $4, NOW())
       ON CONFLICT (slot_key) DO UPDATE SET
         media_type = EXCLUDED.media_type,
         mime_type = EXCLUDED.mime_type,
         media_url = EXCLUDED.media_url,
         updated_at = NOW()
       RETURNING *`,
      ['main_shop', mediaType, req.file.mimetype, mediaUrl]
    );

    res.json({ ok: true, banner: rows[0] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Не удалось сохранить баннер' });
  }
});

module.exports = router;
