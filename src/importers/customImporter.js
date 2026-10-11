// Generic statement importer behind "Learn format" (Profile → Data).
//
// A learned format is a small JSON description of how to read one provider's export:
// where the header row is, which columns hold date / description / amount, how dates
// and numbers are written, which sign means "money out", who owns the account and
// which rows to ignore. Formats are inferred from a sample file, reviewed by the user,
// stored with the workspace and recognised automatically on later imports.
import * as XLSX from "xlsx";
import { matchMembers, ownAccountTerms } from "./householdMatch.js";

export const CUSTOM_FORMAT_VERSION = 2;
const MAX_HEADER_SCAN_ROWS = 40;

// ---------- text helpers ----------
export function normalizeHeader(value) {
  return String(value ?? "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}
function cleanCell(value) {
  if (value instanceof Date) return value;
  if (typeof value === "number") return value;
  return String(value ?? "").replace(/ /g, " ").trim();
}
function isBlank(value) {
  return value === null || value === undefined || (typeof value === "string" && value.trim() === "");
}
function pad2(n) { return String(n).padStart(2, "0"); }
function isoFromParts(y, m, d) {
  const year = Number(y) < 100 ? 2000 + Number(y) : Number(y);
  const date = new Date(year, Number(m) - 1, Number(d));
  if (date.getFullYear() !== year || date.getMonth() !== Number(m) - 1 || date.getDate() !== Number(d)) return "";
  return `${year}-${pad2(m)}-${pad2(d)}`;
}
function round2(n) { return Math.round((Number(n) || 0) * 100) / 100; }
export function slugify(value) {
  return normalizeHeader(value).replace(/\s+/g, "_").slice(0, 40) || "bank";
}

// ---------- file reading ----------
function decodeText(buffer) {
  const bytes = new Uint8Array(buffer);
  let text = new TextDecoder("utf-8").decode(bytes);
  // Many banks still export Windows-1252 CSVs; fall back when UTF-8 decoding produced garbage.
  if (text.includes("�")) {
    try { text = new TextDecoder("windows-1252").decode(bytes); } catch { /* keep utf-8 */ }
  }
  return text.replace(/^﻿/, "");
}

export function detectDelimiter(text) {
  const lines = text.split(/\r?\n/).filter((l) => l.trim()).slice(0, 30);
  const candidates = [";", ",", "\t", "|"];
  let best = ",";
  let bestScore = -1;
  for (const delim of candidates) {
    const counts = lines.map((line) => splitCsvLine(line, delim).length);
    const multi = counts.filter((c) => c > 1);
    if (!multi.length) continue;
    // Prefer the delimiter that yields many columns consistently across lines.
    const freq = {};
    multi.forEach((c) => { freq[c] = (freq[c] || 0) + 1; });
    const [mode, modeCount] = Object.entries(freq).sort((a, b) => b[1] - a[1])[0];
    const score = modeCount * Math.min(Number(mode), 12);
    if (score > bestScore) { bestScore = score; best = delim; }
  }
  return best;
}
function splitCsvLine(line, delim) {
  const out = [];
  let cur = "";
  let quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"' && line[i + 1] === '"') { cur += '"'; i += 1; }
      else if (ch === '"') quoted = false;
      else cur += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === delim) { out.push(cur); cur = ""; }
    else cur += ch;
  }
  out.push(cur);
  return out;
}
export function parseCsv(text, delimiter = detectDelimiter(text)) {
  const rows = [];
  let row = [];
  let cur = "";
  let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') { cur += '"'; i += 1; }
      else if (ch === '"') quoted = false;
      else cur += ch;
      continue;
    }
    if (ch === '"') { quoted = true; continue; }
    if (ch === delimiter) { row.push(cur); cur = ""; continue; }
    if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i += 1;
      row.push(cur); rows.push(row); row = []; cur = "";
      continue;
    }
    cur += ch;
  }
  if (cur !== "" || row.length) { row.push(cur); rows.push(row); }
  return rows.map((r) => r.map(cleanCell));
}

/** Reads CSV/TXT/XLSX/XLS files into plain tables: [{ fileName, sheets: [{ name, rows }] }]. */
export async function readCustomImportFiles(files = []) {
  const out = [];
  for (const file of Array.from(files || [])) {
    const name = file.name || "file";
    const buffer = await file.arrayBuffer();
    if (/\.(csv|txt|tsv)$/i.test(name)) {
      const text = decodeText(buffer);
      const delimiter = /\.tsv$/i.test(name) ? "\t" : detectDelimiter(text);
      out.push({ fileName: name, delimiter, sheets: [{ name: "CSV", rows: parseCsv(text, delimiter) }] });
      continue;
    }
    const wb = XLSX.read(buffer, { type: "array", cellDates: true });
    const sheets = wb.SheetNames.map((sheetName) => ({
      name: sheetName,
      rows: XLSX.utils.sheet_to_json(wb.Sheets[sheetName], { header: 1, raw: true, defval: "" }).map((r) => r.map(cleanCell)),
    })).filter((s) => s.rows.length);
    out.push({ fileName: name, sheets });
  }
  return out;
}

// ---------- value parsing ----------
const MONTHS = {
  jan: 1, gen: 1, ene: 1, janv: 1, januar: 1, gennaio: 1, january: 1, enero: 1, janvier: 1,
  feb: 2, febbraio: 2, february: 2, febrero: 2, fev: 2, fevr: 2, fevrier: 2, februar: 2,
  mar: 3, marzo: 3, march: 3, mars: 3, marz: 3, maerz: 3,
  apr: 4, aprile: 4, april: 4, abr: 4, abril: 4, avr: 4, avril: 4,
  may: 5, mag: 5, maggio: 5, mayo: 5, mai: 5,
  jun: 6, giu: 6, giugno: 6, june: 6, junio: 6, juin: 6, juni: 6,
  jul: 7, lug: 7, luglio: 7, july: 7, julio: 7, juil: 7, juillet: 7, juli: 7,
  aug: 8, ago: 8, agosto: 8, august: 8, aout: 8,
  sep: 9, set: 9, sept: 9, settembre: 9, september: 9, septiembre: 9, septembre: 9,
  oct: 10, ott: 10, ottobre: 10, october: 10, octubre: 10, octobre: 10, okt: 10, oktober: 10,
  nov: 11, novembre: 11, november: 11, noviembre: 11,
  dec: 12, dic: 12, dicembre: 12, december: 12, diciembre: 12, decembre: 12, dez: 12, dezember: 12,
};

/** Splits a date-like string into numeric parts, or returns null. */
function dateParts(text) {
  const t = String(text).trim();
  let m = t.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})(?:[ T].*)?$/);
  if (m) return { kind: "ymd", a: +m[1], b: +m[2], c: +m[3] };
  m = t.match(/^(\d{1,2})[-/. ](\d{1,2})[-/. ](\d{2,4})(?:[ T,].*)?$/);
  if (m) return { kind: "xxy", a: +m[1], b: +m[2], c: +m[3] };
  m = t.match(/^(\d{8})$/);
  if (m) return { kind: "ymd", a: +t.slice(0, 4), b: +t.slice(4, 6), c: +t.slice(6, 8) };
  // "05 Sep 2026", "5-set-26", "Sep 5, 2026"
  const norm = normalizeHeader(t);
  m = norm.match(/^(\d{1,2}) ([a-z]+) (\d{2,4})/);
  if (m && MONTHS[m[2]]) return { kind: "named", y: +m[3], mo: MONTHS[m[2]], d: +m[1] };
  m = norm.match(/^([a-z]+) (\d{1,2}) (\d{2,4})/);
  if (m && MONTHS[m[1]]) return { kind: "named", y: +m[3], mo: MONTHS[m[1]], d: +m[2] };
  return null;
}

export function parseDateValue(value, order = "DMY") {
  if (value instanceof Date && !Number.isNaN(value.getTime())) return isoFromParts(value.getFullYear(), value.getMonth() + 1, value.getDate());
  if (typeof value === "number" && value > 20000 && value < 80000) {
    const p = XLSX.SSF.parse_date_code(value);
    return p ? isoFromParts(p.y, p.m, p.d) : "";
  }
  const parts = dateParts(value);
  if (!parts) return "";
  if (parts.kind === "ymd") return isoFromParts(parts.a, parts.b, parts.c);
  if (parts.kind === "named") return isoFromParts(parts.y, parts.mo, parts.d);
  return order === "MDY" ? isoFromParts(parts.c, parts.a, parts.b) : isoFromParts(parts.c, parts.b, parts.a);
}

/** Guesses DMY vs MDY from a sample of date strings. */
export function detectDateOrder(values = []) {
  let dmy = 0;
  let mdy = 0;
  for (const v of values) {
    const p = typeof v === "string" ? dateParts(v) : null;
    if (!p || p.kind !== "xxy") continue;
    if (p.a > 12 && p.b <= 12) dmy += 1;
    if (p.b > 12 && p.a <= 12) mdy += 1;
  }
  if (mdy > dmy) return "MDY";
  return "DMY";
}

/** Parses "1.234,56", "1,234.56", "-12,50", "(12.50)", "12,50-", "€ 12", "12.50 CR"… */
export function parseAmountValue(value, decimal = "auto") {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  let text = String(value ?? "").trim();
  if (!text) return null;
  let negative = false;
  if (/^\(.*\)$/.test(text)) { negative = true; text = text.slice(1, -1); }
  if (/[-−]\s*$/.test(text)) { negative = true; text = text.replace(/[-−]\s*$/, ""); }
  if (/^\s*[-−]/.test(text) || /^[^\d]*[-−]\s*\d/.test(text)) negative = true;
  if (/\b(dr|debit)\b\.?\s*$/i.test(text)) negative = true;
  text = text.replace(/\b(cr|dr|credit|debit|eur|usd|gbp|chf)\b\.?/gi, "").replace(/[^\d.,']/g, "").replace(/'/g, "");
  if (!/\d/.test(text)) return null;
  let dec = decimal;
  if (dec === "auto") {
    const lastComma = text.lastIndexOf(",");
    const lastDot = text.lastIndexOf(".");
    if (lastComma >= 0 && lastDot >= 0) dec = lastComma > lastDot ? "," : ".";
    else if (lastComma >= 0) dec = /,\d{3}$/.test(text) && !/,\d{3},/.test(text) && text.split(",").length > 2 ? "." : ",";
    else dec = ".";
  }
  if (dec === ",") text = text.replace(/\./g, "").replace(",", ".");
  else text = text.replace(/,/g, "");
  const n = Number(text);
  if (!Number.isFinite(n)) return null;
  return negative ? -Math.abs(n) : n;
}

/** Guesses the decimal separator from amount-like strings. */
export function detectDecimal(values = []) {
  let comma = 0;
  let dot = 0;
  for (const v of values) {
    if (typeof v !== "string") continue;
    const t = v.replace(/[^\d.,]/g, "");
    if (/,\d{1,2}$/.test(t)) comma += 1;
    else if (/\.\d{1,2}$/.test(t)) dot += 1;
  }
  return comma > dot ? "," : ".";
}

// ---------- header & column detection ----------
const ROLE_KEYWORDS = {
  date: ["data operazione", "data contabile", "booking date", "transaction date", "posting date", "date", "data", "datum", "buchungstag", "buchungsdatum", "fecha", "date operation", "started date", "completed date", "data registrazione", "trans date"],
  valueDate: ["data valuta", "value date", "valuta", "wertstellung", "fecha valor", "date valeur"],
  description: ["descrizione completa", "descrizione", "description", "causale", "details", "dettagli", "merchant", "esercente", "beneficiario", "payee", "counterparty", "controparte", "verwendungszweck", "buchungstext", "concepto", "libelle", "narrative", "memo", "reference text", "tipologia", "name", "nome"],
  amount: ["importo", "amount", "betrag", "importe", "montant", "valore", "transaction amount", "amount eur", "importo eur", "spesa", "value"],
  debit: ["uscite", "addebiti", "addebito", "dare", "debit", "debits", "money out", "paid out", "withdrawal", "withdrawals", "soll", "ausgang", "cargo", "debe", "debito"],
  credit: ["entrate", "accrediti", "accredito", "avere", "credit", "credits", "money in", "paid in", "deposit", "deposits", "haben", "eingang", "abono", "haber", "credito"],
  indicator: ["dare avere", "debit credit", "dr cr", "cr dr", "segno", "sign", "type d c", "s h", "soll haben", "credit debit indicator"],
  currency: ["valuta", "divisa", "currency", "wahrung", "waehrung", "moneda", "devise", "ccy"],
  holder: ["titolare", "intestatario", "cardholder", "card holder", "card member", "holder", "account holder", "karteninhaber", "titular"],
  category: ["categoria", "category", "kategorie", "categoria spesa", "moneymap", "categorie"],
  reference: ["riferimento", "reference", "id transazione", "transaction id", "id", "referenz", "referencia", "numero operazione", "ref"],
  status: ["stato", "status", "state", "estado", "statut"],
  balance: ["saldo", "balance", "kontostand", "solde"],
  country: ["paese", "country", "land", "pais", "pays", "nazione"],
  type: ["tipo", "type", "tipologia operazione", "transaction type"],
};
function headerMatchScore(header, role) {
  const h = normalizeHeader(header);
  if (!h) return 0;
  let best = 0;
  for (const kw of ROLE_KEYWORDS[role] || []) {
    if (h === kw) best = Math.max(best, 3);
    else if (` ${h} `.includes(` ${kw} `)) best = Math.max(best, 2);
  }
  return best;
}
function looksLikeDate(v) { return v instanceof Date || (typeof v === "number" && v > 30000 && v < 60000) || (typeof v === "string" && !!dateParts(v)); }
function looksLikeAmount(v) { return typeof v === "number" || (typeof v === "string" && /^[\s(€$£+\-−]*\d[\d.,' ]*[)\-−]?\s*(cr|dr|eur|€)?$/i.test(v.trim())); }

/** Picks the most plausible header row in the first rows of a table. */
export function detectHeaderRow(rows = []) {
  let best = { index: 0, score: -Infinity };
  const limit = Math.min(rows.length, MAX_HEADER_SCAN_ROWS);
  for (let i = 0; i < limit; i += 1) {
    const row = rows[i] || [];
    const cells = row.filter((c) => !isBlank(c));
    if (cells.length < 2) continue;
    const textCells = cells.filter((c) => typeof c === "string" && !looksLikeDate(c) && !looksLikeAmount(c));
    const keywordHits = row.reduce((sum, c) => sum + Math.max(...Object.keys(ROLE_KEYWORDS).map((role) => headerMatchScore(c, role))), 0);
    const below = rows.slice(i + 1, i + 6).filter((r) => r && r.filter((c) => !isBlank(c)).length >= Math.max(2, cells.length - 2));
    const dataLike = below.filter((r) => r.some(looksLikeDate) && r.some(looksLikeAmount)).length;
    const score = textCells.length * 2 + keywordHits * 2 + dataLike * 4 - (cells.length - textCells.length) * 3;
    if (score > best.score) best = { index: i, score };
  }
  return best.index;
}

export function headersFromRow(row = []) {
  const seen = {};
  return row.map((cell, idx) => {
    let name = cell instanceof Date ? "" : String(cell ?? "").trim();
    if (!name) name = `Column ${idx + 1}`;
    if (seen[name]) { seen[name] += 1; name = `${name} (${seen[name]})`; } else seen[name] = 1;
    return name;
  });
}

export function headerSignature(headers = []) {
  return headers.map(normalizeHeader).filter((h) => h && !/^column \d+$/.test(h));
}

function columnValues(dataRows, idx, limit = 200) {
  const out = [];
  for (const row of dataRows) {
    if (out.length >= limit) break;
    const v = row?.[idx];
    if (!isBlank(v)) out.push(v);
  }
  return out;
}

/**
 * Analyses one table and returns a draft format plus diagnostics.
 * `headerIndex` can be forced (the user can correct the detected row).
 */
export function analyzeTable(rows = [], { headerIndex } = {}) {
  const hIdx = Number.isInteger(headerIndex) ? headerIndex : detectHeaderRow(rows);
  const headers = headersFromRow(rows[hIdx] || []);
  const dataRows = rows.slice(hIdx + 1).filter((r) => r && r.some((c) => !isBlank(c)));
  const stats = headers.map((header, idx) => {
    const values = columnValues(dataRows, idx);
    const n = values.length || 1;
    const dateShare = values.filter(looksLikeDate).length / n;
    const amountShare = values.filter((v) => looksLikeAmount(v) && !looksLikeDate(v)).length / n;
    const textValues = values.filter((v) => typeof v === "string" && !looksLikeAmount(v) && !looksLikeDate(v));
    const avgLen = textValues.reduce((s, v) => s + v.length, 0) / (textValues.length || 1);
    const distinct = new Set(values.map(String)).size / n;
    return { header, idx, values, filled: values.length / Math.max(1, dataRows.length), dateShare, amountShare, textShare: textValues.length / n, avgLen, distinct };
  });
  const pick = (role, predicate, used = new Set()) => {
    const ranked = stats
      .filter((s) => !used.has(s.idx) && predicate(s))
      .map((s) => ({ s, score: headerMatchScore(s.header, role) * 10 + s.filled * 3 }))
      .sort((a, b) => b.score - a.score);
    return ranked[0]?.s || null;
  };
  const used = new Set();
  const take = (s) => { if (s) used.add(s.idx); return s ? s.header : ""; };

  const dateCol = pick("date", (s) => s.dateShare > 0.6 && headerMatchScore(s.header, "valueDate") < 3 || (s.dateShare > 0.6 && headerMatchScore(s.header, "date") >= 2));
  const date = take(dateCol);
  const valueDate = take(pick("valueDate", (s) => s.dateShare > 0.6 && headerMatchScore(s.header, "valueDate") > 0, used));

  // Amounts: separate in/out columns win when both are present.
  const debitCol = pick("debit", (s) => s.amountShare > 0.5 && headerMatchScore(s.header, "debit") > 0, used);
  const creditCol = pick("credit", (s) => s.amountShare > 0.5 && headerMatchScore(s.header, "credit") > 0 && s.idx !== debitCol?.idx, used);
  let amountMode = "single";
  let amount = "";
  let debit = "";
  let credit = "";
  if (debitCol && creditCol) {
    amountMode = "split";
    debit = take(debitCol);
    credit = take(creditCol);
  } else {
    const amountCol = pick("amount", (s) => s.amountShare > 0.6 && headerMatchScore(s.header, "balance") === 0 && (headerMatchScore(s.header, "amount") > 0 || s.dateShare < 0.2), used)
      || debitCol || creditCol;
    amount = take(amountCol);
  }
  const indicatorCol = amountMode === "single" ? pick("indicator", (s) => headerMatchScore(s.header, "indicator") > 0 || (s.values.length && s.values.every((v) => /^(d|c|dr|cr|debit|credit|dare|avere|s|h|soll|haben)$/i.test(String(v).trim()))), used) : null;
  const indicator = take(indicatorCol);
  if (indicator) amountMode = "indicator";

  const currency = take(pick("currency", (s) => headerMatchScore(s.header, "currency") > 0 && s.values.every((v) => /^[A-Za-z]{3}$|^[€$£]$/.test(String(v).trim())), used));
  const holder = take(pick("holder", (s) => headerMatchScore(s.header, "holder") > 0 && s.textShare > 0.5, used));
  const category = take(pick("category", (s) => headerMatchScore(s.header, "category") > 0 && s.textShare > 0.5, used));
  const status = take(pick("status", (s) => headerMatchScore(s.header, "status") > 0, used));
  const country = take(pick("country", (s) => headerMatchScore(s.header, "country") > 0 && s.textShare > 0.5, used));
  const reference = take(pick("reference", (s) => headerMatchScore(s.header, "reference") >= 2 && s.distinct > 0.9, used));
  // Description: best text column; a second, longer text column is appended when present (e.g. "Descrizione" + "Descrizione completa").
  const textCandidates = stats
    .filter((s) => !used.has(s.idx) && s.textShare > 0.5 && headerMatchScore(s.header, "balance") === 0)
    .map((s) => ({ s, score: headerMatchScore(s.header, "description") * 10 + Math.min(s.avgLen, 60) / 6 + s.distinct * 4 }))
    .sort((a, b) => b.score - a.score);
  const description = textCandidates.slice(0, 1).map((c) => c.s.header);
  const extra = textCandidates[1];
  if (extra && headerMatchScore(extra.s.header, "description") > 0) description.push(extra.s.header);

  const dateValues = dateCol ? dateCol.values.filter((v) => typeof v === "string") : [];
  const amountValues = [amount, debit, credit].filter(Boolean).flatMap((h) => stats.find((s) => s.header === h)?.values || []);
  const decimal = detectDecimal(amountValues);
  const dateOrder = detectDateOrder(dateValues);

  // Sign convention: bank accounts usually show money out as negative; card statements as positive.
  let signMode = "negative_is_expense";
  if (amountMode === "single" && amount) {
    const nums = amountValues.map((v) => parseAmountValue(v, decimal)).filter((n) => Number.isFinite(n) && n !== 0);
    const neg = nums.filter((n) => n < 0).length;
    const pos = nums.length - neg;
    // Bank accounts: many purchases (negative), few incomes. Card statements: mostly positive charges.
    if (pos > neg) signMode = "positive_is_expense";
  }
  const debitValues = indicator
    ? [...new Set((stats.find((s) => s.header === indicator)?.values || []).map((v) => String(v).trim()))].filter((v) => /^(d|dr|debit|debito|addebito|dare|uscita|out|s|soll|-)$/i.test(v))
    : [];

  return {
    headerIndex: hIdx,
    headers,
    dataRows,
    columnStats: stats.map(({ values, ...rest }) => ({ ...rest, sample: values.slice(0, 3).map((v) => (v instanceof Date ? v.toISOString().slice(0, 10) : String(v))) })),
    guess: {
      mapping: { date, valueDate, description, amountMode, amount, debit, credit, indicator, debitValues, currency, holder, category, status, country, reference },
      dateOrder,
      decimal,
      signMode,
      incomingAs: signMode === "positive_is_expense" ? "refund" : "income",
    },
  };
}

/** Picks the sheet that looks most like a transaction table. */
export function analyzeFiles(fileTables = [], options = {}) {
  let best = null;
  fileTables.forEach((file, fileIdx) => {
    (file.sheets || []).forEach((sheet, sheetIdx) => {
      if (Number.isInteger(options.sheetIndex) && options.sheetIndex !== sheetIdx) return;
      const analysis = analyzeTable(sheet.rows, options);
      const m = analysis.guess.mapping;
      const score = (m.date ? 3 : 0) + (m.amount || (m.debit && m.credit) ? 3 : 0) + (m.description.length ? 2 : 0) + Math.min(analysis.dataRows.length, 50) / 25;
      if (!best || score > best.score) best = { score, fileIdx, sheetIdx, sheetName: sheet.name, analysis };
    });
  });
  return best;
}

export const DEFAULT_EXCLUDE_KEYWORDS = [
  "saldo carta", "addebito carta di credito", "estratto conto carta", "credit card payment", "card repayment", "american express",
  "payment received", "pagamento ricevuto", "addebito in c c salvo buon fine", "kreditkarte abrechnung",
  "giroconto", "own account", "transfer to savings", "trasferimento tra conti", "top up", "ricarica",
  "acquisto titoli", "vendita titoli", "dividend", "securities", "broker",
];
const REFUND_TERMS = ["refund", "rimborso", "storno", "reso", "cashback", "ruckerstattung", "rueckerstattung", "erstattung", "gutschrift", "remboursement", "reembolso", "devolucion", "chargeback"];
export const DEFAULT_SKIP_STATUS = ["pending", "declined", "reverted", "failed", "cancel", "annullat", "in attesa", "rifiutat", "storn"];

/** Builds a draft format from an analysis (the user reviews it before saving). */
export function draftFormatFromAnalysis(best, { fileName = "", members = [] } = {}) {
  const base = String(fileName).replace(/\.[^.]+$/, "").replace(/[_-]+/g, " ").replace(/\d{4,}/g, "").trim() || "My bank";
  const { guess, headers, headerIndex } = best.analysis;
  return {
    id: "",
    label: base.slice(0, 40),
    version: CUSTOM_FORMAT_VERSION,
    sheetName: best.sheetName,
    headerIndex,
    headerSignature: headerSignature(headers),
    mapping: guess.mapping,
    dateOrder: guess.dateOrder,
    decimal: guess.decimal,
    signMode: guess.signMode,
    incomingAs: guess.incomingAs,
    owner: guess.mapping.holder ? "column" : (members[0]?.id || "shared"),
    excludeKeywords: [...DEFAULT_EXCLUDE_KEYWORDS],
    excludeOwnTransfers: true,
    skipStatus: [...DEFAULT_SKIP_STATUS],
    sampleFileName: fileName,
  };
}

// ---------- matching ----------
function similarity(a = [], b = []) {
  const A = new Set(a);
  const B = new Set(b);
  if (!A.size || !B.size) return 0;
  let inter = 0;
  A.forEach((x) => { if (B.has(x)) inter += 1; });
  return inter / (A.size + B.size - inter);
}
/** Finds the saved format whose header row best matches the given files (or null). */
export function findMatchingFormat(fileTables = [], formats = {}, threshold = 0.75) {
  let best = null;
  for (const format of Object.values(formats || {})) {
    if (!format?.headerSignature?.length) continue;
    for (const file of fileTables) {
      for (const sheet of file.sheets || []) {
        const idx = locateHeader(sheet.rows, format);
        if (idx < 0) continue;
        const score = similarity(headerSignature(headersFromRow(sheet.rows[idx])), format.headerSignature);
        if (score >= threshold && (!best || score > best.score)) best = { format, score };
      }
    }
  }
  return best;
}
/** Finds the header row for a known format, tolerating extra/fewer title rows. */
function locateHeader(rows = [], format) {
  const wanted = format.headerSignature || [];
  let bestIdx = -1;
  let bestScore = 0;
  for (let i = 0; i < Math.min(rows.length, MAX_HEADER_SCAN_ROWS); i += 1) {
    const score = similarity(headerSignature(headersFromRow(rows[i] || [])), wanted);
    if (score > bestScore) { bestScore = score; bestIdx = i; }
  }
  return bestScore >= 0.5 ? bestIdx : -1;
}

// ---------- parsing with a format ----------
function statementKey(iso) {
  const [y, m, d] = iso.split("-").map(Number);
  const end = d <= 20 ? new Date(y, m - 1, 20) : new Date(y, m, 20);
  const start = new Date(end.getFullYear(), end.getMonth() - 1, 21);
  const f = (x) => `${x.getFullYear()}-${pad2(x.getMonth() + 1)}-${pad2(x.getDate())}`;
  return `${f(start)}_${f(end)}`;
}
function cellByHeader(row, headers, name) {
  if (!name) return "";
  const idx = headers.indexOf(name);
  return idx >= 0 ? row[idx] : "";
}
function includesTerm(text, term) {
  const t = normalizeHeader(term);
  return t && ` ${text} `.includes(` ${t} `);
}

/**
 * Interprets one data row. Returns { tx } or { skip: reason }.
 * Amount convention of the app: positive = money out (spend), negative = money in.
 */
export function interpretRow(row, headers, format, ctx = {}) {
  const m = format.mapping || {};
  const members = ctx.members || [];
  const descParts = (Array.isArray(m.description) ? m.description : [m.description]).filter(Boolean).map((h) => String(cellByHeader(row, headers, h) ?? "").trim()).filter(Boolean);
  const desc = [...new Set(descParts)].join(" · ");
  const rawDate = cellByHeader(row, headers, m.date) || cellByHeader(row, headers, m.valueDate);
  const date = parseDateValue(rawDate, format.dateOrder || "DMY");
  if (!date && !desc) return { skip: "empty" };
  if (!date) return { skip: "invalid_date" };
  if (!desc) return { skip: "missing_description" };

  const status = normalizeHeader(cellByHeader(row, headers, m.status));
  if (status && (format.skipStatus || []).some((s) => status.includes(normalizeHeader(s)))) return { skip: "status" };

  let outflow = null; // money leaving the account, positive number
  if (m.amountMode === "split") {
    const debit = parseAmountValue(cellByHeader(row, headers, m.debit), format.decimal);
    const credit = parseAmountValue(cellByHeader(row, headers, m.credit), format.decimal);
    if (debit) outflow = Math.abs(debit);
    else if (credit) outflow = -Math.abs(credit);
  } else {
    const value = parseAmountValue(cellByHeader(row, headers, m.amount), format.decimal);
    if (value !== null) {
      if (m.amountMode === "indicator") {
        const ind = String(cellByHeader(row, headers, m.indicator) ?? "").trim().toLowerCase();
        const isDebit = (m.debitValues || []).some((v) => String(v).trim().toLowerCase() === ind);
        outflow = isDebit ? Math.abs(value) : -Math.abs(value);
      } else {
        outflow = format.signMode === "positive_is_expense" ? value : -value;
      }
    }
  }
  if (outflow === null || !Number.isFinite(outflow)) return { skip: "invalid_amount" };
  if (outflow === 0) return { skip: "zero_amount" };

  // Ownership
  let holder = "";
  let accountScope = "";
  let personalFlag = "personale";
  let shared = false;
  const ownerMember = members.find((x) => x.id === format.owner);
  if (format.owner === "shared") shared = true;
  else if (format.owner === "column") {
    holder = String(cellByHeader(row, headers, m.holder) ?? "").trim();
    const matched = matchMembers(holder, members);
    if (matched.length > 1) shared = true;
    else if (matched[0]) { holder = matched[0].name; accountScope = matched[0].id; }
  } else if (ownerMember) { holder = ownerMember.name; accountScope = ownerMember.id; }
  if (shared) { holder = ctx.sharedLabel || "Shared"; accountScope = "shared"; personalFlag = "comune"; }

  // Classification: expense / income / refund / excluded
  const text = normalizeHeader(desc);
  let cashflowType = "expense";
  let excludeReason = "";
  const keyword = (format.excludeKeywords || []).find((k) => includesTerm(text, k));
  const ownTransfer = format.excludeOwnTransfers && /\b(bonifico|giroconto|transfer|trasferimento|ueberweisung|virement|transferencia)\b/.test(text)
    && ownAccountTerms(members).some((k) => includesTerm(text, k));
  if (keyword) { cashflowType = "excluded"; excludeReason = "keyword"; }
  else if (ownTransfer) { cashflowType = "excluded"; excludeReason = "internal_transfer"; }
  else if (outflow < 0) {
    // Money in: a refund keeps reducing spend even on accounts where money in counts as income.
    const looksLikeRefund = REFUND_TERMS.some((k) => text.includes(k));
    if (looksLikeRefund) cashflowType = "expense";
    else if (format.incomingAs === "excluded") { cashflowType = "excluded"; excludeReason = "income"; }
    else if (format.incomingAs === "income") cashflowType = "income";
    // "refund": stays an expense row with a negative amount (reduces spend)
  }

  const currency = String(cellByHeader(row, headers, m.currency) || ctx.defaultCurrency || "EUR").trim().toUpperCase().replace("€", "EUR") || "EUR";
  return {
    tx: {
      date,
      desc,
      amount: round2(outflow),
      originalAmount: round2(outflow),
      originalCurrency: currency,
      holder,
      accountScope,
      personalFlag,
      split: shared ? "household" : null,
      paese: String(cellByHeader(row, headers, m.country) ?? "").trim(),
      bankCategory: String(cellByHeader(row, headers, m.category) ?? "").trim(),
      bankReference: String(cellByHeader(row, headers, m.reference) ?? "").trim(),
      cashflowType,
      excludeFromCashflow: cashflowType !== "expense",
      excludeReason,
      isRefund: cashflowType === "expense" && outflow < 0,
    },
  };
}

async function fetchEurRates(dates, currencies) {
  const list = [...new Set(currencies.filter((c) => c && c !== "EUR"))];
  const sorted = [...new Set(dates)].sort();
  if (!list.length || !sorted.length) return {};
  const res = await fetch(`https://api.frankfurter.dev/v1/${sorted[0]}..${sorted[sorted.length - 1]}?from=EUR&to=${encodeURIComponent(list.join(","))}`);
  if (!res.ok) throw new Error(`FX rates unavailable (${res.status})`);
  return (await res.json())?.rates || {};
}
function rateFor(rates, date, currency) {
  const cursor = new Date(`${date}T12:00:00`);
  for (let i = 0; i < 10; i += 1) {
    const key = cursor.toISOString().slice(0, 10);
    const r = rates?.[key]?.[currency];
    if (Number.isFinite(Number(r))) return Number(r);
    cursor.setDate(cursor.getDate() - 1);
  }
  return null;
}

/**
 * Parses files with a saved format. Every row ends up imported or counted in
 * `stats.skipped` with a reason, so nothing disappears silently.
 */
export async function parseWithFormat(fileTables = [], format, ctx = {}) {
  const importedAt = ctx.importedAt || new Date().toISOString();
  const rowsOut = [];
  const skipped = {};
  const rejectedExamples = [];
  let rowsRead = 0;
  for (const file of fileTables) {
    for (const sheet of file.sheets || []) {
      const hIdx = locateHeader(sheet.rows, format);
      if (hIdx < 0) continue;
      const headers = headersFromRow(sheet.rows[hIdx]);
      const occurrences = {};
      sheet.rows.slice(hIdx + 1).forEach((row, offset) => {
        if (!row || !row.some((c) => !isBlank(c))) return;
        rowsRead += 1;
        const res = interpretRow(row, headers, format, ctx);
        if (res.skip) {
          if (res.skip !== "empty") {
            skipped[res.skip] = (skipped[res.skip] || 0) + 1;
            if (rejectedExamples.length < 5 && res.skip !== "status") rejectedExamples.push({ reason: res.skip, rowNumber: hIdx + offset + 2, fileName: file.fileName });
          }
          return;
        }
        const tx = res.tx;
        // Stable reference: provider id when available, otherwise date+amount+description plus an
        // occurrence counter, so identical same-day rows survive and overlapping exports dedupe.
        const baseKey = tx.bankReference ? `ref:${tx.bankReference}` : `${tx.date}:${Math.round(tx.amount * 100)}:${normalizeHeader(tx.desc).slice(0, 80)}`;
        occurrences[baseKey] = (occurrences[baseKey] || 0) + 1;
        rowsOut.push({
          ...tx,
          ref: `${format.id}:${baseKey}${tx.bankReference ? "" : `:${occurrences[baseKey]}`}`,
          source: format.id,
          accountName: tx.accountScope === "shared" ? `${format.label} shared` : (tx.holder ? `${format.label} ${tx.holder}` : format.label),
          statementKey: statementKey(tx.date),
          calendarKey: tx.date.slice(0, 7),
          sourceFileName: file.fileName,
          sourceSheet: sheet.name,
          sourceRow: hIdx + offset + 2,
          importedAt,
          rawData: Object.fromEntries(headers.map((h, i) => [h, row[i] instanceof Date ? row[i].toISOString().slice(0, 10) : row[i]])),
        });
      });
    }
  }

  const foreign = rowsOut.filter((tx) => tx.originalCurrency && tx.originalCurrency !== "EUR");
  let fxConverted = 0;
  if (foreign.length && ctx.convertCurrency !== false) {
    const rates = await (ctx.fetchRates || fetchEurRates)(foreign.map((t) => t.date), foreign.map((t) => t.originalCurrency));
    for (const tx of foreign) {
      const rate = rateFor(rates, tx.date, tx.originalCurrency);
      if (!rate) throw new Error(`Missing FX rate for ${tx.originalCurrency} on ${tx.date}`);
      tx.fxRate = rate;
      tx.amount = round2(tx.originalAmount / rate);
      fxConverted += 1;
    }
  }

  return {
    transactions: rowsOut,
    stats: {
      rowsRead,
      imported: rowsOut.length,
      skipped,
      rejectedExamples,
      expenseCount: rowsOut.filter((t) => t.cashflowType === "expense" && t.amount > 0).length,
      refundCount: rowsOut.filter((t) => t.isRefund).length,
      incomeCount: rowsOut.filter((t) => t.cashflowType === "income").length,
      excludedCount: rowsOut.filter((t) => t.cashflowType === "excluded").length,
      fxConverted,
      currencies: [...new Set(rowsOut.map((t) => t.originalCurrency))].sort(),
    },
  };
}

/** Synchronous preview of the first rows of the analysed table (no FX conversion). */
export function previewRows(analysis, format, ctx = {}, limit = 12) {
  const out = [];
  const skipped = {};
  let ok = 0;
  analysis.dataRows.forEach((row, i) => {
    const res = interpretRow(row, analysis.headers, format, ctx);
    if (res.skip) {
      if (res.skip !== "empty") skipped[res.skip] = (skipped[res.skip] || 0) + 1;
      if (out.length < limit && res.skip !== "empty") out.push({ rowNumber: analysis.headerIndex + i + 2, skip: res.skip, raw: row.slice(0, 6) });
      return;
    }
    ok += 1;
    if (out.length < limit) out.push({ rowNumber: analysis.headerIndex + i + 2, tx: res.tx });
  });
  return { rows: out, ok, skipped, total: analysis.dataRows.length };
}

/** Maps ids from the first implementation (e.g. "custom_my-bank") to the current form ("custom_my_bank"). */
export function legacyCustomSourceId(id) {
  const raw = String(id || "").trim();
  if (!/^custom_/i.test(raw)) return "";
  const rest = raw.slice(7).toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  return rest ? `custom_${rest}` : "";
}

/** Upgrades formats saved by the first "Learn format" implementation (column mapping only). */
export function upgradeLegacyFormat(format) {
  if (!format || format.version === CUSTOM_FORMAT_VERSION) return format;
  const old = format.mapping || {};
  const headers = [...new Set(Object.values(old).filter((v) => typeof v === "string" && v))];
  return {
    ...format,
    id: legacyCustomSourceId(format.id) || `custom_${slugify(format.label || format.id)}`,
    version: CUSTOM_FORMAT_VERSION,
    headers,
    headerSignature: headerSignature(headers),
    mapping: { date: old.date || "", description: old.description ? [old.description] : [], amountMode: "single", amount: old.amount || "", currency: old.currency || "", holder: old.holder || "", category: old.category || "", country: "", reference: "", status: "" },
    dateOrder: "DMY",
    decimal: ",",
    signMode: "positive_is_expense",
    incomingAs: format.excludePositiveAmounts ? "income" : "refund",
    owner: old.holder ? "column" : "shared",
    excludeKeywords: [...DEFAULT_EXCLUDE_KEYWORDS],
    excludeOwnTransfers: true,
    skipStatus: [...DEFAULT_SKIP_STATUS],
  };
}
