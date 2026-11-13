const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const { Pool } = require('pg');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json({ limit: '15mb' }));

// Подключение к PostgreSQL (Supabase Transaction Pooler порт 6543)
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// Автоматическая проверка и синхронизация схемы БД при запуске
async function initDB() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS users (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        public_id SERIAL,
        username VARCHAR(50) UNIQUE NOT NULL,
        email VARCHAR(255) UNIQUE NOT NULL,
        password_hash VARCHAR(255) NOT NULL,
        avatar_url TEXT DEFAULT '/avatars/default.png',
        banner_url TEXT DEFAULT '/banners/default.png',
        role VARCHAR(20) DEFAULT 'user',
        likes_count INT DEFAULT 0,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      );
    `);

    await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS public_id SERIAL;`);
    await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS role VARCHAR(20) DEFAULT 'user';`);
    await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS likes_count INT DEFAULT 0;`);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS profile_likes_log (
        id SERIAL PRIMARY KEY,
        from_user_id UUID REFERENCES users(id) ON DELETE CASCADE,
        to_user_id UUID REFERENCES users(id) ON DELETE CASCADE,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      );
    `);

    await pool.query(`
      DO $$ BEGIN
        CREATE TYPE card_rarity AS ENUM ('D', 'C', 'B', 'A', 'S', 'SS');
      EXCEPTION
        WHEN duplicate_object THEN null;
      END $$;
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS cards (
        id SERIAL PRIMARY KEY,
        public_id TEXT,
        name VARCHAR(100) NOT NULL,
        character_name VARCHAR(100) NOT NULL,
        manga_title VARCHAR(150) NOT NULL,
        image_url TEXT NOT NULL,
        rarity card_rarity NOT NULL DEFAULT 'D',
        drop_rate NUMERIC(5,2) NOT NULL DEFAULT 10.00
      );
    `);

    await pool.query(`ALTER TABLE cards ADD COLUMN IF NOT EXISTS public_id TEXT;`);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS user_cards (
        id SERIAL PRIMARY KEY,
        user_id UUID REFERENCES users(id) ON DELETE CASCADE,
        card_id INT REFERENCES cards(id) ON DELETE CASCADE,
        obtained_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      );
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS card_drop_cooldowns (
        user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
        last_drop_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      );
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS trades (
        id SERIAL PRIMARY KEY,
        sender_id UUID REFERENCES users(id) ON DELETE CASCADE,
        receiver_id UUID REFERENCES users(id) ON DELETE CASCADE,
        sender_user_card_id INT REFERENCES user_cards(id) ON DELETE CASCADE,
        receiver_user_card_id INT REFERENCES user_cards(id) ON DELETE SET NULL,
        status VARCHAR(20) DEFAULT 'pending',
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      );
    `);

    console.log('✅ База данных успешно проверена и синхронизирована');
  } catch (err) {
    console.error('❌ Ошибка инициализации БД:', err.message);
  }
}

// Вспомогательные функции хеширования паролей без сторонних зависимостей
function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

function verifyPassword(password, storedHash) {
  if (!storedHash || !storedHash.includes(':')) {
    return password === storedHash;
  }
  const [salt, key] = storedHash.split(':');
  const hashBuffer = crypto.scryptSync(password, salt, 64);
  const keyBuffer = Buffer.from(key, 'hex');
  if (hashBuffer.length !== keyBuffer.length) return false;
  return crypto.timingSafeEqual(hashBuffer, keyBuffer);
}

// ==========================================
// 1. АВТОРИЗАЦИЯ И РЕГИСТРАЦИЯ (Поддержка обоих форматов URL)
// ==========================================

app.post(['/api/auth/register', '/api/register'], async (req, res) => {
  const { username, email, password } = req.body;
  if (!username || !email || !password) {
    return res.status(400).json({ error: 'Заполните все обязательные поля' });
  }

  try {
    const passwordHash = hashPassword(password);
    const result = await pool.query(
      `INSERT INTO users (username, email, password_hash)
       VALUES ($1, $2, $3)
       RETURNING id, public_id, username, email, avatar_url, banner_url, role, likes_count`,
      [username.trim(), email.trim().toLowerCase(), passwordHash]
    );

    const user = result.rows[0];
    const token = Buffer.from(`${user.id}:${Date.now()}`).toString('base64');
    res.status(201).json({ success: true, token, user });
  } catch (err) {
    console.error('Register error:', err);
    if (err.code === '23505') {
      return res.status(409).json({ error: 'Пользователь с таким именем или email уже существует' });
    }
    res.status(500).json({ error: err.message });
  }
});

app.post(['/api/auth/login', '/api/login'], async (req, res) => {
  const { email, username, password } = req.body;
  const loginIdentifier = (email || username || '').trim();

  if (!loginIdentifier || !password) {
    return res.status(400).json({ error: 'Введите логин/email и пароль' });
  }

  try {
    const result = await pool.query(
      `SELECT id, public_id, username, email, password_hash, avatar_url, banner_url, role, likes_count
       FROM users
       WHERE LOWER(email) = LOWER($1) OR LOWER(username) = LOWER($1)
       LIMIT 1`,
      [loginIdentifier]
    );

    if (result.rows.length === 0) {
      return res.status(401).json({ error: 'Неверный логин или пароль' });
    }

    const user = result.rows[0];
    const isValid = verifyPassword(password, user.password_hash);
    if (!isValid) {
      return res.status(401).json({ error: 'Неверный логин или пароль' });
    }

    delete user.password_hash;
    const token = Buffer.from(`${user.id}:${Date.now()}`).toString('base64');
    res.json({ success: true, token, user });
  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ==========================================
// 2. ПОЛЬЗОВАТЕЛИ И ПРОФИЛИ (v17_2 + v18)
// ==========================================

app.get('/api/users', async (req, res) => {
  const { search } = req.query;
  try {
    let query = `
      SELECT id, public_id, username, email, avatar_url, banner_url, role, likes_count, created_at
      FROM users
    `;
    const params = [];

    if (search && search.trim() !== '') {
      query += ` WHERE username ILIKE $1 OR CAST(public_id AS TEXT) = $2`;
      params.push(`%${search.trim()}%`, search.trim());
    }

    query += ` ORDER BY created_at DESC LIMIT 100`;
    const result = await pool.query(query, params);
    res.json({ success: true, users: result.rows });
  } catch (err) {
    console.error('Get users error:', err);
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/users/:id', async (req, res) => {
  const { id } = req.params;
  try {
    const result = await pool.query(`DELETE FROM users WHERE id = $1 RETURNING id`, [id]);
    if (result.rowCount === 0) {
      return res.status(404).json({ error: 'Пользователь не найден' });
    }
    res.json({ success: true, message: 'Пользователь удален' });
  } catch (err) {
    console.error('Delete user error:', err);
    res.status(500).json({ error: err.message });
  }
});

app.patch(['/api/profile', '/api/users/profile'], async (req, res) => {
  const { userId, username, avatarUrl, bannerUrl } = req.body;
  try {
    const result = await pool.query(
      `UPDATE users
       SET username = COALESCE($1, username),
           avatar_url = COALESCE($2, avatar_url),
           banner_url = COALESCE($3, banner_url)
       WHERE id = $4
       RETURNING id, public_id, username, email, avatar_url, banner_url, role, likes_count`,
      [username, avatarUrl, bannerUrl, userId]
    );
    if (result.rowCount === 0) {
      return res.status(404).json({ error: 'Пользователь не найден' });
    }
    res.json({ success: true, user: result.rows[0] });
  } catch (err) {
    console.error('Update profile error:', err);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/profile/:targetUserId/like', async (req, res) => {
  const { fromUserId } = req.body;
  const { targetUserId } = req.params;

  if (fromUserId === targetUserId) {
    return res.status(400).json({ error: 'Нельзя ставить лайк самому себе' });
  }

  try {
    const lastLikeRes = await pool.query(
      `SELECT created_at FROM profile_likes_log
       WHERE from_user_id = $1 AND to_user_id = $2
       ORDER BY created_at DESC LIMIT 1`,
      [fromUserId, targetUserId]
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
      [fromUserId, targetUserId]
    );
    await pool.query(
      `UPDATE users SET likes_count = likes_count + 1 WHERE id = $1`,
      [targetUserId]
    );
    await pool.query('COMMIT');

    res.json({ success: true, message: 'Лайк успешно поставлен!' });
  } catch (err) {
    await pool.query('ROLLBACK');
    console.error('Like error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ==========================================
// 3. КАРТОЧКИ И ДРОП (Таймер 10 минут)
// ==========================================

app.get('/api/cards', async (req, res) => {
  try {
    const result = await pool.query(`SELECT * FROM cards ORDER BY id DESC`);
    res.json({ success: true, cards: result.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/users/:userId/cards', async (req, res) => {
  const { userId } = req.params;
  try {
    const result = await pool.query(
      `SELECT uc.id AS user_card_id, uc.obtained_at, c.*
       FROM user_cards uc
       JOIN cards c ON uc.card_id = c.id
       WHERE uc.user_id = $1
       ORDER BY uc.obtained_at DESC`,
      [userId]
    );
    res.json({ success: true, cards: result.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/cards/claim-drop', async (req, res) => {
  const { userId } = req.body;

  try {
    const cdRes = await pool.query(
      `SELECT last_drop_at FROM card_drop_cooldowns WHERE user_id = $1`,
      [userId]
    );

    const tenMinutesInMs = 10 * 60 * 1000;
    if (cdRes.rows.length > 0) {
      const lastDrop = new Date(cdRes.rows[0].last_drop_at).getTime();
      if (Date.now() - lastDrop < tenMinutesInMs) {
        const remainingSec = Math.ceil((tenMinutesInMs - (Date.now() - lastDrop)) / 1000);
        return res.status(429).json({
          error: `Карточка еще не готова. Осталось ${remainingSec} сек.`
        });
      }
    }

    const rand = Math.random() * 100;
    let selectedRarity = 'D';
    if (rand > 99.5) selectedRarity = 'SS';
    else if (rand > 97.0) selectedRarity = 'S';
    else if (rand > 90.0) selectedRarity = 'A';
    else if (rand > 75.0) selectedRarity = 'B';
    else if (rand > 50.0) selectedRarity = 'C';

    let cardRes = await pool.query(
      `SELECT * FROM cards WHERE rarity = $1 ORDER BY RANDOM() LIMIT 1`,
      [selectedRarity]
    );

    if (cardRes.rows.length === 0) {
      cardRes = await pool.query(`SELECT * FROM cards ORDER BY RANDOM() LIMIT 1`);
    }

    if (cardRes.rows.length === 0) {
      return res.status(404).json({ error: 'В базе данных пока нет ни одной карточки' });
    }

    const droppedCard = cardRes.rows[0];

    await pool.query('BEGIN');
    await pool.query(
      `INSERT INTO user_cards (user_id, card_id) VALUES ($1, $2)`,
      [userId, droppedCard.id]
    );
    await pool.query(
      `INSERT INTO card_drop_cooldowns (user_id, last_drop_at) VALUES ($1, NOW())
       ON CONFLICT (user_id) DO UPDATE SET last_drop_at = NOW()`,
      [userId]
    );
    await pool.query('COMMIT');

    res.json({ success: true, card: droppedCard });
  } catch (err) {
    await pool.query('ROLLBACK');
    console.error('Claim drop error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ==========================================
// 4. СИСТЕМА ОБМЕНА КАРТОЧКАМИ (v18)
// ==========================================

app.get('/api/trades/:userId', async (req, res) => {
  const { userId } = req.params;
  try {
    const result = await pool.query(
      `SELECT t.*,
              u_send.username AS sender_name,
              u_recv.username AS receiver_name,
              c_send.name AS sender_card_name,
              c_send.rarity AS sender_card_rarity,
              c_recv.name AS receiver_card_name,
              c_recv.rarity AS receiver_card_rarity
       FROM trades t
       LEFT JOIN users u_send ON t.sender_id = u_send.id
       LEFT JOIN users u_recv ON t.receiver_id = u_recv.id
       LEFT JOIN user_cards uc_send ON t.sender_user_card_id = uc_send.id
       LEFT JOIN cards c_send ON uc_send.card_id = c_send.id
       LEFT JOIN user_cards uc_recv ON t.receiver_user_card_id = uc_recv.id
       LEFT JOIN cards c_recv ON uc_recv.card_id = c_recv.id
       WHERE t.sender_id = $1 OR t.receiver_id = $1
       ORDER BY t.created_at DESC`,
      [userId]
    );
    res.json({ success: true, trades: result.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/trades', async (req, res) => {
  const { senderId, receiverId, senderUserCardId, receiverUserCardId } = req.body;
  try {
    const result = await pool.query(
      `INSERT INTO trades (sender_id, receiver_id, sender_user_card_id, receiver_user_card_id, status)
       VALUES ($1, $2, $3, $4, 'pending')
       RETURNING *`,
      [senderId, receiverId, senderUserCardId, receiverUserCardId]
    );
    res.status(201).json({ success: true, trade: result.rows[0] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/trades/:tradeId/respond', async (req, res) => {
  const { tradeId } = req.params;
  const { action } = req.body;

  try {
    const tradeRes = await pool.query(`SELECT * FROM trades WHERE id = $1`, [tradeId]);
    if (tradeRes.rows.length === 0) {
      return res.status(404).json({ error: 'Обмен не найден' });
    }

    const trade = tradeRes.rows[0];
    if (trade.status !== 'pending') {
      return res.status(400).json({ error: 'Этот обмен уже завершен' });
    }

    if (action === 'reject') {
      await pool.query(`UPDATE trades SET status = 'rejected' WHERE id = $1`, [tradeId]);
      return res.json({ success: true, message: 'Обмен отклонен' });
    }

    if (action === 'accept') {
      await pool.query('BEGIN');

      if (trade.sender_user_card_id) {
        await pool.query(
          `UPDATE user_cards SET user_id = $1 WHERE id = $2`,
          [trade.receiver_id, trade.sender_user_card_id]
        );
      }

      if (trade.receiver_user_card_id) {
        await pool.query(
          `UPDATE user_cards SET user_id = $1 WHERE id = $2`,
          [trade.sender_id, trade.receiver_user_card_id]
        );
      }

      await pool.query(`UPDATE trades SET status = 'accepted' WHERE id = $1`, [tradeId]);
      await pool.query('COMMIT');

      return res.json({ success: true, message: 'Обмен успешно выполнен!' });
    }

    res.status(400).json({ error: 'Неизвестное действие' });
  } catch (err) {
    await pool.query('ROLLBACK');
    console.error('Trade respond error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Проверка работоспособности сервера
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, async () => {
  console.log(`Server listening on port ${PORT}`);
  await initDB();
});
