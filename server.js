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
