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
function getCalendarKey(dateStr) { return String(dateStr || "").slice(0, 7); }
function round2(n) { return Math.round((Number(n) || 0) * 100) / 100; }

function rowsFromWorksheet(ws) {
  const cellAddresses = Object.keys(ws || {}).filter((key) => /^[A-Z]+[0-9]+$/.test(key));
  if (!cellAddresses.length) return [];
  const decoded = cellAddresses.map((addr) => ({ addr, cell: XLSX.utils.decode_cell(addr) }));
  const maxRow = Math.max(...decoded.map((x) => x.cell.r));
  const maxCol = Math.max(...decoded.map((x) => x.cell.c));
  const rows = Array.from({ length: maxRow + 1 }, () => Array(maxCol + 1).fill(""));
  for (const { addr, cell } of decoded) rows[cell.r][cell.c] = ws[addr]?.v ?? ws[addr]?.w ?? "";
  return rows;
}

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
  let cleaned = text.replace(/\s/g, "").replace(/€/g, "");
  const hasComma = cleaned.includes(",");
  const hasDot = cleaned.includes(".");
  if (hasComma && hasDot) {
    cleaned = cleaned.lastIndexOf(",") > cleaned.lastIndexOf(".") ? cleaned.replace(/\./g, "").replace(/,/g, ".") : cleaned.replace(/,/g, "");
  } else if (hasComma) {
    cleaned = cleaned.replace(/,/g, ".");
  }
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : 0;
}

function extractMetadata(rows) {
  const meta = {};
  for (const row of rows.slice(0, 12)) {
    const first = String(row?.[0] || "").trim();
    const t = normalizeText(first);
    if (t.startsWith("conto corrente") && !t.includes("intestazione conto corrente")) {
      const m = first.match(/conto corrente:\s*(.+)$/i);
      if (m) meta.accountNumber = m[1].trim();
    }
    if (t.includes("intestazione conto corrente")) {
      const m = first.match(/intestazione conto corrente:\s*(.+)$/i);
      if (m) meta.accountHolders = m[1].trim();
    }
    if (t.includes("periodo dal")) meta.period = first;
  }
  return meta;
}

const INVESTMENT_TERMS = [
  "dossier titoli", "conto titoli", "imposta bollo dossier", "dividendo", "dividendi", "riten dividendi", "ritenuta dividendo",
  "etf", "directa", "fineco trading", "portaf remunerato", "portafoglio remunerato", "interessi portaf", "ritenuta portaf",
  "acquisto titoli", "vendita titoli", "cedola", "cedole", "isin"
];
const INTERNAL_TERMS = [
  "conto condiviso", "conto comune", "conto cointestato", "revolut", "mediobanca", "directa", "trade republic", "fineco",
  "spese comuni", "investimenti", "investimento", "giroconto"
];
function classifyFinecoCashflow(desc, fullDesc, moneymap, amount, direction, ownTerms = []) {
  const text = normalizeText(`${desc} ${fullDesc} ${moneymap}`);
  if (!Number.isFinite(amount) || amount === 0) return { excludeFromCashflow: true, excludeReason: "zero_amount" };
  if (direction === "in") return { excludeFromCashflow: true, excludeReason: "income" };

  if (text.includes("utilizzo carta di credito") || text.includes("estratto conto") || text.includes("carta di credito di finecobank")) {
    return { excludeFromCashflow: true, excludeReason: "card_payment" };
  }
  if (text.includes("libretto postale")) return { excludeFromCashflow: true, excludeReason: "internal_transfer" };
  if ((text.includes("revolut") || text.includes("revolut bank") || text.includes("revolut ltd")) && (text.includes("bonifico") || text.includes("ricarica") || text.includes("top up") || text.includes("trasferimento") || text.includes("sepa"))) {
    return { excludeFromCashflow: true, excludeReason: "internal_transfer" };
  }
  if (INVESTMENT_TERMS.some((k) => text.includes(k))) return { excludeFromCashflow: true, excludeReason: "investment" };
  if ((text.includes("bonifico") || text.includes("giroconto")) && (INTERNAL_TERMS.some((k) => text.includes(k)) || ownTerms.some((k) => ` ${text} `.includes(` ${k} `)))) {
    return { excludeFromCashflow: true, excludeReason: "internal_transfer" };
  }
  return { excludeFromCashflow: false, excludeReason: "" };
}

const FINECO_ALIASES = {
  operationDate: ["data operazione", "data_operazione"],
  valueDate: ["data valuta", "data_valuta"],
  income: ["entrate"],
  outcome: ["uscite"],
  description: ["descrizione"],
  fullDescription: ["descrizione completa", "descrizione_completa"],
  status: ["stato"],
  moneymap: ["moneymap", "money map"]
};
function buildHeaderMap(headerRow) {
  const normalizedToIndex = new Map((headerRow || []).map((h, idx) => [normalizeText(h), idx]));
  const map = {};
  for (const [field, aliases] of Object.entries(FINECO_ALIASES)) {
    const found = aliases.map(normalizeText).map((a) => normalizedToIndex.get(a)).find((idx) => Number.isInteger(idx));
    if (Number.isInteger(found)) map[field] = found;
  }
  return map;
}
function get(row, map, field) { const idx = map?.[field]; return Number.isInteger(idx) ? row?.[idx] : ""; }

export function parseFinecoWorkbook(fileBuffer, options = {}) {
  const sourceFileName = options.sourceFileName || "";
  const startDate = options.startDate || "";
  const ownTerms = ownAccountTerms(options.members || []);
  const wb = XLSX.read(fileBuffer, { type: "array", cellDates: true });
  const transactions = [];
  const statementKeys = new Set();
  let rowsRead = 0, rowsInPeriod = 0, refundCount = 0, excludedCount = 0, parsedSheets = 0;
  const excludedBreakdown = { income: 0, internal_transfer: 0, card_payment: 0, investment: 0, zero_amount: 0, other: 0 };
  let accountInfo = null;

  for (const sheetName of wb.SheetNames) {
    const ws = wb.Sheets[sheetName];
    const rows = rowsFromWorksheet(ws);
    if (!rows.length) continue;
    const meta = extractMetadata(rows);
    const inferred = inferAccountOwnership(meta.accountHolders, options, "Fineco");
    accountInfo = accountInfo || { ...inferred, accountNumber: meta.accountNumber };
    const headerIndex = rows.findIndex((row) => {
      const normalized = (row || []).map((h) => normalizeText(h));
      return normalized.includes("data operazione") && normalized.includes("entrate") && normalized.includes("uscite") && normalized.includes("descrizione completa");
    });
    if (headerIndex < 0) continue;
    const map = buildHeaderMap(rows[headerIndex]);
    if (["operationDate", "description", "fullDescription", "income", "outcome"].some((k) => !Number.isInteger(map[k]))) continue;
    let sheetCount = 0;
    for (let i = headerIndex + 1; i < rows.length; i += 1) {
      const row = rows[i];
      const desc = String(get(row, map, "description") || "").trim();
      const fullDesc = String(get(row, map, "fullDescription") || "").trim();
      if (!desc && !fullDesc) continue;
      rowsRead += 1;
      const txDate = parseDateCell(get(row, map, "operationDate")) || parseDateCell(get(row, map, "valueDate"));
      if (!txDate) continue;
      const date = isoDate(txDate);
      if (startDate && date < startDate) continue;
      rowsInPeriod += 1;
      const income = Math.abs(parseAmount(get(row, map, "income")));
      const outcome = Math.abs(parseAmount(get(row, map, "outcome")));
      if (!income && !outcome) continue;
      const direction = outcome > 0 ? "out" : "in";
      const amount = direction === "out" ? outcome : -income;
      const moneymap = String(get(row, map, "moneymap") || "").trim();
      const exclusion = classifyFinecoCashflow(desc, fullDesc, moneymap, amount, direction, ownTerms);
      if (exclusion.excludeFromCashflow) {
        excludedCount += 1;
        const key = exclusion.excludeReason || "other";
        excludedBreakdown[key] = (excludedBreakdown[key] || 0) + 1;
      }
      const isRefund = amount < 0 && !exclusion.excludeFromCashflow;
      if (isRefund) refundCount += 1;
      const calendarKey = getCalendarKey(date);
      statementKeys.add(calendarKey);
      sheetCount += 1;
      const rowNumber = i + 1;
      const ref = `fineco:${meta.accountNumber || inferred.accountName}:${date}:${round2(amount)}:${desc}:${fullDesc}`;
      transactions.push({
        date,
        desc: fullDesc || desc,
        holder: inferred.holder,
        amount: round2(amount),
        calendarKey,
        statementKey: calendarKey,
        ref,
        paese: "",
        source: "fineco",
        accountName: inferred.accountName,
        accountScope: inferred.accountScope,
        personalFlag: inferred.personalFlag,
        split: inferred.split,
        sourceFileName,
        sourceSheet: sheetName,
        sourceRow: rowNumber,
        finecoType: desc,
        finecoMoneymap: moneymap,
        originalAmount: round2(direction === "out" ? -outcome : income),
        originalCurrency: "EUR",
        excludeFromCashflow: exclusion.excludeFromCashflow,
        excludeReason: exclusion.excludeReason,
        isRefund,
        rawData: {
          dataOperazione: get(row, map, "operationDate"),
          dataValuta: get(row, map, "valueDate"),
          entrate: get(row, map, "income"),
          uscite: get(row, map, "outcome"),
          descrizione: desc,
          descrizioneCompleta: fullDesc,
          stato: get(row, map, "status"),
          moneymap,
          accountHolders: meta.accountHolders,
          accountNumber: meta.accountNumber
        }
      });
    }
    if (sheetCount) parsedSheets += 1;
  }

  if (!transactions.length) throw new Error("Nessuna transazione Fineco valida trovata nel file");
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
      currencies: ["EUR"],
    }
  };
}
