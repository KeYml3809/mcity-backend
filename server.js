const express = require('express');
const cors = require('cors');
const axios = require('axios');
const FormData = require('form-data');
const { createClient } = require('@supabase/supabase-js');

const app = express();

// 1. Разрешаем CORS для запросов с фронтенда (Netlify)
app.use(cors());

// 2. ВАЖНО: Увеличиваем лимит на входящий JSON/Base64 до 200MB,
// чтобы браузер не выдавал ошибку "Не удалось загрузить страницу" при больших главах
app.use(express.json({ limit: '200mb' }));
app.use(express.urlencoded({ limit: '200mb', extended: true }));

// Подключение к Supabase (если используется на бэкенде)
const SUPABASE_URL = process.env.SUPABASE_URL || 'https://frxftmxdmjttldtrplmh.supabase.co';
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY;
const supabase = (SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY) 
  ? createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY) 
  : null;

// ==========================================
// 1. Проверка работоспособности сервера (Health check)
// ==========================================
app.get('/', (req, res) => {
    res.send('MCity Backend Service is Running!');
});

// ==========================================
// 2. Telegram CDN Upload (Загрузка страниц в Telegram)
// ==========================================
app.post('/api/upload-page', async (req, res) => {
    try {
        const { imageBase64, fileName } = req.body;
        if (!imageBase64) {
            return res.status(400).json({ error: 'Изображение не передано' });
        }

        const botToken = process.env.TELEGRAM_BOT_TOKEN;
        const channelId = process.env.TELEGRAM_CHANNEL_ID;

        if (!botToken || !channelId) {
            console.error('Не заданы TELEGRAM_BOT_TOKEN или TELEGRAM_CHANNEL_ID на Render!');
            return res.status(500).json({ error: 'Сервер не настроен для работы с Telegram CDN (отсутствуют переменные окружения)' });
        }

        // Чистим Base64 префикс если он есть
        const base64Content = imageBase64.replace(/^data:image\/\w+;base64,/, '');
        const buffer = Buffer.from(base64Content, 'base64');

        // Подготавливаем multipart/form-data для Telegram API
        const form = new FormData();
        form.append('chat_id', channelId);
        form.append('document', buffer, { filename: fileName || `page_${Date.now()}.webp` });

        // Отправляем файл в Telegram-канал
        const tgRes = await axios.post(
            `https://api.telegram.org/bot${botToken}/sendDocument`,
            form,
            { headers: form.getHeaders() }
        );

        if (!tgRes.data.ok) {
            throw new Error('Telegram Bot API вернул ошибку при сохранении документа');
        }

        const document = tgRes.data.result.document || (tgRes.data.result.photo && tgRes.data.result.photo.slice(-1)[0]);
        if (!document) {
            throw new Error('Не удалось получить file_id от Telegram');
        }

        const fileId = document.file_id;

        // Запрашиваем путь к файлу у Telegram
        const fileInfoRes = await axios.get(`https://api.telegram.org/bot${botToken}/getFile?file_id=${fileId}`);
        const filePath = fileInfoRes.data.result.file_path;

        // Формируем прямую публичную ссылку на документ
        const publicUrl = `https://api.telegram.org/file/bot${botToken}/${filePath}`;

        return res.json({ url: publicUrl });

    } catch (err) {
        console.error('Ошибка загрузки в Telegram CDN:', err.response?.data || err.message);
        return res.status(500).json({ 
            error: 'Не удалось загрузить страницу в Telegram', 
            details: err.response?.data?.description || err.message 
        });
    }
});

// ==========================================
// 3. Эндпоинты для Лайков
// ==========================================
app.post('/api/profile/like', async (req, res) => {
    try {
        const { from_user_id, to_user_id } = req.body;
        
        if (supabase) {
            // Регистрация лайка в Supabase при необходимости
        }

        return res.json({ success: true, message: 'Лайк успешно зарегистрирован' });
    } catch (err) {
        console.error('Ошибка при обработке лайка:', err);
        return res.status(500).json({ error: 'Ошибка сервера при отправке лайка' });
    }
});

// ==========================================
// 4. Эндпоинты для Дропа и Инвентаря Карточек
// ==========================================
app.post('/api/cards/drop', async (req, res) => {
    try {
        const { user_id } = req.body;

        const defaultPool = [
            { id: 'c1', title: 'Ярость Мо Сы', rank: 'SS', image: 'https://images.unsplash.com/photo-1578632767115-351597cf2477?w=300' },
            { id: 'c2', title: 'Главный герой', rank: 'S', image: 'https://images.unsplash.com/photo-1607604276583-eef5d076aa5f?w=300' },
            { id: 'c3', title: 'Тайный взгляд', rank: 'A', image: 'https://images.unsplash.com/photo-1563089145-599997674d42?w=300' },
            { id: 'c4', title: 'Злодейка истории', rank: 'B', image: 'https://images.unsplash.com/photo-1534528741775-53994a69daeb?w=300' }
        ];

        const randomCard = defaultPool[Math.floor(Math.random() * defaultPool.length)];

        return res.json({ success: true, card: randomCard });
    } catch (err) {
        console.error('Ошибка выпадения карточки:', err);
        return res.status(500).json({ error: 'Ошибка сервера при генерации дропа' });
    }
});

app.get('/api/user/:userId/cards', async (req, res) => {
    try {
        const { userId } = req.params;
        return res.json({ cards: [] });
    } catch (err) {
        return res.status(500).json({ error: 'Ошибка получения карточек' });
    }
});

// ==========================================
// Запуск сервера
// ==========================================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});
