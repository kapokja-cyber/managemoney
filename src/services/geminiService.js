/**
 * Gemini AI Service
 * วิเคราะห์ข้อความภาษาไทย → structured JSON
 * รองรับทั้ง text และ image (slip/ใบเสร็จ)
 */
const { GoogleGenerativeAI } = require('@google/generative-ai');
const axios = require('axios');
const { config } = require('../config');
const { buildSystemPrompt, buildUserPrompt } = require('../constants/prompts');
const { getToday, getYesterday, isValidDate, parseDateFromText } = require('../utils/dateParser');
const { ALL_CATEGORIES, categorizeByKeyword, classifyByKeyword } = require('../constants/categories');
const { boostConfidenceForObviousTransaction, isAmbiguousTransactionText } = require('../utils/transactionRules');
const { cleanTransactionItem, extractAmount, parseAmountValue } = require('../utils/moneyParser');

// ─── Initialize Gemini ─────────────────────────────────
const genAI = new GoogleGenerativeAI(config.gemini.apiKey);

const model = genAI.getGenerativeModel(
  {
    model: config.gemini.model,
    generationConfig: {
      temperature: 0.15,
    },
  },
  { apiVersion: 'v1' }
);

/**
 * ส่งข้อความให้ Gemini AI วิเคราะห์
 * @param {string} userMessage - ข้อความจากผู้ใช้
 * @returns {object} parsed transaction data
 */
async function parseExpenseMessage(userMessage) {
  try {
    const today = getToday();
    const yesterday = getYesterday();

    const systemPrompt = buildSystemPrompt(today, yesterday);
    const userPrompt = buildUserPrompt(userMessage);

    const result = await model.generateContent({
      contents: [
        { role: 'user', parts: [{ text: systemPrompt + '\n\n' + userPrompt }] },
      ],
    });

    const responseText = result.response.text();
    const parsed = JSON.parse(responseText);

    // ─── Validate & Sanitize ──────────────────────────
    return sanitizeResult(parsed, userMessage);
  } catch (error) {
    console.error('❌ Gemini AI Error:', error.message);

    // Fallback: พยายาม parse เองถ้า Gemini ล้มเหลว
    return fallbackParse(userMessage);
  }
}

/**
 * Validate และ sanitize ผลลัพธ์จาก Gemini
 */
function sanitizeResult(parsed, originalText) {
  const today = getToday();
  const keywordType = classifyByKeyword(originalText);
  const keywordCategory = categorizeByKeyword(originalText, keywordType);
  const parsedDateFromText = parseDateFromText(originalText);

  // Validate amount
  if (parsed.amount !== null && parsed.amount !== undefined) {
    parsed.amount = parseAmountValue(parsed.amount);
    if (parsed.amount === null) {
      parsed.amount = null;
      if (!parsed.missing_fields) parsed.missing_fields = [];
      if (!parsed.missing_fields.includes('amount')) {
        parsed.missing_fields.push('amount');
      }
    }
  } else {
    parsed.amount = extractAmount(originalText);
  }

  // Validate type
  if (!['รายรับ', 'รายจ่าย'].includes(parsed.type)) {
    parsed.type = keywordType;
    parsed.confidence = Math.min(parsed.confidence || 0.5, 0.6);
  }

  // Validate category
  if (!ALL_CATEGORIES.includes(parsed.category)) {
    parsed.category = keywordCategory;
    parsed.confidence = Math.min(parsed.confidence || 0.5, 0.7);
  } else if (keywordCategory !== 'อื่นๆ' && parsed.category === 'อื่นๆ') {
    parsed.category = keywordCategory;
  }

  // Validate date
  if (!parsed.date || !isValidDate(parsed.date)) {
    parsed.date = parsedDateFromText || today;
  }

  // Validate confidence
  if (typeof parsed.confidence !== 'number' || parsed.confidence < 0 || parsed.confidence > 1) {
    parsed.confidence = 0.7;
  }

  // Ensure missing_fields is array
  if (!Array.isArray(parsed.missing_fields)) {
    parsed.missing_fields = [];
  }

  // ถ้าไม่มี amount ต้องอยู่ใน missing_fields
  if (parsed.amount === null || parsed.amount === undefined) {
    if (!parsed.missing_fields.includes('amount')) {
      parsed.missing_fields.push('amount');
    }
  }

  // ถ้าไม่มี item
  if (!parsed.item || parsed.item.trim() === '') {
    parsed.item = cleanTransactionItem(originalText);
    if (!parsed.missing_fields.includes('item')) {
      parsed.missing_fields.push('item');
    }
  } else {
    parsed.item = String(parsed.item).trim();
  }

  // ถ้าเราเติม item/amount ได้จากข้อความแล้ว ให้เคลียร์ missing field ที่เกี่ยวข้อง
  parsed.missing_fields = parsed.missing_fields.filter((field) => {
    if (field === 'amount') return parsed.amount === null || parsed.amount === undefined;
    if (field === 'item') return !parsed.item;
    if (field === 'type') return !['รายรับ', 'รายจ่าย'].includes(parsed.type);
    if (field === 'category') return !ALL_CATEGORIES.includes(parsed.category);
    return true;
  });

  if (isAmbiguousTransactionText(originalText)) {
    parsed.confidence = Math.min(parsed.confidence, 0.45);
  }

  return boostConfidenceForObviousTransaction(parsed, originalText);
}

/**
 * Fallback parser เมื่อ Gemini ล้มเหลว
 * พยายาม extract จำนวนเงินและ classify ด้วย keyword
 */
function fallbackParse(text) {
  const today = getToday();

  // ดึงจำนวนเงินจากข้อความ
  const amount = extractAmount(text);

  // ดึงชื่อรายการ (ตัดตัวเลขออก)
  const item = cleanTransactionItem(text);

  // แยกประเภท
  const type = classifyByKeyword(text);

  // จัดหมวด
  const category = categorizeByKeyword(text, type);

  // missing fields
  const missing_fields = [];
  if (amount === null) missing_fields.push('amount');
  if (item === null) missing_fields.push('item');

  return {
    item,
    amount,
    category,
    type,
    date: parseDateFromText(text) || today,
    confidence: isAmbiguousTransactionText(text) ? 0.35 : 0.88,
    missing_fields,
    reply_hint: 'ใช้ fallback parser',
  };
}

/**
 * อ่าน slip/รูปภาพจาก LINE แล้วส่งให้ Gemini Vision วิเคราะห์
 * @param {string} messageId - LINE message ID ของรูปภาพ
 * @param {string} lineAccessToken - LINE channel access token
 * @returns {object} parsed transaction data
 */
async function parseImageMessage(messageId, lineAccessToken) {
  const today = getToday();
  try {
    // ดาวน์โหลดรูปจาก LINE API
    const imageUrl = `https://api-data.line.me/v2/bot/message/${messageId}/content`;
    const imageRes = await axios.get(imageUrl, {
      headers: { Authorization: `Bearer ${lineAccessToken}` },
      responseType: 'arraybuffer',
    });

    const imageData = Buffer.from(imageRes.data).toString('base64');
    const mimeType = imageRes.headers['content-type'] || 'image/jpeg';

    // สร้าง prompt สำหรับ slip
    const systemPrompt = buildSystemPrompt(today, getYesterday());
    const imagePrompt = `${systemPrompt}

คุณกำลังดูรูปภาพ slip โอนเงิน หรือใบเสร็จ กรุณา:
1. อ่านยอดเงิน (amount) จากรูป
2. อ่านรายการ/วัตถุประสงค์ (item) ถ้าระบุไว้
3. อ่านวันที่ (date) จากรูป ถ้าไม่มีให้ใช้ ${today}
4. ประเมินว่าเป็นรายรับหรือรายจ่าย (ส่วนใหญ่ slip โอนออก = รายจ่าย)
5. เลือก category ที่เหมาะสม

ตอบเป็น JSON เท่านั้น ตาม schema ที่กำหนด`;

    const result = await model.generateContent({
      contents: [{
        role: 'user',
        parts: [
          { text: imagePrompt },
          { inlineData: { mimeType, data: imageData } },
        ],
      }],
    });

    const responseText = result.response.text();
    const parsed = JSON.parse(responseText);

    // sanitize เหมือน text message
    const sanitized = sanitizeResult(parsed, parsed.item || 'จากรูปภาพ');

    // ถ้าไม่มี item ให้ใช้ default
    if (!sanitized.item || sanitized.item.trim() === '') {
      sanitized.item = 'รายการจาก slip';
      sanitized.missing_fields = sanitized.missing_fields.filter(f => f !== 'item');
    }

    return sanitized;
  } catch (error) {
    console.error('❌ Gemini Vision Error:', error.message);
    return {
      item: 'รายการจากรูปภาพ',
      amount: null,
      category: 'อื่นๆ',
      type: 'รายจ่าย',
      date: today,
      confidence: 0.3,
      missing_fields: ['amount', 'item'],
      reply_hint: 'อ่านรูปไม่สำเร็จ',
    };
  }
}

module.exports = { parseExpenseMessage, parseImageMessage };
