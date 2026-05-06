const express = require('express');
const line = require('@line/bot-sdk');
const { config } = require('./config');
const { handleEvent } = require('./services/lineService');
const { reportCache } = require('./handlers/messageHandler');

function createApp() {
  const app = express();

  const lineMiddleware = line.middleware({
    channelSecret: config.line.channelSecret,
  });

  app.get('/', (req, res) => {
    res.json({ status: 'ok', name: 'ManageMoney LINE Bot', version: '1.0.0' });
  });

  app.get('/health', (req, res) => {
    res.json({ status: 'ok' });
  });

  // Route download Excel
  app.get('/download-report/:cacheKey', (req, res) => {
    const { cacheKey } = req.params;
    const cached = reportCache.get(cacheKey);

    if (!cached) {
      return res.status(404).send('ไฟล์หมดอายุแล้วครับ กรุณาพิมพ์ "ส่ง report" ใหม่อีกครั้ง');
    }

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${cached.filename}"`);
    res.send(Buffer.from(cached.buffer));
  });

  app.post('/webhook', lineMiddleware, async (req, res) => {
    try {
      const events = req.body.events || [];
      if (events.length === 0) return res.status(200).json({ status: 'no events' });
      const results = await Promise.allSettled(events.map((event) => handleEvent(event)));
      results.forEach((result, index) => {
        if (result.status === 'rejected') console.error(`❌ Event ${index} failed:`, result.reason);
      });
      return res.status(200).json({ status: 'ok' });
    } catch (error) {
      console.error('❌ Webhook error:', error);
      return res.status(500).json({ status: 'error', message: error.message });
    }
  });

  app.use((err, req, res, next) => {
    if (err instanceof line.SignatureValidationFailed) return res.status(401).json({ error: 'Invalid signature' });
    if (err instanceof line.JSONParseError) return res.status(400).json({ error: 'Invalid JSON' });
    console.error('❌ Unhandled error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  });

  return app;
}

module.exports = { createApp };
