const { parseExpenseMessage } = require('../services/geminiService');
const { appendTransaction, getTransactions } = require('../services/transactionService');
const { generateExcelReport, MONTHS_TH } = require('../services/reportService');
const {
  GENERAL_RESPONSES,
  generateConfirmQuickReply,
  generateFlexSummary,
  generateMissingFieldReply,
  generateTransactionFlex,
  isAnalysisRequest,
  isGreeting,
  isHelpRequest,
  parseSummaryPeriod,
} = require('../messages');
const { shouldAutoSaveTransaction } = require('../utils/transactionRules');
const { clearPending, getPending, setPending } = require('../state/pendingConfirmations');

const CONFIRM_YES = ['ใช่', 'yes', 'ใช่ครับ', 'ใช่ค่ะ', 'ตกลง', 'ok', 'โอเค', 'ได้', 'บันทึก', 'ถูก', 'ถูกต้อง', '✅', '👍'];
const CONFIRM_NO = ['ไม่', 'no', 'ไม่ใช่', 'ไม่ถูก', 'ผิด', 'ยกเลิก', 'cancel', '❌', '👎'];
const REPORT_KEYWORDS = ['ส่ง report', 'ส่งreport', 'report', 'รายงาน', 'ส่งรายงาน'];

// เก็บ buffer ชั่วคราวใน memory
const reportCache = new Map();

async function handleTextMessage(userId, userMessage) {
  const pendingReply = await handlePendingConfirmation(userId, userMessage);
  if (pendingReply) return pendingReply;

  if (isGreeting(userMessage)) return GENERAL_RESPONSES.greeting;
  if (isHelpRequest(userMessage)) return GENERAL_RESPONSES.help;

  const normalizedMsg = userMessage.toLowerCase().trim();
  if (REPORT_KEYWORDS.some((kw) => normalizedMsg.includes(kw.toLowerCase()))) {
    return buildReportReply(userId);
  }

  if (isAnalysisRequest(userMessage)) return buildSummaryReply(userId, userMessage);
  if (userMessage.length < 2) return GENERAL_RESPONSES.help;

  try {
    console.log(`📩 [${userId || 'unknown'}] "${userMessage}"`);
    const parsed = await parseExpenseMessage(userMessage);
    console.log('🤖 Gemini:', JSON.stringify(parsed));

    if (parsed.missing_fields && parsed.missing_fields.length > 0) {
      return generateMissingFieldReply(parsed.missing_fields, parsed);
    }

    const transactionData = toTransactionData(parsed);
    if (shouldAutoSaveTransaction(parsed, userMessage)) {
      return saveAndBuildReply(transactionData, userId);
    }

    if (userId) setPending(userId, transactionData);
    return generateConfirmQuickReply(transactionData);
  } catch (error) {
    console.error('❌ Error handling message:', error);
    return GENERAL_RESPONSES.error;
  }
}

async function buildReportReply(userId) {
  try {
    const now = new Date();
    const month = now.getMonth() + 1;
    const year = now.getFullYear();
    const dateFrom = `${year}-${String(month).padStart(2, '0')}-01`;
    const lastDay = new Date(year, month, 0).getDate();
    const dateTo = `${year}-${String(month).padStart(2, '0')}-${lastDay}`;

    console.log(`📊 สร้าง report ${dateFrom} → ${dateTo}`);
    const rows = await getTransactions(userId, dateFrom, dateTo);

    if (!rows || rows.length === 0) {
      return 'ไม่มีข้อมูลในเดือนนี้ครับ ลองบันทึกรายการก่อนนะครับ 😊';
    }

    const buffer = await generateExcelReport(rows, month, year);
    const filename = `report-${year}-${String(month).padStart(2, '0')}.xlsx`;

    // เก็บ buffer ใน cache พร้อม key
    const cacheKey = `${userId}-${Date.now()}`;
    reportCache.set(cacheKey, { buffer, filename });

    // ลบ cache เก่าหลัง 10 นาที
    setTimeout(() => reportCache.delete(cacheKey), 10 * 60 * 1000);

    const BASE_URL = process.env.RENDER_EXTERNAL_URL || 'https://managemoney-lq85.onrender.com';
    const downloadUrl = `${BASE_URL}/download-report/${cacheKey}`;

    const totalIncome = rows.filter(r => r.type === 'รายรับ').reduce((s, r) => s + parseFloat(r.amount), 0);
    const totalExpense = rows.filter(r => r.type === 'รายจ่าย').reduce((s, r) => s + parseFloat(r.amount), 0);

    return {
      type: 'flex',
      altText: `รายงานเดือน${MONTHS_TH[month]} พร้อมแล้วครับ`,
      contents: {
        type: 'bubble',
        header: {
          type: 'box',
          layout: 'vertical',
          contents: [{
            type: 'text',
            text: `📊 รายงานเดือน${MONTHS_TH[month]} ${year + 543}`,
            weight: 'bold',
            color: '#FFFFFF',
            size: 'md',
          }],
          backgroundColor: '#2196F3',
          paddingAll: '15px',
        },
        body: {
          type: 'box',
          layout: 'vertical',
          contents: [
            { type: 'text', text: `รายรับรวม: ${totalIncome.toLocaleString()} บาท`, color: '#2E7D32', weight: 'bold', size: 'sm' },
            { type: 'text', text: `รายจ่ายรวม: ${totalExpense.toLocaleString()} บาท`, color: '#C62828', weight: 'bold', size: 'sm', margin: 'sm' },
            { type: 'text', text: `คงเหลือ: ${(totalIncome - totalExpense).toLocaleString()} บาท`, weight: 'bold', size: 'sm', margin: 'sm' },
            { type: 'text', text: `จำนวน ${rows.length} รายการ`, color: '#888888', size: 'xs', margin: 'md' },
          ],
          paddingAll: '15px',
        },
        footer: {
          type: 'box',
          layout: 'vertical',
          contents: [{
            type: 'button',
            action: { type: 'uri', label: '📥 ดาวน์โหลด Excel', uri: downloadUrl },
            style: 'primary',
            color: '#2196F3',
          }],
          paddingAll: '10px',
        },
      },
    };
  } catch (error) {
    console.error('❌ Report error:', error);
    return 'เกิดข้อผิดพลาดในการสร้างรายงานครับ กรุณาลองใหม่อีกครั้ง';
  }
}

async function handlePendingConfirmation(userId, userMessage) {
  if (!userId) return null;
  const pendingData = getPending(userId);
  if (!pendingData) return null;
  const normalizedMessage = userMessage.toLowerCase().trim();
  if (CONFIRM_YES.some((word) => normalizedMessage === word)) {
    clearPending(userId);
    return saveAndBuildReply(pendingData, userId);
  }
  if (CONFIRM_NO.some((word) => normalizedMessage === word)) {
    clearPending(userId);
    return 'ยกเลิกแล้วครับ ถ้าจะบันทึกใหม่ พิมพ์รายการมาได้เลย';
  }
  clearPending(userId);
  return null;
}

async function buildSummaryReply(userId, userMessage) {
  try {
    const { dateFrom, dateTo, label } = parseSummaryPeriod(userMessage);
    const rows = await getTransactions(userId, dateFrom, dateTo);
    if (rows === null) return GENERAL_RESPONSES.error;
    return generateFlexSummary(rows, label) || GENERAL_RESPONSES.noData;
  } catch (error) {
    console.error('❌ Analysis error:', error);
    return GENERAL_RESPONSES.error;
  }
}

async function saveAndBuildReply(transactionData, userId) {
  const result = await appendTransaction(transactionData, userId);
  if (result.success) return generateTransactionFlex(transactionData);
  console.error('❌ บันทึกไม่สำเร็จ:', result.error);
  return GENERAL_RESPONSES.error;
}

function toTransactionData(parsed) {
 const now = new Date();
const pad = n => String(n).padStart(2, '0');
const thailandTime = new Date(now.getTime() + 7 * 60 * 60 * 1000);
const timeStr = `${pad(thailandTime.getUTCHours())}:${pad(thailandTime.getUTCMinutes())}`;
  return {
    item: parsed.item,
    amount: parsed.amount,
    category: parsed.category,
    type: parsed.type,
    date: parsed.date,
    time: timeStr,
  };
}
module.exports = {
  handleTextMessage,
};
