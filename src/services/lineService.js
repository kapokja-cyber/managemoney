/**
 * LINE Service
 * รับ event จาก LINE แล้วส่งต่อให้ message handler
 * รองรับ text และ image (slip/ใบเสร็จ)
 */
const line = require('@line/bot-sdk');
const { config } = require('../config');
const { handleTextMessage, handleImageMessage } = require('../handlers/messageHandler');
const { GENERAL_RESPONSES } = require('../messages');

const lineClient = new line.messagingApi.MessagingApiClient({
  channelAccessToken: config.line.channelAccessToken,
});

async function handleEvent(event) {
  if (event.type !== 'message') return null;

  const userId = event.source?.userId || null;

  // ─── รับ text message ───────────────────────────────
  if (event.message.type === 'text') {
    const userMessage = event.message.text.trim();
    const payload = await handleTextMessage(userId, userMessage);
    return replyPayload(event.replyToken, payload);
  }

  // ─── รับ image message (slip/ใบเสร็จ) ───────────────
  if (event.message.type === 'image') {
    const messageId = event.message.id;
    const payload = await handleImageMessage(userId, messageId, config.line.channelAccessToken);
    return replyPayload(event.replyToken, payload);
  }

  // ─── ประเภทอื่นๆ ────────────────────────────────────
  return replyPayload(event.replyToken, GENERAL_RESPONSES.notText);
}

async function replyPayload(replyToken, payload) {
  try {
    const message = typeof payload === 'string' ? { type: 'text', text: payload } : payload;
    return await lineClient.replyMessage({
      replyToken,
      messages: [message],
    });
  } catch (error) {
    if (error.originalError && error.originalError.response) {
      console.error('❌ LINE reply error:', JSON.stringify(error.originalError.response.data, null, 2));
    } else {
      console.error('❌ LINE reply error:', error.message);
    }
    return null;
  }
}

module.exports = {
  handleEvent,
  replyPayload,
};
