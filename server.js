const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');

const app = express();
app.use(cors());
app.use(express.json());

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// 1. ОБНОВЛЕНИЕ ПРОФИЛЯ
app.patch('/api/profile', async (req, res) => {
  const { userId, avatarUrl, bannerUrl } = req.body;
  try {
    const result = await pool.query(
      `UPDATE users 
       SET avatar_url = COALESCE($1, avatar_url), 
           banner_url = COALESCE($2, banner_url) 
       WHERE id = $3 RETURNING id, username, avatar_url, banner_url`,
      [avatarUrl, bannerUrl, userId]
    );
    if (result.rowCount === 0) return res.status(404).json({ error: 'Пользователь не найден' });
    res.json({ success: true, user: result.rows[0] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 2. ЛАЙК ПРОФИЛЯ С КУЛДАУНОМ 3 ЧАСА
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
    res.status(500).json({ error: err.message });
  }
});

// 3. ДРОП КОЛЛЕКЦИОННОЙ КАРТОЧКИ (Таймер 10 минут)
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
        return res.status(429).json({ error: 'Карточка еще не готова к получению.' });
      }
    }

    const rand = Math.random() * 100;
    let selectedRarity = 'D';
    if (rand > 99.5) selectedRarity = 'SS';
    else if (rand > 97.0) selectedRarity = 'S';
    else if (rand > 90.0) selectedRarity = 'A';
    else if (rand > 75.0) selectedRarity = 'B';
    else if (rand > 50.0) selectedRarity = 'C';

    const cardRes = await pool.query(
      `SELECT * FROM cards WHERE rarity = $1 ORDER BY RANDOM() LIMIT 1`,
      [selectedRarity]
    );

    if (cardRes.rows.length === 0) {
      return res.status(444).json({ error: 'Карточки данного ранга пока отсутствуют' });
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
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`Server listening on port ${PORT}`));
