const ExcelJS = require('exceljs');

const MONTHS_TH = [
  '', 'มกราคม', 'กุมภาพันธ์', 'มีนาคม', 'เมษายน', 'พฤษภาคม', 'มิถุนายน',
  'กรกฎาคม', 'สิงหาคม', 'กันยายน', 'ตุลาคม', 'พฤศจิกายน', 'ธันวาคม',
];

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

module.exports = { generateExcelReport, MONTHS_TH };
