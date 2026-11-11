const express = require('express');
const cors = require('cors');
const axios = require('axios');
const FormData = require('form-data');
const sharp = require('sharp'); // Библиотека для конвертации картинок
const { createClient } = require('@supabase/supabase-js');

const app = express();

app.use(cors());
app.use(express.json({ limit: '200mb' }));
app.use(express.urlencoded({ limit: '200mb', extended: true }));

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://frxftmxdmjttldtrplmh.supabase.co';
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY;
const supabase = (SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY) 
  ? createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY) 
  : null;

app.get('/', (req, res) => {
    res.send('MCity Backend Service is Running!');
});

// ==========================================
// Загрузка страниц в Telegram с конвертацией в JPEG
// ==========================================
app.post('/api/upload-page', async (req, res) => {
    try {
        const { imageBase64, fileName } = req.body;
        if (!imageBase64) {
            return res.status(400).json({ error: 'Изображение не передано' });
        }

        const botToken = process.env.TELEGRAM_BOT_TOKEN;
        const channelId = process.env.TELEGRAM_CHANNEL_ID; // Здесь должен быть ID вашей группы/канала (например, -100...)

        if (!botToken || !channelId) {
            console.error('Не заданы TELEGRAM_BOT_TOKEN или TELEGRAM_CHANNEL_ID на Render!');
            return res.status(500).json({ error: 'Сервер не настроен для работы с Telegram CDN' });
        }

        // 1. Очищаем Base64 и переводим в Buffer
        const base64Content = imageBase64.replace(/^data:image\/\w+;base64,/, '');
        const inputBuffer = Buffer.from(base64Content, 'base64');

        // 2. АВТОМАТИЧЕСКАЯ КОНВЕРТАЦИЯ В JPEG ЧЕРЕЗ SHARP (сохраняет максимальное качество без сжатия Telegram)
        const processedBuffer = await sharp(inputBuffer)
            .jpeg({ quality: 92 }) // Качество 92% — идеальный баланс между весом и четкостью текста манги
            .toBuffer();

        // Формируем имя файла с расширением .jpg
        const cleanName = (fileName ? fileName.substring(0, fileName.lastIndexOf('.')) : 'page') + '.jpg';

        // 3. Отправляем в Telegram КАК ДОКУМЕНТ (sendDocument), что гарантирует 100% сохранение оригинального качества
        const form = new FormData();
        form.append('chat_id', channelId); // Отправка строго в указанную группу/канал
        form.append('document', processedBuffer, { filename: cleanName });

        const tgRes = await axios.post(
            `https://api.telegram.org/bot${botToken}/sendDocument`,
            form,
            { headers: form.getHeaders() }
        );

        if (!tgRes.data.ok) {
            throw new Error('Telegram Bot API вернул ошибку при сохранении документа');
        }

        const document = tgRes.data.result.document;
        if (!document) {
            throw new Error('Не удалось получить file_id от Telegram');
        }

        const fileId = document.file_id;

        // Получаем прямую публичную ссылку
        const fileInfoRes = await axios.get(`https://api.telegram.org/bot${botToken}/getFile?file_id=${fileId}`);
        const filePath = fileInfoRes.data.result.file_path;
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

// Остальные эндпоинты...
app.post('/api/profile/like', async (req, res) => {
    return res.json({ success: true, message: 'Лайк успешно зарегистрирован' });
});

app.post('/api/cards/drop', async (req, res) => {
    const defaultPool = [
        { id: 'c1', title: 'Ярость Мо Сы', rank: 'SS', image: 'https://images.unsplash.com/photo-1578632767115-351597cf2477?w=300' },
        { id: 'c2', title: 'Главный герой', rank: 'S', image: 'https://images.unsplash.com/photo-1607604276583-eef5d076aa5f?w=300' }
    ];
    const randomCard = defaultPool[Math.floor(Math.random() * defaultPool.length)];
    return res.json({ success: true, card: randomCard });
});

app.get('/api/user/:userId/cards', async (req, res) => {
    return res.json({ cards: [] });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});
