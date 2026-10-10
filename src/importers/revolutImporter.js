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

function pad2(n) { return String(n).padStart(2, "0"); }
function isoDateFromText(value) {
  const text = String(value || "").trim();
  if (!text) return "";
  const d = new Date(text.replace(" ", "T"));
  if (Number.isNaN(d.getTime())) return text.slice(0, 10);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}
function round2(n) { return Math.round((Number(n) || 0) * 100) / 100; }
function parseNumber(value) {
  if (typeof value === "number") return value;
  const text = String(value || "").trim();
  if (!text) return 0;
  // Revolut exports may use either 1,234.56 or 1.234,56 depending on locale.
  let cleaned = text.replace(/\s/g, "");
  const hasComma = cleaned.includes(",");
  const hasDot = cleaned.includes(".");
  if (hasComma && hasDot) {
    const lastComma = cleaned.lastIndexOf(",");
    const lastDot = cleaned.lastIndexOf(".");
    cleaned = lastComma > lastDot ? cleaned.replace(/\./g, "").replace(/,/g, ".") : cleaned.replace(/,/g, "");
  } else if (hasComma && !hasDot) {
    cleaned = cleaned.replace(/,/g, ".");
  } else {
    cleaned = cleaned.replace(/,/g, "");
  }
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : 0;
}
function getStatementPeriodKey(dateStr) {
  const d = new Date(dateStr);
  if (Number.isNaN(d.getTime())) return "";
  const y = d.getFullYear();
  const m = d.getMonth();
  const day = d.getDate();
  const end = day <= 20 ? new Date(y, m, 20) : new Date(y, m + 1, 20);
  const start = new Date(end.getFullYear(), end.getMonth() - 1, 21);
  return `${start.getFullYear()}-${pad2(start.getMonth() + 1)}-${pad2(start.getDate())}_${end.getFullYear()}-${pad2(end.getMonth() + 1)}-${pad2(end.getDate())}`;
}

function parseCsv(text) {
  const wb = XLSX.read(text, { type: "string", raw: true });
  const ws = wb.Sheets[wb.SheetNames[0]];
  return XLSX.utils.sheet_to_json(ws, { defval: "", raw: false });
}

const REVOLUT_ALIASES = {
  type: ["type", "tipo"],
  product: ["product", "prodotto"],
  startedDate: ["started date", "data di inizio"],
  completedDate: ["completed date", "data di completamento"],
  description: ["description", "descrizione"],
  amount: ["amount", "importo"],
  fee: ["fee", "commissione", "costo"],
  currency: ["currency", "valuta"],
  state: ["state", "stato"],
  balance: ["balance", "saldo"]
};

function buildHeaderMap(row) {
  const keys = Object.keys(row || {});
  const normalizedToOriginal = new Map(keys.map((k) => [normalizeText(k), k]));
  const map = {};
  for (const [field, aliases] of Object.entries(REVOLUT_ALIASES)) {
    const found = aliases.map(normalizeText).map((a) => normalizedToOriginal.get(a)).find(Boolean);
    if (found) map[field] = found;
  }
  return map;
}

function getField(row, headerMap, field) {
  const key = headerMap?.[field];
  return key ? row[key] : "";
}

function isRevolutRows(rows) {
  if (!rows?.length) return false;
  const map = buildHeaderMap(rows[0] || {});
  return ["type", "product", "startedDate", "completedDate", "description", "amount", "fee", "currency", "state", "balance"].every((k) => !!map[k]);
}

function isCompletedState(value) {
  const state = normalizeText(value);
  return ["completed", "completato", "complete", "settled"].includes(state);
}

function classifyRevolutCashflow(type, description, netOriginal) {
  const t = normalizeText(type);
  const d = normalizeText(description);
  if (t.includes("exchange") || t.includes("cambio")) return { excludeFromCashflow: true, excludeReason: "exchange" };
  if (t.includes("deposit") || t.includes("deposito") || t.includes("ricarica") || t.includes("topup") || t.includes("top up")) return { excludeFromCashflow: true, excludeReason: "deposit" };
  if (t.includes("transfer") || t.includes("trasferimento") || t.includes("bonifico")) return { excludeFromCashflow: true, excludeReason: "transfer" };
  if (t.includes("interest") || t.includes("interesse") || t.includes("interessi")) return { excludeFromCashflow: true, excludeReason: "interest" };
  if (d.includes("conto deposito") || d.includes("pocket ")) return { excludeFromCashflow: true, excludeReason: "transfer" };
  if (Number(netOriginal) === 0) return { excludeFromCashflow: true, excludeReason: "zero_amount" };
  return { excludeFromCashflow: false, excludeReason: "" };
}

async function fetchFxTable(dates, currencies) {
  const nonEur = [...new Set(currencies.filter((c) => c && c !== "EUR"))];
  if (!nonEur.length) return { ratesByDate: {}, convertedWithApi: false };
  const sortedDates = [...new Set(dates.filter(Boolean))].sort();
  if (!sortedDates.length) return { ratesByDate: {}, convertedWithApi: false };
  const start = sortedDates[0];
  const end = sortedDates[sortedDates.length - 1];
  const url = `https://api.frankfurter.dev/v1/${start}..${end}?from=EUR&to=${encodeURIComponent(nonEur.join(","))}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`FX rates unavailable (${res.status})`);
  const json = await res.json();
  return { ratesByDate: json?.rates || {}, convertedWithApi: true };
}

function findRate(ratesByDate, date, currency) {
  if (currency === "EUR") return { rate: 1, date, fallback: false };
  let cursor = new Date(date);
  if (Number.isNaN(cursor.getTime())) return { rate: null, date: "", fallback: false };
  for (let i = 0; i < 10; i += 1) {
    const key = `${cursor.getFullYear()}-${pad2(cursor.getMonth() + 1)}-${pad2(cursor.getDate())}`;
    const rate = ratesByDate?.[key]?.[currency];
    if (Number.isFinite(Number(rate))) return { rate: Number(rate), date: key, fallback: key !== date };
    cursor.setDate(cursor.getDate() - 1);
  }
  return { rate: null, date: "", fallback: false };
}

export async function parseRevolutCsvFiles(files, options = {}) {
  const fileList = Array.from(files || []);
  const startDate = options.startDate || "";
  const account = options.account || {};
  const accountName = account.accountName || "Revolut";
  const accountScope = account.accountScope || "";
  const holder = account.holder || "";
  const personalFlag = account.personalFlag || (accountScope === "shared" ? "comune" : "personale");
  const split = accountScope === "shared" ? "household" : null;
  const rowsWithFile = [];
  for (const file of fileList) {
    const text = await file.text();
    const rows = parseCsv(text);
    if (!isRevolutRows(rows)) {
      const headers = Object.keys(rows?.[0] || {}).join(", ");
      throw new Error(`${file.name}: formato Revolut non riconosciuto. Colonne trovate: ${headers || "nessuna"}`);
    }
    const headerMap = buildHeaderMap(rows[0] || {});
    rows.forEach((row, rowIndex) => rowsWithFile.push({ row, rowIndex, fileName: file.name, headerMap }));
  }

  const eligible = rowsWithFile.map(({ row, rowIndex, fileName, headerMap }) => {
    const date = isoDateFromText(getField(row, headerMap, "completedDate") || getField(row, headerMap, "startedDate"));
    const startedDate = String(getField(row, headerMap, "startedDate") || "").trim();
    const completedDate = String(getField(row, headerMap, "completedDate") || "").trim();
    const originalAmount = parseNumber(getField(row, headerMap, "amount"));
    const feeOriginal = parseNumber(getField(row, headerMap, "fee"));
    const netOriginal = originalAmount - feeOriginal;
    const currency = String(getField(row, headerMap, "currency") || "EUR").trim().toUpperCase() || "EUR";
    const state = getField(row, headerMap, "state");
    const type = String(getField(row, headerMap, "type") || "").trim();
    const product = String(getField(row, headerMap, "product") || "").trim();
    const description = String(getField(row, headerMap, "description") || "").trim();
    return { row, rowIndex, fileName, headerMap, date, startedDate, completedDate, originalAmount, feeOriginal, netOriginal, currency, state, type, product, description };
  }).filter((x) => x.date && (!startDate || x.date >= startDate) && isCompletedState(x.state) && Number.isFinite(x.netOriginal) && x.netOriginal !== 0);

  const { ratesByDate, convertedWithApi } = await fetchFxTable(eligible.map((x) => x.date), eligible.map((x) => x.currency));
  const transactions = [];
  let refundCount = 0;
  let excludedCount = 0;
  let fxConvertedCount = 0;
  let fxFallbackCount = 0;
  const excludedBreakdown = { deposit: 0, transfer: 0, exchange: 0, interest: 0, zero_amount: 0, other: 0 };

  for (const item of eligible) {
    const { row, rowIndex, fileName, date, startedDate, completedDate, originalAmount, feeOriginal, netOriginal, currency, type, product, description } = item;
    const rateInfo = findRate(ratesByDate, date, currency);
    if (!rateInfo.rate) throw new Error(`Tasso FX mancante per ${currency} il ${date}`);
    if (currency !== "EUR") fxConvertedCount += 1;
    if (rateInfo.fallback) fxFallbackCount += 1;
    // The app uses positive numbers for expenses and negative numbers for credits/refunds.
    const eurAmount = currency === "EUR" ? -netOriginal : -(netOriginal / rateInfo.rate);
    const desc = String(description || "").trim();
    const exclusion = classifyRevolutCashflow(type, desc, netOriginal);
    const isRefund = eurAmount < 0 && !exclusion.excludeFromCashflow;
    if (isRefund) refundCount += 1;
    if (exclusion.excludeFromCashflow) {
      excludedCount += 1;
      const key = exclusion.excludeReason || "other";
      excludedBreakdown[key] = (excludedBreakdown[key] || 0) + 1;
    }
    const ref = `revolut:${currency}:${startedDate}:${completedDate}:${type}:${netOriginal}:${desc}`;
    transactions.push({
      date,
      desc,
      holder,
      accountScope,
      personalFlag,
      split,
      amount: round2(eurAmount),
      statementKey: getStatementPeriodKey(date),
      ref,
      paese: "",
      source: "revolut",
      accountName,
      sourceFileName: fileName,
      sourceRow: rowIndex + 2,
      revolutType: type,
      revolutProduct: product,
      originalAmount,
      feeOriginal,
      netOriginal,
      originalCurrency: currency,
      fxBaseCurrency: "EUR",
      fxRate: currency === "EUR" ? 1 : rateInfo.rate,
      fxRateDate: rateInfo.date,
      fxRateFallback: rateInfo.fallback,
      isRefund,
      excludeFromCashflow: exclusion.excludeFromCashflow,
      excludeReason: exclusion.excludeReason,
      rawData: row
    });
  }

  return {
    transactions,
    stats: {
      filesRead: fileList.length,
      rowsRead: rowsWithFile.length,
      rowsInPeriod: eligible.length,
      rowsSkippedBeforeStart: rowsWithFile.length - eligible.length,
      refundCount,
      excludedCount,
      excludedBreakdown,
      financialExcludedCount: (excludedBreakdown.deposit || 0) + (excludedBreakdown.transfer || 0) + (excludedBreakdown.exchange || 0) + (excludedBreakdown.interest || 0),
      fxConvertedCount,
      fxFallbackCount,
      currencies: [...new Set(eligible.map((x) => x.currency))].sort(),
      convertedWithApi
    }
  };
}
