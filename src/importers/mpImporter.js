import * as XLSX from "xlsx";
import { inferAccountOwnership, ownAccountTerms } from "./householdMatch.js";

function normalizeText(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9+&. ]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}
function pad2(n) { return String(n).padStart(2, "0"); }
function isoDate(d) { return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`; }
function round2(n) { return Math.round((Number(n) || 0) * 100) / 100; }

function ensureWorksheetRange(ws) {
  if (!ws) return;
  const cellAddresses = Object.keys(ws).filter((key) => /^[A-Z]+[0-9]+$/.test(key));
  if (!cellAddresses.length) return;
  const decoded = cellAddresses.map((addr) => XLSX.utils.decode_cell(addr));
  const range = decoded.reduce((acc, cell) => ({
    s: { c: Math.min(acc.s.c, cell.c), r: Math.min(acc.s.r, cell.r) },
    e: { c: Math.max(acc.e.c, cell.c), r: Math.max(acc.e.r, cell.r) }
  }), { s: { c: decoded[0].c, r: decoded[0].r }, e: { c: decoded[0].c, r: decoded[0].r } });
  ws['!ref'] = XLSX.utils.encode_range(range);
}

function rowsFromWorksheet(ws) {
  // MP exports sometimes declare a partial Excel range (for example B1:G94)
  // and SheetJS may shift columns differently depending on the workbook.
  // Build rows directly from cell addresses so B:G exports and A:G exports parse identically.
  const cellAddresses = Object.keys(ws || {}).filter((key) => /^[A-Z]+[0-9]+$/.test(key));
  if (!cellAddresses.length) return [];
  const decoded = cellAddresses.map((addr) => ({ addr, cell: XLSX.utils.decode_cell(addr) }));
  const maxRow = Math.max(...decoded.map((x) => x.cell.r));
  const maxCol = Math.max(...decoded.map((x) => x.cell.c));
  const rows = Array.from({ length: maxRow + 1 }, () => Array(maxCol + 1).fill(""));
  for (const { addr, cell } of decoded) {
    const value = ws[addr]?.v ?? ws[addr]?.w ?? "";
    rows[cell.r][cell.c] = value;
  }
  return rows;
}
function getCalendarKey(dateStr) { return String(dateStr || "").slice(0, 7); }

function parseDateCell(value) {
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value;
  if (typeof value === "number") {
    const parsed = XLSX.SSF.parse_date_code(value);
    if (parsed) return new Date(parsed.y, parsed.m - 1, parsed.d);
  }
  const text = String(value || "").trim();
  if (!text) return null;
  let m = text.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (m) return new Date(Number(m[3]), Number(m[2]) - 1, Number(m[1]));
  m = text.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (m) return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return null;
}

function parseAmount(value) {
  if (typeof value === "number") return value;
  const text = String(value || "").trim();
  if (!text) return 0;
  const normalized = text.replace(/\s/g, "").replace(/€/g, "").replace(/\./g, "").replace(",", ".");
  const n = Number(normalized);
  return Number.isFinite(n) ? n : 0;
}

function detectMpCashflowExclusion(desc, amount, direction, ownTerms = []) {
  const t = normalizeText(desc);
  if (!Number.isFinite(amount) || amount === 0) return { excludeFromCashflow: true, excludeReason: "zero_amount" };
  if (direction === "in") return { excludeFromCashflow: true, excludeReason: "income" };

  const isInvestment = [
    "dossier titoli", "conto titoli", "titoli n", "imposte tasse dossier", "imposte tasse conto titoli",
    "acquisto titoli", "vendita titoli", "sottoscrizione", "rimborso titolo", "rimborso fondo",
    "cedole", "dividendi", "btp", "etf", "ishares", "xtrackers", "dbx", "operazione titoli", "gestione patrimoniale"
  ].some((k) => t.includes(k));
  if (isInvestment) return { excludeFromCashflow: true, excludeReason: "investment" };

  const isCardPayment = t.includes("american express") || t.includes("amex") || t.includes("addebito carta") || t.includes("carta di credito");
  if (isCardPayment) return { excludeFromCashflow: true, excludeReason: "card_payment" };

  const isInternalDestination = [
    "revolut", "directa", "trade republic", "fineco", "mediobanca", "spostamento fondi", "giroconto"
  ].some((k) => t.includes(k)) || ((t.includes("bonifico") || t.includes("giroconto")) && ownTerms.some((k) => ` ${t} `.includes(` ${k} `)));
  if (isInternalDestination) return { excludeFromCashflow: true, excludeReason: "internal_transfer" };

  return { excludeFromCashflow: false, excludeReason: "" };
}

function extractMetadata(rows) {
  const meta = {};
  for (const row of rows.slice(0, 14)) {
    const cells = Array.isArray(row) ? row : [];
    for (let idx = 0; idx < cells.length; idx += 1) {
      const key = normalizeText(cells[idx] || "");
      if (!key) continue;
      const value = String(cells.slice(idx + 1).find((v) => String(v || "").trim()) || "").trim();
      if (key.includes("rapporto")) meta.accountNumber = value;
      if (key.includes("iban")) meta.iban = value;
      if (key.includes("intestatari")) meta.intestatari = value;
      if (key.includes("divisa")) meta.currency = value;
    }
  }
  return meta;
}

export function parseMpWorkbook(fileBuffer, options = {}) {
  const sourceFileName = options.sourceFileName || "";
  const startDate = options.startDate || "";
  const ownTerms = ownAccountTerms(options.members || []);
  const isCsv = String(sourceFileName).toLowerCase().endsWith(".csv");
  const readOpts = { type: "array", cellDates: true };
  if (isCsv) {
    readOpts.raw = true;
  }
  const wb = XLSX.read(fileBuffer, readOpts);
  const transactions = [];
  const statementKeys = new Set();
  let rowsRead = 0;
  let rowsInPeriod = 0;
  let refundCount = 0;
  let excludedCount = 0;
  const excludedBreakdown = { income: 0, internal_transfer: 0, card_payment: 0, investment: 0, zero_amount: 0, other: 0 };
  let parsedSheets = 0;
  let accountInfo = null;

  for (const sheetName of wb.SheetNames) {
    const ws = wb.Sheets[sheetName];
    if (!ws) continue;
    ensureWorksheetRange(ws);
    const rows = rowsFromWorksheet(ws);
    const meta = extractMetadata(rows);
    const inferred = inferAccountOwnership(meta.intestatari, options, "MP");
    accountInfo = accountInfo || { ...inferred, iban: meta.iban, accountNumber: meta.accountNumber };
    const headerIndex = rows.findIndex((row) => {
      const normalizedRow = (Array.isArray(row) ? row : []).map((h) => normalizeText(h));
      return normalizedRow.includes("data contabile") && normalizedRow.includes("tipologia");
    });
    if (headerIndex === -1) continue;
    const headers = rows[headerIndex].map((h) => normalizeText(h));
    const findIdx = (label) => headers.findIndex((h) => h === normalizeText(label));
    const accountingDateIdx = findIdx("Data contabile");
    const valueDateIdx = findIdx("Data valuta");
    const descIdx = findIdx("Tipologia");
    const incomeIdx = findIdx("Entrate");
    const outIdx = findIdx("Uscite");
    const currencyIdx = findIdx("Divisa");
    if ([valueDateIdx, descIdx, incomeIdx, outIdx].some((idx) => idx < 0)) continue;

    let sheetCount = 0;
    for (let i = headerIndex + 1; i < rows.length; i += 1) {
      const row = rows[i];
      const desc = String(row?.[descIdx] || "").trim();
      if (!desc) continue;
      rowsRead += 1;
      const txDate = parseDateCell(row?.[accountingDateIdx]) || parseDateCell(row?.[valueDateIdx]);
      if (!txDate) continue;
      const date = isoDate(txDate);
      if (startDate && date < startDate) continue;
      rowsInPeriod += 1;
      const income = Math.abs(parseAmount(row?.[incomeIdx]));
      const outgoing = Math.abs(parseAmount(row?.[outIdx]));
      if (!income && !outgoing) continue;
      const direction = outgoing > 0 ? "out" : "in";
      const amount = direction === "out" ? outgoing : -income;
      const currency = String(row?.[currencyIdx] || meta.currency || "EUR").trim().toUpperCase() || "EUR";
      const exclusion = detectMpCashflowExclusion(desc, amount, direction, ownTerms);
      if (exclusion.excludeFromCashflow) {
        excludedCount += 1;
        const key = exclusion.excludeReason || "other";
        excludedBreakdown[key] = (excludedBreakdown[key] || 0) + 1;
      }
      const isRefund = amount < 0 && !exclusion.excludeFromCashflow;
      if (isRefund) refundCount += 1;
      const rowNumber = i + 1;
      const ref = `mp:${meta.iban || meta.accountNumber || inferred.accountName}:${date}:${round2(amount)}:${desc}`;
      const calendarKey = getCalendarKey(date);
      statementKeys.add(calendarKey);
      sheetCount += 1;
      transactions.push({
        date,
        desc,
        holder: inferred.holder,
        amount: round2(amount),
        calendarKey,
        statementKey: calendarKey,
        ref,
        paese: "",
        source: "mp",
        accountName: inferred.accountName,
        accountScope: inferred.accountScope,
        personalFlag: inferred.personalFlag,
        split: inferred.split,
        sourceFileName,
        sourceSheet: sheetName,
        sourceRow: rowNumber,
        mpType: desc.split(" - ")[0] || desc,
        originalAmount: round2(direction === "out" ? -outgoing : income),
        originalCurrency: currency,
        excludeFromCashflow: exclusion.excludeFromCashflow,
        excludeReason: exclusion.excludeReason,
        isRefund,
        rawData: {
          dataContabile: accountingDateIdx >= 0 ? row?.[accountingDateIdx] : "",
          dataValuta: row?.[valueDateIdx],
          tipologia: desc,
          entrate: row?.[incomeIdx],
          uscite: row?.[outIdx],
          divisa: currency,
          intestatari: meta.intestatari,
          iban: meta.iban,
          rapporto: meta.accountNumber
        }
      });
    }
    if (sheetCount) parsedSheets += 1;
  }

  if (!transactions.length) throw new Error("Nessuna transazione MP valida trovata nel file");
  return {
    transactions,
    statementKeys: [...statementKeys],
    accountInfo,
    stats: {
      parsedSheets,
      rowsRead,
      rowsInPeriod,
      refundCount,
      excludedCount,
      excludedBreakdown,
      financialExcludedCount: Object.values(excludedBreakdown).reduce((sum, n) => sum + Number(n || 0), 0),
      currencies: [...new Set(transactions.map((tx) => tx.originalCurrency || "EUR"))].sort(),
    }
  };
}
