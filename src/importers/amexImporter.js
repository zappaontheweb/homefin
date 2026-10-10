import * as XLSX from "xlsx";

function normalizeText(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9+& ]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function pad2(n) { return String(n).padStart(2, '0'); }
function isoDate(d) { return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`; }
function round2(n) { return Math.round((Number(n) || 0) * 100) / 100; }

function parseStatementRange(statementKey) {
  const match = String(statementKey || '').match(/^(\d{4})-(\d{2})-(\d{2})_(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return null;
  const [, sy, sm, sd, ey, em, ed] = match.map(String);
  const start = new Date(Number(sy), Number(sm) - 1, Number(sd));
  const end = new Date(Number(ey), Number(em) - 1, Number(ed));
  return { start, end };
}
function dateInRange(date, statementKey) {
  const range = parseStatementRange(statementKey);
  if (!date || !range) return false;
  const t = date.getTime();
  return t >= range.start.getTime() && t <= range.end.getTime();
}
function dateInStatementRangeWithTolerance(date, statementKey) {
  const range = parseStatementRange(statementKey);
  if (!date || !range) return false;
  const startWithTolerance = new Date(range.start);
  startWithTolerance.setDate(startWithTolerance.getDate() - 1);
  const t = date.getTime();
  return t >= startWithTolerance.getTime() && t <= range.end.getTime();
}
function chooseDateForStatement(candidates, statementKey) {
  const valid = (candidates || []).filter((d) => d instanceof Date && !Number.isNaN(d.getTime()));
  if (!valid.length) return null;
  const inRange = valid.find((d) => dateInRange(d, statementKey));
  return inRange || valid[0];
}
function strictDate(year, month, day) {
  const y = Number(year);
  const m = Number(month);
  const d = Number(day);
  if (!Number.isInteger(y) || !Number.isInteger(m) || !Number.isInteger(d)) return null;
  if (m < 1 || m > 12 || d < 1 || d > 31) return null;
  const date = new Date(y, m - 1, d);
  if (date.getFullYear() !== y || date.getMonth() !== m - 1 || date.getDate() !== d) return null;
  return date;
}
function parseDateCell(value, statementKey = '') {
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    const raw = value;
    const swapped = strictDate(raw.getFullYear(), raw.getDate(), raw.getMonth() + 1);
    return chooseDateForStatement([raw, swapped], statementKey);
  }
  if (typeof value === "number") {
    const parsed = XLSX.SSF.parse_date_code(value);
    if (parsed) {
      const raw = strictDate(parsed.y, parsed.m, parsed.d);
      const swapped = strictDate(parsed.y, parsed.d, parsed.m);
      return chooseDateForStatement([raw, swapped], statementKey);
    }
  }
  const text = String(value || "").trim();
  if (!text) return null;
  const match = text.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (match) {
    const [, a, b, yyyy] = match;
    const ddmm = strictDate(yyyy, b, a);
    const mmdd = strictDate(yyyy, a, b);
    return chooseDateForStatement([ddmm, mmdd], statementKey);
  }
  return null;
}

function getStatementPeriodKey(dateStr) {
  const d = new Date(dateStr);
  if (Number.isNaN(d.getTime())) return "";
  const y = d.getFullYear();
  const m = d.getMonth();
  const day = d.getDate();
  const end = day <= 20 ? new Date(y, m, 20) : new Date(y, m + 1, 20);
  const start = new Date(end.getFullYear(), end.getMonth() - 1, 21);
  return `${isoDate(start)}_${isoDate(end)}`;
}
function statementKeyRangeDays(statementKey) {
  const range = parseStatementRange(statementKey);
  if (!range) return Infinity;
  return Math.round((range.end.getTime() - range.start.getTime()) / 86400000) + 1;
}
function isPlausibleStatementKey(statementKey) {
  const days = statementKeyRangeDays(statementKey);
  return days >= 25 && days <= 35;
}
function safeStatementKeyForDate(date, candidateKey = '') {
  const computed = getStatementPeriodKey(isoDate(date));
  if (!candidateKey || !isPlausibleStatementKey(candidateKey) || !dateInStatementRangeWithTolerance(date, candidateKey)) return computed;
  return candidateKey;
}

function parseStatementKeyFromWorkbook(rows) {
  const headerText = [rows?.[0]?.[0], rows?.[0]?.[1], rows?.[1]?.[0], rows?.[1]?.[1]].filter(Boolean).join(' ');
  const clean = normalizeText(headerText)
    .replace(/,/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const match = clean.match(/(\d{1,2})\s+([a-zà-ÿ]{3,})\s+(\d{4})\s+[aà]\s+(\d{1,2})\s+([a-zà-ÿ]{3,})\s+(\d{4})/i);
  if (!match) return null;
  const monthIndex = (txt) => {
    const t = normalizeText(txt).slice(0, 3);
    const months = { jan:1, feb:2, mar:3, apr:4, may:5, mag:5, jun:6, giu:6, jul:7, lug:7, aug:8, ago:8, sep:9, set:9, oct:10, ott:10, nov:11, dec:12, dic:12 };
    return months[t] || null;
  };
  const startMonth = monthIndex(match[2]);
  const endMonth = monthIndex(match[5]);
  if (!startMonth || !endMonth) return null;
  return `${match[3]}-${pad2(startMonth)}-${pad2(Number(match[1]))}_${match[6]}-${pad2(endMonth)}-${pad2(Number(match[4]))}`;
}

function parseAmountCell(value) {
  if (typeof value === 'number') return value;
  const text = String(value || '').trim();
  if (!text) return 0;
  const normalized = text.replace(/\s/g, '').replace(/€/g, '').replace(/\./g, '').replace(',', '.');
  const n = Number(normalized);
  return Number.isFinite(n) ? n : 0;
}

function detectCashflowExclusion(desc) {
  const t = normalizeText(desc);
  if (t.includes('addebito in c c salvo buon fine')) return { excludeFromCashflow: true, excludeReason: 'card_payment' };
  if (t.includes('saldo') && (t.includes('carta') || t.includes('american express') || t.includes('amex'))) return { excludeFromCashflow: true, excludeReason: 'card_payment' };
  return { excludeFromCashflow: false, excludeReason: '' };
}

export function parseAmexMonthlyWorkbook(file) {
  const wb = XLSX.read(file, { type: 'array' });
  const transactions = [];
  const statementKeys = new Set();
  let refundCount = 0;
  let excludedCount = 0;
  let parsedSheets = 0;
  let rejectedCount = 0;
  const rejectedExamples = [];
  const rejectRow = (sheetName, rowNumber, reason, row) => {
    rejectedCount += 1;
    if (rejectedExamples.length < 5) {
      rejectedExamples.push({
        sheetName,
        rowNumber,
        reason,
        date: String(row?.[0] || '').trim(),
        desc: String(row?.[1] || '').trim(),
        amount: String(row?.[4] || '').trim()
      });
    }
  };

  for (const sheetName of wb.SheetNames) {
    const ws = wb.Sheets[sheetName];
    if (!ws) continue;
    const rows = XLSX.utils.sheet_to_json(ws, { header: 1, raw: true, defval: '' });
    const headerIndex = rows.findIndex((row) => String(row?.[0] || '').trim() === 'Data' && String(row?.[1] || '').trim() === 'Descrizione');
    if (headerIndex === -1) continue;
    const statementKeyFromFile = parseStatementKeyFromWorkbook(rows);
    const headers = rows[headerIndex].map((h) => String(h || '').trim());
    const idx = (name) => headers.findIndex((h) => normalizeText(h) === normalizeText(name));
    const dateIdx = idx('Data');
    const descIdx = idx('Descrizione');
    const holderIdx = idx('Titolare');
    const amountIdx = idx('Importo');
    const refIdx = idx('Riferimento');
    const paeseIdx = idx('Paese');
    if ([dateIdx, descIdx, holderIdx, amountIdx].some((i) => i === -1)) continue;

    let sheetTransactionCount = 0;
    for (const [offset, row] of rows.slice(headerIndex + 1).entries()) {
      const rowNumber = headerIndex + 2 + offset;
      const date = parseDateCell(row[dateIdx], statementKeyFromFile || '');
      const desc = String(row[descIdx] || '').trim();
      const holder = String(row[holderIdx] || '').trim();
      const amount = parseAmountCell(row[amountIdx]);
      if (!date) { rejectRow(sheetName, rowNumber, 'invalid_date', row); continue; }
      if (!desc) { rejectRow(sheetName, rowNumber, 'missing_description', row); continue; }
      if (!Number.isFinite(amount) || amount === 0) { rejectRow(sheetName, rowNumber, 'invalid_amount', row); continue; }
      const statementKey = safeStatementKeyForDate(date, statementKeyFromFile || '');
      statementKeys.add(statementKey);
      const exclusion = detectCashflowExclusion(desc);
      const isRefund = amount < 0 && !exclusion.excludeFromCashflow;
      if (isRefund) refundCount += 1;
      if (exclusion.excludeFromCashflow) excludedCount += 1;
      sheetTransactionCount += 1;
      transactions.push({
        date: isoDate(date),
        desc,
        holder,
        amount: round2(amount),
        statementKey,
        ref: refIdx >= 0 ? String(row[refIdx] || '').trim() : '',
        paese: paeseIdx >= 0 ? String(row[paeseIdx] || '').trim() : '',
        source: 'amex',
        sourceSheet: sheetName,
        isRefund,
        excludeFromCashflow: exclusion.excludeFromCashflow,
        excludeReason: exclusion.excludeReason,
        importedAt: new Date().toISOString()
      });
    }
    if (sheetTransactionCount) parsedSheets += 1;
  }

  if (!transactions.length) throw new Error('Nessuna transazione valida trovata nel file');
  return { transactions, statementKeys: [...statementKeys], stats: { refundCount, excludedCount, parsedSheets, rejectedCount, rejectedExamples } };
}
