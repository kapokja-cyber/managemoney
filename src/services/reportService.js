const { google } = require('googleapis');
const ExcelJS = require('exceljs');

const FOLDER_ID = '1xiNoy0UKKZ35wPbTfvnj4_ax4Bw2l4ua';

const MONTHS_TH = [
  '', 'มกราคม', 'กุมภาพันธ์', 'มีนาคม', 'เมษายน', 'พฤษภาคม', 'มิถุนายน',
  'กรกฎาคม', 'สิงหาคม', 'กันยายน', 'ตุลาคม', 'พฤศจิกายน', 'ธันวาคม',
];

function getAuthClient() {
  const credentials = JSON.parse(process.env.GOOGLE_CREDENTIALS);
  const auth = new google.auth.JWT(
    credentials.client_email,
    null,
    credentials.private_key,
    ['https://www.googleapis.com/auth/drive']
  );
  return auth;
}

async function generateExcelReport(rows, month, year) {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('รายรับรายจ่าย');

  sheet.columns = [
    { header: 'วันที่', key: 'date', width: 15 },
    { header: 'รายการ', key: 'item', width: 25 },
    { header: 'หมวด', key: 'category', width: 18 },
    { header: 'ประเภท', key: 'type', width: 12 },
    { header: 'จำนวนเงิน (บาท)', key: 'amount', width: 18 },
  ];

  sheet.getRow(1).eachCell((cell) => {
    cell.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF2196F3' } };
    cell.alignment = { horizontal: 'center' };
  });

  let totalIncome = 0;
  let totalExpense = 0;

  rows.forEach((row) => {
    const amount = parseFloat(row.amount);
    if (row.type === 'รายรับ') totalIncome += amount;
    else totalExpense += amount;

    const addedRow = sheet.addRow({
      date: row.date,
      item: row.item,
      category: row.category,
      type: row.type,
      amount: amount,
    });

    addedRow.getCell('amount').font = {
      color: { argb: row.type === 'รายรับ' ? 'FF2E7D32' : 'FFC62828' },
      bold: true,
    };
  });

  sheet.addRow({});
  const incomeRow = sheet.addRow({ item: 'รวมรายรับ', amount: totalIncome });
  incomeRow.getCell('amount').font = { bold: true, color: { argb: 'FF2E7D32' } };
  incomeRow.getCell('item').font = { bold: true };

  const expenseRow = sheet.addRow({ item: 'รวมรายจ่าย', amount: totalExpense });
  expenseRow.getCell('amount').font = { bold: true, color: { argb: 'FFC62828' } };
  expenseRow.getCell('item').font = { bold: true };

  const balanceRow = sheet.addRow({ item: 'คงเหลือ', amount: totalIncome - totalExpense });
  balanceRow.getCell('amount').font = { bold: true };
  balanceRow.getCell('item').font = { bold: true };

  return workbook.xlsx.writeBuffer();
}

async function uploadToDrive(buffer, month, year) {
  const auth = getAuthClient();
  const drive = google.drive({ version: 'v3', auth });

  const filename = `รายรับรายจ่าย-${MONTHS_TH[month]}-${year + 543}.xlsx`;
  const { PassThrough } = require('stream');
  const stream = new PassThrough();
  stream.end(Buffer.from(buffer));

  const response = await drive.files.create({
    supportsAllDrives: true,
    requestBody: {
      name: filename,
      parents: [FOLDER_ID],
      mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    },
    media: {
      mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      body: stream,
    },
    fields: 'id, webViewLink',
  });

  // ตั้งค่าให้ทุกคนที่มี link เปิดได้
  await drive.permissions.create({
    supportsAllDrives: true,
    fileId: response.data.id,
    requestBody: {
      role: 'reader',
      type: 'anyone',
    },
  });

  return {
    fileId: response.data.id,
    link: `https://drive.google.com/file/d/${response.data.id}/view`,
    filename,
  };
}

module.exports = { generateExcelReport, uploadToDrive };
