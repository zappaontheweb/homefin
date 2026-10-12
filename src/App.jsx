
import { memo, useState, useEffect, useRef, useCallback, useMemo } from "react";
import { PieChart, Pie, Cell, LineChart, Line, BarChart, Bar, XAxis, YAxis, Tooltip, Legend, ResponsiveContainer, CartesianGrid } from "recharts";
import { parseAmexMonthlyWorkbook } from "./importers/amexImporter";
import { parseRevolutCsvFiles } from "./importers/revolutImporter";
import { parseMpWorkbook } from "./importers/mpImporter";
import { parseFinecoWorkbook } from "./importers/finecoImporter";
import { readCustomImportFiles, parseWithFormat, findMatchingFormat, upgradeLegacyFormat, legacyCustomSourceId } from "./importers/customImporter";
import LearnFormatPanel from "./LearnFormatPanel.jsx";
import { buildDemoStore } from "./demoData";

// ===== DASHBOARD CONFIG =====
const BASE_CAT_CONFIG = {
  ristoranti:    { label:"Ristoranti",      icon:"🍽️", color:"#FF6B6B" },
  supermercato:  { label:"Supermercato",    icon:"🛒", color:"#4ECDC4" },
  amazon:        { label:"Amazon",          icon:"📦", color:"#FF9F43" },
  salute:        { label:"Salute",          icon:"🏥", color:"#A29BFE" },
  delivery:      { label:"Delivery",        icon:"🛵", color:"#FD79A8" },
  streaming_tech:{ label:"Streaming & App", icon:"📺", color:"#6C5CE7" },
  tv:            { label:"Sky / TV",        icon:"📡", color:"#0984E3" },
  hotel:         { label:"Hotel",           icon:"🏨", color:"#00B894" },
  voli:          { label:"Voli",            icon:"✈️", color:"#00CEC9" },
  trasporti:     { label:"Trasporti",       icon:"🚕", color:"#FDCB6E" },
  benessere:     { label:"Benessere",       icon:"💆", color:"#E17055" },
  quota_assoc:   { label:"Quota Assoc.",    icon:"🏛️", color:"#74B9FF" },
  altro:         { label:"Altro",           icon:"📋", color:"#636E72" },
};

const SUB_COLORS = { "Netflix":"#E50914","Sky Italia":"#0074D9","Apple":"#A2AAAD","ChatGPT":"#10A37F","Amazon Prime":"#FF9900","Disney+":"#113CCF","MUBI":"#FF5E5B","Spotify":"#1DB954","NordVPN":"#4687FF","n8n Cloud":"#FF6D00","Quota Assoc.":"#74B9FF" };
const SUB_ICONS  = { "Netflix":"N","Sky Italia":"📡","Apple":"","ChatGPT":"🤖","Amazon Prime":"📦","Disney+":"D+","MUBI":"🎬","Spotify":"🎵","NordVPN":"🔒","n8n Cloud":"⚙️","Quota Assoc.":"🏛️" };
const PALETTE = ["#FF6B6B","#4ECDC4","#FF9F43","#A29BFE","#FD79A8","#6C5CE7","#0984E3","#00B894","#00CEC9","#FDCB6E","#E17055","#74B9FF","#B2BEC3","#636E72"];
const RAW_BASE_RENDER_LIMIT = 100;
const RAW_FILTER_RENDER_STEP = 100;
const RAW_FILTER_DEBOUNCE_MS = 200;
const RAW_VIRTUAL_ROW_HEIGHT = 41;
const RAW_VIRTUAL_OVERSCAN = 8;
const RAW_VIRTUAL_MAX_HEIGHT = 640;

function normalizeCategoryKey(label) {
  const base = normalizeText(label).replace(/\s+/g, '_').replace(/[^a-z0-9_]/g, '').replace(/^_+|_+$/g, '');
  return base || 'categoria_custom';
}
function getCustomCategories(store) {
  return store?.customCategories && typeof store.customCategories === 'object' ? store.customCategories : {};
}
function getCategoryCustomizations(store) {
  return store?.categoryCustomizations && typeof store.categoryCustomizations === 'object' ? store.categoryCustomizations : {};
}
function getCategoryConfig(store) {
  const merged = { ...BASE_CAT_CONFIG, ...getCustomCategories(store) };
  const custom = getCategoryCustomizations(store);
  Object.entries(custom).forEach(([key, patch]) => {
    if (merged[key]) merged[key] = { ...merged[key], ...patch };
  });
  return merged;
}
function mergeViabilitaToTrasporti(store) {
  if (!store || typeof store !== 'object') return store;
  const mapCat = (v) => (v === 'viabilita' || v === 'viabilità') ? 'trasporti' : v;
  const txs = Array.isArray(store.transactions) ? store.transactions.map((tx) => ({ ...tx, ruleCategory: mapCat(tx.ruleCategory) })) : [];
  const categoryOverrides = {};
  Object.entries(store.categoryOverrides || {}).forEach(([k,v]) => { categoryOverrides[k] = mapCat(v); });
  const rules = Array.isArray(store.rules) ? store.rules.map((r) => ({ ...r, category: mapCat(r.category) })) : store.rules;
  const overrideHistory = Array.isArray(store.overrideHistory) ? store.overrideHistory.map((h) => ({ ...h, category: mapCat(h.category) })) : [];
  const customCategories = { ...(store.customCategories || {}) }; delete customCategories.viabilita; delete customCategories['viabilità']; delete customCategories.personale; delete customCategories.Personale;
  const categoryCustomizations = { ...(store.categoryCustomizations || {}) }; delete categoryCustomizations.viabilita; delete categoryCustomizations['viabilità']; delete categoryCustomizations.personale; delete categoryCustomizations.Personale;
  return { ...store, transactions: txs, categoryOverrides, rules, overrideHistory, customCategories, categoryCustomizations, meta: { ...(store.meta || {}), viabilitaMergedIntoTrasporti: true } };
}
function resolveCategoryInput(input, categoryConfig) {
  const raw = String(input || "").trim();
  if (!raw) return null;
  if (categoryConfig[raw]) return raw;
  const wanted = normalizeCategoryKey(raw);
  if (categoryConfig[wanted]) return wanted;
  const found = Object.entries(categoryConfig).find(([key, cfg]) => {
    return normalizeCategoryKey(key) === wanted || normalizeCategoryKey(cfg?.label || "") === wanted;
  });
  return found ? found[0] : null;
}

function makeCustomCategory(label, existingConfig = {}) {
  const cleanLabel = String(label || '').trim();
  if (!cleanLabel) return null;
  const baseKey = normalizeCategoryKey(cleanLabel);
  let key = baseKey;
  let i = 2;
  while (existingConfig[key]) key = baseKey + '_' + (i++);
  const color = PALETTE[Object.keys(existingConfig).length % PALETTE.length] || '#636E72';
  return { key, cfg: { label: cleanLabel, icon: '🏷️', color } };
}

function formatItalianNumber(value, decimals = 0) {
  const num = Number(value || 0);
  if (!Number.isFinite(num)) return decimals ? '0,00' : '0';
  const sign = num < 0 ? '-' : '';
  const fixed = Math.abs(num).toFixed(decimals);
  const [intPart, decPart] = fixed.split('.');
  const grouped = intPart.replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  return sign + grouped + (decimals ? ',' + decPart : '');
}
const fmt = n => '€' + formatItalianNumber(n, 0);
const fmtDec = n => '€' + formatItalianNumber(n, 2);
// ===== HOUSEHOLD =====
// One household per deployment. Members are configured during onboarding and in
// Profile → Household; they drive holder detection, shared-cost allocation and charts.
const SHARED_HOLDER_KEY = 'shared';
const SHARED_HOLDER_LABEL = 'Shared';
const SHARED_HOLDER_ALIASES = ['shared', 'joint', 'cointestato', 'condiviso', 'comune'];
let ACTIVE_HOUSEHOLD = { members: [], splitMode: 'equal', sharedSplit: {} };
function memberIdFromName(name) {
  return String(name || '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'member';
}
function normalizeHousehold(input) {
  const members = (Array.isArray(input?.members) ? input.members : [])
    .map((m) => ({
      id: memberIdFromName(m?.id || m?.name),
      name: String(m?.name || '').trim(),
      keywords: (Array.isArray(m?.keywords) ? m.keywords : String(m?.keywords || '').split(',')).map((k) => String(k || '').trim()).filter(Boolean),
    }))
    .filter((m) => m.name)
    .filter((m, idx, arr) => arr.findIndex((x) => x.id === m.id) === idx);
  const sharedSplit = {};
  members.forEach((m) => { const v = Number(input?.sharedSplit?.[m.id]); sharedSplit[m.id] = Number.isFinite(v) && v >= 0 ? v : 0; });
  return { members, splitMode: input?.splitMode === 'custom' ? 'custom' : 'equal', sharedSplit };
}
function setActiveHousehold(household) { ACTIVE_HOUSEHOLD = normalizeHousehold(household); return ACTIVE_HOUSEHOLD; }
function householdMembers() { return ACTIVE_HOUSEHOLD.members; }
function getMember(id) { return ACTIVE_HOUSEHOLD.members.find((m) => m.id === id) || null; }
// Fraction of a shared transaction allocated to each member (sums to 1).
function householdShares() {
  const members = householdMembers();
  if (!members.length) return {};
  const equal = Object.fromEntries(members.map((m) => [m.id, 1 / members.length]));
  if (ACTIVE_HOUSEHOLD.splitMode !== 'custom') return equal;
  const total = members.reduce((sum, m) => sum + Number(ACTIVE_HOUSEHOLD.sharedSplit?.[m.id] || 0), 0);
  if (!(total > 0)) return equal;
  return Object.fromEntries(members.map((m) => [m.id, Number(ACTIVE_HOUSEHOLD.sharedSplit?.[m.id] || 0) / total]));
}
function memberMatchTerms(member) {
  return [member?.name, member?.id?.replace(/_/g, ' '), ...(member?.keywords || [])].map((t) => normalizeText(t)).filter((t) => t.length >= 2);
}
// Returns the ids of every member whose name/keywords appear in the given text.
function matchMembersInText(text) {
  const t = ` ${normalizeText(text)} `;
  return householdMembers().filter((m) => memberMatchTerms(m).some((term) => t.includes(` ${term} `))).map((m) => m.id);
}
function holderKey(name) {
  const n = normalizeText(name);
  if (!n) return '';
  if (SHARED_HOLDER_ALIASES.some((a) => ` ${n} `.includes(` ${a} `))) return SHARED_HOLDER_KEY;
  if (getMember(n.replace(/\s+/g, '_'))) return n.replace(/\s+/g, '_');
  const matches = matchMembersInText(n);
  return matches.length === 1 ? matches[0] : n;
}
function holderDisplayName(key) {
  if (key === SHARED_HOLDER_KEY) return SHARED_HOLDER_LABEL;
  return getMember(key)?.name || '';
}
function canonicalHolderDisplay(value, fallback = '') {
  const key = holderKey(value || fallback || '');
  return holderDisplayName(key) || String(value || fallback || '').trim();
}
function memberColor(theme, idx) {
  const palette = [theme?.splitA, theme?.splitB, ...PALETTE].filter(Boolean);
  return palette[idx % palette.length];
}
function isSharedAccountTx(tx) {
  const source = normalizeSource(tx?.source || tx?.accountName || 'amex');
  if (source === 'amex') return false; // Amex holder is always the cardholder; shared is only an allocation flag.
  const accountText = normalizeText(`${tx?.accountName || ''} ${tx?.accountScope || ''} ${tx?.accountOwnershipId || ''}`);
  return tx?.accountScope === SHARED_HOLDER_KEY
    || tx?.accountOwnershipId === SHARED_HOLDER_KEY
    || SHARED_HOLDER_ALIASES.some((a) => ` ${accountText} `.includes(` ${a} `))
    || holderKey(tx?.holder || '') === SHARED_HOLDER_KEY;
}
function isSharedTx(tx) {
  if (tx?.personalFlag === 'personale') return false;
  const pf = tx?.personalFlag === 'comune' || tx?.personalFlag === 'shared' || tx?.personalFlag === 'condiviso' ? 'comune' : null;
  return pf === 'comune' || isSharedAccountTx(tx) || !!tx?.split;
}
function txMatchesSelectedHolder(tx, selectedHolder) {
  if (!selectedHolder || selectedHolder === 'ALL') return true;
  if (isSharedTx(tx)) return !!getMember(selectedHolder);
  return holderKey(tx?.holder || '') === selectedHolder;
}
function initials(name) { return String(name || 'User').trim().split(/\s+/).filter(Boolean).slice(0,2).map(x => (x[0] || '').toUpperCase()).join('') || 'U'; }
function amountTick(v) { return '€' + formatItalianNumber(v, 0); }
const EMOJI_CHOICES = ['🏷️','🍽️','🍕','🍔','☕','🍷','🛒','🥦','🧴','📦','🛍️','👕','👟','💄','🏥','💊','🩺','🦷','🧘','💆','🏋️','🛵','🍱','📺','📡','📱','💻','🎮','🎬','🎵','📚','🏨','✈️','🚕','🚆','🚗','⛽','🅿️','🧳','🌍','🏖️','🏠','🧸','🎁','🐶','🏫','🧾','🏛️','💼','👤','👥','💳','💸','🏦','📈','🛡️','⚙️','❓'];
const SOURCE_LABELS = { amex: 'Amex', revolut: 'Revolut', mp: 'MP', fineco: 'Fineco' };
const SOURCE_ORDER = ['amex', 'revolut', 'mp', 'fineco'];
const CUSTOM_SOURCE_PREFIX = 'custom_';
// Learned import formats (Profile → Data → Learn format) are registered here so they
// behave like built-in sources in filters, labels and charts.
let ACTIVE_CUSTOM_FORMATS = {};
function setActiveCustomFormats(formats) { ACTIVE_CUSTOM_FORMATS = formats && typeof formats === 'object' ? formats : {}; }
function isCustomSource(value) { return /^custom_[a-z0-9_]+$/.test(String(value || '').trim()); }
function normalizeSource(value) {
  const rawValue = String(value || '').trim();
  if (isCustomSource(rawValue)) return rawValue;
  const legacyCustom = legacyCustomSourceId(rawValue);
  if (legacyCustom) return legacyCustom;
  const raw = normalizeText(rawValue || 'amex');
  if (raw.includes('revolut')) return 'revolut';
  if (raw.includes('mediobanca') || raw === 'mp' || raw.includes('premier')) return 'mp';
  if (raw.includes('fineco')) return 'fineco';
  if (raw.includes('amex') || raw.includes('american express')) return 'amex';
  return raw || 'amex';
}
function sourceLabel(value) {
  const source = normalizeSource(value);
  if (isCustomSource(source)) return ACTIVE_CUSTOM_FORMATS[source]?.label || source.slice(CUSTOM_SOURCE_PREFIX.length).replace(/_/g, ' ');
  return SOURCE_LABELS[source] || String(value || 'Amex');
}

const ACCOUNT_IMPORT_OPTIONS = [
  { id: 'amex', source: 'amex', accountName: 'Amex', labelIt: 'Amex', labelEn: 'Amex' },
  { id: 'revolut', source: 'revolut', accountName: 'Revolut', labelIt: 'Revolut', labelEn: 'Revolut' },
  { id: 'mp', source: 'mp', accountName: 'MP', labelIt: 'MP', labelEn: 'MP' },
  { id: 'fineco', source: 'fineco', accountName: 'Fineco', labelIt: 'Fineco', labelEn: 'Fineco' },
];
// Account owner choices for imports whose files may not say who owns the account:
// one per household member, plus "Shared" when there are 2+ members.
function memberAccountOptions(bankLabel) {
  const personal = householdMembers().map((m) => ({ id: m.id, accountName: `${bankLabel} ${m.name}`, holder: m.name, accountScope: m.id, personalFlag: 'personale', labelIt: m.name, labelEn: m.name }));
  const shared = householdMembers().length > 1 ? [{ id: SHARED_HOLDER_KEY, accountName: `${bankLabel} shared`, holder: SHARED_HOLDER_LABEL, accountScope: SHARED_HOLDER_KEY, personalFlag: 'comune', split: 'household', labelIt: 'Condiviso', labelEn: 'Shared' }] : [];
  return [...personal, ...shared];
}
function revolutAccountOptions() { return memberAccountOptions('Revolut'); }
function getRevolutAccountOption(id) {
  const options = revolutAccountOptions();
  return options.find((o) => o.id === id) || options[0] || { id: '', accountName: 'Revolut', holder: '', accountScope: '', personalFlag: 'personale' };
}
function revolutAccountLabel(optionOrId, lang = 'en') {
  const option = typeof optionOrId === 'string' ? getRevolutAccountOption(optionOrId) : optionOrId;
  return lang === 'en' ? (option?.labelEn || 'Account') : (option?.labelIt || 'Account');
}
// MP: "auto" keeps the owner detected from the file's "Intestatari" metadata (XLSX exports).
const MP_AUTO_ACCOUNT = { id: 'auto', labelIt: 'Rileva dal file', labelEn: 'Detect from file' };
function mpAccountOptions() { return [MP_AUTO_ACCOUNT, ...memberAccountOptions('MP')]; }
function getMpAccountOption(id) { return mpAccountOptions().find((o) => o.id === id) || MP_AUTO_ACCOUNT; }
function mpAccountLabel(optionOrId, lang = 'en') {
  const option = typeof optionOrId === 'string' ? getMpAccountOption(optionOrId) : optionOrId;
  return lang === 'en' ? (option?.labelEn || 'Account') : (option?.labelIt || 'Account');
}
function getImportSourceOption(id) {
  return ACCOUNT_IMPORT_OPTIONS.find((o) => o.id === id || o.source === id) || ACCOUNT_IMPORT_OPTIONS[0];
}
function getCustomImportFormats(store) {
  const raw = store?.customImportFormats && typeof store.customImportFormats === 'object' ? store.customImportFormats : {};
  return Object.fromEntries(Object.values(raw).filter(Boolean).map(upgradeLegacyFormat).map((f) => [f.id, f]));
}
function customImportFormatToOption(format) {
  return {
    id: format.id,
    source: format.id,
    accountName: format.label || format.id,
    labelIt: format.label || format.id,
    labelEn: format.label || format.id,
    customFormat: format
  };
}
function getImportSourceOptions(store) {
  return [...ACCOUNT_IMPORT_OPTIONS, ...Object.values(getCustomImportFormats(store)).map(customImportFormatToOption)];
}
function getImportSourceOptionForStore(id, store) {
  return getImportSourceOptions(store).find((o) => o.id === id || o.source === id) || getImportSourceOption(id);
}
function accountImportLabel(optionOrId, lang = 'en') {
  const option = typeof optionOrId === 'string' ? getImportSourceOption(optionOrId) : optionOrId;
  return lang === 'en' ? (option?.labelEn || option?.accountName || 'Account') : (option?.labelIt || option?.accountName || 'Account');
}
function importerHouseholdOptions() {
  return { members: householdMembers(), sharedLabel: SHARED_HOLDER_LABEL };
}
function normalizeImportedTx(tx, sourceOptionOrId) {
  const option = typeof sourceOptionOrId === 'string' ? getImportSourceOption(sourceOptionOrId) : sourceOptionOrId;
  const source = option?.source || normalizeSource(tx.source || tx.accountName || 'amex');
  const optionHasExplicitAccount = (source === 'revolut' || source === 'mp') && option && option.id && (option.id === SHARED_HOLDER_KEY || !!getMember(option.id));
  const base = optionHasExplicitAccount ? { ...tx, accountName: option.accountName, accountScope: option.accountScope, holder: option.holder, personalFlag: option.personalFlag, split: option.split || null, accountOwnershipId: option.id } : tx;

  // Important: “shared” is a cashflow allocation flag, not always an account holder.
  // Amex rows keep the cardholder from the file; only genuinely shared bank accounts get holder=Shared.
  const accountIsShared = isSharedAccountTx({ ...base, source });
  const sharedForAllocation = isSharedTx(base);

  return {
    ...base,
    source,
    accountName: base.accountName || option?.accountName || sourceLabel(source),
    accountScope: accountIsShared ? SHARED_HOLDER_KEY : (base.accountScope || ''),
    accountOwnershipId: base.accountOwnershipId || base.accountScope || '',
    holder: accountIsShared ? SHARED_HOLDER_LABEL : canonicalHolderDisplay(base.holder || ''),
    personalFlag: base.personalFlag || (sharedForAllocation ? 'comune' : 'personale'),
    split: sharedForAllocation ? 'household' : null,
  };
}
function emptyAllocation() { return Object.fromEntries(householdMembers().map((m) => [m.id, 0])); }
// Splits an amount across household members: shared rows use the household split,
// personal rows go 100% to the holder (unmatched holders fall back to the first member).
function txUserAllocation(tx, amount = Number(tx?.amount || 0), store = null, idx = 0) {
  const effectiveFlag = store ? personalFlagForTx(tx, store, idx) : (tx?.personalFlag === 'comune' ? 'comune' : (tx?.personalFlag === 'personale' ? 'personale' : null));
  const out = emptyAllocation();
  const members = householdMembers();
  if (!members.length) return out;

  // When the UI is scoped to one person, shared transactions are already
  // transformed to that person's allocated share. Do not split them again.
  if (tx?.scopedAllocationFromShared) {
    const hk = holderKey(tx?.holder || '');
    if (getMember(hk)) { out[hk] = amount; return out; }
  }

  if (effectiveFlag === 'comune' || isSharedTx(tx)) {
    const shares = householdShares();
    members.forEach((m) => { out[m.id] = round2(amount * (shares[m.id] || 0)); });
    return out;
  }
  const hk = holderKey(tx?.holder || '');
  out[getMember(hk) ? hk : members[0].id] = amount;
  return out;
}

function sourceOptionsFromTransactions(transactions = []) {
  const found = new Set((transactions || []).map((tx) => normalizeSource(tx?.source || tx?.accountName || 'amex')));
  const builtIn = SOURCE_ORDER.filter((key) => found.has(key)).map((key) => ({ key, label: SOURCE_LABELS[key] }));
  const custom = [...found].filter(isCustomSource).sort().map((key) => ({ key, label: sourceLabel(key) }));
  return [...builtIn, ...custom];
}
function withDefaultTransactionSource(tx, importedAt = '') {
  const source = normalizeSource(tx?.source || tx?.accountName || 'amex');
  return {
    ...tx,
    source,
    accountName: tx?.accountName || sourceLabel(source),
    importedAt: tx?.importedAt || importedAt || '',
  };
}
function getImportHistory(store) {
  return Array.isArray(store?.importHistory) ? store.importHistory : [];
}
function formatImportTimestamp(value, lang = 'en') {
  if (!value) return '—';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return String(value);
  return d.toLocaleString(lang === 'it' ? 'it-IT' : 'en-GB', { dateStyle:'short', timeStyle:'short' });
}

function formatFinancialBreakdown(breakdown = {}, lang = 'en') {
  const labels = lang === 'it'
    ? { deposit: 'depositi', transfer: 'trasferimenti', exchange: 'cambi valuta', interest: 'interessi', income: 'entrate', internal_transfer: 'giroconti/trasferimenti interni', card_payment: 'pagamenti carta/estratti conto', investment: 'titoli/investimenti', zero_amount: 'zero', other: 'altro' }
    : { deposit: 'deposits', transfer: 'transfers', exchange: 'exchanges', interest: 'interest', income: 'income', internal_transfer: 'internal transfers', card_payment: 'card payments/statements', investment: 'securities/investments', zero_amount: 'zero', other: 'other' };
  return Object.entries(breakdown || {})
    .filter(([, value]) => Number(value || 0) > 0)
    .map(([key, value]) => `${labels[key] || key}: ${value}`)
    .join(' · ');
}
// ============================

const IT_MONTHS = [
  "Gen", "Feb", "Mar", "Apr", "Mag", "Giu",
  "Lug", "Ago", "Set", "Ott", "Nov", "Dic"
];
const EN_MONTHS = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"
];
function monthNames(lang) { return lang === 'it' ? IT_MONTHS : EN_MONTHS; }



const TARGET_STORE_VERSION = 6;
const EMPTY_STORE = { version: 5, meta: { baselineId: "empty" }, transactions: [], rules: [], overrideHistory: [] };

function normalizeText(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9+& ]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function pad2(n) { return String(n).padStart(2, "0"); }
function isoDate(d) { return `${d.getFullYear()}-${pad2(d.getMonth()+1)}-${pad2(d.getDate())}`; }
function round2(n) { return Math.round(((Number(n) || 0) + Number.EPSILON) * 100) / 100; }
function toValidDate(dateLike) {
  const d = typeof dateLike === "string" ? new Date(dateLike) : dateLike;
  return d instanceof Date && !Number.isNaN(d.getTime()) ? d : null;
}
function getCalendarKey(dateLike) {
  const d = toValidDate(dateLike);
  if (!d) return null;
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}`;
}
function getStatementPeriodKey(dateLike) {
  const d = toValidDate(dateLike);
  if (!d) return null;
  const year = d.getFullYear();
  const month = d.getMonth();
  const day = d.getDate();
  let endYear = year;
  let endMonth = month;
  if (day > 20) {
    endMonth += 1;
    if (endMonth > 11) { endMonth = 0; endYear += 1; }
  }
  const end = new Date(endYear, endMonth, 20);
  const start = new Date(endYear, endMonth - 1, 21);
  return `${isoDate(start)}_${isoDate(end)}`;
}
function getStatementPeriodRange(dateLike) {
  const key = getStatementPeriodKey(dateLike);
  if (!key) return null;
  const [start, end] = key.split("_");
  return { key, start, end };
}

function parseIsoDateStrict(value) {
  const m = String(value || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return null;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return Number.isNaN(d.getTime()) ? null : d;
}
function statementRangeFromKey(key) {
  const m = String(key || '').match(/^(\d{4})-(\d{2})-(\d{2})_(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return null;
  const start = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  const end = new Date(Number(m[4]), Number(m[5]) - 1, Number(m[6]));
  return Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) ? null : { start, end, key: String(key) };
}
function statementRangeDays(range) {
  if (!range?.start || !range?.end) return Infinity;
  return Math.round((range.end.getTime() - range.start.getTime()) / 86400000) + 1;
}
function isPlausibleStatementRange(range) {
  if (!range?.start || !range?.end) return false;
  const days = statementRangeDays(range);
  return days >= 25 && days <= 35 && range.start <= range.end;
}
function normalizeAmexStatementKeyForTx(tx) {
  if (normalizeSource(tx?.source || tx?.accountName || 'amex') !== 'amex') return { tx, fixed: false, reason: '' };
  const computedKey = getStatementPeriodKey(tx?.date);
  if (!computedKey) return { tx, fixed: false, reason: '' };
  const currentRange = statementRangeFromKey(tx?.statementKey);
  const computedRange = statementRangeFromKey(computedKey);
  const current = parseIsoDateStrict(tx?.date);
  const currentOk = currentRange && isPlausibleStatementRange(currentRange) && (!current || isDateInsideRange(current, currentRange));
  if (currentOk && tx.statementKey === currentRange.key) return { tx, fixed: false, reason: '' };
  if (!computedRange || !isPlausibleStatementRange(computedRange)) return { tx, fixed: false, reason: '' };
  return {
    tx: {
      ...tx,
      statementKey: computedKey,
      calendarKey: getCalendarKey(tx.date) || tx.calendarKey,
      amexStatementKeyGuardVersion: 'v25.3.2',
      amexStatementKeyGuardOriginal: tx.amexStatementKeyGuardOriginal || tx.statementKey || '',
      amexStatementKeyGuardFixedAt: new Date().toISOString()
    },
    fixed: tx.statementKey !== computedKey,
    reason: 'invalid_or_implausible_statement_key'
  };
}
function statementRangeFromSourceSheet(sheetName) {
  const clean = normalizeText(sheetName || '');
  const parts = clean.split(' ').filter(Boolean);
  const months = { gennaio:1, gen:1, january:1, jan:1, febbraio:2, feb:2, february:2, marzo:3, mar:3, march:3, aprile:4, apr:4, april:4, maggio:5, mag:5, may:5, giugno:6, giu:6, jun:6, june:6, luglio:7, lug:7, jul:7, july:7, agosto:8, ago:8, aug:8, august:8, settembre:9, set:9, sep:9, september:9, ottobre:10, ott:10, oct:10, october:10, novembre:11, nov:11, november:11, dicembre:12, dic:12, dec:12, december:12 };
  const hits = [];
  for (let i = 0; i < parts.length; i += 1) {
    const token = parts[i];
    const compact = token.match(/^([a-z]+)(\d{4})$/);
    if (compact && months[compact[1]]) hits.push({ month: months[compact[1]], year: Number(compact[2]) });
    if (months[token] && /^\d{4}$/.test(parts[i + 1] || '')) hits.push({ month: months[token], year: Number(parts[i + 1]) });
  }
  if (hits.length < 2) return null;
  const startHit = hits[0];
  const endHit = hits[hits.length - 1];
  const start = new Date(startHit.year, startHit.month - 1, 21);
  const end = new Date(endHit.year, endHit.month - 1, 20);
  return { start, end, key: `${isoDate(start)}_${isoDate(end)}` };
}
function isDateInsideRange(date, range) {
  if (!date || !range) return false;
  const t = date.getTime();
  return t >= range.start.getTime() && t <= range.end.getTime();
}
function fixAmexDateIfNeeded(tx) {
  if (normalizeSource(tx?.source || tx?.accountName || 'amex') !== 'amex') return { tx, fixed: false };
  const current = parseIsoDateStrict(tx?.date);
  if (!current) return { tx, fixed: false };
  const sheetRange = statementRangeFromSourceSheet(tx?.sourceSheet);
  const keyRange = statementRangeFromKey(tx?.statementKey);
  const authoritativeRange = isPlausibleStatementRange(sheetRange) ? sheetRange : (isPlausibleStatementRange(keyRange) ? keyRange : null);
  if (!authoritativeRange) {
    const normalized = normalizeAmexStatementKeyForTx(tx);
    return { tx: normalized.tx, fixed: normalized.fixed };
  }
  if (isDateInsideRange(current, authoritativeRange)) {
    const correctKey = authoritativeRange.key || tx.statementKey || getStatementPeriodKey(tx.date);
    const next = {
      ...tx,
      statementKey: correctKey,
      calendarKey: getCalendarKey(tx.date) || tx.calendarKey,
      amexDateGuardChecked: 'v24.10'
    };
    return { tx: next, fixed: false };
  }
  const swapped = new Date(current.getFullYear(), current.getDate() - 1, current.getMonth() + 1);
  if (!isDateInsideRange(swapped, authoritativeRange)) return { tx: { ...tx, amexDateGuardChecked: 'v24.10' }, fixed: false };
  const fixedDate = isoDate(swapped);
  const next = {
    ...tx,
    date: fixedDate,
    statementKey: authoritativeRange.key || getStatementPeriodKey(fixedDate) || tx.statementKey,
    calendarKey: getCalendarKey(fixedDate),
    amexDateGuardVersion: 'v24.10',
    amexDateGuardOriginalDate: tx.amexDateGuardOriginalDate || tx.date,
    amexDateGuardFixedAt: new Date().toISOString()
  };
  return { tx: next, fixed: true };
}
function applyAmexDateGuard(transactions = []) {
  let fixedCount = 0;
  let fixedStatementKeyCount = 0;
  const fixedDates = {};
  const fixedStatementKeys = {};
  const next = (transactions || []).map((tx) => {
    const dateResult = fixAmexDateIfNeeded(tx);
    const keyResult = normalizeAmexStatementKeyForTx(dateResult.tx);
    if (dateResult.fixed) {
      fixedCount += 1;
      const key = `${tx.date}->${dateResult.tx.date}`;
      fixedDates[key] = (fixedDates[key] || 0) + 1;
    }
    if (keyResult.fixed) {
      fixedStatementKeyCount += 1;
      const key = `${dateResult.tx.statementKey || ''}->${keyResult.tx.statementKey || ''}`;
      fixedStatementKeys[key] = (fixedStatementKeys[key] || 0) + 1;
    }
    return keyResult.tx;
  });
  return { transactions: next, fixedCount, fixedDates, fixedStatementKeyCount, fixedStatementKeys };
}
function isCalendarMonthKey(key) { return /^\d{4}-\d{2}$/.test(String(key || '')); }
function isStatementPeriodKey(key) { return /^\d{4}-\d{2}-\d{2}_\d{4}-\d{2}-\d{2}$/.test(String(key || '')); }
function monthLabelFromParts(y, m, lang = 'en') {
  if (!y || !m) return '';
  return `${monthNames(lang)[Number(m) - 1] || String(m)}-${String(y).slice(2)}`;
}
function periodEndParts(key) {
  if (!key) return null;
  if (isCalendarMonthKey(key)) {
    const [y, m] = String(key).split('-').map(Number);
    return { y, m };
  }
  if (isStatementPeriodKey(key)) {
    const [y, m] = String(key).split('_')[1].split('-').map(Number);
    return { y, m };
  }
  return null;
}
function periodKeyForTx(tx, viewMode = 'statement') {
  if (!tx) return '';
  if (viewMode === 'calendar') return getCalendarKey(tx.date);
  const statementKey = tx.statementKey || '';
  return isStatementPeriodKey(statementKey) ? statementKey : getStatementPeriodKey(tx.date);
}
function formatCalendarLabel(key, lang = 'en') {
  const parts = periodEndParts(key);
  return parts ? monthLabelFromParts(parts.y, parts.m, lang) : String(key || '');
}
function formatStatementLabel(key, lang = 'en') {
  const parts = periodEndParts(key);
  return parts ? monthLabelFromParts(parts.y, parts.m, lang) : String(key || '');
}
function periodLabel(key, viewMode, lang = 'en') {
  const parts = periodEndParts(key);
  return parts ? monthLabelFromParts(parts.y, parts.m, lang) : String(key || '');
}
function periodDropdownLabel(key, viewMode, lang = 'en') {
  return periodLabel(key, viewMode, lang);
}
function formatStatementRangeLabel(startKey, endKey, lang = 'en') {
  const first = startKey || endKey;
  const last = endKey || startKey;
  if (!first && !last) return '';
  const parseStatementBoundary = (key, which) => {
    if (!key || !/^\d{4}-\d{2}-\d{2}_\d{4}-\d{2}-\d{2}$/.test(key)) return null;
    const part = key.split('_')[which === 'end' ? 1 : 0];
    const [y, m, d] = part.split('-').map(Number);
    return new Date(y, m - 1, d);
  };
  const fmt = (date, includeYear = true) => {
    if (!date) return '';
    const month = monthNames(lang)[date.getMonth()];
    const base = `${month} ${date.getDate()}`;
    return includeYear ? `${base}, ${date.getFullYear()}` : base;
  };
  const start = parseStatementBoundary(first, 'start');
  const end = parseStatementBoundary(last, 'end');
  if (!start || !end) return [periodLabel(first, 'statement', lang), periodLabel(last, 'statement', lang)].filter(Boolean).join(' → ');
  if (first === last) {
    const sameYear = start.getFullYear() === end.getFullYear();
    return `${fmt(start, !sameYear)}–${fmt(end, true)}`;
  }
  return `${fmt(start, true)} → ${fmt(end, true)}`;
}
function formatCalendarRangeLabel(startKey, endKey, lang = 'en') {
  const first = startKey || endKey;
  const last = endKey || startKey;
  if (!first && !last) return '';
  if (first === last) return formatCalendarLabel(first, lang);
  return `${formatCalendarLabel(first, lang)} → ${formatCalendarLabel(last, lang)}`;
}
function formatRangeLabel(startKey, endKey, viewMode, lang = 'en') {
  return viewMode === 'calendar' ? formatCalendarRangeLabel(startKey, endKey, lang) : formatStatementRangeLabel(startKey, endKey, lang);
}
function sortPeriodKeys(keys, viewMode) {
  return [...keys].sort((a, b) => {
    const pa = periodEndParts(a);
    const pb = periodEndParts(b);
    const va = pa ? pa.y * 100 + pa.m : String(a || '');
    const vb = pb ? pb.y * 100 + pb.m : String(b || '');
    return va > vb ? 1 : va < vb ? -1 : String(a).localeCompare(String(b));
  });
}

function detectSubscription(desc) {
  const t = normalizeText(desc);
  if (t.includes("quota associativa mensile")) return "Quota Assoc.";
  if (t.includes("netflix")) return "Netflix";
  if (t.includes("sky italia") || t.includes("sky it ")) return "Sky Italia";
  if (t.includes("spotify")) return "Spotify";
  if (t.includes("mubi")) return "MUBI";
  if (t.includes("disney+")) return "Disney+";
  if (t.includes("nordvpn")) return "NordVPN";
  if (t.includes("n8n")) return "n8n Cloud";
  if (t.includes("chatgpt") || t.includes("openai")) return "ChatGPT";
  if (t.includes("amazon prime") || t.includes("prime video") || t.includes("negozio prime video")) return "Amazon Prime";
  if (t.includes("apple com bill") || t.includes("apple.com bill") || t.includes("apple services") || t.includes("apple com") || t.includes("apple bill")) return "Apple";
  return null;
}

function categorize(desc) {
  const t = normalizeText(desc);
  if (t.includes("quota associativa mensile")) return "quota_assoc";
  if (["glovo", "deliveroo", "uber eats"].some(k => t.includes(k))) return "delivery";
  if (["sky italia", "sky it "].some(k => t.includes(k))) return "tv";
  if (["airbnb", "hotel", "booking com", "booking.com", "albergo", "hostel"].some(k => t.includes(k))) return "hotel";
  if (["ita airways", "ryanair", "klm", "british airways", "iberia", "cathay", "skymark", "easyjet", "wizzair", "lufthansa", "air france"].some(k => t.includes(k))) return "voli";
  if (["uber trip", "taxi", "cabvision", "radiotaxi", "it taxi", "taxis on booking"].some(k => t.includes(k))) return "trasporti";
  if (["telepass", "autogrill", "cless ticket", "parking", "parcheggio", "autostrade", "trenitalia", "italo", "metro"].some(k => t.includes(k))) return "trasporti";
  if (["farmacia", "pharmacy", "clinica", "clinic", "ospedal", "hospital", "medic", "doctor", "dentist"].some(k => t.includes(k))) return "salute";
  if (["ristor", "restaurant", "pizzeria", "bar ", " sushi", "trattoria", "osteria", "caffe", "caf e", "cafe", "bistro", "gelateria"].some(k => t.includes(k)) || t.startsWith("bar ")) return "ristoranti";
  if (["esselunga", "carrefour", "coop", "eataly", "acqua e sapone", "supermerc", "supermarket", "pam", "conad", "lidl", "aldi", "market", "tesco", "spar"].some(k => t.includes(k))) return "supermercato";
  if (["amazon", "amzn", "kindle svcs"].some(k => t.includes(k))) return "amazon";
  if (["netflix", "disney+", "apple", "spotify", "mubi", "openai", "chatgpt", "kindle", "n8n", "nordvpn", "amazon prime", "prime video"].some(k => t.includes(k))) return "streaming_tech";
  if (["parrucch", "hairdress", "estet", "fisioter", "physio", "spa ", "treatwell", "gym", "palestra"].some(k => t.includes(k))) return "benessere";
  return "altro";
}


const PHONE_COUNTRIES = [
  { code:'IT', name:'Italia', prefix:'+39' }, { code:'US', name:'United States', prefix:'+1' }, { code:'GB', name:'United Kingdom', prefix:'+44' },
  { code:'ES', name:'España', prefix:'+34' }, { code:'FR', name:'France', prefix:'+33' }, { code:'DE', name:'Deutschland', prefix:'+49' },
  { code:'CH', name:'Schweiz', prefix:'+41' }, { code:'NL', name:'Nederland', prefix:'+31' }, { code:'IE', name:'Ireland', prefix:'+353' }, { code:'JP', name:'Japan', prefix:'+81' }
];
function userIdFromName(name) {
  return String(name || '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'user';
}
// Rewrites holders to the configured member display names; genuinely shared accounts become "Shared".
function canonicalizeTransactionHolders(transactions = []) {
  return (transactions || []).map((tx) => {
    const sharedAccount = isSharedAccountTx(tx);
    const sharedAllocation = isSharedTx(tx);
    const nextHolder = (sharedAccount && !tx?.holderManualOverrideV2413) ? SHARED_HOLDER_LABEL : canonicalHolderDisplay(tx?.holder || '');
    const patch = {};
    if (nextHolder && tx?.holder !== nextHolder) patch.holder = nextHolder;
    if (sharedAccount && tx?.accountScope !== SHARED_HOLDER_KEY) patch.accountScope = SHARED_HOLDER_KEY;
    if (sharedAllocation) {
      patch.personalFlag = normalizePersonalFlag(tx.personalFlag || 'comune');
      if (tx?.split !== 'household') patch.split = 'household';
    } else if (tx?.split) {
      patch.split = null;
    }
    return Object.keys(patch).length ? { ...tx, ...patch } : tx;
  });
}
// Login accounts (users) are separate from household members. Credentials live only on the server.
function ensureUsers(store) {
  const users = store?.users && typeof store.users === 'object' ? { ...store.users } : {};
  const ids = Object.keys(users);
  if (ids.length && !ids.some((id) => users[id]?.role === 'admin')) users[ids[0]] = { ...users[ids[0]], role: 'admin' };
  ids.forEach((id) => { if (!users[id].role) users[id] = { ...users[id], role: id === ids[0] ? 'admin' : 'user' }; });
  return users;
}
function getUsers(store) { return ensureUsers(store); }
function validateEmail(value) {
  const v = String(value || '').trim();
  return !v || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v);
}
function downloadJson(filename, data) {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type:'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function safeFilePart(value) {
  return String(value || 'backup').trim().toLowerCase().replace(/[^a-z0-9]+/gi, '-').replace(/^-+|-+$/g, '').slice(0, 64) || 'backup';
}

const DEFAULT_RULES = [];
function txId(tx, idx = 0) { return tx?.ref || [tx?.date || '', tx?.holder || '', tx?.amount || '', tx?.desc || '', idx].join('|'); }
function stableIncomeTxKey(tx) {
  return [
    tx?.ref || '',
    tx?.date || '',
    tx?.holder || '',
    tx?.amount ?? '',
    tx?.desc || tx?.description || '',
    tx?.statementKey || '',
    tx?.source || '',
    tx?.accountName || ''
  ].map((part) => String(part).trim()).join('|');
}
function rowKey(tx, idx = 0) { return tx?.incomeRowKey || stableIncomeTxKey(tx) || txId(tx, idx); }
function makeRuleId() { return 'rule-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8); }
function getRules(store) { return Array.isArray(store?.rules) ? store.rules : DEFAULT_RULES; }
function getOverrides(store) { return store?.categoryOverrides && typeof store.categoryOverrides === 'object' ? store.categoryOverrides : {}; }
function getTimeMachineBackups(store) {
  return Array.isArray(store?.timeMachineBackups)
    ? [...store.timeMachineBackups].filter((item) => item?.snapshot && Array.isArray(item.snapshot.transactions)).sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')))
    : [];
}
function snapshotStoreForTimeMachine(store) {
  const snapshot = normalizeStoreShape(store || {});
  delete snapshot.timeMachineBackups;
  snapshot.meta = { ...(snapshot.meta || {}), timeMachineSnapshot: true, timeMachineSnapshotCreatedAt: new Date().toISOString() };
  return snapshot;
}
function summarizeTimeMachineSnapshot(snapshot) {
  return {
    transactions: Array.isArray(snapshot?.transactions) ? snapshot.transactions.length : 0,
    rules: Array.isArray(snapshot?.rules) ? snapshot.rules.length : 0,
    customCategories: snapshot?.customCategories && typeof snapshot.customCategories === 'object' ? Object.keys(snapshot.customCategories).length : 0,
    formats: snapshot?.customImportFormats && typeof snapshot.customImportFormats === 'object' ? Object.keys(snapshot.customImportFormats).length : 0
  };
}
function makeTimeMachineBackup(store, name, userId) {
  const createdAt = new Date().toISOString();
  const snapshot = snapshotStoreForTimeMachine(store);
  return {
    id: 'tm-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8),
    name: String(name || '').trim() || 'Backup ' + new Date(createdAt).toLocaleString('it-IT', { dateStyle:'short', timeStyle:'short' }),
    createdAt,
    createdBy: userId || '',
    summary: summarizeTimeMachineSnapshot(snapshot),
    snapshot
  };
}

function isPersonalCategory(value) {
  const key = normalizeCategoryKey(value || '');
  return key === 'personale' || key === 'personal';
}
function normalizePersonalFlag(value) {
  return String(value || '').toLowerCase() === 'personale' ? 'personale' : 'comune';
}
function heuristicCategoryForFormerPersonal(tx) {
  const t = normalizeText(tx?.desc || tx?.description || '');
  if (t.includes('amazon') || t.includes('amzn')) return 'amazon';
  if (['ristorante', 'ristor', 'bar', 'caffe', 'cafe', 'caf e'].some(k => t.includes(k)) || t.startsWith('bar ')) return 'ristoranti';
  if (['uber', 'taxi', 'train', 'metro', 'trenitalia', 'cless ticket'].some(k => t.includes(k))) return 'trasporti';
  if (['hotel', 'booking'].some(k => t.includes(k))) return 'hotel';
  return 'altro';
}
function rulePersonalFlag(rule) {
  if (!rule) return null;
  if (rule.personalFlag === 'personale' || rule.personalFlag === 'comune') return rule.personalFlag;
  if (rule.setPersonalFlag === 'personale' || rule.setPersonalFlag === 'comune') return rule.setPersonalFlag;
  if (rule.action?.personalFlag === 'personale' || rule.action?.personalFlag === 'comune') return rule.action.personalFlag;
  if (isPersonalCategory(rule.category)) return 'personale';
  return null;
}
function ruleCategory(rule) {
  if (!rule) return null;
  const category = rule.category || rule.action?.category || '';
  if (!category || isPersonalCategory(category)) return null;
  return category;
}
function ruleCashflowType(rule) {
  if (!rule) return '';
  return normalizeCashflowTypeValue(rule.cashflowType || rule.action?.cashflowType || '');
}
function personalFlagForTx(tx, store, idx = 0) {
  const storedFlag = tx?.personalFlag === 'personale' || tx?.personalFlag === 'comune' ? tx.personalFlag : null;
  if (tx?.personalFlagManualOverrideV19 && storedFlag) return storedFlag;
  const rule = getRules(store).find((r) => ruleMatches(r, tx, store, idx));
  return rulePersonalFlag(rule) || storedFlag || 'comune';
}
function applyPersonalFlagMigration(store) {
  if (!store || typeof store !== 'object') return store;
  const alreadyRan = !!store.meta?.personalFlagMigrationV19;
  let migrated = 0;
  const nextTx = (store.transactions || []).map((tx, idx) => {
    const currentFlag = normalizePersonalFlag(tx.personalFlag);
    if (alreadyRan || tx.personalFlag === 'personale' || tx.personalFlag === 'comune') return { ...tx, personalFlag: currentFlag };
    const effectiveStoredCategory = tx.category || tx.ruleCategory || '';
    if (!isPersonalCategory(effectiveStoredCategory)) return { ...tx, personalFlag: currentFlag };
    migrated += 1;
    const nextCategory = heuristicCategoryForFormerPersonal(tx);
    const out = { ...tx, personalFlag: 'personale', migratedFromPersonaleCategoryV19: true };
    if (isPersonalCategory(out.category)) out.category = nextCategory;
    if (isPersonalCategory(out.ruleCategory)) out.ruleCategory = nextCategory;
    return out;
  });
  const nextRules = (store.rules || []).map((r) => {
    if (!isPersonalCategory(r.category)) return r;
    return { ...r, category: 'altro', personalFlag: r.personalFlag || 'personale', migratedFromPersonaleCategoryV19: true };
  });
  const customCategories = { ...(store.customCategories || {}) };
  const categoryCustomizations = { ...(store.categoryCustomizations || {}) };
  Object.keys(customCategories).forEach((key) => { if (isPersonalCategory(key)) delete customCategories[key]; });
  Object.keys(categoryCustomizations).forEach((key) => { if (isPersonalCategory(key)) delete categoryCustomizations[key]; });
  return {
    ...store,
    transactions: nextTx,
    rules: nextRules,
    customCategories,
    categoryCustomizations,
    meta: { ...(store.meta || {}), personalFlagMigrationV19: true, personalFlagMigrationV19At: store.meta?.personalFlagMigrationV19At || new Date().toISOString(), personalFlagMigrationV19Count: store.meta?.personalFlagMigrationV19Count ?? migrated }
  };
}
function filterTransactionsByPersonalFlag(transactions, filter, store) {
  if (!filter || filter === 'ALL') return transactions || [];
  const wanted = filter === 'personale' ? 'personale' : 'comune';
  return (transactions || []).filter((tx, idx) => personalFlagForTx(tx, store, idx) === wanted);
}
function filterTransactionsByPersonalFlags(transactions, filters, store) {
  const active = Array.isArray(filters) ? filters.filter(Boolean) : [];
  if (!active.length || active.length >= 2) return transactions || [];
  const allowed = new Set(active.map((x) => x === 'personale' ? 'personale' : 'comune'));
  return (transactions || []).filter((tx, idx) => allowed.has(personalFlagForTx(tx, store, idx)));
}
function filterTransactionsBySources(transactions, filters) {
  const active = Array.isArray(filters) ? filters.filter(Boolean) : [];
  if (!active.length) return transactions || [];
  const allowed = new Set(active.map(normalizeSource));
  return (transactions || []).filter(tx => allowed.has(normalizeSource(tx?.source || tx?.accountName || 'amex')));
}
function filterTransactionsByCategories(transactions, filters, store) {
  const active = Array.isArray(filters) ? filters.filter(Boolean) : [];
  if (active.includes('__NONE__')) return [];
  if (!active.length) return transactions || [];
  const allowed = new Set(active);
  return (transactions || []).filter((tx, idx) => allowed.has(categoryForTx(tx, store, idx)));
}
function toggleFilterValue(current, value, allValues = []) {
  const active = Array.isArray(current) ? current.filter(Boolean) : [];
  if (!active.length) return [value];
  const exists = active.includes(value);
  const next = exists ? active.filter((x) => x !== value) : [...active, value];
  const all = (allValues || []).filter(Boolean);
  if (!next.length) return [];
  if (all.length && next.length >= all.length && all.every((x) => next.includes(x))) return [];
  return next;
}
function isFilterValueSelected(current, value) {
  const active = Array.isArray(current) ? current.filter(Boolean) : [];
  return !active.length || active.includes(value);
}
function isCategoryFilterValueSelected(current, value) {
  const active = Array.isArray(current) ? current.filter(Boolean) : [];
  if (active.includes('__NONE__')) return false;
  return !active.length || active.includes(value);
}
function toggleCategoryFilterValue(current, value, allValues = []) {
  const all = (allValues || []).filter(Boolean);
  const active = Array.isArray(current) ? current.filter(Boolean) : [];
  if (active.includes('__NONE__')) return [value];
  if (!active.length) return all.filter((x) => x !== value);
  const exists = active.includes(value);
  const next = exists ? active.filter((x) => x !== value) : [...active, value];
  if (!next.length) return ['__NONE__'];
  if (all.length && next.length >= all.length && all.every((x) => next.includes(x))) return [];
  return next;
}
function toggleAllCategoryFilters(current) {
  const active = Array.isArray(current) ? current.filter(Boolean) : [];
  return active.length ? [] : ['__NONE__'];
}
function isAllCategoriesActive(current) {
  const active = Array.isArray(current) ? current.filter(Boolean) : [];
  return !active.length;
}
function summarizeMultiFilterLabel(active, allLabel, labelsByKey = {}, lang = 'en') {
  const list = Array.isArray(active) ? active.filter(Boolean) : [];
  if (!list.length) return allLabel;
  if (list.includes('__NONE__')) return tr(lang, 'noneSelected');
  if (list.length <= 2) return list.map((x) => labelsByKey[x] || x).join(', ');
  return `${list.length} ${tr(lang, 'selectedCount')}`;
}
function normalizeStoreShape(data) {
  const rawBase = data && Array.isArray(data.transactions) ? data : { version: TARGET_STORE_VERSION, meta: {}, transactions: [], rules: DEFAULT_RULES, categoryOverrides: {}, overrideHistory: [], customCategories: {}, categoryCustomizations: {} };
  const base = mergeViabilitaToTrasporti(rawBase);
  const household = setActiveHousehold(base.household);
  setActiveCustomFormats(getCustomImportFormats(base));
  const guarded = applyAmexDateGuard(base.transactions || []);
  const baseUsers = base.users && typeof base.users === 'object' ? base.users : {};
  const normalizedTransactions = canonicalizeTransactionHolders(guarded.transactions || [])
    .map((tx) => normalizeCashflowTransaction(withDefaultTransactionSource(tx), base));
  const shaped = { ...base, household, users: baseUsers, version: Math.max(Number(base.version || 0), TARGET_STORE_VERSION), rules: Array.isArray(base.rules) ? base.rules : DEFAULT_RULES, categoryOverrides: getOverrides(base), overrideHistory: Array.isArray(base.overrideHistory) ? base.overrideHistory : [], incomeLearningRules: getIncomeLearningRules(base), customCategories: getCustomCategories(base), categoryCustomizations: getCategoryCustomizations(base), importHistory: getImportHistory(base), transactions: normalizedTransactions, meta: { ...(base.meta || {}), viabilitaMergedIntoTrasporti: true, amexDateGuardVersion: 'v25.3.2', amexDateGuardLastFixedCount: guarded.fixedCount || 0, amexDateGuardLastFixedDates: guarded.fixedDates || {}, amexDateGuardFixedTotal: Number(base.meta?.amexDateGuardFixedTotal || 0) + Number(guarded.fixedCount || 0), amexStatementKeyGuardVersion: 'v25.3.2', amexStatementKeyGuardLastFixedCount: guarded.fixedStatementKeyCount || 0, amexStatementKeyGuardLastFixedKeys: guarded.fixedStatementKeys || {}, amexStatementKeyGuardFixedTotal: Number(base.meta?.amexStatementKeyGuardFixedTotal || 0) + Number(guarded.fixedStatementKeyCount || 0) } }; const migrated = applyPersonalFlagMigration(shaped); return { ...migrated, users: ensureUsers(migrated), importHistory: getImportHistory(migrated) };
}
function baseCategoryForRuleMatch(tx, store, idx = 0) {
  const override = getOverrides(store)[txId(tx, idx)];
  if (override && !isPersonalCategory(override)) return override;
  if (tx?.ruleCategory && !isPersonalCategory(tx.ruleCategory)) return tx.ruleCategory;
  if (tx?.category && !isPersonalCategory(tx.category)) return tx.category;
  if (override && isPersonalCategory(override)) return heuristicCategoryForFormerPersonal(tx);
  return categorize(tx?.desc || '');
}
function getTxFieldValue(tx, field, store, idx = 0) {
  const safeField = String(field || 'desc');
  if (safeField === 'category' || safeField === 'effectiveCategory') {
    const key = baseCategoryForRuleMatch(tx, store, idx);
    const label = getCategoryConfig(store)[key]?.label || key;
    return `${key} ${label}`;
  }
  if (safeField === 'personalFlag') return normalizePersonalFlag(tx?.personalFlag);
  if (safeField === 'subscription') return detectSubscription(tx?.desc || '') || '';
  if (safeField === 'calendarKey') return getCalendarKey(tx?.date);
  if (safeField === '__all__') {
    const key = baseCategoryForRuleMatch(tx, store, idx);
    const label = getCategoryConfig(store)[key]?.label || key;
    return [
      tx?.date, tx?.desc, tx?.holder, tx?.paese, tx?.amount,
      key, label, normalizePersonalFlag(tx?.personalFlag),
      detectSubscription(tx?.desc || ''), getCalendarKey(tx?.date),
      tx?.statementKey || getStatementPeriodKey(tx?.date), tx?.ref
    ].filter((v) => v !== null && v !== undefined && v !== '').join(' ');
  }
  return tx?.[safeField] ?? '';
}
function getRuleFieldOptions(_transactions = [], lang = 'en') {
  const labels = lang === 'it'
    ? { __all__: 'Tutti i campi visibili', desc: 'Descrizione', category: 'Categoria attuale', holder: 'Titolare', paese: 'Paese', amount: 'Importo', date: 'Data', personalFlag: 'Flag personale', subscription: 'Abbonamento rilevato', calendarKey: 'Periodo calendario', statementKey: 'Periodo Amex', ref: 'Riferimento' }
    : { __all__: 'All visible fields', desc: 'Description', category: 'Current category', holder: 'Holder', paese: 'Country', amount: 'Amount', date: 'Date', personalFlag: 'Personal flag', subscription: 'Detected subscription', calendarKey: 'Calendar period', statementKey: 'Amex period', ref: 'Reference' };
  const ordered = ['__all__', 'desc', 'category', 'holder', 'paese', 'amount', 'date', 'personalFlag', 'subscription', 'calendarKey', 'statementKey', 'ref'];
  return ordered.map((key) => ({ key, label: labels[key] || key }));
}
function ruleMatches(rule, tx, store, idx = 0) {
  if (!rule?.enabled) return false;
  const haystack = normalizeText(String(getTxFieldValue(tx, rule.field, store, idx) ?? ''));
  const needle = normalizeText(rule.value);
  if (!needle) return false;
  if (rule.operator === 'equals') return haystack === needle;
  if (rule.operator === 'startsWith') return haystack.startsWith(needle);
  if (rule.operator === 'endsWith') return haystack.endsWith(needle);
  return haystack.includes(needle);
}
function categoryForTx(tx, store, idx = 0) {
  const override = getOverrides(store)[txId(tx, idx)];
  if (override && !isPersonalCategory(override)) return override;
  const rule = getRules(store).find((r) => ruleMatches(r, tx, store, idx));
  const fromRule = ruleCategory(rule);
  if (fromRule) return fromRule;
  if (tx?.ruleCategory && !isPersonalCategory(tx.ruleCategory)) return tx.ruleCategory;
  if (tx?.category && !isPersonalCategory(tx.category)) return tx.category;
  if (override && isPersonalCategory(override)) return heuristicCategoryForFormerPersonal(tx);
  return categorize(tx?.desc || '');
}
const RULE_SIGNATURE_NOISE_WORDS = new Set(['www','com','it','bill','https','http','help','web','online','store','shop','payment','payments']);
const RULE_SIGNATURE_TRAILING_LOCATIONS = new Set(['milano','milan','roma','rome','torino','venezia','bologna','napoli','firenze','seattle','london','tokyo','osaka','amsterdam','madrid','barcelona','italy','spain','united','kingdom','states','netherlands','luxembourg','japan']);
function isLikelyProcessorCode(token) {
  if (!token) return true;
  if (/^\d+$/.test(token)) return true;
  if (/^(at|id|ref)?\d{5,}$/i.test(token)) return true;
  if (/^(\d+[a-z]+|[a-z]+\d+)[a-z0-9]*$/i.test(token) && token.length >= 5) return true;
  return false;
}
function isUsefulRuleSignature(signature) {
  const tokens = normalizeText(signature).split(' ').filter(Boolean);
  if (!tokens.length) return false;
  const meaningful = tokens.filter((t) => !RULE_SIGNATURE_NOISE_WORDS.has(t) && !isLikelyProcessorCode(t) && /[a-z]/.test(t));
  if (!meaningful.length) return false;
  if (meaningful.join(' ').length < 4) return false;
  return true;
}
function merchantSignature(desc) {
  const tokens = normalizeText(desc).split(' ').filter(Boolean);
  const kept = [];
  for (const token of tokens) {
    if (RULE_SIGNATURE_NOISE_WORDS.has(token)) continue;
    if (isLikelyProcessorCode(token)) continue;
    if (kept[kept.length - 1] === token) continue;
    if (kept.includes(token) && token.length >= 4) continue;
    kept.push(token);
  }
  while (kept.length > 1 && RULE_SIGNATURE_TRAILING_LOCATIONS.has(kept[kept.length - 1])) kept.pop();
  const candidate = kept.slice(0, 5).join(' ').trim();
  if (isUsefulRuleSignature(candidate)) return candidate;
  const fallback = tokens.filter((t) => !RULE_SIGNATURE_NOISE_WORDS.has(t)).slice(0, 4).join(' ').trim();
  return isUsefulRuleSignature(fallback) ? fallback : '';
}
function getRuleSuggestions(store) {
  const grouped = {};
  const dismissed = new Set(store?.dismissedSuggestions || []);
  const addSuggestion = ({ desc, signature: rawSignature, category, personalFlag }) => {
    const signature = merchantSignature(desc || rawSignature || '');
    if (!signature || !isUsefulRuleSignature(signature)) return;
    const flag = personalFlag === 'personale' || personalFlag === 'comune' ? personalFlag : (isPersonalCategory(category) ? 'personale' : 'no_change');
    const cat = isPersonalCategory(category) ? '' : String(category || '').trim();
    if (!cat && flag === 'no_change') return;
    const actionKey = cat ? `cat:${cat}` : `flag:${flag}`;
    const key = normalizeText(signature) + '|' + actionKey;
    if (!grouped[key]) grouped[key] = { signature, category: cat, personalFlag: flag, count: 0 };
    grouped[key].count += 1;
  };
  for (const item of store?.overrideHistory || []) addSuggestion(item);
  for (const item of store?.personalFlagOverrideHistory || []) addSuggestion({ ...item, personalFlag: normalizePersonalFlag(item.personalFlag) });
  const existing = new Set(getRules(store).map((r) => {
    const cat = ruleCategory(r) || '';
    const flag = rulePersonalFlag(r) || 'no_change';
    const actionKey = cat ? `cat:${cat}` : `flag:${flag}`;
    return normalizeText(r.value) + '|' + actionKey;
  }));
  return Object.values(grouped)
    .filter((x) => {
      const actionKey = x.category ? `cat:${x.category}` : `flag:${x.personalFlag}`;
      const key = normalizeText(x.signature) + '|' + actionKey;
      return x.count >= 3 && !existing.has(key) && !dismissed.has(key);
    })
    .sort((a,b) => b.count - a.count);
}
function applyRulesRetroactively(store) {
  let changed = 0;
  const overrides = getOverrides(store);
  const nextTx = (store.transactions || []).map((tx, idx) => {
    const rule = getRules(store).find((r) => ruleMatches(r, tx, store, idx));
    const baseFlag = normalizePersonalFlag(tx.personalFlag);
    if (!rule) return { ...tx, personalFlag: baseFlag };
    const patch = { ruleId: rule.id };
    if (!tx.personalFlagManualOverrideV19) {
      patch.personalFlag = rulePersonalFlag(rule) || baseFlag;
    } else {
      patch.personalFlag = baseFlag;
    }
    if (!overrides[txId(tx, idx)]) {
      const cat = ruleCategory(rule);
      if (cat) patch.ruleCategory = cat;
    }
    if (!tx.cashflowManualOverrideAt) {
      const cashflowType = ruleCashflowType(rule);
      if (cashflowType) {
        patch.ruleCashflowType = cashflowType;
        patch.excludeFromCashflow = cashflowType !== 'expense';
        patch.excludeReason = cashflowType === 'excluded' ? 'rule' : '';
        if (cashflowType === 'income') patch.incomeManualOverride = 'income';
        else if (tx.incomeManualOverride === 'income') patch.incomeManualOverride = '';
      }
    }
    const next = { ...tx, ...patch };
    if (next.ruleCategory !== tx.ruleCategory || next.ruleId !== tx.ruleId || next.personalFlag !== tx.personalFlag || next.ruleCashflowType !== tx.ruleCashflowType) changed += 1;
    return next;
  });
  return { ...store, transactions: nextTx, meta: { ...(store.meta || {}), lastRetroAppliedAt: new Date().toISOString(), lastRetroAppliedCount: changed } };
}

function isAutoExcludedCashflowDesc(desc) {
  const t = normalizeText(desc);
  return t.includes("addebito in c c salvo buon fine")
    || (t.includes("saldo") && (t.includes("carta") || t.includes("american express") || t.includes("amex")));
}
const CASHFLOW_TYPES = new Set(['expense', 'income', 'excluded']);
function normalizeCashflowTypeValue(value) {
  const normalized = String(value || '').toLowerCase().trim();
  return CASHFLOW_TYPES.has(normalized) ? normalized : '';
}
function legacyIncomeOverrideForCashflowType(type) {
  return normalizeCashflowTypeValue(type) === 'income' ? 'income' : 'not_income';
}
function cashflowTypeFromIncomeLearningRule(rule) {
  const cashflowType = normalizeCashflowTypeValue(rule?.cashflowType);
  if (cashflowType) return cashflowType;
  if (rule?.override === 'income') return 'income';
  if (rule?.override === 'not_income') return 'excluded';
  return '';
}
function cashflowPatchForType(type, now = new Date().toISOString()) {
  const cashflowType = normalizeCashflowTypeValue(type) || 'expense';
  const incomeOverride = legacyIncomeOverrideForCashflowType(cashflowType);
  return {
    cashflowType,
    excludeFromCashflow: cashflowType !== 'expense',
    excludeReason: cashflowType === 'excluded' ? 'manual' : '',
    cashflowManualOverrideAt: now,
    incomeManualOverride: incomeOverride,
    incomeManualOverrideAt: now,
  };
}
function isIncomeAutoBlockedTx(tx) {
  const desc = normalizeText(tx?.desc || tx?.description || '');
  return isAutoExcludedCashflowDesc(desc) || INCOME_AUTO_EXCLUDE_PATTERNS.some((p) => desc.includes(p));
}
function strongIncomeCategoryRuleForTx(tx) {
  const desc = normalizeText(tx?.desc || tx?.description || '');
  if (!desc || isIncomeAutoBlockedTx(tx)) return null;
  return INCOME_CATEGORY_RULES.find((rule) => rule.patterns.some((p) => desc.includes(p))) || null;
}
function cashflowTypeForTx(tx, store = null) {
  const explicit = normalizeCashflowTypeValue(tx?.cashflowType);
  const amount = Number(tx?.amount || 0);
  if (!Number.isFinite(amount) || amount === 0) return 'excluded';
  if (tx?.cashflowManualOverrideAt && explicit) return explicit;
  if (tx?.incomeManualOverride === 'income') return 'income';
  if (tx?.incomeManualOverride === 'not_income') return 'excluded';
  if (tx?.cashflowManualOverrideAt && tx?.excludeFromCashflow === false) return 'expense';
  const learnedType = cashflowTypeFromIncomeLearningRule(latestIncomeLearningRuleForTx(store, tx));
  if (learnedType === 'expense' || learnedType === 'excluded') return learnedType;
  if (learnedType === 'income') return 'income';
  const ruleType = normalizeCashflowTypeValue(tx?.ruleCashflowType) || ruleCashflowType(getRules(store).find((r) => ruleMatches(r, tx, store)));
  if (ruleType) return ruleType;
  if (explicit) return explicit;
  if (tx?.excludeFromCashflow === true) return 'excluded';
  return 'expense';
}
function normalizeCashflowTransaction(tx, store = null) {
  if (!tx || typeof tx !== 'object') return tx;
  const cashflowType = cashflowTypeForTx(tx, store);
  return {
    ...tx,
    cashflowType,
    excludeFromCashflow: cashflowType !== 'expense',
    excludeReason: cashflowType === 'excluded' ? (tx.excludeReason || 'manual') : '',
    incomeManualOverride: cashflowType === 'income' ? 'income' : (tx.incomeManualOverride || ''),
  };
}
function cashflowTypeLabel(type, lang = 'en') {
  const cashflowType = normalizeCashflowTypeValue(type) || 'expense';
  if (cashflowType === 'income') return tr(lang, 'cashflowIncome');
  if (cashflowType === 'excluded') return tr(lang, 'cashflowExcluded');
  return tr(lang, 'cashflowExpense');
}
function isExcludedFromCashflow(txOrDesc, amountMaybe, store = null) {
  if (txOrDesc && typeof txOrDesc === 'object') {
    const tx = txOrDesc;
    return cashflowTypeForTx(tx, store) !== 'expense';
  }
  const amount = Number(amountMaybe || 0);
  if (!Number.isFinite(amount) || amount === 0) return true;
  return isAutoExcludedCashflowDesc(txOrDesc);
}
function shouldIgnore(txOrDesc, amount) {
  return isExcludedFromCashflow(txOrDesc, amount);
}

const INCOME_CATEGORY_RULES = [
  { key: 'salary', it: 'Stipendio', en: 'Salary', patterns: ['stipendio', 'salary', 'payroll', 'bonifico stipendio', 'retribuzione', 'compenso'] },
  { key: 'refund', it: 'Rimborsi', en: 'Reimbursements', patterns: ['rimborso', 'refund', 'reimbursement', 'cashback', 'storno'] },
  { key: 'interest', it: 'Interessi', en: 'Interest', patterns: ['interessi', 'interest', 'cedola', 'coupon'] },
  { key: 'business', it: 'Business', en: 'Business', patterns: ['fattura', 'invoice', 'consulenza', 'fee', 'freelance'] },
];
const INCOME_AUTO_EXCLUDE_PATTERNS = [
  'giroconto', 'giro conto', 'transfer', 'top up', 'top-up', 'ricarica revolut', 'revolut topup', 'ricarica carta', 'card top up',
  'saldo carta', 'saldo amex', 'american express', 'amex', 'investimento', 'investimenti', 'disinvestimento', 'disinvestimenti',
  'deposito proprio', 'deposito miei', 'own deposit', 'exchange', 'cambio valuta', 'cambi valuta', 'fx', 'securities', 'broker',
  'libretto', 'conto titoli', 'titoli'
];
const INCOME_AMBIGUOUS_PATTERNS = ['bonifico', 'bank transfer', 'accredito', 'credit transfer', 'versamento', 'deposito', 'incoming'];
const INCOME_LEARNING_MAX_RULES = 200;
const INCOME_GENERIC_SIGNATURES = new Set(['bonifico', 'bank transfer', 'accredito', 'credit transfer', 'versamento', 'deposito', 'incoming', 'payment', 'transfer']);

function incomeCategoryLabel(key, lang = 'en') {
  const rule = INCOME_CATEGORY_RULES.find((r) => r.key === key);
  if (!rule) return lang === 'en' ? 'Other income' : 'Altre entrate';
  return lang === 'en' ? rule.en : rule.it;
}
function incomeLearningSignature(tx) {
  const signature = merchantSignature(tx?.desc || tx?.description || '');
  if (!signature) return '';
  const tokens = normalizeText(signature).split(' ').filter(Boolean);
  if (tokens.length < 2 && tokens.every((token) => INCOME_GENERIC_SIGNATURES.has(token))) return '';
  if (INCOME_GENERIC_SIGNATURES.has(normalizeText(signature))) return '';
  const distinctive = tokens.filter((token) => token.length >= 4 && !INCOME_GENERIC_SIGNATURES.has(token));
  return distinctive.length ? signature : '';
}
function makeIncomeLearningRule(tx, type, now) {
  const signature = incomeLearningSignature(tx);
  const cashflowType = normalizeCashflowTypeValue(type) || (type === 'income' ? 'income' : (type === 'not_income' ? 'excluded' : ''));
  if (!signature || !cashflowType) return null;
  const override = legacyIncomeOverrideForCashflowType(cashflowType);
  const source = normalizeSource(tx?.source || tx?.accountName || 'amex');
  const accountName = normalizeText(tx?.accountName || '');
  const holder = holderKey(tx?.holder || '');
  return {
    id: `${source}|${accountName}|${holder}|${signature}|${cashflowType}`,
    signature,
    source,
    accountName,
    holder,
    cashflowType,
    override,
    createdAt: now,
    updatedAt: now,
  };
}
function incomeLearningRuleMatches(rule, tx) {
  if (!rule?.signature || !cashflowTypeFromIncomeLearningRule(rule)) return false;
  const desc = normalizeText(tx?.desc || tx?.description || '');
  if (!desc.includes(normalizeText(rule.signature))) return false;
  const source = normalizeSource(tx?.source || tx?.accountName || 'amex');
  if (rule.source && rule.source !== source) return false;
  if (rule.accountName && normalizeText(tx?.accountName || '') !== rule.accountName) return false;
  if (rule.holder && holderKey(tx?.holder || '') !== rule.holder) return false;
  return true;
}
function incomeLearningRuleIdentity(rule) {
  return [
    normalizeText(rule?.signature || ''),
    rule?.source ? normalizeSource(rule.source) : '',
    normalizeText(rule?.accountName || ''),
    holderKey(rule?.holder || '')
  ].join('|');
}
function incomeLearningRuleTime(rule) {
  const time = Date.parse(rule?.updatedAt || rule?.createdAt || '');
  return Number.isFinite(time) ? time : 0;
}
function getIncomeLearningRules(store) {
  return Array.isArray(store?.incomeLearningRules) ? store.incomeLearningRules.filter((rule) => rule?.signature).slice(-INCOME_LEARNING_MAX_RULES) : [];
}
function latestIncomeLearningRuleForTx(store, tx) {
  return getIncomeLearningRules(store).reduce((latest, rule, idx) => {
    if (!incomeLearningRuleMatches(rule, tx)) return latest;
    const candidate = { rule, idx, time: incomeLearningRuleTime(rule) };
    if (!latest || candidate.time > latest.time || (candidate.time === latest.time && candidate.idx > latest.idx)) return candidate;
    return latest;
  }, null)?.rule || null;
}
function classifyIncomeTx(tx, lang = 'en', store = null) {
  const amount = Number(tx?.amount || 0);
  const desc = normalizeText(`${tx?.desc || tx?.description || ''} ${tx?.category || ''} ${tx?.accountName || ''}`);
  const manual = tx?.incomeManualOverride === 'income' || tx?.incomeManualOverride === 'not_income' ? tx.incomeManualOverride : '';
  const categoryRule = INCOME_CATEGORY_RULES.find((rule) => rule.patterns.some((p) => desc.includes(p)));
  const incomeCategory = tx?.incomeCategory || categoryRule?.key || 'other';
  const cashflowType = cashflowTypeForTx(tx, store);
  const autoExcluded = amount <= 0 || cashflowType === 'expense' || INCOME_AUTO_EXCLUDE_PATTERNS.some((p) => desc.includes(p));
  const learnedRule = manual ? null : latestIncomeLearningRuleForTx(store, tx);
  const ambiguous = cashflowType === 'excluded' && amount !== 0 && !categoryRule && INCOME_AMBIGUOUS_PATTERNS.some((p) => desc.includes(p));
  const autoCandidate = cashflowType === 'income';
  const learned = cashflowTypeFromIncomeLearningRule(learnedRule) || learnedRule?.override || '';
  const needsReview = cashflowType === 'excluded' && !manual && !learned && ambiguous;
  const isIncome = cashflowType === 'income';
  return {
    isIncome,
    cashflowType,
    manual,
    learned,
    autoCandidate,
    autoExcluded,
    ambiguous: needsReview,
    incomeCategory,
    incomeCategoryLabel: incomeCategoryLabel(incomeCategory, lang),
  };
}
function buildIncomeModel(transactions, aggregateKeys, viewMode, store, lang = 'en', categoryConfig = BASE_CAT_CONFIG) {
  const validKeys = new Set(aggregateKeys || []);
  const periodRows = (transactions || [])
    .map((tx, idx) => {
      const key = periodKeyForTx(tx, viewMode);
      if (validKeys.size && !validKeys.has(key)) return null;
      const amount = Number(tx.amount || 0);
      const incomeAmount = Math.abs(amount);
      const info = classifyIncomeTx(tx, lang, store);
      const effectiveCategory = categoryForTx(tx, store, idx);
      const categoryCfg = categoryConfig[effectiveCategory] || { label: effectiveCategory, icon: '🏷️' };
      return {
        ...tx,
        rowId: rowKey(tx, idx),
        amount,
        incomeAmount,
        periodKey: key,
        periodLabel: periodLabel(key, viewMode, lang),
        incomeInfo: info,
        incomeCategoryKey: effectiveCategory,
        incomeCategoryLabel: `${categoryCfg.label || effectiveCategory}`,
        sourceKey: normalizeSource(tx.source || tx.accountName || 'amex'),
        sourceName: `${sourceLabel(tx.source || tx.accountName || 'amex')} · ${tx.accountName || sourceLabel(tx.source || 'amex')}`,
        effectiveCategory,
      };
    })
    .filter(Boolean)
    .sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')) || Math.abs(b.amount) - Math.abs(a.amount));
  const rows = periodRows.filter((row) => row.incomeInfo.cashflowType === 'income');
  const total = round2(rows.reduce((sum, row) => sum + row.incomeAmount, 0));
  const byPeriod = {};
  const byCategory = {};
  const bySource = {};
  const byHolder = {};
  rows.forEach((row) => {
    byPeriod[row.periodKey] = round2((byPeriod[row.periodKey] || 0) + row.incomeAmount);
    byCategory[row.incomeCategoryKey] = round2((byCategory[row.incomeCategoryKey] || 0) + row.incomeAmount);
    bySource[row.sourceName] = round2((bySource[row.sourceName] || 0) + row.incomeAmount);
    const allocation = txUserAllocation(row, row.amount, store);
    Object.entries(allocation || {}).forEach(([holder, value]) => {
      byHolder[holder] = round2((byHolder[holder] || 0) + Math.abs(Number(value || 0)));
    });
  });
  const topSource = Object.entries(bySource).sort(([, a], [, b]) => b - a)[0] || null;
  return {
    rows,
    total,
    count: rows.length,
    average: rows.length ? round2(total / rows.length) : 0,
    byHolder,
    topSource,
    trend: (aggregateKeys || []).map((key) => ({ month: periodLabel(key, viewMode, lang), [tr(lang, 'income')]: Math.round(byPeriod[key] || 0) })),
    categoryRows: Object.entries(byCategory).sort(([, a], [, b]) => b - a).map(([key, value]) => ({ key, label: `${categoryConfig[key]?.label || key}`, value })),
    sourceRows: Object.entries(bySource).sort(([, a], [, b]) => b - a).map(([label, value]) => ({ label, value })),
    ambiguousRows: periodRows.filter((row) => row.incomeInfo.ambiguous).slice(0, 10),
  };
}

function summarizeTransactions(transactions, viewMode, store) {
  const grouped = {};
  for (const tx of transactions || []) {
    const amount = Number(tx.amount || 0);
    const desc = tx.desc || tx.description || '';
    if (shouldIgnore(tx)) continue;
    const holder = tx.holder || '';
    const dateValue = tx.date;
    const key = periodKeyForTx(tx, viewMode);
    if (!key) continue;
    if (!grouped[key]) grouped[key] = { total:0, byHolder:{}, categories:{}, subs:{} };
    const bucket = grouped[key];
    bucket.total = round2(bucket.total + amount);
    const allocation = txUserAllocation(tx, amount, store);
    Object.entries(allocation).forEach(([memberId, value]) => { bucket.byHolder[memberId] = round2((bucket.byHolder[memberId] || 0) + value); });
    const category = categoryForTx(tx, store);
    bucket.categories[category] = round2((bucket.categories[category] || 0) + amount);
    const sub = detectSubscription(desc);
    if (sub) {
      const current = bucket.subs[sub] || { total:0, count:0 };
      current.total = round2(current.total + amount);
      current.count += 1;
      bucket.subs[sub] = current;
    }
  }
  return grouped;
}

function mergeTransactions(existing, incoming, replaceStatementKeys = []) {
  const makeKey = (tx) => {
    if (tx.ref && (tx.ref.startsWith('mp:') || tx.ref.startsWith('fineco:'))) {
      const parts = tx.ref.split(':');
      if (parts.length >= 5) {
        const prefix = parts[0];
        // Key on the account owner rather than the raw account id, so the same row
        // imported from XLSX and CSV exports of one account is recognised as a duplicate.
        let scope = tx.accountScope;
        if (!scope) {
          const hk = holderKey(tx.holder || '');
          scope = hk === SHARED_HOLDER_KEY || getMember(hk) ? hk : (householdMembers()[0]?.id || 'unknown');
        }
        const date = parts[2];
        const amount = parts[3];
        const desc = parts.slice(4).join(':');
        return `${prefix}:${scope}:${date}:${amount}:${desc}`.trim();
      }
    }
    return String(tx.ref || `${tx.date}|${tx.holder}|${tx.amount}|${tx.desc}`).trim();
  };
  const existingRows = (existing || []).map((tx) => withDefaultTransactionSource(tx));
  const incomingRows = (incoming || []).map((tx) => withDefaultTransactionSource(tx));
  const seen = new Set(existingRows.map(makeKey));
  const existingIndexByKey = new Map(existingRows.map((tx, idx) => [makeKey(tx), idx]));
  const merged = [...existingRows];
  let addedCount = 0;
  let duplicateCount = 0;
  for (const tx of incomingRows) {
    const key = makeKey(tx);
    if (seen.has(key)) {
      duplicateCount += 1;
      const existingIdx = existingIndexByKey.get(key);
      const existingTx = existingIdx == null ? null : merged[existingIdx];
      const incomingCalendarKey = tx.calendarKey || getCalendarKey(tx.date);
      if (existingTx && (existingTx.date !== tx.date || existingTx.statementKey !== tx.statementKey || existingTx.calendarKey !== incomingCalendarKey)) {
        merged[existingIdx] = {
          ...existingTx,
          date: tx.date || existingTx.date,
          statementKey: tx.statementKey || existingTx.statementKey,
          calendarKey: incomingCalendarKey || existingTx.calendarKey,
          amexDateGuardOriginalDate: existingTx.amexDateGuardOriginalDate || existingTx.date,
          amexDateGuardOriginalStatementKey: existingTx.amexDateGuardOriginalStatementKey || existingTx.statementKey || '',
          amexDateGuardFixedAt: new Date().toISOString()
        };
      }
      continue;
    }
    seen.add(key);
    existingIndexByKey.set(key, merged.length);
    merged.push(tx);
    addedCount += 1;
  }
  merged.sort((a,b) => String(a.date || '').localeCompare(String(b.date || '')) || String(a.ref || '').localeCompare(String(b.ref || '')) || String(a.desc || '').localeCompare(String(b.desc || '')));
  return { transactions: merged, addedCount, duplicateCount, totalIncoming: incomingRows.length };
}

// ===== API CLIENT =====
// Credentials are only ever sent in the Authorization header (Basic on login, Bearer afterwards).
const LS = {
  token: 'homefin:token',
  user: 'homefin:user',
  theme: 'homefin:theme',
  lang: 'homefin:lang',
  importSource: 'homefin:import-source',
  importAccount: 'homefin:import-account',
};
function lsGet(key) { try { return localStorage.getItem(key) || ''; } catch { return ''; } }
function lsSet(key, value) { try { localStorage.setItem(key, value); } catch {} }
function lsDel(key) { try { localStorage.removeItem(key); } catch {} }
const getToken = () => lsGet(LS.token);
function utf8ToB64(text) {
  const bytes = new TextEncoder().encode(text);
  let bin = '';
  bytes.forEach((b) => { bin += String.fromCharCode(b); });
  return btoa(bin);
}
async function apiFetch(action, { method = 'GET', body, headers = {} } = {}) {
  const [name, query = ''] = String(action).split('&');
  const r = await fetch(`/api/data?action=${encodeURIComponent(name)}${query ? `&${query}` : ''}`, {
    method,
    headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
  const j = await r.json().catch(() => null);
  if (!r.ok) {
    const err = new Error(j?.error || `HTTP ${r.status}`);
    err.status = r.status;
    throw err;
  }
  return j;
}
const authHeaders = () => ({ Authorization: `Bearer ${getToken()}` });
async function apiStatus() { return apiFetch('status'); }
async function apiBootstrap({ data, admin, household, setupToken }) {
  const j = await apiFetch('bootstrap', { method: 'POST', body: { data, admin, household }, headers: { 'X-Homefin-Setup-Token': setupToken } });
  lsSet(LS.token, j.token);
  lsSet(LS.user, j.userId);
  return j;
}
async function apiLogin(username, password) {
  const j = await apiFetch('login', { method: 'POST', headers: { Authorization: `Basic ${utf8ToB64(`${username}:${password}`)}` } });
  lsSet(LS.token, j.token);
  lsSet(LS.user, j.userId);
  return j;
}
async function apiLogout() {
  try { if (getToken()) await apiFetch('logout', { method: 'POST', headers: authHeaders() }); } catch {}
  lsDel(LS.token);
  lsDel(LS.user);
}
async function apiGet() { return apiFetch('get', { headers: authHeaders() }); }
async function apiSet(data) { return apiFetch('set', { method: 'POST', body: { data }, headers: authHeaders() }); }
async function apiReplace(data) { return (await apiFetch('replace', { method: 'POST', body: { data }, headers: authHeaders() })).data; }
async function apiUpdateProfile(profile, password = '') {
  return (await apiFetch('profile', { method: 'POST', body: { profile, password }, headers: authHeaders() })).data;
}
async function apiTimeMachineList() {
  const j = await apiFetch('time-machine-list', { headers: authHeaders() });
  return Array.isArray(j?.backups) ? j.backups : [];
}
async function apiTimeMachineCreate(name) {
  const j = await apiFetch('time-machine-create', { method: 'POST', body: { name }, headers: authHeaders() });
  return Array.isArray(j?.backups) ? j.backups : [];
}
async function apiTimeMachineDelete(id) {
  const j = await apiFetch('time-machine-delete', { method: 'POST', body: { id }, headers: authHeaders() });
  return Array.isArray(j?.backups) ? j.backups : [];
}
async function apiTimeMachineRestore(id) {
  return (await apiFetch('time-machine-restore', { method: 'POST', body: { id }, headers: authHeaders() })).data;
}
async function apiTimeMachineDownload(id) {
  return apiFetch(`time-machine-download&id=${encodeURIComponent(id)}`, { headers: authHeaders() });
}

function BrandLogo({ compact = false, theme = THEMES.dark }) {
  return (
    <div className={`hf-brand ${compact ? 'is-compact' : ''}`.trim()}>
      <div className="hf-brand-mark">
        <img className="hf-mark" src="/logo.png" alt="" />
      </div>
      <div className="hf-brand-copy">
        <div className="hf-brand-wordmark">
          <span className="hf-brand-name">homefin</span>
        </div>
        {!compact && <div className="hf-brand-tagline">Household finance clarity</div>}
      </div>
    </div>
  );
}

const STITCH_ICON_PATHS = {
  more: <><circle cx="5" cy="12" r="1.6"/><circle cx="12" cy="12" r="1.6"/><circle cx="19" cy="12" r="1.6"/></>,
  overview: <><rect width="7" height="9" x="3" y="3" rx="1"/><rect width="7" height="5" x="14" y="3" rx="1"/><rect width="7" height="9" x="14" y="12" rx="1"/><rect width="7" height="5" x="3" y="16" rx="1"/></>,
  income: <><path d="M12 19V5"/><path d="m5 12 7-7 7 7"/><path d="M5 21h14"/></>,
  trends: <><path d="m3 16 4-4 4 4 4-4 6 6"/><path d="M18 12h4v4"/></>,
  data: <><ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5"/><path d="M3 12c0 1.66 4 3 9 3s9-1.34 9-3"/></>,
  filters: <polygon points="22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3"/>,
  reset: <><path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/></>,
  profile: <><path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></>,
  users: <><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></>,
  security: <><rect width="18" height="11" x="3" y="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></>,
  theme: <><circle cx="12" cy="12" r="4"/><path d="M12 2v2"/><path d="M12 20v2"/><path d="m4.93 4.93 1.41 1.41"/><path d="m17.66 17.66 1.41 1.41"/><path d="M2 12h2"/><path d="M20 12h2"/><path d="m6.34 17.66-1.41 1.41"/><path d="m19.07 4.93-1.41 1.41"/></>,
  language: <><circle cx="12" cy="12" r="10"/><path d="M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20"/><path d="M2 12h20"/></>,
  logout: <><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/></>,
  health: <><path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z"/><path d="m9 12 2 2 4-4"/></>,
  rules: <><path d="M9 5H4"/><path d="M14 5h6"/><circle cx="11" cy="5" r="2"/><path d="M4 12h10"/><path d="M18 12h2"/><circle cx="16" cy="12" r="2"/><path d="M8 19H4"/><path d="M12 19h8"/><circle cx="10" cy="19" r="2"/></>,
  customization: <><path d="M12 2v4"/><path d="M12 18v4"/><path d="m4.93 4.93 2.83 2.83"/><path d="m16.24 16.24 2.83 2.83"/><path d="M2 12h4"/><path d="M18 12h4"/><path d="m4.93 19.07 2.83-2.83"/><path d="m16.24 7.76 2.83-2.83"/><circle cx="12" cy="12" r="3"/></>,
  import: <><path d="M12 3v12"/><path d="m7 10 5 5 5-5"/><path d="M5 21h14"/></>,
  export: <><path d="M12 21V9"/><path d="m17 14-5-5-5 5"/><path d="M5 3h14"/></>,
  sync: <><path d="M21 12a9 9 0 0 0-14.6-7"/><path d="M3 12a9 9 0 0 0 14.6 7"/><path d="M7 4H3v4"/><path d="M17 20h4v-4"/></>,
  restore: <><path d="M3 3v6h6"/><path d="M3 9a9 9 0 1 0 2.64-6.36"/></>,
  notes: <><path d="M4 4h16v16H4z"/><path d="M8 8h8"/><path d="M8 12h8"/><path d="M8 16h5"/></>,
  forecast: <><path d="M3 3v18h18"/><path d="m7 15 4-4 3 3 5-7"/></>,
  thumbUp: <><path d="M7 10v11"/><path d="M15 6.5 14 10h5.6a1.8 1.8 0 0 1 1.75 2.22l-1.4 6A2.4 2.4 0 0 1 17.6 20H7"/><path d="M7 10H4a2 2 0 0 0-2 2v7a2 2 0 0 0 2 2h3"/><path d="M14 10V5.5A2.5 2.5 0 0 0 11.5 3L8 10"/></>,
  thumbDown: <><path d="M17 14V3"/><path d="M9 17.5 10 14H4.4a1.8 1.8 0 0 1-1.75-2.22l1.4-6A2.4 2.4 0 0 1 6.4 4H17"/><path d="M17 14h3a2 2 0 0 0 2-2V5a2 2 0 0 0-2-2h-3"/><path d="M10 14v4.5A2.5 2.5 0 0 0 12.5 21L16 14"/></>,
  insights: <><path d="M12 2v4"/><path d="M12 18v4"/><path d="M4.93 4.93 7.76 7.76"/><path d="M16.24 16.24l2.83 2.83"/><path d="M2 12h4"/><path d="M18 12h4"/><path d="M4.93 19.07 7.76 16.24"/><path d="M16.24 7.76l2.83-2.83"/></>,
  category: <><path d="M20.59 13.41 13.42 20.6a2 2 0 0 1-2.83 0L2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.82z"/><path d="M7 7h.01"/></>,
  account: <><path d="M3 21h18"/><path d="M5 21V7l7-4 7 4v14"/><path d="M9 21v-8h6v8"/></>,
  delete: <><path d="M3 6h18"/><path d="M8 6V4h8v2"/><path d="M19 6l-1 14H6L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/></>,
  check: <><path d="M20 6 9 17l-5-5"/></>,
  close: <><path d="M18 6 6 18"/><path d="m6 6 12 12"/></>,
  search: <><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></>,
  plus: <><path d="M12 5v14"/><path d="M5 12h14"/></>,
  warning: <><path d="m21.73 18-8-14a2 2 0 0 0-3.46 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3"/><path d="M12 9v4"/><path d="M12 17h.01"/></>,
};

function Icon({ name, className = '', size = 18, strokeWidth = 2, title }) {
  const paths = STITCH_ICON_PATHS[name] || STITCH_ICON_PATHS.overview;
  return (
    <svg className={`hf-stitch-icon ${className}`.trim()} width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round" aria-hidden={title ? undefined : true} role={title ? 'img' : undefined}>
      {title && <title>{title}</title>}
      {paths}
    </svg>
  );
}

function IconLabel({ icon, children, className = '' }) {
  return <span className={`hf-icon-label ${className}`.trim()}><Icon name={icon} /><span>{children}</span></span>;
}

function CircleToggle({ children, title, onClick, theme }) {
  return <button className="hf-icon-button" onClick={onClick} title={title}>{children}</button>;
}


function HouseholdEditor({ value, onChange, theme, input, T }) {
  const members = value.members || [];
  const update = (idx, patch) => onChange({ ...value, members: members.map((m, i) => i === idx ? { ...m, ...patch } : m) });
  const remove = (idx) => onChange({ ...value, members: members.filter((_, i) => i !== idx) });
  const add = () => onChange({ ...value, members: [...members, { name: '', keywords: '' }] });
  const setSplit = (id, pct) => onChange({ ...value, sharedSplit: { ...(value.sharedSplit || {}), [id]: pct } });
  const named = members.filter((m) => String(m.name || '').trim());
  const splitTotal = named.reduce((sum, m) => sum + Number(value.sharedSplit?.[memberIdFromName(m.name)] || 0), 0);
  return <div className="hfx-household">
    {members.map((m, idx) => <div key={idx} className="hfx-member-row">
      <input className="hfx-field" aria-label={T('memberName')} placeholder={T('memberName')} value={m.name || ''} onChange={(e) => update(idx, { name: e.target.value })} />
      <input className="hfx-field" aria-label={T('memberKeywords')} placeholder={T('memberKeywords')} value={Array.isArray(m.keywords) ? m.keywords.join(', ') : (m.keywords || '')} onChange={(e) => update(idx, { keywords: e.target.value })} />
      <button type="button" className="hfx-icon-btn" onClick={() => remove(idx)} disabled={members.length <= 1} aria-label={`${T('delete')} ${m.name || ''}`.trim()}><Icon name="close" size={16} /></button>
    </div>)}
    <button type="button" className="hfx-btn hfx-btn-quiet" onClick={add}><Icon name="plus" size={14} /><span>{T('addMember')}</span></button>
    <p className="hfx-help">{T('memberKeywordsHelp')}</p>
    {named.length > 1 && <div className="hfx-household-split">
      <div className="hfx-field-label">{T('sharedSplit')}</div>
      <div className="hfx-seg">
        {[['equal', T('splitEqual')], ['custom', T('splitCustom')]].map(([mode, label]) => <button type="button" key={mode} className={value.splitMode === mode ? 'is-active' : ''} aria-pressed={value.splitMode === mode} onClick={() => onChange({ ...value, splitMode: mode })}>{label}</button>)}
      </div>
      {value.splitMode === 'custom' && <>
        {named.map((m) => { const id = memberIdFromName(m.name); return <label key={id} className="hfx-split-row"><span>{m.name}</span><input className="hfx-field hfx-num" type="number" min="0" max="100" value={value.sharedSplit?.[id] ?? ''} onChange={(e) => setSplit(id, e.target.value === '' ? '' : Number(e.target.value))} placeholder="%" /></label>; })}
        <div className={`hfx-help ${Math.round(splitTotal) === 100 ? '' : 'is-neg'}`}>{T('splitTotal')}: {splitTotal || 0}%</div>
      </>}
    </div>}
  </div>;
}
function householdDraftFromStore(household) {
  const h = normalizeHousehold(household);
  return { members: h.members.length ? h.members.map((m) => ({ name: m.name, keywords: m.keywords.join(', ') })) : [{ name: '', keywords: '' }], splitMode: h.splitMode, sharedSplit: h.sharedSplit };
}
function householdFromDraft(draft) {
  return normalizeHousehold({ ...draft, members: (draft.members || []).map((m) => ({ name: m.name, keywords: m.keywords })) });
}
function validateHouseholdDraft(draft, T) {
  const h = householdFromDraft(draft);
  if (!h.members.length) return T('householdRequired');
  if (h.members.length !== (draft.members || []).filter((m) => String(m.name || '').trim()).length) return T('householdDuplicate');
  if (h.splitMode === 'custom' && h.members.length > 1) {
    const total = h.members.reduce((sum, m) => sum + Number(h.sharedSplit[m.id] || 0), 0);
    if (Math.round(total) !== 100) return T('splitMustBe100');
  }
  return '';
}

function SetupWizard({ onComplete }) {
  const [themeMode, setThemeMode] = useState(() => lsGet(LS.theme) || 'dark');
  const [lang, setLang] = useState(() => lsGet(LS.lang) || 'en');
  const [setupToken, setSetupToken] = useState('');
  const [admin, setAdmin] = useState({ name:'', email:'', password:'', confirm:'' });
  const [household, setHousehold] = useState({ members: [{ name:'', keywords:'' }, { name:'', keywords:'' }], splitMode:'equal', sharedSplit:{} });
  const [startWith, setStartWith] = useState('empty');
  const [db, setDb] = useState(null);
  const [fileName, setFileName] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const fileRef = useRef();
  const theme = THEMES[themeMode] || THEMES.dark;
  const T = (key) => tr(lang, key);
  const input = { width:'100%', background:theme.input, border:'1px solid '+theme.border, borderRadius:14, padding:'12px 14px', color:theme.text, fontSize:14, outline:'none', boxSizing:'border-box', fontFamily:"'Inter',system-ui" };
  const toggleTheme = () => { const next = themeMode === 'dark' ? 'light' : 'dark'; setThemeMode(next); lsSet(LS.theme, next); };
  const toggleLang = () => { const next = lang === 'en' ? 'it' : 'en'; setLang(next); lsSet(LS.lang, next); };
  const readDatabase = async (file) => {
    setErr(''); setFileName(file?.name || '');
    if (!file) return;
    try {
      if (file.name.toLowerCase().endsWith('.json')) {
        const parsed = JSON.parse(await file.text());
        if (!parsed || !Array.isArray(parsed.transactions)) throw new Error(T('invalidBackup'));
        const { users, ...rest } = parsed;
        setDb(rest);
        if (rest.household?.members?.length) setHousehold(householdDraftFromStore(rest.household));
      } else {
        const parsed = parseAmexMonthlyWorkbook(await file.arrayBuffer());
        setDb({ version: TARGET_STORE_VERSION, meta:{ setupSourceFile:file.name }, transactions: parsed.transactions, rules: DEFAULT_RULES });
      }
    } catch (e) {
      setErr(String(e?.message || e));
      setDb(null);
    }
  };
  const submit = async () => {
    setErr('');
    if (!setupToken) { setErr(T('setupTokenRequired')); return; }
    if (!admin.name.trim() || !admin.password) { setErr(T('signupAdminRequired')); return; }
    if (admin.password.length < 8) { setErr(T('passwordTooShort')); return; }
    if (admin.password !== admin.confirm) { setErr(T('passwordsDontMatch')); return; }
    const householdError = validateHouseholdDraft(household, T);
    if (householdError) { setErr(householdError); return; }
    if (startWith === 'file' && !db) { setErr(T('signupUploadRequired')); return; }
    setBusy(true);
    try {
      const finalHousehold = householdFromDraft(household);
      setActiveHousehold(finalHousehold);
      const base = startWith === 'demo'
        ? buildDemoStore(finalHousehold.members)
        : startWith === 'file' ? db : { version: TARGET_STORE_VERSION, meta: {}, transactions: [], rules: DEFAULT_RULES };
      const data = normalizeStoreShape({ ...base, household: finalHousehold, users: {} });
      const { users, ...payload } = data;
      const result = await apiBootstrap({ data: payload, admin: { name: admin.name.trim(), email: admin.email.trim(), password: admin.password, language: lang }, household: finalHousehold, setupToken });
      onComplete(result.data, result.userId);
    } catch (e) {
      const message = String(e?.message || e);
      setErr(message.includes('Setup already completed') ? T('setupAlreadyCompleted') : message);
    }
    setBusy(false);
  };
  const steps = [T('setupStepToken'), T('createAdmin'), T('setupStepHousehold'), T('setupStepData')];
  const section = (n, title, children, help) => <section className="hfx-auth-section" aria-labelledby={`setup-step-${n}`}>
    <div className="hfx-auth-section-head"><span className="hfx-step-num hfx-num">{n}</span><h2 id={`setup-step-${n}`}>{title}</h2></div>
    {help && <p className="hfx-help">{help}</p>}
    <div className="hfx-auth-fields">{children}</div>
  </section>;
  return <div className="hfx-auth is-setup" data-theme={themeMode}>
    <header className="hfx-auth-top">
      <div className="hfx-brand"><img className="hfx-logo" src="/logo.png" alt="" /><span>homefin</span></div>
      <div className="hfx-auth-tools">
        <button type="button" className="hfx-icon-btn" onClick={toggleTheme} aria-label={themeMode === 'dark' ? T('light') : T('dark')}><Icon name="theme" size={16} /></button>
        <button type="button" className="hfx-icon-btn hfx-lang" onClick={toggleLang} aria-label={T('language')}>{lang.toUpperCase()}</button>
      </div>
    </header>
    <main className="hfx-auth-grid">
      <aside className="hfx-auth-intro">
        <div className="hfx-eyebrow">{T('firstTimeSetup')}</div>
        <h1>{T('setupTitle')}</h1>
        <p>{T('setupSubtitle')}</p>
        <ol className="hfx-steps">{steps.map((label, i) => <li key={label}><span className="hfx-num">{i + 1}</span>{label}</li>)}</ol>
      </aside>
      <div className="hfx-auth-card">
        {section(1, T('setupStepToken'), <input className="hfx-field" type="password" autoComplete="off" aria-label={T('setupStepToken')} placeholder="APP_PASSWORD" value={setupToken} onChange={(e) => setSetupToken(e.target.value)} />, T('setupTokenHelp'))}
        {section(2, T('createAdmin'), <>
          <label className="hfx-label"><span>{T('name')}</span><input className="hfx-field" autoComplete="name" value={admin.name} onChange={e=>setAdmin(a=>({...a,name:e.target.value}))}/></label>
          <label className="hfx-label"><span>{T('email')}</span><input className="hfx-field" type="email" autoComplete="email" value={admin.email} onChange={e=>setAdmin(a=>({...a,email:e.target.value}))}/></label>
          <div className="hfx-field-pair">
            <label className="hfx-label"><span>{T('password')}</span><input className="hfx-field" type="password" autoComplete="new-password" value={admin.password} onChange={e=>setAdmin(a=>({...a,password:e.target.value}))}/></label>
            <label className="hfx-label"><span>{T('confirmNewPassword')}</span><input className="hfx-field" type="password" autoComplete="new-password" value={admin.confirm} onChange={e=>setAdmin(a=>({...a,confirm:e.target.value}))}/></label>
          </div>
          <p className="hfx-help">{T('setupPasswordHelp')}</p>
        </>)}
        {section(3, T('setupStepHousehold'), <HouseholdEditor value={household} onChange={setHousehold} theme={theme} input={input} T={T} />, T('householdHelp'))}
        {section(4, T('setupStepData'), <>
          <div className="hfx-seg" role="group" aria-label={T('setupStepData')}>
            {[['empty', T('startEmpty')], ['demo', T('startDemo')], ['file', T('startFile')]].map(([key, label]) => <button type="button" key={key} className={startWith === key ? 'is-active' : ''} aria-pressed={startWith === key} onClick={() => setStartWith(key)}>{label}</button>)}
          </div>
          {startWith === 'demo' && <p className="hfx-help">{T('startDemoHelp')}</p>}
          {startWith === 'file' && <>
            <input ref={fileRef} type='file' accept='.json,.xlsx,.xls' onChange={e=>readDatabase(e.target.files?.[0])} style={{ display:'none' }} />
            <button type="button" className="hfx-btn hfx-btn-block" onClick={()=>fileRef.current?.click()}>{db ? <><Icon name="check" size={15} /> {T('setupReady')}</> : <><Icon name="import" size={15} /> {T('uploadDatabase')}</>}</button>
            <p className="hfx-help">{fileName ? `${fileName} · ${db?.transactions?.length || 0} ${T('transactions')}` : T('setupDatabaseHelp')}</p>
          </>}
        </>)}
        {err && <div className="hfx-error" role="alert">{err}</div>}
        <button type="button" className="hfx-btn is-primary hfx-btn-block hfx-btn-lg" onClick={submit} disabled={busy}>{busy ? T('loading') : T('createWorkspace')}</button>
      </div>
    </main>
  </div>;
}

function Login({ onLogin }) {
  const [userId, setUserId] = useState(() => lsGet(LS.user));
  const [pw, setPw] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [themeMode, setThemeMode] = useState(() => lsGet(LS.theme) || 'dark');
  const [lang, setLang] = useState(() => lsGet(LS.lang) || 'en');
  const theme = THEMES[themeMode] || THEMES.dark;
  const T = (key) => tr(lang, key);
  const input = { width:'100%', background:theme.input, border:'1px solid ' + theme.border, borderRadius:16, padding:'15px 16px', color:theme.text, fontSize:15, outline:'none', boxSizing:'border-box', marginBottom:12, fontFamily:"'Inter',system-ui" };

  const submitLogin = async () => {
    setErr('');
    setBusy(true);
    try {
      const result = await apiLogin(userId.trim(), pw);
      onLogin(result.data, result.userId);
    } catch (e) {
      const message = String(e?.message || '');
      setErr(e?.status === 401 ? T('invalidLogin') : e?.status === 429 ? T('tooManyAttempts') : `${T('apiError')}: ${message}`);
    }
    setBusy(false);
  };
  const toggleTheme = () => { const next = themeMode === 'dark' ? 'light' : 'dark'; setThemeMode(next); lsSet(LS.theme, next); };
  const toggleLang = () => { const next = lang === 'en' ? 'it' : 'en'; setLang(next); lsSet(LS.lang, next); };

  return (
    <div className="hfx-auth is-login" data-theme={themeMode}>
      <header className="hfx-auth-top">
        <div className="hfx-brand"><img className="hfx-logo" src="/logo.png" alt="" /><span>homefin</span></div>
        <div className="hfx-auth-tools">
          <button type="button" className="hfx-icon-btn" onClick={toggleTheme} aria-label={themeMode === 'dark' ? T('light') : T('dark')}><Icon name="theme" size={16} /></button>
          <button type="button" className="hfx-icon-btn hfx-lang" onClick={toggleLang} aria-label={T('language')}>{lang.toUpperCase()}</button>
        </div>
      </header>
      <main className="hfx-auth-grid">
        <aside className="hfx-auth-intro">
          <div className="hfx-eyebrow">{T('loginKicker')}</div>
          <h1>{T('loginHeadline')}</h1>
          <p>{T('loginTagline')}</p>
          <dl className="hfx-auth-features">
            {[[T('rules'), T('smartCategorization')],[T('flag'), T('personalVsShared')],[T('trends'), T('monthlyClarity')]].map(([a,b]) => <div key={a}><dt>{a}</dt><dd>{b}</dd></div>)}
          </dl>
        </aside>
        <form className="hfx-auth-card is-narrow" onSubmit={(e) => { e.preventDefault(); submitLogin(); }}>
          <h2 className="hfx-auth-title">{T('login')}</h2>
          <p className="hfx-help">{T('loginSub')}</p>
          <label className="hfx-label"><span>{T('user')}</span><input className="hfx-field" autoComplete="username" autoCapitalize="none" value={userId} onChange={e => setUserId(e.target.value)} /></label>
          <label className="hfx-label"><span>{T('password')}</span><input className="hfx-field" type="password" autoComplete="current-password" value={pw} onChange={e => setPw(e.target.value)} /></label>
          {err && <div className="hfx-error" role="alert">{err}</div>}
          <button type="submit" className="hfx-btn is-primary hfx-btn-block hfx-btn-lg" disabled={busy}>{busy ? T('loading') : T('login')}</button>
          <p className="hfx-help">{T('loginHelp')}</p>
        </form>
      </main>
    </div>
  );
}

const THEMES = {
  // "Quiet Ledger" palette: calm neutrals, one accent, no gradients. Values mirror the CSS tokens in redesign.css.
  dark: {
    name: 'dark',
    bg: '#0C0D0F',
    panel: '#131417',
    panelAlt: '#17181C',
    soft: '#1D1F24',
    border: 'rgba(255,255,255,0.08)',
    text: '#ECEDEF',
    subtext: '#9A9EA6',
    accent: '#4FD1B5',
    accentSoft: 'rgba(79,209,181,0.12)',
    accentAlt: '#8AB4F8',
    success: '#4FD1B5',
    shadow: 'none',
    input: '#17181C',
    inputBg: '#17181C',
    tooltipBg: '#1B1C20',
    tooltipBorder: 'rgba(255,255,255,0.10)',
    chipBg: 'rgba(255,255,255,0.04)',
    headerGradient: '#0C0D0F',
    splitA: '#8AB4F8',
    splitB: '#E9B872',
    navBg: '#0C0D0F',
    navText: '#ECEDEF',
    totalGreen: '#4FD1B5',
    loginBg: '#0C0D0F',
    heroPanel: '#131417',
    gradientPrimary: '#4FD1B5',
    onAccent: '#06241D'
  },
  light: {
    name: 'light',
    bg: '#F7F7F5',
    panel: '#FFFFFF',
    panelAlt: '#FBFBFA',
    soft: '#F1F1EE',
    border: 'rgba(20,20,15,0.09)',
    text: '#17181A',
    subtext: '#62656B',
    accent: '#0E7A63',
    accentSoft: 'rgba(14,122,99,0.08)',
    accentAlt: '#2F5FD0',
    success: '#0E7A63',
    shadow: 'none',
    input: '#FFFFFF',
    inputBg: '#FFFFFF',
    tooltipBg: '#FFFFFF',
    tooltipBorder: 'rgba(20,20,15,0.10)',
    chipBg: 'rgba(20,20,15,0.04)',
    headerGradient: '#F7F7F5',
    splitA: '#2F5FD0',
    splitB: '#B26A12',
    navBg: '#F7F7F5',
    navText: '#17181A',
    totalGreen: '#0E7A63',
    loginBg: '#F7F7F5',
    heroPanel: '#FFFFFF',
    gradientPrimary: '#0E7A63',
    onAccent: '#FFFFFF'
  }
};
const THEME_OPTIONS = [{ key:'dark', label:'Scuro / Dark' }, { key:'light', label:'Chiaro / Light' }];
const I18N = {
  it: { profile:'Profilo', personalProfile:'Profilo personale', data:'Dati', customization:'Personalizzazione', saveProfile:'Salva profilo', saveCustomization:'Salva personalizzazione', dark:'Scuro', light:'Chiaro', overview:'Spese', categories:'Categorie', perUser:'Per utente', rules:'Regole', totalSpend:'Spesa totale', selectedRange:'Periodi inclusi', allHistory:'Tutto lo storico', goUpload:'Nessun periodo caricato. Vai su Dati per caricare lo storico.', sync:'Sync KV', importExcel:'Import Excel', exportJson:'Export JSON', importBackup:'Import Backup', language:'Lingua dashboard', displayedName:'Nome visualizzato', username:'Username', gender:'Genere', email:'Email', phone:'Telefono', password:'Password', sections:'Sezioni', user:'Utente', all:'Tutti', personalOnly:'Solo personali', commonOnly:'Solo comuni', allCategories:'Tutte le categorie', spendTrend:'Trend spesa', selectedRangeSubSingle:'periodo', selectedRangeSubPlural:'periodi', allUsers:'Tutti gli utenti', clickAll:'Clicca per tornare a tutti', ofTotal:'del totale', selectedRangeBlock:'Range selezionato', calendarMonth:'Mese calendario', amexPeriod:'Periodo Amex', calendar:'Calendario', allYears:'Tutti gli anni', fullYear:'Intero anno', fromPeriod:'Da periodo…', toPeriod:'A periodo…', topCategories:'Top categorie', subscriptions:'Abbonamenti rilevati', distribution:'Distribuzione', categoryDistribution:'Distribuzione categorie', categoryTrend:'Trend categorie', trendSplit:'Trend split', monthlyTrend:'Trend mensile', categoriesByUser:'Categorie per utente', userFilteredCategoryTrend:'Trend categorie · filtro utente applicato', subtotal:'Subtotale selezione corrente', filteredTransactions:'transazioni filtrate', newCategory:'Nuova categoria…', doNotChange:'Non modificare', active:'Attiva', field:'Campo', match:'Match', text:'Testo', category:'Categoria', personalFlag:'Flag personale', actions:'Azioni', categorizationRules:'Regole di categorizzazione', rulesHelp:'Le regole vengono applicate ai nuovi upload. Puoi applicarle a qualsiasi campo del DB; gli override manuali restano prioritari.', newRule:'+ Nuova regola', applyRetro:'Applica retroattivamente', suggestions:'Suggerimenti da override manuali', contains:'contiene', startsWith:'inizia con', equals:'è uguale a', endsWith:'finisce con', create:'Crea', delete:'Elimina', merchantDesc:'Merchant / descrizione', holder:'Titolare', country:'Paese', min:'Min', max:'Max', subscription:'Abbonamento', calendarPeriod:'Periodo calendario', statementPeriod:'Periodo Amex', reference:'Riferimento', personal:'Personale', common:'Comune', onlyPersonalLower:'solo personali', onlyCommonLower:'solo comuni', allLower:'tutti', colorTheme:'Tema colore per questo utente', cannotDeleteOther:'Altro non può essere eliminata', deleteCategory:'Elimina categoria', loginSub:'Login con utente e password', initialPassword:'Password iniziale:', initialPasswordHelp:'Potrai cambiarla dal Profilo.', optionalUser:'Utente (opzionale al primo accesso)', login:'Accedi', show:'Mostra', hide:'Nascondi', notSpecified:'Non indicato', prefix:'Prefisso', phoneNumber:'Numero', newPassword:'Nuova password', confirmNewPassword:'Conferma nuova password', back:'Torna', loading:'Caricamento…', year:'Anno', period:'Periodo', month:'Mese', view:'Vista', amexPeriodEnding:'Periodo Amex con chiusura al 20', fullYearPrefix:'Anno', date:'Data', description:'Descrizione', amount:'Importo €', flag:'Flag', dismissSuggestion:'Cestina suggerimento', overrideCount:'override', overrideCountPlural:'override', readingExcel:'📖 Lettura Excel…', updated:'✅ Aggiornato:', fileImportError:'Errore importazione file', invalidBackup:'Il file non sembra un backup valido', restoreBackupConfirm:'Stai per RIPRISTINARE l\'intero database dal backup JSON:', restoreBackupWarning:'Questa operazione sovrascrive il contenuto KV corrente. Confermi?', transactions:'transazioni', rulesCount:'regole', customCategoriesCount:'categorie custom', overridesCount:'override', backupImported:'✅ Backup JSON importato e salvato su KV', backupImportError:'Errore import backup JSON', invalidEmail:'Email non valida', passwordsDontMatch:'Le due password non coincidono', profileUpdated:'✅ Profilo utente aggiornato', deleteCategoryConfirmStart:'Eliminare la categoria', deleteCategoryConfirmBody:'Le transazioni, le regole e gli override associati saranno rimappati su Altro. Nessuna transazione o regola verrà cancellata.', other:'Altro', remappedToOther:'rimappata su Altro', personalizationSaved:'✅ Personalizzazione salvata', newCategoryPrompt:'Nome nuova categoria', ruleCategoryPrompt:'Categoria target: scrivi nome/chiave, oppure lascia vuoto per non modificare la categoria', invalidCategory:'Categoria non valida. Usa una categoria già esistente oppure creala prima dal tab Dati.', retroApplied:'✅ Regole applicate retroattivamente', included:'inclusi', filteredRows:'righe filtrate', filter:'Filtra', workspace:'Navigazione', accountArea:'Account', users:'Utenti', userManagement:'Gestione utenti', addUser:'Aggiungi utente', role:'Ruolo', admin:'Admin', standardUser:'Utente', createAdmin:'Crea account admin', uploadDatabase:'Carica database', setupTitle:'Configura homefin', setupSubtitle:'Crea il primo amministratore, definisci il nucleo familiare e scegli i dati di partenza. Il setup si esegue una sola volta per deployment.', setupDatabaseHelp:'Un backup JSON di homefin oppure un estratto Excel Amex.', setupReady:'Database pronto', createAccount:'Crea account', setupDone:'Setup completato', name:'Nome', setupPasswordHelp:'Almeno 8 caratteri. Viene salvata solo come hash PBKDF2 sul server.', logout:'Logout' },
  en: { profile:'Profile', personalProfile:'Personal profile', data:'Data', customization:'Customization', saveProfile:'Save profile', saveCustomization:'Save customization', dark:'Dark', light:'Light', overview:'Spending', categories:'Categories', perUser:'By user', rules:'Rules', totalSpend:'Total spend', selectedRange:'Included periods', allHistory:'Full history', goUpload:'No periods loaded yet. Go to Data to upload your history.', sync:'Sync KV', importExcel:'Import Excel', exportJson:'Export JSON', importBackup:'Import Backup', language:'Dashboard language', displayedName:'Display name', username:'Username', gender:'Gender', email:'Email', phone:'Phone', password:'Password', sections:'Sections', user:'User', all:'All', personalOnly:'Personal only', commonOnly:'Shared only', allCategories:'All categories', spendTrend:'Spend trend', selectedRangeSubSingle:'period', selectedRangeSubPlural:'periods', allUsers:'All users', clickAll:'Click to show all', ofTotal:'of total', selectedRangeBlock:'Selected range', calendarMonth:'Calendar month', amexPeriod:'Amex period', calendar:'Calendar', allYears:'All years', fullYear:'Full year', fromPeriod:'From period…', toPeriod:'To period…', topCategories:'Top categories', subscriptions:'Detected subscriptions', distribution:'Distribution', categoryDistribution:'Category distribution', categoryTrend:'Category trend', trendSplit:'Split trend', monthlyTrend:'Monthly trend', categoriesByUser:'Categories by user', userFilteredCategoryTrend:'Category trend · user filter applied', subtotal:'Subtotal for current selection', filteredTransactions:'filtered transactions', newCategory:'New category…', doNotChange:'Do not change', active:'Active', field:'Field', match:'Match', text:'Text', category:'Category', personalFlag:'Personal flag', actions:'Actions', categorizationRules:'Categorization rules', rulesHelp:'Rules are applied to new uploads. You can apply them to any DB field; manual overrides remain the priority.', newRule:'+ New rule', applyRetro:'Apply retroactively', suggestions:'Suggestions from manual overrides', contains:'contains', startsWith:'starts with', equals:'equals', endsWith:'ends with', create:'Create', delete:'Delete', merchantDesc:'Merchant / description', holder:'Holder', country:'Country', min:'Min', max:'Max', subscription:'Subscription', calendarPeriod:'Calendar period', statementPeriod:'Amex period', reference:'Reference', personal:'Personal', common:'Shared', onlyPersonalLower:'personal only', onlyCommonLower:'shared only', allLower:'all', colorTheme:'Color theme for this user', cannotDeleteOther:'Other cannot be deleted', deleteCategory:'Delete category', loginSub:'Login with user and password', initialPassword:'Initial password:', initialPasswordHelp:'You can change it from Profile.', optionalUser:'User (optional on first login)', login:'Log in', show:'Show', hide:'Hide', notSpecified:'Not specified', prefix:'Prefix', phoneNumber:'Number', newPassword:'New password', confirmNewPassword:'Confirm new password', back:'Back', loading:'Loading…', year:'Year', period:'Period', month:'Month', view:'View', amexPeriodEnding:'Amex period ending on the 20th', fullYearPrefix:'Year', date:'Date', description:'Description', amount:'Amount €', flag:'Flag', dismissSuggestion:'Dismiss suggestion', overrideCount:'override', overrideCountPlural:'overrides', readingExcel:'📖 Reading Excel…', updated:'✅ Updated:', fileImportError:'File import error', invalidBackup:'This file does not look like a valid backup', restoreBackupConfirm:'You are about to RESTORE the full database from the JSON backup:', restoreBackupWarning:'This operation overwrites the current KV content. Confirm?', transactions:'transactions', rulesCount:'rules', customCategoriesCount:'custom categories', overridesCount:'overrides', backupImported:'✅ JSON backup imported and saved to KV', backupImportError:'JSON backup import error', invalidEmail:'Invalid email', passwordsDontMatch:'The two passwords do not match', profileUpdated:'✅ User profile updated', deleteCategoryConfirmStart:'Delete category', deleteCategoryConfirmBody:'Transactions, rules and related overrides will be remapped to Other. No transaction or rule will be deleted.', other:'Other', remappedToOther:'remapped to Other', personalizationSaved:'✅ Customization saved', newCategoryPrompt:'New category name', ruleCategoryPrompt:'Target category: enter a name/key, or leave blank to avoid changing category', invalidCategory:'Invalid category. Use an existing category or create it first from the Data tab.', retroApplied:'✅ Rules applied retroactively', included:'included', filteredRows:'filtered rows', filter:'Filter', workspace:'Workspace', accountArea:'Account', users:'Users', userManagement:'User management', addUser:'Add user', role:'Role', admin:'Admin', standardUser:'User', createAdmin:'Create admin account', uploadDatabase:'Upload database', setupTitle:'Set up homefin', setupSubtitle:'Create the first administrator, define your household and choose your starting data. Setup runs once per deployment.', setupDatabaseHelp:'A homefin JSON backup or an Amex Excel statement.', setupReady:'Database ready', createAccount:'Create account', setupDone:'Setup completed', name:'Name', setupPasswordHelp:'At least 8 characters. Stored only as a PBKDF2 hash on the server.', logout:'Logout' }
};
const LANGUAGE_OPTIONS = [{key:'en',label:'English'},{key:'it',label:'Italiano'}];
const EXTRA_I18N = {
  it: {
    close:'Chiudi',
    selectRow:'Seleziona',
    newWorkspace:'Nuovo workspace',
    signupTitle:'Inizia caricando il tuo primo database',
    signupHelp:'Carica un estratto Excel Amex oppure un backup JSON di homefin.',
    uploadFirstDatabase:'Carica primo database',
    signupUploadRequired:'Carica prima un export o un backup JSON.',
    signupAdminRequired:'Nome e password admin sono obbligatori.',
    setupAlreadyCompleted:'Il workspace è già configurato. Accedi con un utente esistente oppure chiedi a un admin di creare il tuo account.',
    smartCategorization:'Categorizzazione intelligente',
    personalVsShared:'Personale vs comune',
    monthlyClarity:'Trend mensili chiari',
    getStarted:'Inizia',
    getStartedSub:'Crea il primo account admin. Poi caricherai il riepilogo spese dal tab Dati.',
    uploadAfterSignupHelp:'Dopo la creazione dell’account entrerai nel workspace vuoto: usa il tab Dati per caricare il tuo riepilogo spese Amex in Excel o un backup JSON.',
    flag:'Flag', deleteUser:'Rimuovi utente', deleteUserConfirm:'Rimuovere questo utente?', firstAdminLocked:'Il primo admin non può essere rimosso', sharePassword:'Condividi password', copyPassword:'Copia password', passwordCreatedHelp:'Password creata. Copiala e condividila con il nuovo utente.', permissions:'Permessi', feature:'Funzione', viewData:'Vedere dati', editData:'Modificare dati', editRules:'Modificare regole', manageUsers:'Gestire utenti', manageCustomization:'Gestire personalizzazione', yes:'Sì', no:'No', resetFilters:'Reset', quickAll:'Tutto', quickYtd:'YTD', quickLast3:'Ultimi 3M', quickLast6:'Ultimi 6M', quickLast12:'Ultimi 12M', quickLastMonth:'Ultimo mese', pickRangeHelp:'Seleziona primo e ultimo periodo', notes:'Note', notesTab:'Note', trends:'Trend', notesMonth:'Mese', notesUser:'Utente', notesPersonalSpend:'Spese personali', notesText:'Note', notesCompleted:'Completato', notesHelp:'Note mensili per utente basate sui periodi correnti e sulle sole spese personali.', timeRange:'Periodo', viewBy:'Vista per', calendarType:'Tipologia calendario', quickRange:'Periodi rapidi', customRange:'Da - a', start:'Da', end:'A', cashflow:'Cashflow', includedInCashflow:'Incluso', excludedFromCashflow:'Escluso', exclude:'Escludi', include:'Includi', refund:'Rimborso', source:'Fonte', noneSelected:'0 selezionati', selectedCount:'selezionati', selectedRows:'righe selezionate', holderNoChange:'Titolare: nessuna modifica', categoryNoChange:'Categoria: nessuna modifica', flagNoChange:'Flag: nessuna modifica', cashflowNoChange:'Cashflow: nessuna modifica', subscriptionNoChange:'Abbonamento: nessuna modifica', clear:'Pulisci', apply:'Applica', selectVisible:'Seleziona visibili', executiveOverview:'Sintesi direzionale', categoryDrivers:'Driver categorie', sourceAccountDrivers:'Driver fonte/conto', openTrends:'Apri Trend', peopleSplit:'Split persone', byAccountSource:'Per conto / fonte', noDataInRange:'Nessun dato nel range selezionato.', averagePerPeriod:'Media per periodo', topCategory:'Categoria principale', shared:'Comuni', personalLabel:'Personali', sharedAllocationNote:'Le spese comuni sono divise secondo lo split del nucleo; le personali vanno al titolare.', profileWorkspaceSubtitle:'Profilo, dati, import, data health e personalizzazione.', dataImport:'Dati & Import', dataHealth:'Salute dati', rulesLogic:'Regole & Logica', revolutAccount:'Account Revolut', mpAccount:'Account MP', dataRefreshHelp:'Aggiorna la dashboard leggendo l’ultima versione salvata in KV.', bankCard:'Banca / carta', importSourceHelp:'Scegli la fonte prima di importare. Per Revolut (e MP in CSV) indica anche l’account, perché il file non contiene l’intestatario. I formati appresi compaiono qui sotto le banche integrate.', exportBackupHelp:'Scarica un backup completo ripristinabile con override totale del DB.', restoreBackupHelp:'Ripristina un backup JSON sostituendo integralmente il DB corrente.', importHistory:'Storico import', rowsRead:'Righe lette', duplicatesSkipped:'Duplicate ignorate', newRows:'nuove', files:'File', sheets:'Fogli', financialExcluded:'Movimenti finanziari esclusi', rulesApplied:'Regole applicate', showMoreImports:'Mostra altre importazioni', noImports:'Nessun import registrato ancora.', manualSubscription:'Abbonamento manuale', showAll:'Mostra tutto', latestRowsNotice:'Mostro le ultime {count} righe. Applica filtri o ricerca per restringere i risultati.', filteredRowsNotice:'Mostro {shown} di {total} righe filtrate per mantenere la tabella veloce.', showMoreRules:'Mostra altre 10', timeMachine:'Time Machine', timeMachineHelp:'Salva fino a 5 snapshot completi nel DB/KV tramite la normale API dell’app. Utile prima di importare una nuova banca o cambiare regole importanti.', timeMachineNamePlaceholder:'Nome backup (opzionale)', createBackup:'Crea backup', timeMachineEmpty:'Nessun backup salvato.', backupCreated:'Backup creato', backupDeleted:'Backup eliminato', backupRestored:'Backup ripristinato', restore:'Ripristina', download:'Scarica', restoreTimeMachineConfirm:'Ripristinare questo backup? Il database corrente verrà sostituito, mentre la lista Time Machine resterà disponibile.', formatsCount:'formati'
  },
  en: {
    close:'Close',
    selectRow:'Select',
    newWorkspace:'New workspace',
    signupTitle:'Start by uploading your first database',
    signupHelp:'Upload an Amex Excel statement or a homefin JSON backup.',
    uploadFirstDatabase:'Upload first database',
    signupUploadRequired:'Upload an export or JSON backup first.',
    signupAdminRequired:'Admin name and password are required.',
    setupAlreadyCompleted:'This workspace is already set up. Log in with an existing user or ask an admin to create your account.',
    smartCategorization:'Smart categorization',
    personalVsShared:'Personal vs shared',
    monthlyClarity:'Monthly clarity',
    getStarted:'Get started',
    getStartedSub:'Create the first admin account. Then upload your spending report from the Data tab.',
    uploadAfterSignupHelp:'After creating the account, you will enter an empty workspace: use the Data tab to upload your Amex Excel spending report or a JSON backup.',
    flag:'Flag', deleteUser:'Remove user', deleteUserConfirm:'Remove this user?', firstAdminLocked:'The first admin cannot be removed', sharePassword:'Share password', copyPassword:'Copy password', passwordCreatedHelp:'Password created. Copy it and share it with the new user.', permissions:'Permissions', feature:'Feature', viewData:'View data', editData:'Edit data', editRules:'Edit rules', manageUsers:'Manage users', manageCustomization:'Manage customization', yes:'Yes', no:'No', resetFilters:'Reset', quickAll:'All', quickYtd:'YTD', quickLast3:'Last 3M', quickLast6:'Last 6M', quickLast12:'Last 12M', quickLastMonth:'Last month', pickRangeHelp:'Select first and last period', notes:'Notes', notesTab:'Notes', trends:'Trends', notesMonth:'Month', notesUser:'User', notesPersonalSpend:'Personal spend', notesText:'Notes', notesCompleted:'Completed', notesHelp:'Monthly user notes based on the current periods and personal expenses only.', timeRange:'Time range', viewBy:'View by', calendarType:'Calendar type', quickRange:'Quick periods', customRange:'Custom range', start:'From', end:'To', cashflow:'Cashflow', includedInCashflow:'Included', excludedFromCashflow:'Excluded', exclude:'Exclude', include:'Include', refund:'Refund', source:'Source', noneSelected:'0 selected', selectedCount:'selected', selectedRows:'selected rows', holderNoChange:'Holder: no change', categoryNoChange:'Category: no change', flagNoChange:'Flag: no change', cashflowNoChange:'Cashflow: no change', subscriptionNoChange:'Subscription: no change', clear:'Clear', apply:'Apply', selectVisible:'Select visible', executiveOverview:'Executive overview', categoryDrivers:'Category drivers', sourceAccountDrivers:'Source/account drivers', openTrends:'Open Trends', peopleSplit:'People split', byAccountSource:'By account / source', noDataInRange:'No data in the selected range.', averagePerPeriod:'Average per period', topCategory:'Top category', shared:'Shared', personalLabel:'Personal', sharedAllocationNote:'Shared expenses follow the household split; personal expenses go to the holder.', profileWorkspaceSubtitle:'Profile, data, import, data health and customization.', dataImport:'Data & Import', dataHealth:'Data Health', rulesLogic:'Rules & Logic', revolutAccount:'Revolut account', mpAccount:'MP account', dataRefreshHelp:'Refresh the dashboard from the latest KV data.', bankCard:'Bank / card', importSourceHelp:'Choose the source before importing. Revolut (and MP CSV) also need the account, because the file has no holder metadata. Learned formats appear here after the built-in banks.', exportBackupHelp:'Download a full backup restorable with full DB override.', restoreBackupHelp:'Restore a JSON backup by fully replacing the current DB.', importHistory:'Import history', rowsRead:'Rows read', duplicatesSkipped:'Duplicates skipped', newRows:'new', files:'Files', sheets:'Sheets', financialExcluded:'Financial movements excluded', rulesApplied:'Rules applied', showMoreImports:'Show more imports', noImports:'No imports recorded yet.', manualSubscription:'Manual subscription', showAll:'Show all', latestRowsNotice:'Showing latest {count} rows. Apply filters/search to narrow results.', filteredRowsNotice:'Showing {shown} of {total} filtered rows to keep the table fast.', showMoreRules:'Show 10 more', timeMachine:'Time Machine', timeMachineHelp:'Save up to 5 full snapshots inside DB/KV through the app API. Useful before importing a new bank or changing important rules.', timeMachineNamePlaceholder:'Backup name (optional)', createBackup:'Create backup', timeMachineEmpty:'No saved backups yet.', backupCreated:'Backup created', backupDeleted:'Backup deleted', backupRestored:'Backup restored', restore:'Restore', download:'Download', restoreTimeMachineConfirm:'Restore this backup? The current database will be replaced, while the Time Machine list stays available.', formatsCount:'formats'
  }
};
Object.assign(EXTRA_I18N.it, {
  overview:'Spese',
  income:'Entrate',
  totalIncome:'Totale entrate',
  incomeMovements:'Movimenti',
  averageIncome:'Media movimento',
  mainIncomeSource:'Fonte principale',
  incomeTrend:'Trend entrate',
  incomeCategoryBreakdown:'Categorie entrate',
  incomeSourceBreakdown:'Fonte / conto',
  incomeReview:'Da verificare',
  addTransaction:'Aggiungi riga',
  saveTransaction:'Salva riga',
  cancel:'Annulla',
  deleteSelectedRows:'Elimina righe',
  deleteRowsConfirm:'Eliminare {count} righe selezionate?',
  manualEntry:'Riga manuale',
  manualEntryMissing:'Compila data, descrizione e importo.',
  manualEntrySaved:'Riga manuale salvata.',
  noIncomeInRange:'Nessuna entrata nel range selezionato.',
  noIncomeReview:'Nessun candidato ambiguo da verificare.',
  manualNotIncome:'Marcati Not income',
  noManualNotIncome:'Nessun movimento marcato Not income nel range.',
  markIncome:'Income',
  markNotIncome:'Not income',
  incomeCategory:'Categoria entrata',
  incomeStatus:'Income',
  learned:'Appreso',
  review:'Review',
  logicSaved:'Salvato nel JSON/KV.',
  healthUserCointestato:'Utente Cointestato creato',
  healthHolderCointestato:'Holder Cointestato su Amex',
  healthSuspiciousDates:'Date sospette / fuori formato',
  healthMissingHolder:'Titolare mancante',
  healthMissingCategory:'Categoria Altro / mancante',
  healthUnknownSource:'Fonte/account sconosciuti',
  healthMissingFx:'FX potenzialmente mancante',
  healthCashflowExcluded:'Movimenti esclusi dal cashflow',
  healthHelp:'Controlli diagnostici: non modificano il database, servono solo a intercettare anomalie dopo import o restore.',
  lastImportBySource:'Ultimo import per fonte',
  rowsBySourceAccount:'Righe per fonte/account',
  noImportsRecorded:'Nessun import registrato.',
  noTransactions:'Nessuna transazione.',
  rawDataHelp:'Apri la tabella transazioni. È pensata soprattutto per desktop.',
  openDataTable:'Apri Data table',
  rulesLogicHelp:'Regole di categorizzazione, suggerimenti e logiche operative documentate nel backup JSON.',
  suggestionsLower:'suggerimenti',
  showMore12:'Vedi altre 12',
  logicHelp:'Questa sezione tiene traccia delle logiche operative. Le modifiche vengono salvate nel backup JSON/KV; usiamola come source of truth quando aggiorniamo importer e allocazione.',
  rulesLogicMobileOnly:'Rules & Logic è disponibile solo su desktop perché contiene tabelle complesse.',
  filters:'Filtri',
  resetAllFiltersLong:'Reset globale filtri e selezioni',
  notesHelp:'Summary mensile per utente basato sui filtri correnti. Le spese includono solo cashflow Expense; le entrate sono separate.',
  notesSpend:'Spesa',
  notesSharedSpend:'Spesa condivisa',
  selectedSpend:'Spesa selezionata',
  expenseOut:'Spese',
  netCashflow:'Saldo netto',
  cashflowCoverage:'Copertura',
  projectedCashflow:'Forecast cashflow mese corrente',
  projectedIncome:'Entrate previste',
  projectedExpense:'Spese previste',
  projectedNet:'Saldo previsto',
  incomeExpenseTrend:'Entrate, spese e saldo',
  cashflowBridge:'Dialogo entrate/spese',
  incomeDrivers:'Driver entrate',
  expenseDrivers:'Driver spese',
  coverageHelp:'Entrate / spese',
  cashflowExpense:'Spesa',
  cashflowIncome:'Entrata',
  cashflowExcluded:'Escluso',
  vsPreviousPeriod:'Vs periodo precedente',
  notEnoughHistory:'Storico insufficiente',
  vs3mAvg:'Vs media 3M',
  vs6mAvg:'Vs media 6M',
  unavailable:'Non disponibile',
  average:'Media',
  forecastCurrent:'Forecast mese corrente · recurring-aware',
  forecastCurrentHelp:'Il forecast separa ricorrenti previste e spesa variabile. Evita di proiettare due volte affitto/mutuo, abbonamenti e bollette.',
  actualSoFar:'Già registrato',
  expectedRecurring:'Ricorrenti attese',
  projectedVariable:'Variabile stimata',
  daysElapsed:'Giorni usati',
  expectedAroundDay:'attesa intorno al giorno',
  notPostedYet:'non ancora vista',
  upcoming:'upcoming',
  noUpcomingRecurring:'Nessuna ricorrente attesa ancora mancante nel periodo corrente.',
  expandRecurring:'Vedi tutte le voci',
  collapseRecurring:'Riduci elenco',
  forecastThumbUp:'Conferma previsione',
  forecastThumbDown:'Escludi dal forecast',
  cfoMonthlyTrend:'Trend mensile CFO',
  automaticInsights:'Insight automatici',
  yoyHelp:'YoY comparirà automaticamente quando esisterà lo stesso periodo dell’anno precedente.',
  peopleAllocationTrend:'Trend allocazione persone',
  currentLabel:'Corrente',
  previousLabel:'Precedente'
});
Object.assign(EXTRA_I18N.en, {
  overview:'Spending',
  income:'Income',
  totalIncome:'Total income',
  incomeMovements:'Movements',
  averageIncome:'Average movement',
  mainIncomeSource:'Main source',
  incomeTrend:'Income trend',
  incomeCategoryBreakdown:'Income categories',
  incomeSourceBreakdown:'Source / account',
  incomeReview:'To review',
  addTransaction:'Add row',
  saveTransaction:'Save row',
  cancel:'Cancel',
  deleteSelectedRows:'Delete rows',
  deleteRowsConfirm:'Delete {count} selected rows?',
  manualEntry:'Manual row',
  manualEntryMissing:'Fill date, description and amount.',
  manualEntrySaved:'Manual row saved.',
  noIncomeInRange:'No income in the selected range.',
  noIncomeReview:'No ambiguous candidates to review.',
  manualNotIncome:'Marked Not income',
  noManualNotIncome:'No movements marked Not income in this range.',
  markIncome:'Income',
  markNotIncome:'Not income',
  incomeCategory:'Income category',
  incomeStatus:'Income',
  learned:'Learned',
  review:'Review',
  logicSaved:'Saved to JSON/KV.',
  healthUserCointestato:'Cointestato user created',
  healthHolderCointestato:'Cointestato holder on Amex',
  healthSuspiciousDates:'Suspicious / invalid dates',
  healthMissingHolder:'Missing holder',
  healthMissingCategory:'Other / missing category',
  healthUnknownSource:'Unknown source/account',
  healthMissingFx:'Potentially missing FX',
  healthCashflowExcluded:'Cashflow-excluded movements',
  healthHelp:'Diagnostic checks: they do not modify the database and only help catch anomalies after imports or restores.',
  lastImportBySource:'Last import by source',
  rowsBySourceAccount:'Rows by source/account',
  noImportsRecorded:'No imports recorded.',
  noTransactions:'No transactions.',
  rawDataHelp:'Open the transaction table. Best on desktop.',
  openDataTable:'Open Data table',
  rulesLogicHelp:'Categorization rules, suggestions and operating logic documented in the JSON backup.',
  suggestionsLower:'suggestions',
  showMore12:'Show 12 more',
  logicHelp:'This section tracks operating logic. Changes are saved in JSON/KV; we use it as source of truth when updating importers and allocation.',
  rulesLogicMobileOnly:'Rules & Logic is available on desktop only because it contains complex tables.',
  filters:'Filters',
  resetAllFiltersLong:'Reset all filters and selections',
  notesHelp:'Monthly user summary based on the current filters. Spend includes Expense cashflow only; income is shown separately.',
  notesSpend:'Spend',
  notesSharedSpend:'Shared spend',
  selectedSpend:'Selected spend',
  expenseOut:'Expenses',
  netCashflow:'Net cashflow',
  cashflowCoverage:'Coverage',
  projectedCashflow:'Current-month cashflow forecast',
  projectedIncome:'Projected income',
  projectedExpense:'Projected expenses',
  projectedNet:'Projected net',
  incomeExpenseTrend:'Income, expenses and net',
  cashflowBridge:'Income/expense bridge',
  incomeDrivers:'Income drivers',
  expenseDrivers:'Expense drivers',
  coverageHelp:'Income / expenses',
  cashflowExpense:'Expense',
  cashflowIncome:'Income',
  cashflowExcluded:'Excluded',
  vsPreviousPeriod:'Vs previous period',
  notEnoughHistory:'Not enough history',
  vs3mAvg:'Vs 3M avg',
  vs6mAvg:'Vs 6M avg',
  unavailable:'Unavailable',
  average:'Average',
  forecastCurrent:'Current-month forecast · recurring-aware',
  forecastCurrentHelp:'The forecast separates expected recurring spend from variable spend, so rent/mortgage, subscriptions and bills are not projected twice.',
  actualSoFar:'Actual so far',
  expectedRecurring:'Expected recurring',
  projectedVariable:'Projected variable',
  daysElapsed:'Days elapsed',
  expectedAroundDay:'expected around day',
  notPostedYet:'not posted yet',
  upcoming:'upcoming',
  noUpcomingRecurring:'No expected recurring spend still missing in the current period.',
  expandRecurring:'Show all items',
  collapseRecurring:'Collapse list',
  forecastThumbUp:'Confirm forecast item',
  forecastThumbDown:'Exclude from forecast',
  cfoMonthlyTrend:'CFO monthly trend',
  automaticInsights:'Automatic insights',
  yoyHelp:'YoY will appear automatically once the same period exists in the previous year.',
  peopleAllocationTrend:'People allocation trend',
  currentLabel:'Current',
  previousLabel:'Previous'
});
Object.assign(EXTRA_I18N.it, {
  memberName:'Nome', memberKeywords:'Parole chiave titolare (opzionale)', addMember:'Aggiungi membro',
  memberKeywordsHelp:'Le parole chiave (es. cognome o nome come appare negli estratti) aiutano gli importer a riconoscere a chi appartiene un conto o una carta. Separale con virgole.',
  sharedSplit:'Divisione spese comuni', splitEqual:'In parti uguali', splitCustom:'Percentuali personalizzate', splitTotal:'Totale', splitMustBe100:'Le percentuali devono sommare a 100.',
  householdRequired:'Aggiungi almeno un membro del nucleo.', householdDuplicate:'Ogni membro deve avere un nome diverso.', household:'Nucleo', saveHousehold:'Salva nucleo', householdSaved:'Nucleo salvato.',
  householdHelp:'Le persone tra cui dividere le spese. Non sono account di login: gli utenti si gestiscono nella sezione Utenti.',
  firstTimeSetup:'Primo avvio', setupStepToken:'Token di setup', setupStepHousehold:'Nucleo familiare', setupStepData:'Dati iniziali',
  setupTokenHelp:'Il valore della variabile d’ambiente APP_PASSWORD impostata su Vercel. Serve solo per creare il workspace (e per il recupero password).',
  setupTokenRequired:'Inserisci il token di setup (APP_PASSWORD).', passwordTooShort:'La password deve avere almeno 8 caratteri.',
  startEmpty:'Vuoto', startDemo:'Dati demo', startFile:'Carica file', startDemoHelp:'Sei mesi di transazioni fittizie generate per i membri indicati. Potrai cancellarle ripristinando un backup vuoto.',
  createWorkspace:'Crea workspace', invalidLogin:'Utente o password non validi', tooManyAttempts:'Troppi tentativi falliti, riprova tra qualche minuto.', apiError:'Errore API',
  loginKicker:'Dashboard privata self-hosted', loginHeadline:'Le spese di casa, finalmente leggibili.', loginTagline:'Categorie pulite, spese personali vs comuni, regole intelligenti e trend chiari in un unico cockpit.',
  loginHelp:'Gli account vengono creati da un admin in Profilo → Utenti.', changePassword:'Cambia password',
  healthUnmatchedHolder:'Titolari non associati a un membro', healthHolderShared:'Titolare "Shared" su Amex'
});
Object.assign(EXTRA_I18N.en, {
  memberName:'Name', memberKeywords:'Owner keywords (optional)', addMember:'Add member',
  memberKeywordsHelp:'Keywords (e.g. surname or the name as printed on statements) help importers detect who owns an account or card. Separate with commas.',
  sharedSplit:'Shared expense split', splitEqual:'Equal split', splitCustom:'Custom percentages', splitTotal:'Total', splitMustBe100:'Percentages must add up to 100.',
  householdRequired:'Add at least one household member.', householdDuplicate:'Each member needs a distinct name.', household:'Household', saveHousehold:'Save household', householdSaved:'Household saved.',
  householdHelp:'The people expenses are split between. These are not login accounts: manage logins in the Users section.',
  firstTimeSetup:'First-time setup', setupStepToken:'Setup token', setupStepHousehold:'Household', setupStepData:'Starting data',
  setupTokenHelp:'The value of the APP_PASSWORD environment variable you set in Vercel. It is only needed to create the workspace (and for password recovery).',
  setupTokenRequired:'Enter the setup token (APP_PASSWORD).', passwordTooShort:'Password must be at least 8 characters.',
  startEmpty:'Empty', startDemo:'Demo data', startFile:'Upload file', startDemoHelp:'Six months of fictional transactions generated for the members above. You can wipe them later by restoring an empty backup.',
  createWorkspace:'Create workspace', invalidLogin:'Invalid user or password', tooManyAttempts:'Too many failed attempts, try again in a few minutes.', apiError:'API error',
  loginKicker:'Self-hosted private dashboard', loginHeadline:'Household spending, finally readable.', loginTagline:'Clean categories, personal vs shared spend, smart rules and clear trends in one cockpit.',
  loginHelp:'Accounts are created by an admin in Profile → Users.', changePassword:'Change password',
  healthUnmatchedHolder:'Holders not matched to a member', healthHolderShared:'"Shared" holder on Amex'
});
Object.assign(EXTRA_I18N.it, { more:'Altro', vsPrevious:'vs periodo precedente', savingsRate:'Tasso di risparmio', net:'Netto', avgPerPeriod:'Media per periodo', people:'Persone', share:'Quota', monthlySpending:'Spesa mensile', noData:'Nessun dato nel periodo' });
Object.assign(EXTRA_I18N.en, { more:'More', vsPrevious:'vs previous period', savingsRate:'Savings rate', net:'Net', avgPerPeriod:'Average per period', people:'People', share:'Share', monthlySpending:'Monthly spending', noData:'No data in this range' });
function tr(lang, key) { return (I18N[lang] && I18N[lang][key]) || (EXTRA_I18N[lang] && EXTRA_I18N[lang][key]) || I18N.en[key] || (EXTRA_I18N.en && EXTRA_I18N.en[key]) || key; }
const CATEGORY_LABEL_TRANSLATIONS = {
  en: { ristoranti:'Restaurants', supermercato:'Groceries', amazon:'Amazon', salute:'Health', delivery:'Delivery', streaming_tech:'Streaming & Apps', tv:'Sky / TV', hotel:'Hotels', voli:'Flights', trasporti:'Transport', benessere:'Wellness', quota_assoc:'Membership fee', altro:'Other', personale:'Personal', lavoro:'Work', assicurazione_meidca:'Medical insurance', assicurazione_medica:'Medical insurance', spese_terzi:'Third-party expenses', food:'Food', shopping:'Shopping', viaggi:'Travel', assicurazione:'Insurance' }
};
const LABEL_TRANSLATIONS = { en: { 'Ristoranti':'Restaurants', 'Supermercato':'Groceries', 'Amazon':'Amazon', 'Salute':'Health', 'Delivery':'Delivery', 'Streaming & App':'Streaming & Apps', 'Sky / TV':'Sky / TV', 'Hotel':'Hotels', 'Voli':'Flights', 'Trasporti':'Transport', 'Benessere':'Wellness', 'Quota Assoc.':'Membership fee', 'Altro':'Other', 'Personale':'Personal', 'Comune':'Shared', 'Lavoro':'Work', 'Assicurazione meidca':'Medical insurance', 'Assicurazione medica':'Medical insurance', 'Spese terzi':'Third-party expenses', 'Food':'Food', 'Shopping':'Shopping', 'Viaggi':'Travel', 'Assicurazione':'Insurance', 'assicurazione':'Insurance', 'supermercato':'Groceries', 'altro':'Other', 'lavoro':'Work', 'hotel':'Hotels', 'voli':'Flights', 'amazon':'Amazon' } };
function displayLabel(lang, value) { return lang === 'en' ? (LABEL_TRANSLATIONS.en[value] || value) : value; }
function translateCategoryConfig(config, lang) {
  if (lang !== 'en') return config;
  return Object.fromEntries(Object.entries(config || {}).map(([key, cfg]) => [key, { ...cfg, label: categoryLabelForInput(key, cfg, lang) }]));
}

function categoryLabelForInput(key, cfg, lang) {
  const raw = cfg?.label || key;
  if (cfg?.labelEdited) return raw;
  if (lang !== 'en') return raw;
  const baseLabel = BASE_CAT_CONFIG[key]?.label;
  // In English we translate untouched built-in category labels, but once a user edits
  // the label we must show the custom value so existing categories remain editable.
  if (baseLabel && raw !== baseLabel) return raw;
  return CATEGORY_LABEL_TRANSLATIONS.en[key] || displayLabel('en', raw);
}

function getPeriodYear(key, viewMode) {
  if (!key) return null;
  const parts = periodEndParts(key);
  return parts?.y ? String(parts.y) : null;
}

function aggregateSummary(keys, summaryData) {
  const out = { total: 0, byHolder: {}, categories: {}, subs: {} };
  for (const key of keys || []) {
    const row = summaryData[key];
    if (!row) continue;
    out.total = round2(out.total + (row.total || 0));
    Object.entries(row.byHolder || {}).forEach(([holder, value]) => { out.byHolder[holder] = round2((out.byHolder[holder] || 0) + value); });
    Object.entries(row.categories || {}).forEach(([cat, value]) => {
      out.categories[cat] = round2((out.categories[cat] || 0) + value);
    });
    Object.entries(row.subs || {}).forEach(([name, info]) => {
      const current = out.subs[name] || { total: 0, count: 0 };
      current.total = round2(current.total + (info.total || 0));
      current.count += info.count || 0;
      out.subs[name] = current;
    });
  }
  return out;
}


function safePct(delta, base) {
  const b = Number(base || 0);
  if (!Number.isFinite(b) || Math.abs(b) < 0.01) return null;
  return Math.round((Number(delta || 0) / b) * 100);
}
function formatDeltaText(delta, pct, fmtFn) {
  const sign = delta > 0 ? '+' : delta < 0 ? '−' : '';
  const abs = Math.abs(Number(delta || 0));
  return `${sign}${fmtFn(abs)}${pct === null || pct === undefined ? '' : ` (${sign}${Math.abs(pct)}%)`}`;
}
function forecastFeedbackMap(store) {
  const feedback = store?.forecastFeedback;
  return feedback && typeof feedback === 'object' && !Array.isArray(feedback) ? feedback : {};
}
function forecastReactionFor(feedback, key) {
  const value = feedback?.[key];
  const reaction = typeof value === 'string' ? value : value?.reaction;
  return reaction === 'up' || reaction === 'down' ? reaction : '';
}
function addMonthsToParts(y, m, delta) {
  const d = new Date(Number(y), Number(m) - 1 + Number(delta || 0), 1);
  return { y: d.getFullYear(), m: d.getMonth() + 1 };
}
function buildPeriodKeyFromEndParts(y, m, viewMode = 'calendar') {
  const yy = String(y).padStart(4, '0');
  const mm = String(m).padStart(2, '0');
  if (viewMode === 'calendar') return `${yy}-${mm}`;
  const end = new Date(Number(y), Number(m) - 1, 20);
  const start = new Date(end);
  start.setMonth(start.getMonth() - 1);
  start.setDate(21);
  const iso = (d) => `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
  return `${iso(start)}_${iso(end)}`;
}
function shiftPeriodKey(key, delta, viewMode = 'calendar') {
  const parts = periodEndParts(key);
  if (!parts) return '';
  const next = addMonthsToParts(parts.y, parts.m, delta);
  return buildPeriodKeyFromEndParts(next.y, next.m, viewMode);
}
function periodDaysInfo(key, viewMode = 'calendar', now = new Date()) {
  const parts = periodEndParts(key);
  if (!parts) return { daysTotal: 30, daysElapsed: 1, currentDayInPeriod: 1, isCurrent: false };
  let start; let end;
  if (viewMode === 'calendar') {
    start = new Date(parts.y, parts.m - 1, 1);
    end = new Date(parts.y, parts.m, 0);
  } else {
    end = new Date(parts.y, parts.m - 1, 20);
    start = new Date(end); start.setMonth(start.getMonth() - 1); start.setDate(21);
  }
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const daysTotal = Math.max(1, Math.round((end - start) / 86400000) + 1);
  const isCurrent = today >= start && today <= end;
  const rawElapsed = Math.round((today - start) / 86400000) + 1;
  const daysElapsed = Math.min(daysTotal, Math.max(1, isCurrent ? rawElapsed : daysTotal));
  return { daysTotal, daysElapsed, currentDayInPeriod: daysElapsed, isCurrent, start, end };
}
function recurringMerchantKey(tx, store, idx = 0) {
  const desc = normalizeText(tx?.desc || tx?.description || '')
    .replace(/\b\d{1,2}[/-]\d{1,2}([/-]\d{2,4})?\b/g, ' ')
    .replace(/\b\d{4,}\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const words = desc.split(' ').filter(Boolean).slice(0, 6).join(' ');
  const cat = categoryForTx(tx, store, idx);
  const flag = personalFlagForTx(tx, store, idx) === 'comune' ? 'shared' : holderKey(tx?.holder || '');
  return `${words || 'unknown'}|${cat}|${flag}`;
}
function detectRecurringGroups(transactions = [], viewMode = 'calendar', store = null) {
  const groups = new Map();
  (transactions || []).forEach((tx, idx) => {
    const amount = Math.abs(Number(tx?.amount || 0));
    if (!Number.isFinite(amount) || amount < 2 || shouldIgnore(tx)) return;
    const key = recurringMerchantKey(tx, store, idx);
    const periodKey = periodKeyForTx(tx, viewMode);
    if (!periodKey) return;
    const date = new Date(tx.date);
    const day = Number.isFinite(date.getTime()) ? date.getDate() : 15;
    const g = groups.get(key) || { key, label: String(tx.desc || tx.description || 'Recurring').slice(0, 56), category: categoryForTx(tx, store, idx), allocation: personalFlagForTx(tx, store, idx) === 'comune' ? 'shared' : holderKey(tx?.holder || ''), occurrences: [], months: new Set() };
    g.occurrences.push({ tx, amount, signedAmount: Number(tx.amount || 0), periodKey, day });
    g.months.add(periodKey);
    groups.set(key, g);
  });
  return [...groups.values()].map((g) => {
    const amounts = g.occurrences.map((o) => o.amount).sort((a,b)=>a-b);
    const days = g.occurrences.map((o) => o.day).sort((a,b)=>a-b);
    const avg = round2(amounts.reduce((a,b)=>a+b,0) / Math.max(1, amounts.length));
    const min = amounts[0] || 0;
    const max = amounts.at(-1) || 0;
    const stable = avg ? ((max - min) / avg) <= 0.12 || (max - min) <= 10 : false;
    const monthsCount = g.months.size;
    const confidence = monthsCount >= 6 && stable ? 'high' : monthsCount >= 3 ? 'medium' : 'low';
    const expectedDay = Math.round(days.reduce((a,b)=>a+b,0) / Math.max(1, days.length));
    return { ...g, monthsCount, avgAmount: avg, minAmount: min, maxAmount: max, stable, confidence, expectedDay };
  }).filter((g) => g.monthsCount >= 3).sort((a,b) => (b.monthsCount - a.monthsCount) || (b.avgAmount - a.avgAmount));
}
function summarizeTxByDimension(transactions = [], keys = [], store = null, dimension = 'category') {
  const wanted = new Set(keys || []);
  return (transactions || []).reduce((acc, tx, idx) => {
    if (shouldIgnore(tx) || !wanted.has(periodKeyForTx(tx, 'calendar')) && false) return acc;
    return acc;
  }, {});
}
function computeDimensionDelta(transactions = [], currentKeys = [], previousKeys = [], viewMode = 'calendar', store = null, categoryConfig = {}) {
  const curSet = new Set(currentKeys || []); const prevSet = new Set(previousKeys || []);
  const out = { categories: {}, accounts: {}, people: {} };
  const add = (obj, key, side, amount) => {
    if (!key) return;
    obj[key] = obj[key] || { current: 0, previous: 0 };
    obj[key][side] = round2((obj[key][side] || 0) + amount);
  };
  (transactions || []).forEach((tx, idx) => {
    if (shouldIgnore(tx)) return;
    const key = periodKeyForTx(tx, viewMode);
    const side = curSet.has(key) ? 'current' : prevSet.has(key) ? 'previous' : null;
    if (!side) return;
    const amount = Number(tx.amount || 0);
    const cat = categoryForTx(tx, store, idx);
    add(out.categories, cat, side, amount);
    const source = sourceLabel(tx.source || tx.accountName || 'amex');
    add(out.accounts, tx.accountName ? `${source} · ${tx.accountName}` : source, side, amount);
    const alloc = txUserAllocation(tx, amount, store, idx);
    householdMembers().forEach((m) => add(out.people, m.name, side, alloc[m.id] || 0));
  });
  const toRows = (obj, type) => Object.entries(obj).map(([key, v]) => {
    const delta = round2((v.current || 0) - (v.previous || 0));
    const pct = safePct(delta, v.previous || 0);
    const cfg = type === 'category' ? categoryConfig[key] : null;
    return { key, label: cfg ? `${cfg.label || key}` : key, current: v.current || 0, previous: v.previous || 0, delta, pct };
  }).sort((a,b)=>Math.abs(b.delta)-Math.abs(a.delta));
  return { categories: toRows(out.categories, 'category'), accounts: toRows(out.accounts, 'account'), people: toRows(out.people, 'people') };
}
function buildRecurringForecast(transactions = [], currentKey, viewMode = 'calendar', store = null) {
  const info = periodDaysInfo(currentKey, viewMode);
  const currentSet = new Set([currentKey]);
  const feedback = forecastFeedbackMap(store);
  const groups = detectRecurringGroups(transactions, viewMode, store);
  const activeGroups = groups.filter((g) => forecastReactionFor(feedback, g.key) !== 'down');
  const recurringKeys = new Set(activeGroups.map((g) => g.key));
  const currentTx = (transactions || []).filter((tx) => !shouldIgnore(tx) && currentSet.has(periodKeyForTx(tx, viewMode)));
  const actual = round2(currentTx.reduce((a,tx)=>a+Number(tx.amount||0),0));
  const currentSeenKeys = new Set(currentTx.map((tx, idx) => recurringMerchantKey(tx, store, idx)));
  const upcoming = activeGroups
    .filter((g) => (['high','medium'].includes(g.confidence) || forecastReactionFor(feedback, g.key) === 'up') && !currentSeenKeys.has(g.key))
    .map((g) => ({ ...g, amount: g.avgAmount, reaction: forecastReactionFor(feedback, g.key), status: g.expectedDay >= info.currentDayInPeriod ? 'upcoming' : 'missing' }))
    .sort((a,b)=>a.expectedDay-b.expectedDay);
  const expectedRecurring = round2(upcoming.reduce((a,g)=>a+Number(g.amount||0),0));
  const variableActual = round2(currentTx.reduce((a,tx,idx)=> recurringKeys.has(recurringMerchantKey(tx, store, idx)) ? a : a + Number(tx.amount||0), 0));
  const variableForecast = info.isCurrent ? round2((variableActual / Math.max(1, info.daysElapsed)) * Math.max(0, info.daysTotal - info.daysElapsed)) : 0;
  const forecast = round2(actual + expectedRecurring + variableForecast);
  return { ...info, groups, feedback, actual, expectedRecurring, variableActual, variableForecast, forecast, upcoming, possible: groups.filter(g=>g.confidence==='low').slice(0,5) };
}
function buildCfoTrendModel({ transactions, viewMode, aggregateKeys, summaryData, store, categoryConfig, lang }) {
  const universe = sortPeriodKeys(Object.keys(summaryData || {}), viewMode);
  const selected = sortPeriodKeys((aggregateKeys || []).filter(Boolean), viewMode);
  const count = Math.max(1, selected.length || 1);
  const firstIdx = universe.indexOf(selected[0]);
  const previousKeys = firstIdx > 0 ? universe.slice(Math.max(0, firstIdx - count), firstIdx) : [];
  const current = aggregateSummary(selected, summaryData);
  const previous = aggregateSummary(previousKeys, summaryData);
  const delta = round2((current.total || 0) - (previous.total || 0));
  const pct = safePct(delta, previous.total || 0);
  const monthKeysBefore = universe.filter(k => selected.length ? sortPeriodKeys([k, selected[0]], viewMode)[0] === k && k !== selected[0] : true);
  const avgFor = (n) => {
    const keys = monthKeysBefore.slice(-n);
    const total = aggregateSummary(keys, summaryData).total || 0;
    return keys.length ? round2(total / keys.length) : null;
  };
  const avg3 = avgFor(3); const avg6 = avgFor(6);
  const currentPeriodKey = periodKeyForTx({ date: new Date().toISOString().slice(0,10) }, viewMode);
  const forecast = selected.includes(currentPeriodKey) ? buildRecurringForecast(transactions, currentPeriodKey, viewMode, store) : null;
  const drivers = computeDimensionDelta(transactions, selected, previousKeys, viewMode, store, categoryConfig);
  const topCat = drivers.categories[0]; const topAcc = drivers.accounts[0];
  const insights = [];
  if (previousKeys.length) insights.push(`${lang === 'it' ? 'Spesa' : 'Spend'} ${formatDeltaText(delta, pct, fmtDec)} ${lang === 'it' ? 'vs periodo precedente comparabile' : 'vs previous comparable period'}.`);
  else insights.push(lang === 'it' ? 'Non c’è abbastanza storico precedente per il confronto MoM.' : 'Not enough previous history for a comparable MoM bridge.');
  if (topCat && Math.abs(topCat.delta) > 1) insights.push(`${lang === 'it' ? 'Driver categoria principale' : 'Main category driver'}: ${topCat.label} ${formatDeltaText(topCat.delta, topCat.pct, fmtDec)}.`);
  if (topAcc && Math.abs(topAcc.delta) > 1) insights.push(`${lang === 'it' ? 'Driver conto/source' : 'Main source/account driver'}: ${topAcc.label} ${formatDeltaText(topAcc.delta, topAcc.pct, fmtDec)}.`);
  if (forecast?.isCurrent) insights.push(`${lang === 'it' ? 'Forecast mese corrente' : 'Current-month forecast'}: ${fmtDec(forecast.forecast)} = ${fmtDec(forecast.actual)} ${lang === 'it' ? 'già registrati' : 'actual'} + ${fmtDec(forecast.expectedRecurring)} ${lang === 'it' ? 'ricorrenti attese' : 'expected recurring'} + ${fmtDec(forecast.variableForecast)} ${lang === 'it' ? 'variabile stimata' : 'projected variable'}.`);
  return { universe, selected, previousKeys, current, previous, delta, pct, avg3, avg6, forecast, drivers, insights: insights.slice(0,4) };
}

function buildCashflowTrendModel({ transactions, viewMode, aggregateKeys, store, categoryConfig, lang, expenseForecast = null }) {
  const byPeriod = {};
  const addPeriod = (key) => {
    if (!key) return null;
    byPeriod[key] = byPeriod[key] || { income: 0, expense: 0, net: 0, incomeCount: 0, expenseCount: 0 };
    return byPeriod[key];
  };
  const currentDims = { incomeCategories: {}, expenseCategories: {}, incomeSources: {}, expenseSources: {} };
  const addDim = (obj, key, label, amount) => {
    if (!key) return;
    obj[key] = obj[key] || { key, label, value: 0 };
    obj[key].value = round2((obj[key].value || 0) + amount);
  };
  (transactions || []).forEach((tx, idx) => {
    const type = cashflowTypeForTx(tx, store);
    if (type !== 'income' && type !== 'expense') return;
    const key = periodKeyForTx(tx, viewMode);
    const bucket = addPeriod(key);
    if (!bucket) return;
    const amount = Math.abs(Number(tx.amount || 0));
    if (!Number.isFinite(amount) || amount === 0) return;
    if (type === 'income') {
      bucket.income = round2(bucket.income + amount);
      bucket.incomeCount += 1;
    } else {
      bucket.expense = round2(bucket.expense + amount);
      bucket.expenseCount += 1;
    }
  });
  Object.values(byPeriod).forEach((row) => { row.net = round2((row.income || 0) - (row.expense || 0)); });
  const universe = sortPeriodKeys(Object.keys(byPeriod), viewMode);
  const selected = sortPeriodKeys((aggregateKeys || []).filter(Boolean), viewMode);
  const count = Math.max(1, selected.length || 1);
  const firstIdx = universe.indexOf(selected[0]);
  const previousKeys = firstIdx > 0 ? universe.slice(Math.max(0, firstIdx - count), firstIdx) : [];
  const totalsFor = (keys) => (keys || []).reduce((acc, key) => {
    const row = byPeriod[key] || {};
    acc.income = round2(acc.income + Number(row.income || 0));
    acc.expense = round2(acc.expense + Number(row.expense || 0));
    acc.net = round2(acc.net + Number(row.net || 0));
    acc.incomeCount += Number(row.incomeCount || 0);
    acc.expenseCount += Number(row.expenseCount || 0);
    return acc;
  }, { income: 0, expense: 0, net: 0, incomeCount: 0, expenseCount: 0 });
  const current = totalsFor(selected);
  const previous = totalsFor(previousKeys);
  const coverage = current.expense ? Math.round((current.income / current.expense) * 100) : (current.income ? 100 : 0);
  const deltas = {
    income: round2(current.income - previous.income),
    expense: round2(current.expense - previous.expense),
    net: round2(current.net - previous.net),
  };
  const priorKeys = universe.filter((key) => selected.length ? sortPeriodKeys([key, selected[0]], viewMode)[0] === key && key !== selected[0] : true);
  const avgFor = (field, n) => {
    const keys = priorKeys.slice(-n);
    if (!keys.length) return null;
    return round2(keys.reduce((sum, key) => sum + Number(byPeriod[key]?.[field] || 0), 0) / keys.length);
  };
  const avg3Income = avgFor('income', 3);
  const avg3Expense = avgFor('expense', 3);
  const currentPeriodKey = periodKeyForTx({ date: new Date().toISOString().slice(0, 10) }, viewMode);
  const forecast = selected.includes(currentPeriodKey) ? (() => {
    const currentPeriod = byPeriod[currentPeriodKey] || { income: 0, expense: 0, net: 0 };
    const projectedExpense = expenseForecast?.forecast != null ? Number(expenseForecast.forecast || 0) : Number(currentPeriod.expense || 0);
    const projectedIncome = Math.max(Number(currentPeriod.income || 0), Number(avg3Income || 0));
    return {
      income: round2(projectedIncome),
      expense: round2(projectedExpense),
      net: round2(projectedIncome - projectedExpense),
      actualIncome: round2(currentPeriod.income || 0),
      actualExpense: round2(currentPeriod.expense || 0),
      coverage: projectedExpense ? Math.round((projectedIncome / projectedExpense) * 100) : 0,
    };
  })() : null;
  const selectedSet = new Set(selected);
  (transactions || []).forEach((tx, idx) => {
    const type = cashflowTypeForTx(tx, store);
    if (type !== 'income' && type !== 'expense') return;
    if (!selectedSet.has(periodKeyForTx(tx, viewMode))) return;
    const amount = Math.abs(Number(tx.amount || 0));
    const cat = categoryForTx(tx, store, idx);
    const cfg = categoryConfig[cat] || { label: cat, icon: '🏷️' };
    const source = sourceLabel(tx.source || tx.accountName || 'amex');
    const sourceKey = tx.accountName ? `${source} · ${tx.accountName}` : source;
    if (type === 'income') {
      addDim(currentDims.incomeCategories, cat, `${cfg.label || cat}`, amount);
      addDim(currentDims.incomeSources, sourceKey, sourceKey, amount);
    } else {
      addDim(currentDims.expenseCategories, cat, `${cfg.label || cat}`, amount);
      addDim(currentDims.expenseSources, sourceKey, sourceKey, amount);
    }
  });
  const topRows = (obj) => Object.values(obj).sort((a, b) => b.value - a.value).slice(0, 6);
  const trend = universe.map((key) => ({
    month: periodLabel(key, viewMode, lang),
    [tr(lang, 'income')]: Math.round(byPeriod[key]?.income || 0),
    [tr(lang, 'expenseOut')]: Math.round(byPeriod[key]?.expense || 0),
    [tr(lang, 'netCashflow')]: Math.round(byPeriod[key]?.net || 0),
  }));
  const insights = [
    `${tr(lang, 'netCashflow')}: ${fmtDec(current.net)} (${coverage}% ${lang === 'it' ? 'copertura entrate/spese' : 'income/expense coverage'}).`,
    previousKeys.length ? `${lang === 'it' ? 'Saldo vs periodo precedente' : 'Net vs previous period'}: ${formatDeltaText(deltas.net, safePct(deltas.net, previous.net || 0), fmtDec)}.` : '',
    forecast ? `${lang === 'it' ? 'Saldo previsto mese corrente' : 'Projected current-period net'}: ${fmtDec(forecast.net)}.` : '',
  ].filter(Boolean);
  return { universe, selected, previousKeys, current, previous, coverage, deltas, avg3Income, avg3Expense, forecast, trend, insights, ...currentDims, topRows };
}

function buildRawRows(transactions, store, categoryConfig = BASE_CAT_CONFIG, lang = 'en') {
  return (transactions || []).map((tx, idx) => {
    const calendarKey = getCalendarKey(tx.date);
    const statementKey = periodKeyForTx(tx, 'statement');
    const amount = Number(tx.amount || 0);
    const categoryKey = categoryForTx(tx, store, idx);
    const subscription = Object.prototype.hasOwnProperty.call(tx, 'subscriptionOverride') ? String(tx.subscriptionOverride || '') : detectSubscription(tx.desc || '');
    const personalFlag = personalFlagForTx(tx, store, idx);
    const incomeInfo = classifyIncomeTx(tx, lang, store);
    const cashflowType = cashflowTypeForTx(tx, store);
    const incomeStatus = incomeInfo.manual || incomeInfo.learned || (incomeInfo.ambiguous ? 'review' : cashflowType);
    return {
      id: tx.ref || `${tx.date}-${idx}-${amount}`,
      rowId: rowKey(tx, idx),
      date: tx.date,
      desc: tx.desc || '',
      holder: tx.holder || '',
      paese: tx.paese || '',
      amount,
      amountLabel: tx.originalCurrency && tx.originalCurrency !== 'EUR'
        ? `${formatRawMoney(amount)} · ${tx.originalCurrency} ${formatItalianNumber(tx.netOriginal ?? tx.originalAmount ?? 0, 2)}${tx.fxRate ? ` @ ${formatItalianNumber(tx.fxRate, 4)}` : ''}`
        : formatRawMoney(amount),
      categoryKey,
      category: categoryConfig[categoryKey]?.label || categoryKey,
      personalFlag,
      personalFlagLabel: personalFlag === 'personale' ? tr(lang, 'personal') : tr(lang, 'common'),
      subscription: subscription || '',
      calendarKey,
      calendarLabel: formatCalendarLabel(calendarKey, lang),
      statementKey,
      statementLabel: formatStatementLabel(statementKey, lang),
      year: tx.date ? String(tx.date).slice(0, 4) : '',
      ref: tx.ref || '',
      source: normalizeSource(tx.source || tx.accountName || 'amex'),
      sourceLabel: sourceLabel(tx.source || tx.accountName || 'amex'),
      accountName: tx.accountName || sourceLabel(tx.source || 'amex'),
      importBatchId: tx.importBatchId || '',
      sourceFileName: tx.sourceFileName || '',
      importedAt: tx.importedAt || '',
      isRefund: tx.isRefund === true || amount < 0,
      cashflowType,
      excludeFromCashflow: cashflowType !== 'expense',
      excludeReason: tx.excludeReason || (isAutoExcludedCashflowDesc(tx.desc || '') ? 'auto' : ''),
      cashflowLabel: cashflowTypeLabel(cashflowType, lang),
      incomeInfo,
      incomeStatus,
      incomeCategoryKey: incomeInfo.incomeCategory,
      incomeCategoryLabel: incomeInfo.incomeCategoryLabel,
      _search: null,
    };
  }).map((row) => ({
    ...row,
    _search: {
      date: String(row.date || '').toLowerCase(),
      desc: String(row.desc || '').toLowerCase(),
      holder: String(row.holder || '').toLowerCase(),
      source: `${row.sourceLabel || ''} ${row.accountName || ''} ${row.source || ''}`.toLowerCase(),
      paese: String(row.paese || '').toLowerCase(),
      category: `${row.category || ''} ${row.categoryKey || ''}`.toLowerCase(),
      personalFlag: `${row.personalFlagLabel || ''} ${row.personalFlag || ''}`.toLowerCase(),
      subscription: String(row.subscription || '').toLowerCase(),
      calendar: `${row.calendarLabel || ''} ${row.calendarKey || ''}`.toLowerCase(),
      statement: `${row.statementLabel || ''} ${row.statementKey || ''}`.toLowerCase(),
      ref: String(row.ref || '').toLowerCase(),
      cashflow: `${row.cashflowLabel || ''} ${row.cashflowType || ''} ${row.incomeStatus || ''} ${row.incomeCategoryLabel || ''} ${row.excludeReason || ''}`.toLowerCase(),
    }
  })).sort((a, b) => (b.date || '').localeCompare(a.date || '') || (b.amount - a.amount));
}

function formatRawMoney(n) {
  return '€' + formatItalianNumber(n, 2);
}
const COUNTRY_COORDS = { ITALY:[53,43], SPAIN:[46,42], FRANCE:[49,39], GERMANY:[52,35], NETHERLANDS:[51,32], IRELAND:[43,31], 'UNITED KINGDOM':[45,31], SWEDEN:[54,25], SLOVAKIA:[56,38], CYPRUS:[62,47], LUXEMBOURG:[50,36], 'UNITED STATES':[24,39], JAPAN:[86,43], SINGAPORE:[74,66], SWITZERLAND:[51,39], GREECE:[58,47], PORTUGAL:[44,43], TURKEY:[61,46] };
function getGeoData(transactions, store) {
  const grouped = {};
  (transactions || []).forEach((tx, idx) => {
    const amount = Number(tx.amount || 0); if (shouldIgnore(tx)) return;
    const paese = String(tx.paese || 'NON INDICATO').trim().toUpperCase() || 'NON INDICATO';
    const cat = categoryForTx(tx, store, idx);
    if (!grouped[paese]) grouped[paese] = { country: paese, total: 0, count: 0, categories: {} };
    grouped[paese].total = round2(grouped[paese].total + amount); grouped[paese].count += 1;
    grouped[paese].categories[cat] = round2((grouped[paese].categories[cat] || 0) + amount);
  });
  return Object.values(grouped).sort((a,b)=>b.total-a.total);
}
function txMatchesFilters(row, filters) {
  const q = (key) => String(filters?.[key] || '').toLowerCase().trim();
  const textMatch = (key) => !q(key) || String(row?._search?.[key] || '').includes(q(key));
  if (!textMatch('date')) return false;
  if (!textMatch('desc')) return false;
  if (!textMatch('holder')) return false;
  if (!textMatch('source')) return false;
  if (!textMatch('paese')) return false;
  if (!textMatch('category')) return false;
  if (!textMatch('personalFlag')) return false;
  if (!textMatch('subscription')) return false;
  if (!textMatch('calendar')) return false;
  if (!textMatch('statement')) return false;
  if (!textMatch('ref')) return false;
  if (!textMatch('cashflow')) return false;
  if (filters.amountMin && row.amount < Number(String(filters.amountMin).replace(',', '.'))) return false;
  if (filters.amountMax && row.amount > Number(String(filters.amountMax).replace(',', '.'))) return false;
  return true;
}

function StatCard({ title, value, sub, accent, theme, onClick, active, className = '' }) {
  return (
    <div className={`hf-stat-card ${active ? 'is-active' : ''} ${onClick ? 'is-clickable' : ''} ${className}`.trim()} onClick={onClick} style={{ '--hf-stat-accent': accent || theme.text }}>
      <div className="hf-stat-label">{title}</div>
      <div className="hf-stat-value">{value}</div>
      {sub && <div className="hf-stat-sub">{sub}</div>}
    </div>
  );
}

function Segmented({ options, value, onChange, theme }) {
  return (
    <div className="hf-segmented">
      {options.map((option) => {
        const active = option.value === value;
        return (
          <button key={option.value} className={`hf-segmented-option ${active ? 'is-active' : ''}`} onClick={() => onChange(option.value)}>{option.label}</button>
        );
      })}
    </div>
  );
}

function UserMenuModal({ store, currentUserId, theme, lang, onClose, embedded = false, onSave, inputStyle, onRefresh, syncing, onImportExcel, uploading, onExportData, onImportBackup, importSourceId, onImportSourceChange, importAccountId, onImportAccountChange, onSavePersonalization, onDeleteCategory, onSaveUsers, onSaveHousehold, onSaveFormat, onDeleteFormat, onSaveFormatAndImport, onLogout, onOpenRawData, onSaveStore, onTimeMachineRestored, onApplyRulesRetroactively }) {
  const users = getUsers(store); const allIds = Object.keys(users); const isCurrentAdmin = users[currentUserId]?.role === 'admin'; const ids = isCurrentAdmin ? allIds : allIds.filter((id)=>id===currentUserId); const initialId = users[currentUserId] ? currentUserId : ids[0];
  const [selectedId, setSelectedId] = useState(initialId); const [section, setSection] = useState('profile'); const [importHistoryVisible, setImportHistoryVisible] = useState(5); const [advancedView, setAdvancedView] = useState('rules'); const [visibleProfileRulesCount, setVisibleProfileRulesCount] = useState(12); const [logicSavedMsg, setLogicSavedMsg] = useState('');
  const [form, setForm] = useState(users[initialId] || {}); const [householdDraft, setHouseholdDraft] = useState(() => householdDraftFromStore(store?.household)); const [householdMsg, setHouseholdMsg] = useState('');
  const [passwordA, setPasswordA] = useState(''); const [passwordB, setPasswordB] = useState('');
  const [catDraft, setCatDraft] = useState(() => getCategoryConfig(store));
  const [timeMachineName, setTimeMachineName] = useState('');
  const [timeMachineMsg, setTimeMachineMsg] = useState('');
  const [timeMachineBackups, setTimeMachineBackups] = useState([]);
  const [timeMachineBusy, setTimeMachineBusy] = useState(false);
  const isAdmin = isCurrentAdmin;
  const initialLang = (lang || users[initialId]?.language) === 'it' ? 'it' : 'en';
  const [newUser, setNewUser] = useState({ name:'', password:'', role:'user', language: initialLang });
  const [createdUser, setCreatedUser] = useState(null);
  const firstAdminId = Object.values(users).filter(u=>u?.role==='admin').sort((a,b)=>(a.createdAt||'').localeCompare(b.createdAt||''))[0]?.id || Object.keys(users).find(id=>users[id]?.role==='admin') || Object.keys(users)[0];
  useEffect(() => { setForm(users[selectedId] || {}); setPasswordA(''); setPasswordB(''); }, [selectedId]);
  useEffect(() => { setCatDraft(getCategoryConfig(store)); }, [store]);
  useEffect(() => { setHouseholdDraft(householdDraftFromStore(store?.household)); }, [store?.household]);
  const saveHousehold = async () => {
    const error = validateHouseholdDraft(householdDraft, T);
    if (error) { setHouseholdMsg(error); return; }
    await onSaveHousehold?.(householdFromDraft(householdDraft));
    setHouseholdMsg(T('householdSaved'));
  };
  useEffect(() => {
    if (section !== 'data') return;
    let alive = true;
    apiTimeMachineList()
      .then((items) => { if (alive) setTimeMachineBackups(items); })
      .catch(() => { if (alive) setTimeMachineMsg(''); });
    return () => { alive = false; };
  }, [section]);
  const update = (patch) => setForm((f) => ({ ...f, ...patch }));
  const uiLang = (lang || form.language) === 'it' ? 'it' : 'en';
  const T = (key) => tr(uiLang, key);
  const txsForHealth = Array.isArray(store?.transactions) ? store.transactions : [];
  const input = inputStyle || { width:'100%', background:theme.input, border:'1px solid ' + theme.border, borderRadius:12, padding:'10px 12px', color:theme.text, boxSizing:'border-box' };
  const importOptions = getImportSourceOptions(store);
  const profileRules = getRules(store);
  const profileRuleFieldOptions = getRuleFieldOptions(txsForHealth, uiLang);
  const profileSuggestions = getRuleSuggestions(store);
  const profileSortedRules = [...profileRules].sort((a,b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')) || String(b.id || '').localeCompare(String(a.id || '')));
  const profileVisibleRules = profileSortedRules.slice(0, visibleProfileRulesCount);
  const logicDefaults = {
    cashflow: [
      { id:'spending', label:'Card purchases, bank payments, SDD/SEPA direct debits and third-party transfers are included as spend.' },
      { id:'refunds', label:'Refunds and negative corrections are included, not discarded, when they represent real cashback/refunds.' },
      { id:'amex_balance', label:'Amex balance-settlement rows are excluded from cashflow; stamp duty and card fees are included.' },
      { id:'internal', label:'Internal transfers between own accounts, deposits, exchanges, card repayments, securities/investment movements and income are excluded.' },
      { id:'bank_fees', label:'Ordinary banking fees/taxes are included unless tied to a securities account/investments.' },
      { id:'bank_imports', label:'Bank-account imports (MP, Fineco): card/debit purchases, direct debits, third-party payments, cash withdrawals, taxes and loan instalments are included; income, transfers to accounts owned by household members, broker/investment flows and credit-card statement totals are excluded.' }
    ],
    allocation: [
      { id:'personal', label:'Personal-flagged rows are allocated 100% to the holder.' },
      { id:'shared', label:'Shared-flagged rows are split across household members using the household split (equal or custom %).' },
      { id:'shared_holder', label:'"Shared" is an account/holder label only, never an extra household member.' },
      { id:'amex', label:'Amex holder always comes from the original cardholder in the statement; shared/personal allocation is controlled only by the flag.' }
    ]
  };
  const logicConfig = { cashflow: Array.isArray(store?.logicConfig?.cashflow) ? store.logicConfig.cashflow : logicDefaults.cashflow, allocation: Array.isArray(store?.logicConfig?.allocation) ? store.logicConfig.allocation : logicDefaults.allocation };
  const saveProfileStore = (next) => onSaveStore?.(next);
  const showTimeMachineMsg = (msg) => {
    setTimeMachineMsg(msg);
    window.setTimeout(() => setTimeMachineMsg(''), 2200);
  };
  const createTimeMachineBackup = async () => {
    setTimeMachineBusy(true);
    try {
      const backups = await apiTimeMachineCreate(timeMachineName);
      setTimeMachineBackups(backups);
      setTimeMachineName('');
      showTimeMachineMsg(T('backupCreated'));
    } finally {
      setTimeMachineBusy(false);
    }
  };
  const deleteTimeMachineBackup = async (id) => {
    setTimeMachineBusy(true);
    try {
      const backups = await apiTimeMachineDelete(id);
      setTimeMachineBackups(backups);
      showTimeMachineMsg(T('backupDeleted'));
    } finally {
      setTimeMachineBusy(false);
    }
  };
  const restoreTimeMachineBackup = async (backup) => {
    if (!backup?.id || !window.confirm(T('restoreTimeMachineConfirm'))) return;
    setTimeMachineBusy(true);
    try {
      const restored = await apiTimeMachineRestore(backup.id);
      onTimeMachineRestored?.(normalizeStoreShape(restored));
      showTimeMachineMsg(T('backupRestored'));
    } finally {
      setTimeMachineBusy(false);
    }
  };
  const downloadTimeMachineBackup = async (backup) => {
    if (!backup?.id) return;
    const payload = await apiTimeMachineDownload(backup.id);
    if (payload?.data) downloadJson('hf-time-machine-' + safeFilePart(backup.name) + '.json', payload.data);
  };
  const addProfileRule = async (seed = {}) => {
    const rawValue = Object.prototype.hasOwnProperty.call(seed, 'value') ? seed.value : '';
    const value = String(rawValue || '').trim();
    const rawCategory = Object.prototype.hasOwnProperty.call(seed, 'category') ? seed.category : '';
    const category = String(rawCategory || '').trim() ? resolveCategoryInput(rawCategory, getCategoryConfig(store)) : '';
    if (String(rawCategory || '').trim() && !category) { alert(T('invalidCategory')); return; }
    let personalFlag = Object.prototype.hasOwnProperty.call(seed, 'personalFlag') ? seed.personalFlag : 'no_change';
    if (personalFlag !== 'personale' && personalFlag !== 'comune') personalFlag = 'no_change';
    const cashflowType = normalizeCashflowTypeValue(seed.cashflowType);
    const nextRule = { id: makeRuleId(), field: seed.field || 'desc', operator: seed.operator || 'contains', value, category, personalFlag, cashflowType, enabled: true, createdAt: new Date().toISOString() };
    await saveProfileStore({ ...store, rules: [nextRule, ...profileRules] });
    setVisibleProfileRulesCount((n) => Math.max(12, n));
  };
  const updateProfileRule = async (id, patch) => saveProfileStore({ ...store, rules: profileRules.map((r) => r.id === id ? { ...r, ...patch } : r) });
  const deleteProfileRule = async (id) => saveProfileStore({ ...store, rules: profileRules.filter((r) => r.id !== id) });
  const dismissProfileSuggestion = async (sug) => { const actionKey = sug.category ? `cat:${sug.category}` : `flag:${sug.personalFlag || 'no_change'}`; const key = normalizeText(sug.signature) + '|' + actionKey; await saveProfileStore({ ...store, dismissedSuggestions: [...new Set([...(store.dismissedSuggestions || []), key])] }); };
  const applyProfileRetro = async () => onApplyRulesRetroactively?.();
  const updateLogicLine = (group, id, value) => {
    const nextConfig = { ...logicConfig, [group]: logicConfig[group].map((line) => line.id === id ? { ...line, label: value } : line) };
    saveProfileStore({ ...store, logicConfig: nextConfig });
    setLogicSavedMsg(T('logicSaved'));
    window.setTimeout(() => setLogicSavedMsg(''), 2000);
  };

  const nav = [ ['profile', T('profile'), 'profile'], ...(isAdmin ? [['household', T('household'), 'account'], ['users', T('users'), 'users']] : []), ['data', T('dataImport'), 'data'], ['health', T('dataHealth'), 'health'], ['advanced', T('rulesLogic'), 'rules'], ['personalization',T('customization'),'customization'] ];
  const importHistoryForHealth = getImportHistory(store);
  const bySourceForHealth = txsForHealth.reduce((acc, tx) => { const key = tx.accountName || sourceLabel(tx.source) || tx.source || 'Unknown'; acc[key] = (acc[key] || 0) + 1; return acc; }, {});
  const lastImportBySource = importHistoryForHealth.reduce((acc, item) => { const key = sourceLabel(item.source) || item.source || 'Unknown'; if (!acc[key] || String(item.importedAt || '') > String(acc[key].importedAt || '')) acc[key] = item; return acc; }, {});
  const healthChecks = (() => {
    const lower = (v) => String(v || '').trim().toLowerCase();
    const amexRows = txsForHealth.filter(tx => lower(tx.source) === 'amex' || lower(tx.sourceLabel) === 'amex' || lower(tx.accountName) === 'amex');
    const checks = [];
    const unmatchedHolders = txsForHealth.filter(tx => { const key = holderKey(tx.holder || ''); return key && key !== SHARED_HOLDER_KEY && !getMember(key); }).length;
    const amexShared = amexRows.filter(tx => holderKey(tx.holder || '') === SHARED_HOLDER_KEY).length;
    const suspiciousDates = txsForHealth.filter(tx => { const d = String(tx.date || ''); return d && !/^\d{4}-\d{2}-\d{2}$/.test(d); }).length;
    const missingHolder = txsForHealth.filter(tx => !String(tx.holder || '').trim()).length;
    const missingCategory = txsForHealth.filter((tx, idx) => !categoryForTx(tx, store, idx) || categoryForTx(tx, store, idx) === 'altro').length;
    const unknownSource = txsForHealth.filter(tx => !String(tx.source || tx.sourceLabel || tx.accountName || '').trim()).length;
    const fxMissing = txsForHealth.filter(tx => { const c = String(tx.currency || tx.originalCurrency || '').toUpperCase(); return c && c !== 'EUR' && !(Number.isFinite(Number(tx.amountEur)) || Number.isFinite(Number(tx.fxRate)) || Number.isFinite(Number(tx.amount))); }).length;
    const cashflowExcluded = txsForHealth.filter(tx => tx.excludeFromCashflow === true || tx.cashflowIncluded === false).length;
    checks.push({ label: T('healthUnmatchedHolder'), count: unmatchedHolders, ok: unmatchedHolders === 0 });
    checks.push({ label: T('healthHolderShared'), count: amexShared, ok: amexShared === 0, rawFilters: { holder: SHARED_HOLDER_LABEL.toLowerCase(), source: 'amex' } });
    checks.push({ label: T('healthSuspiciousDates'), count: suspiciousDates, ok: suspiciousDates === 0 });
    checks.push({ label: T('healthMissingHolder'), count: missingHolder, ok: missingHolder === 0 });
    checks.push({ label: T('healthMissingCategory'), count: missingCategory, ok: missingCategory === 0, category: 'altro' });
    checks.push({ label: T('healthUnknownSource'), count: unknownSource, ok: unknownSource === 0 });
    checks.push({ label: T('healthMissingFx'), count: fxMissing, ok: fxMissing === 0 });
    checks.push({ label: T('healthCashflowExcluded'), count: cashflowExcluded, ok: true, rawFilters: { cashflow: uiLang === 'it' ? 'escluso' : 'excluded' } });
    return checks;
  })();
  const savePersonalization = () => {
    const categoryCustomizations = {};
    Object.entries(catDraft).forEach(([key,cfg]) => {
      const original = { ...(BASE_CAT_CONFIG[key] || getCustomCategories(store)[key] || {}) }; const patch = {};
      if ((cfg.label || '') !== (original.label || '') || cfg.labelEdited) { patch.label = cfg.label || key; if (cfg.labelEdited) patch.labelEdited = true; }
      if ((cfg.icon || '') !== (original.icon || '')) patch.icon = cfg.icon || '🏷️';
      if ((cfg.color || '') !== (original.color || '')) patch.color = cfg.color || original.color || theme.accent;
      if (Object.keys(patch).length) categoryCustomizations[key] = patch;
    });
    onSavePersonalization({ userId: selectedId, profile: { ...form }, categoryCustomizations });
  };
  return <div className="profile-modal">
    {!embedded && <div className="profile-titlebar">
      <div><div className="profile-title"><IconLabel icon="profile">{T('profile')}</IconLabel></div><div className="profile-subtitle">{T('profileWorkspaceSubtitle')}</div></div>
      <button className="profile-back" onClick={onClose} title={T('back')}>‹</button>
    </div>}
    <div className="profile-layout">
      <div className="profile-nav">
        <div className="profile-nav-title">{T('sections')}</div>{nav.map(([id,label,icon]) => <button className={`profile-nav-btn ${id===section ? 'is-active' : ''}`} key={id} title={label} aria-label={label} onClick={()=>setSection(id)}><span className="profile-nav-icon"><Icon name={icon} /></span><span className="profile-nav-label">{label}</span></button>)}
      </div>
      <div className="profile-content">
        {section === 'profile' && <><div className="profile-section-title">{T('personalProfile')}</div><div className="profile-field-grid">
          <label><div className="profile-field-label">{T('displayedName')}</div><input style={input} value={form.name || ''} onChange={e=>update({name:e.target.value})} /></label>
          <label><div className="profile-field-label">{T('username')}</div><input style={{...input, opacity:0.78}} value={form.id || ''} readOnly /></label>
        </div><div className="profile-divider"><div className="profile-section-title">{T('changePassword')}</div><div className="profile-field-grid"><input type="password" style={input} value={passwordA} onChange={e=>setPasswordA(e.target.value)} placeholder={T('newPassword')} /><input type="password" style={input} value={passwordB} onChange={e=>setPasswordB(e.target.value)} placeholder={T('confirmNewPassword')} /></div></div><div className="profile-actions"><button className="profile-primary-btn" onClick={()=>onSave(form,passwordA,passwordB)}>{T('saveProfile')}</button></div></>}
        {section === 'data' && <><div className="profile-section-title"><IconLabel icon="data">{T('dataImport')}</IconLabel></div><div className="profile-data-stack">
          <div className="profile-action-row profile-time-machine-row"><div className="profile-time-machine-controls"><input style={input} value={timeMachineName} onChange={(e)=>setTimeMachineName(e.target.value)} placeholder={T('timeMachineNamePlaceholder')} /><button className="profile-primary-btn" onClick={createTimeMachineBackup} disabled={timeMachineBusy}><Icon name="restore" /> {timeMachineBusy ? T('loading') : T('createBackup')}</button></div><div className="profile-action-copy"><b>{T('timeMachine')}</b><br/>{T('timeMachineHelp')}{timeMachineMsg ? <span className="profile-inline-status"> {timeMachineMsg}</span> : null}</div></div>
          <div className="profile-time-machine-list">{timeMachineBackups.length ? timeMachineBackups.map((backup)=><div key={backup.id} className="profile-time-machine-item"><div><div className="profile-time-machine-title">{backup.name}</div><div className="profile-history-meta">{formatImportTimestamp(backup.createdAt, uiLang)} · {(backup.summary?.transactions || 0)} {T('transactions')} · {(backup.summary?.rules || 0)} {T('rulesCount')} · {(backup.summary?.customCategories || 0)} {T('customCategoriesCount')} · {(backup.summary?.formats || 0)} {T('formatsCount')}</div></div><div className="profile-time-machine-actions"><button className="profile-secondary-btn" disabled={timeMachineBusy} onClick={()=>downloadTimeMachineBackup(backup)}>{T('download')}</button><button className="profile-secondary-btn" disabled={timeMachineBusy} onClick={()=>restoreTimeMachineBackup(backup)}>{T('restore')}</button><button className="hf-icon-danger-btn" disabled={timeMachineBusy} onClick={()=>deleteTimeMachineBackup(backup.id)}>{T('delete')}</button></div></div>) : <div className="profile-empty-state">{T('timeMachineEmpty')}</div>}</div>
          {isAdmin && <LearnFormatPanel store={store} theme={theme} input={input} lang={uiLang} members={householdMembers()} sharedLabel={SHARED_HOLDER_LABEL} onSaveFormat={(format) => onSaveFormat?.(format)} onDeleteFormat={onDeleteFormat} onSaveAndImport={onSaveFormatAndImport} />}
          <div className="profile-action-row"><button className="profile-primary-btn" onClick={onImportExcel} disabled={uploading}>{uploading ? 'Import...' : <><Icon name="import" /> {T('importExcel')}</>}</button><div className="profile-import-options"><label><div className="profile-field-label">{T('bankCard')}</div><select value={importSourceId || 'amex'} onChange={(e)=>onImportSourceChange?.(e.target.value)} style={input}>{importOptions.map((o)=><option key={o.id} value={o.id}>{accountImportLabel(o, uiLang)}</option>)}</select></label>{(importSourceId || 'amex') === 'revolut' && <label><div className="profile-field-label">{T('revolutAccount')}</div><select value={getRevolutAccountOption(importAccountId).id} onChange={(e)=>onImportAccountChange?.(e.target.value)} style={input}>{revolutAccountOptions().map((o)=><option key={o.id} value={o.id}>{revolutAccountLabel(o, uiLang)}</option>)}</select></label>}{(importSourceId || 'amex') === 'mp' && <label><div className="profile-field-label">{T('mpAccount')}</div><select value={getMpAccountOption(importAccountId).id} onChange={(e)=>onImportAccountChange?.(e.target.value)} style={input}>{mpAccountOptions().map((o)=><option key={o.id} value={o.id}>{mpAccountLabel(o, uiLang)}</option>)}</select></label>}<div className="profile-action-copy">{T('importSourceHelp')}</div></div></div>
          <div className="profile-action-row"><button className="profile-primary-btn" onClick={onExportData}><Icon name="export" /> {T('exportJson')}</button><div className="profile-action-copy">{T('exportBackupHelp')}</div></div>
          <div className="profile-action-row"><button className="profile-primary-btn" onClick={onImportBackup}><Icon name="restore" /> {T('importBackup')}</button><div className="profile-action-copy">{T('restoreBackupHelp')}</div></div>
        </div><div className="profile-history"><div className="profile-section-title">{T('importHistory')}</div>{getImportHistory(store).length ? <><div className="profile-history-list">{getImportHistory(store).slice(0,importHistoryVisible).map((item)=><div key={item.id || item.importedAt} className="profile-history-item"><div className="profile-history-head"><span>{formatImportTimestamp(item.importedAt, uiLang)} — {sourceLabel(item.source)} — {item.accountName || sourceLabel(item.source)} — {item.sourceFileName || '—'}</span><span className="profile-history-count">{item.addedCount || 0} {T('newRows')}</span></div><div className="profile-history-meta">{T('rowsRead')}: {item.rowsRead || 0} · {T('duplicatesSkipped')}: {item.duplicateCount || 0} · Refund: {item.refundCount || 0} · {T('excludedFromCashflow')}: {item.excludedCount || 0} · {item.filesRead ? T('files') + ': ' + item.filesRead + ' · ' : ''}{item.parsedSheets ? T('sheets') + ': ' + item.parsedSheets + ' · ' : ''}{item.financialExcludedCount ? (T('financialExcluded') + ': ' + item.financialExcludedCount + (formatFinancialBreakdown(item.excludedBreakdown, uiLang) ? ' (' + formatFinancialBreakdown(item.excludedBreakdown, uiLang) + ')' : '') + ' · ') : ''}{item.currencies?.length ? 'FX: ' + item.currencies.join(', ') + ' · ' : ''}{T('rulesApplied')}: {item.rulesApplied ? T('yes') : '—'}</div></div>)}</div>{getImportHistory(store).length > importHistoryVisible && <button className="profile-secondary-btn" onClick={()=>setImportHistoryVisible(v=>v+10)} style={{marginTop:10,width:'100%'}}>{T('showMoreImports')}</button>}</> : <div className="profile-empty-state">{T('noImports')}</div>}</div></>}
        {section === 'health' && <><div className="profile-section-title"><IconLabel icon="health">Data Health</IconLabel></div><div className="hf-section-copy">{T('healthHelp')}</div><div className="hf-health-grid">{healthChecks.map((check)=>{ const clickable = check.count > 0 && (check.category || check.rawFilters); return <button key={check.label} type="button" disabled={!clickable} onClick={()=>clickable && onOpenRawData?.({ category: check.category || '', rawFilters: check.rawFilters || {} })} className={`hf-health-card ${check.ok ? '' : 'is-warning'} ${clickable ? 'is-clickable' : ''}`.trim()}><div className="hf-health-label">{check.label}</div><div className="hf-health-count"><Icon name={check.ok ? 'check' : 'warning'} />{check.count}</div></button>; })}</div><div className="hf-detail-grid"><div className="hf-detail-card"><div className="hf-detail-title">{T('lastImportBySource')}</div>{Object.keys(lastImportBySource).length ? Object.entries(lastImportBySource).map(([key,item])=><div key={key} className="hf-detail-item"><b>{key}</b><br/>{formatImportTimestamp(item.importedAt, uiLang)} · {item.addedCount || 0} {T('newRows')} · {item.sourceFileName || '—'}</div>) : <div className="hf-empty-text">{T('noImportsRecorded')}</div>}</div><div className="hf-detail-card"><div className="hf-detail-title">{T('rowsBySourceAccount')}</div>{Object.keys(bySourceForHealth).length ? Object.entries(bySourceForHealth).sort((a,b)=>b[1]-a[1]).map(([key,count])=><button key={key} type="button" className="hf-detail-row hf-clickable-row" onClick={()=>onOpenRawData?.({ source:key })}><span>{key}</span><b>{count}</b></button>) : <div className="hf-empty-text">{T('noTransactions')}</div>}</div><div className="hf-detail-card mobile-raw-shortcut"><div className="hf-detail-title">Raw Data</div><div className="hf-section-copy">{T('rawDataHelp')}</div><button className="profile-primary-btn" onClick={()=>onOpenRawData?.()} style={{width:'100%',marginTop:10}}><Icon name="data" /> {T('openDataTable')}</button></div></div></>}

        {section === 'advanced' && <>
          <div className="desktop-only-section">
            <div className="hf-section-head">
              <div>
                <div className="profile-section-title"><IconLabel icon="rules">Rules & Logic</IconLabel></div>
                <div className="hf-section-copy">{T('rulesLogicHelp')}</div>
              </div>
              <div className="hf-segment-row">
                <button className={`hf-segment-btn ${advancedView==='rules' ? 'is-active' : ''}`} onClick={()=>setAdvancedView('rules')}>Rules</button>
                <button className={`hf-segment-btn ${advancedView==='logic' ? 'is-active' : ''}`} onClick={()=>setAdvancedView('logic')}>Logic</button>
              </div>
            </div>
            {advancedView === 'rules' && <div>
              <div className="hf-section-head">
                <div className="hf-section-copy">{profileRules.length} {T('rulesCount')} · {profileSuggestions.length} {T('suggestionsLower')}</div>
                <div className="hf-action-row">
                  <button className="profile-primary-btn" onClick={()=>addProfileRule()}>{T('newRule')}</button>
                  <button className="profile-secondary-btn" onClick={applyProfileRetro}>{T('applyRetro')}</button>
                </div>
              </div>
              {profileSuggestions.length > 0 && <div className="hf-suggestion-panel">
                <div className="hf-suggestion-title">{T('suggestions')}</div>
                {profileSuggestions.slice(0,5).map((sug)=><div key={`${sug.signature}-${sug.category || sug.personalFlag}`} className="hf-suggestion-item">
                  <div className="hf-suggestion-copy"><b>{T('contains')} “{sug.signature}”</b> → {sug.category ? (getCategoryConfig(store)[sug.category]?.label || sug.category) : (sug.personalFlag === 'personale' ? T('personal') : T('common'))} <span>({sug.count})</span></div>
                  <div className="hf-action-row"><button className="profile-secondary-btn" onClick={()=>addProfileRule({value:sug.signature,category:sug.category,personalFlag:sug.personalFlag || 'no_change'})}>{T('create')}</button><button className="hf-icon-danger-btn" onClick={()=>dismissProfileSuggestion(sug)} aria-label={T('delete')}><Icon name="delete" /></button></div>
                </div>)}
              </div>}
              <div className="hf-table-shell">
                <table className="hf-compact-table hf-rules-table">
                  <thead><tr>{[T('active'),T('field'),T('match'),T('text'),T('category'),T('personalFlag'),T('cashflow'),T('actions')].map((h)=><th key={h}>{h}</th>)}</tr></thead>
                  <tbody>{profileVisibleRules.map((rule)=><tr key={rule.id}>
                    <td className="hf-rule-cell"><input type="checkbox" checked={!!rule.enabled} onChange={(e)=>updateProfileRule(rule.id,{enabled:e.target.checked})}/></td>
                    <td className="hf-rule-cell"><select value={rule.field || 'desc'} onChange={(e)=>updateProfileRule(rule.id,{field:e.target.value})} style={input}>{profileRuleFieldOptions.map((field)=><option key={field.key} value={field.key}>{field.label}</option>)}</select></td>
                    <td className="hf-rule-cell"><select value={rule.operator || 'contains'} onChange={(e)=>updateProfileRule(rule.id,{operator:e.target.value})} style={input}><option value="contains">{T('contains')}</option><option value="startsWith">{T('startsWith')}</option><option value="equals">{T('equals')}</option><option value="endsWith">{T('endsWith')}</option></select></td>
                    <td className="hf-rule-cell"><input value={rule.value || ''} onChange={(e)=>updateProfileRule(rule.id,{value:e.target.value})} style={input}/></td>
                    <td className="hf-rule-cell"><select value={rule.category || ''} onChange={(e)=>updateProfileRule(rule.id,{category:e.target.value})} style={input}><option value="">{T('doNotChange')}</option>{Object.entries(getCategoryConfig(store)).filter(([key])=>!isPersonalCategory(key)).map(([key,cfg])=><option key={key} value={key}>{cfg.label}</option>)}</select></td>
                    <td className="hf-rule-cell"><select value={rule.personalFlag || 'no_change'} onChange={(e)=>updateProfileRule(rule.id,{personalFlag:e.target.value})} style={input}><option value="no_change">{T('doNotChange')}</option><option value="personale">{T('personal')}</option><option value="comune">{T('common')}</option></select></td>
                    <td className="hf-rule-cell"><select value={rule.cashflowType || ''} onChange={(e)=>updateProfileRule(rule.id,{cashflowType:e.target.value})} style={input}><option value="">{T('doNotChange')}</option><option value="expense">{T('cashflowExpense')}</option><option value="income">{T('cashflowIncome')}</option><option value="excluded">{T('cashflowExcluded')}</option></select></td>
                    <td className="hf-rule-cell"><button className="hf-icon-danger-btn" onClick={()=>deleteProfileRule(rule.id)}>{T('delete')}</button></td>
                  </tr>)}</tbody>
                </table>
              </div>
              {profileSortedRules.length > visibleProfileRulesCount && <div className="hf-load-more"><button className="profile-secondary-btn" onClick={()=>setVisibleProfileRulesCount(n=>n+12)}>{T('showMore12')}</button></div>}
            </div>}
            {advancedView === 'logic' && <div>
              <div className="hf-section-copy">{T('logicHelp')} {logicSavedMsg && <b style={{color:theme.accent}}> {logicSavedMsg}</b>}</div>
              <div className="hf-logic-grid">
                {[['cashflow','Cashflow'],['allocation','Allocation']].map(([group,title])=><div key={group} className="hf-logic-card">
                  <div className="hf-logic-title">{title}</div>
                  {logicConfig[group].map((line)=><div key={line.id} className="hf-logic-line"><div className="hf-logic-id">{line.id}</div><textarea className="hf-logic-textarea" value={line.label} onChange={(e)=>updateLogicLine(group,line.id,e.target.value)} style={input} /></div>)}
                </div>)}
              </div>
            </div>}
          </div><div className="mobile-only-section hf-section-copy">{T('rulesLogicMobileOnly')}</div></>}

        {section === 'personalization' && <><div className="profile-section-title"><IconLabel icon="customization">{T('customization')}</IconLabel></div><div className="personalization-layout" style={{ display:'grid', gridTemplateColumns:'minmax(220px,320px) 1fr', gap:16 }}><div><div style={{ fontSize:12, color:theme.subtext, fontWeight:800, marginBottom:6 }}>{T('colorTheme')}</div><select style={input} value={form.themeMode || 'dark'} onChange={e=>update({themeMode:e.target.value})}>{THEME_OPTIONS.map(t=><option key={t.key} value={t.key}>{t.label}</option>)}</select><button onClick={savePersonalization} style={{ marginTop:12, width:'100%', background:theme.accent, border:'none', color:'#fff', borderRadius:12, padding:'11px 14px', cursor:'pointer', fontWeight:900 }}>{T('saveCustomization')}</button></div><div className="personalization-categories" style={{ maxHeight:520, overflow:'auto', border:'1px solid '+theme.border, borderRadius:16 }}>{Object.entries(catDraft).filter(([key])=>!isPersonalCategory(key)).map(([key,cfg]) => <div className="personalization-cat-row" key={key} style={{ display:'grid', gridTemplateColumns:'80px 1fr 90px 90px', gap:10, alignItems:'center', padding:12, borderBottom:'1px solid '+theme.border }}><select style={{...input, textAlign:'center'}} value={cfg.icon || '🏷️'} onChange={e=>setCatDraft(d=>({...d,[key]:{...d[key],icon:e.target.value}}))}>{EMOJI_CHOICES.map(e=><option key={e} value={e}>{e}</option>)}</select><input style={input} value={categoryLabelForInput(key, cfg, uiLang)} onChange={e=>setCatDraft(d=>({...d,[key]:{...d[key],label:e.target.value,labelEdited:true}}))} /><input type="color" style={{ width:'100%', height:40, border:'none', background:'transparent' }} value={cfg.color || '#888888'} onChange={e=>setCatDraft(d=>({...d,[key]:{...d[key],color:e.target.value}}))} /><button onClick={()=>onDeleteCategory?.(key)} disabled={key==='altro'} title={key==='altro'?T('cannotDeleteOther'):T('deleteCategory')} style={{background:key==='altro'?theme.soft:'transparent',border:'1px solid '+theme.border,borderRadius:10,color:key==='altro'?theme.subtext:'#EF4444',padding:'9px 10px',fontWeight:800,cursor:key==='altro'?'not-allowed':'pointer'}}>{T('delete')}</button></div>)}</div></div></>}
        {section === 'household' && isAdmin && <><div className="profile-section-title"><IconLabel icon="account">{T('household')}</IconLabel></div><div className="hf-section-copy" style={{marginBottom:14}}>{T('householdHelp')}</div><HouseholdEditor value={householdDraft} onChange={setHouseholdDraft} theme={theme} input={input} T={T} /><div className="profile-actions" style={{marginTop:14}}><button className="profile-primary-btn" onClick={saveHousehold}>{T('saveHousehold')}</button>{householdMsg && <span className="hf-section-copy" style={{marginLeft:12}}>{householdMsg}</span>}</div></>}
        {section === 'users' && isAdmin && <><div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', gap:12, marginBottom:14, flexWrap:'wrap' }}><div className="profile-section-title" style={{marginBottom:0}}><IconLabel icon="users">{T('userManagement')}</IconLabel></div></div><div style={{ display:'grid', gap:10, marginBottom:18 }}>{ids.map(id => { const locked = id===firstAdminId; return <div key={id} style={{display:'grid',gridTemplateColumns:'1fr 130px 110px',gap:10,alignItems:'center',padding:12,border:'1px solid '+theme.border,borderRadius:14,background:theme.panelAlt}}><div><div style={{fontWeight:900}}>{users[id]?.name || id}</div><div style={{fontSize:12,color:theme.subtext}}>{id} · {locked ? T('firstAdminLocked') : (users[id]?.role === 'admin' ? T('admin') : T('standardUser'))}</div></div><select style={input} value={users[id]?.role || 'user'} onChange={e=>onSaveUsers?.({...users,[id]:{...users[id],role:e.target.value}})} disabled={locked}>{['admin','user'].map(r=><option key={r} value={r}>{r==='admin'?T('admin'):T('standardUser')}</option>)}</select><button disabled={locked} onClick={()=>{ if(locked) return; if(!window.confirm(T('deleteUserConfirm'))) return; const next={...users}; delete next[id]; onSaveUsers?.(next); }} style={{background:locked?theme.soft:'transparent',border:'1px solid '+theme.border,borderRadius:12,color:locked?theme.subtext:'#EF4444',padding:'10px 12px',fontWeight:900,cursor:locked?'not-allowed':'pointer'}}>{T('delete')}</button></div>; })}</div><div style={{padding:14,border:'1px solid '+theme.border,borderRadius:16,background:theme.soft,marginBottom:16}}><div className="hf-icon-label" style={{fontWeight:900,marginBottom:10}}><Icon name="users" /> <span>{T('addUser')}</span></div><div style={{display:'grid',gridTemplateColumns:'repeat(auto-fit,minmax(180px,1fr))',gap:10}}><input style={input} placeholder={T('name')} value={newUser.name} onChange={e=>setNewUser(u=>({...u,name:e.target.value}))}/><input style={input} type='password' placeholder={T('password')} value={newUser.password} onChange={e=>setNewUser(u=>({...u,password:e.target.value}))}/><select style={input} value={newUser.role} onChange={e=>setNewUser(u=>({...u,role:e.target.value}))}><option value='user'>{T('standardUser')}</option><option value='admin'>{T('admin')}</option></select><button onClick={()=>{ const id=userIdFromName(newUser.name); if(!newUser.name.trim()||!newUser.password.trim()) return; if(newUser.password.length<8){ alert(T('passwordTooShort')); return; } const created={id,name:newUser.name.trim(),newPassword:newUser.password,role:newUser.role,language:'en',createdAt:new Date().toISOString()}; onSaveUsers?.({...users,[id]:created}); setCreatedUser({ name: created.name, id, password: newUser.password }); setNewUser({name:'',password:'',role:'user',language:'en'}); }} style={{background:theme.accent,border:'none',color:'#fff',borderRadius:12,padding:'10px 12px',fontWeight:900,cursor:'pointer'}}>{T('addUser')}</button></div>{createdUser && <div style={{marginTop:12,padding:12,border:'1px solid '+theme.border,borderRadius:12,background:theme.panel}}><div style={{fontWeight:900,marginBottom:4}}>{T('sharePassword')}</div><div style={{fontSize:13,color:theme.subtext,marginBottom:8}}>{T('passwordCreatedHelp')}</div><div style={{display:'grid',gridTemplateColumns:'1fr auto',gap:8}}><input readOnly style={input} value={`${createdUser.id} / ${createdUser.password}`} /><button onClick={()=>navigator.clipboard?.writeText(`${createdUser.id} / ${createdUser.password}`)} style={{background:theme.input,border:'1px solid '+theme.border,color:theme.text,borderRadius:12,padding:'10px 12px',fontWeight:900,cursor:'pointer'}}>{T('copyPassword')}</button></div></div>}</div><div style={{border:'1px solid '+theme.border,borderRadius:16,overflow:'hidden'}}><div style={{padding:12,fontWeight:900,background:theme.panelAlt}}>{T('permissions')}</div><table style={{width:'100%',borderCollapse:'collapse',fontSize:13}}><thead><tr style={{background:theme.soft}}><th style={{textAlign:'left',padding:10}}>{T('feature')}</th><th style={{padding:10}}>{T('admin')}</th><th style={{padding:10}}>{T('standardUser')}</th></tr></thead><tbody>{[[T('viewData'),true,true],[T('editData'),true,false],[T('editRules'),true,false],[T('manageCustomization'),true,false],[T('manageUsers'),true,false]].map(([feature,admin,user])=><tr key={feature} style={{borderTop:'1px solid '+theme.border}}><td style={{padding:10,fontWeight:800}}>{feature}</td><td style={{padding:10,textAlign:'center'}}>{admin?<Icon name="check" />:'—'}</td><td style={{padding:10,textAlign:'center'}}>{user?<Icon name="check" />:'—'}</td></tr>)}</tbody></table></div></>}
      </div>
    </div>
  </div>;
}

function AppShellLoader() {
  return <div style={{ minHeight:'100vh', display:'flex', alignItems:'center', justifyContent:'center', background: THEMES.dark.bg, color: THEMES.dark.text, fontFamily:"'Inter',system-ui" }}>{tr(lsGet(LS.lang) === 'it' ? 'it' : 'en','loading')}</div>;
}

export default function App() {
  const [store, setStore] = useState(null);
  const [authed, setAuthed] = useState(false);
  const [loading, setLoading] = useState(true);
  const [needsSetup, setNeedsSetup] = useState(false);
  const [activeTab, setActiveTab] = useState('overview');
  const [selectedYear, setSelectedYear] = useState('ALL');
  const [selectedPeriod, setSelectedPeriod] = useState('ALL');
  const [viewMode, setViewMode] = useState('statement');
  const [themeMode, setThemeMode] = useState(() => lsGet(LS.theme) || 'dark');
  const [uploading, setUploading] = useState(false);
  const [uploadMsg, setUploadMsg] = useState('');
  const [syncing, setSyncing] = useState(false);
  const EMPTY_RAW_FILTERS = { date:'', desc:'', holder:'', source:'', paese:'', amountMin:'', amountMax:'', category:'', personalFlag:'', cashflow:'', subscription:'', calendar:'', statement:'', ref:'' };
  const [rawDraftFilters, setRawDraftFilters] = useState(EMPTY_RAW_FILTERS);
  const [rawFilters, setRawFilters] = useState(EMPTY_RAW_FILTERS);
  const [rawSort, setRawSort] = useState({ key: 'date', dir: 'desc' });
  const [rawFilteredRenderLimit, setRawFilteredRenderLimit] = useState(RAW_FILTER_RENDER_STEP);
  const [rawVirtualScrollTop, setRawVirtualScrollTop] = useState(0);
  const [selectedRawIds, setSelectedRawIds] = useState([]);
  const [bulkEdit, setBulkEdit] = useState({ holder:'', category:'', personalFlag:'', cashflow:'', subscription:'' });
  const [manualTxDraft, setManualTxDraft] = useState({ date: isoDate(new Date()), desc: '', amount: '', holder: '', source: 'amex', accountName: 'Amex', category: 'altro', personalFlag: 'personale', cashflow: 'expense' });
  const [showManualTxForm, setShowManualTxForm] = useState(false);
  const [visibleRulesCount, setVisibleRulesCount] = useState(10);
  const [trendCategory, setTrendCategory] = useState('ALL');
  const [categoryLimit, setCategoryLimit] = useState(6);
  const [pieCategoryFilter, setPieCategoryFilter] = useState('ALL');
  const [rangeStart, setRangeStart] = useState('');
  const [rangeEnd, setRangeEnd] = useState('');
  const [currentUserId, setCurrentUserId] = useState(() => lsGet(LS.user));
  const [showUserMenu, setShowUserMenu] = useState(false);
  const [selectedHolder, setSelectedHolder] = useState('ALL');
  const [personalFlagFilters, setPersonalFlagFilters] = useState([]);
  const [sourceFilters, setSourceFilters] = useState([]);
  const [categoryFilters, setCategoryFilters] = useState([]);
  const [importSourceId, setImportSourceId] = useState(() => lsGet(LS.importSource) || 'amex');
  const [importAccountId, setImportAccountId] = useState(() => lsGet(LS.importAccount));
  const [quickRange, setQuickRange] = useState('ALL');
  const [showMobileFilters, setShowMobileFilters] = useState(false);
  const [showFilters, setShowFilters] = useState(false);
  const [showMore, setShowMore] = useState(false);
  const [expandedTxId, setExpandedTxId] = useState(null);
  const [forecastExpanded, setForecastExpanded] = useState(false);
  const fileRef = useRef();
  const backupRef = useRef();
  const theme = THEMES[themeMode] || THEMES.dark;
  // Keep module-level household and learned formats in sync before any derived computation runs this render.
  setActiveHousehold(store?.household);
  setActiveCustomFormats(getCustomImportFormats(store));
  const currentUsers = getUsers(store || {});
  const currentUser = currentUsers[currentUserId] || {};
  const isCurrentAdmin = currentUser?.role === 'admin';
  const currentLang = currentUser?.language === 'it' ? 'it' : 'en';
  const T = (key) => tr(currentLang, key);
  const rawCategoryConfig = useMemo(() => getCategoryConfig(store), [store]);
  const categoryConfig = useMemo(() => translateCategoryConfig(rawCategoryConfig, currentLang), [rawCategoryConfig, currentLang]);

  const saveStore = useCallback(async (newStore) => {
    setStore(newStore);
    setSyncing(true);
    try {
      const result = await apiSet(newStore);
      // The server owns credentials: adopt its sanitized user list (drops any newPassword fields).
      if (result?.users) setStore((prev) => prev ? { ...prev, users: result.users } : prev);
      return true;
    } catch (e) {
      console.error('Sync error', e);
      setStore(store);
      setUploadMsg(currentLang === 'it' ? 'Errore salvataggio: dati non aggiornati' : 'Save error: data was not updated');
      throw e;
    } finally {
      setSyncing(false);
    }
  }, [store, currentLang]);

  useEffect(() => {
    document.body.style.margin = '0';
    document.body.style.background = theme.bg;
    document.body.style.color = theme.text;
    lsSet(LS.theme, themeMode);
  }, [theme, themeMode]);

  useEffect(() => {
    if (!uploadMsg) return;
    const timer = window.setTimeout(() => setUploadMsg(''), 16000);
    return () => window.clearTimeout(timer);
  }, [uploadMsg]);

  useEffect(() => {
    async function tryLoad() {
      try {
        const status = await apiStatus();
        if (status?.needsSetup) { setNeedsSetup(true); setLoading(false); return; }
      } catch {}
      if (!getToken()) { setLoading(false); return; }
      try {
        const remote = await apiGet();
        await handleLogin(remote.data, remote.userId);
      } catch {
        await apiLogout();
      }
      setLoading(false);
    }
    tryLoad();
  }, []);

  const handleLogin = async (remoteData, userId = '') => {
    const normalized = normalizeStoreShape(remoteData && Array.isArray(remoteData.transactions) ? remoteData : { ...(remoteData || {}), transactions: [] });
    const resolvedUserId = userId || lsGet(LS.user) || Object.keys(getUsers(normalized))[0] || '';
    lsSet(LS.user, resolvedUserId);
    setCurrentUserId(resolvedUserId);
    const u = getUsers(normalized)[resolvedUserId];
    lsSet(LS.lang, u?.language === 'it' ? 'it' : 'en');
    if (u?.themeMode && THEMES[u.themeMode]) setThemeMode(u.themeMode); else if (u?.themeMode && !THEMES[u.themeMode]) setThemeMode('dark');
    setStore(normalized);
    if (Number(normalized?.meta?.amexDateGuardLastFixedCount || 0) > 0) { try { await apiSet(normalized); } catch (e) { console.error('Amex date guard sync error', e); } }
    setNeedsSetup(false);
    setAuthed(true);
  };

  const handleSetupComplete = (remoteData, adminUserId) => handleLogin(remoteData, adminUserId);

  const refresh = async () => {
    setSyncing(true);
    try {
      const remote = await apiGet();
      if (remote?.data) {
        const normalized = normalizeStoreShape(remote.data);
        setStore(normalized);
        if (Number(normalized?.meta?.amexDateGuardLastFixedCount || 0) > 0) { try { await apiSet(normalized); } catch (e) { console.error('Amex date guard sync error', e); } }
      }
    } catch (e) {
      console.error(e);
      if (e?.status === 401) logout();
    }
    setSyncing(false);
  };

  // Imports files with a learned format (Profile → Data → Learn format).
  const runCustomImport = async (fileTables, format, baseStore, { recognised = false } = {}) => {
    const importedAt = new Date().toISOString();
    const importBatchId = `${format.id}-${importedAt.replace(/[^0-9]/g, '').slice(0, 14)}`;
    const parsed = await parseWithFormat(fileTables, format, { members: householdMembers(), sharedLabel: SHARED_HOLDER_LABEL, importedAt });
    const option = customImportFormatToOption(format);
    const incoming = parsed.transactions.map((tx) => {
      const category = tx.bankCategory ? resolveCategoryInput(tx.bankCategory, getCategoryConfig(baseStore)) : null;
      return normalizeImportedTx({ ...tx, ...(category ? { category } : {}), importBatchId, importedAt }, option);
    });
    const mergeResult = mergeTransactions(baseStore.transactions, incoming, []);
    const skipped = Object.entries(parsed.stats.skipped || {}).map(([k, v]) => `${k}: ${v}`).join(', ');
    const fileNames = fileTables.map((f) => f.fileName).join(', ');
    const historyItem = {
      id: importBatchId,
      importedAt,
      source: format.id,
      accountName: format.label,
      sourceFileName: fileNames,
      filesRead: fileTables.length,
      rowsRead: parsed.stats.rowsRead,
      addedCount: mergeResult.addedCount,
      duplicateCount: mergeResult.duplicateCount,
      refundCount: parsed.stats.refundCount,
      excludedCount: parsed.stats.excludedCount,
      incomeCount: parsed.stats.incomeCount,
      skipped: parsed.stats.skipped,
      rejectedExamples: parsed.stats.rejectedExamples,
      fxConvertedCount: parsed.stats.fxConverted,
      currencies: parsed.stats.currencies,
      recognisedAutomatically: recognised,
      rulesApplied: true
    };
    const nextStore = applyRulesRetroactively({ ...baseStore, version: TARGET_STORE_VERSION, importHistory: [historyItem, ...getImportHistory(baseStore)].slice(0, 5000), transactions: mergeResult.transactions });
    await saveStore(nextStore);
    setRawFilteredRenderLimit(RAW_FILTER_RENDER_STEP);
    setRawVirtualScrollTop(0);
    setUploadMsg(currentLang === 'it'
      ? `✅ Import ${format.label} completato${recognised ? ' (formato riconosciuto automaticamente)' : ''} · File: ${fileTables.length} · Righe lette: ${parsed.stats.rowsRead} · Nuove: ${mergeResult.addedCount} · Duplicate ignorate: ${mergeResult.duplicateCount} · Entrate: ${parsed.stats.incomeCount} · Rimborsi: ${parsed.stats.refundCount} · Escluse cashflow: ${parsed.stats.excludedCount}${skipped ? ` · Saltate: ${skipped}` : ''}${parsed.stats.fxConverted ? ` · FX convertite: ${parsed.stats.fxConverted}` : ''} · Regole applicate: sì`
      : `✅ ${format.label} import completed${recognised ? ' (format recognised automatically)' : ''} · Files: ${fileTables.length} · Rows read: ${parsed.stats.rowsRead} · New: ${mergeResult.addedCount} · Duplicates skipped: ${mergeResult.duplicateCount} · Income: ${parsed.stats.incomeCount} · Refunds: ${parsed.stats.refundCount} · Cashflow excluded: ${parsed.stats.excludedCount}${skipped ? ` · Skipped: ${skipped}` : ''}${parsed.stats.fxConverted ? ` · FX converted: ${parsed.stats.fxConverted}` : ''} · Rules applied: yes`);
  };

  const saveCustomFormat = async (format, baseStore = store) => {
    try { await apiTimeMachineCreate(`Before format ${format.label}`); } catch (e) { console.error('Time Machine backup failed', e); }
    const next = { ...baseStore, customImportFormats: { ...getCustomImportFormats(baseStore), [format.id]: format } };
    setActiveCustomFormats(next.customImportFormats);
    await saveStore(next);
    return next;
  };
  const deleteCustomFormat = async (id) => {
    const formats = { ...getCustomImportFormats(store) };
    delete formats[id];
    setActiveCustomFormats(formats);
    await saveStore({ ...store, customImportFormats: formats });
    if (importSourceId === id) { setImportSourceId('amex'); lsSet(LS.importSource, 'amex'); }
  };
  const saveFormatAndImport = async (format, files) => {
    setUploading(true);
    try {
      const next = await saveCustomFormat(format);
      await runCustomImport(await readCustomImportFiles(files), format, next);
      setImportSourceId(format.id); lsSet(LS.importSource, format.id);
    } finally {
      setUploading(false);
    }
  };

  const handleUpload = async (e) => {
    const files = Array.from(e.target.files || []);
    const file = files[0];
    if (!file || !store) return;
    setUploading(true);
    setUploadMsg(T('readingExcel'));
    try {
      const hasCsv = files.some((f) => f.name.toLowerCase().endsWith('.csv'));
      const hasExcel = files.some((f) => /\.xlsx?$/i.test(f.name));
      const importOption = getImportSourceOptionForStore(importSourceId, store);
      const revolutAccountOption = getRevolutAccountOption(importAccountId);
      const importSource = importOption?.source || (hasCsv ? 'revolut' : 'amex');
      // Learned formats: used when explicitly selected, or recognised automatically from the file's columns.
      const learnedFormats = getCustomImportFormats(store);
      if (importOption?.customFormat || Object.keys(learnedFormats).length) {
        const fileTables = await readCustomImportFiles(files);
        const match = importOption?.customFormat ? { format: importOption.customFormat } : findMatchingFormat(fileTables, learnedFormats);
        if (match) {
          await runCustomImport(fileTables, match.format, store, { recognised: !importOption?.customFormat });
          return;
        }
      }
      if (hasCsv && importSource !== 'revolut' && importSource !== 'mp') throw new Error(currentLang === 'it' ? 'Questo CSV non corrisponde a nessun formato appreso: usa "Impara formato" in Profilo → Dati, oppure seleziona Revolut/MP.' : 'This CSV matches no learned format: use "Learn format" in Profile → Data, or select Revolut/MP.');
      if (hasExcel && importSource === 'revolut') throw new Error(currentLang === 'it' ? 'Revolut usa CSV: seleziona Amex, MP o Fineco per importare un Excel.' : 'Revolut uses CSV: select Amex, MP or Fineco to import an Excel file.');
      // Fineco is handled below through the XLSX workbook parser.

      if (importSource === 'revolut') {
        const importedAt = new Date().toISOString();
        const importBatchId = `${importSource}-${importedAt.replace(/[^0-9]/g, '').slice(0, 14)}`;
        if (!revolutAccountOption.id) throw new Error(T('householdRequired'));
        const parsed = await parseRevolutCsvFiles(files, { account: revolutAccountOption });
        const incoming = parsed.transactions.map((tx) => normalizeImportedTx({ ...tx, source: importSource, importBatchId, importedAt }, { ...importOption, ...revolutAccountOption, source: importSource }));
        const mergeResult = mergeTransactions(store.transactions, incoming, []);
        const historyItem = {
          id: importBatchId,
          importedAt,
          source: importSource,
          accountName: revolutAccountOption.accountName || 'Revolut',
          accountOwnershipId: revolutAccountOption.id,
          sourceFileName: files.map((f) => f.name).join(', '),
          filesRead: parsed.stats?.filesRead || files.length,
          rowsRead: parsed.stats?.rowsInPeriod || incoming.length,
          rowsSkippedBeforeStart: parsed.stats?.rowsSkippedBeforeStart || 0,
          addedCount: mergeResult.addedCount,
          duplicateCount: mergeResult.duplicateCount,
          refundCount: parsed.stats?.refundCount || 0,
          excludedCount: parsed.stats?.excludedCount || 0,
          financialExcludedCount: parsed.stats?.financialExcludedCount || 0,
          excludedBreakdown: parsed.stats?.excludedBreakdown || {},
          fxConvertedCount: parsed.stats?.fxConvertedCount || 0,
          fxFallbackCount: parsed.stats?.fxFallbackCount || 0,
          currencies: parsed.stats?.currencies || [],
          rulesApplied: true
        };
        const nextStore = applyRulesRetroactively({ ...store, version: TARGET_STORE_VERSION, meta: { ...(store?.meta || {}), baselineId: EMPTY_STORE.meta.baselineId }, importHistory: [historyItem, ...getImportHistory(store)].slice(0, 5000), transactions: mergeResult.transactions });
        await saveStore(nextStore);
        setRawFilteredRenderLimit(RAW_FILTER_RENDER_STEP);
        setRawVirtualScrollTop(0);
        const financialBreakdown = formatFinancialBreakdown(parsed.stats?.excludedBreakdown || {}, currentLang);
        const financialTextIt = financialBreakdown ? ` · Movimenti finanziari esclusi: ${parsed.stats?.financialExcludedCount || 0} (${financialBreakdown})` : ` · Movimenti finanziari esclusi: ${parsed.stats?.financialExcludedCount || 0}`;
        const financialTextEn = financialBreakdown ? ` · Financial movements excluded: ${parsed.stats?.financialExcludedCount || 0} (${financialBreakdown})` : ` · Financial movements excluded: ${parsed.stats?.financialExcludedCount || 0}`;
        const msg = currentLang === 'it'
          ? `✅ Import Revolut completato · File: ${files.length} · Valute: ${(parsed.stats?.currencies || []).join(', ')} · Righe importabili: ${incoming.length} · Nuove: ${mergeResult.addedCount} · Duplicate ignorate: ${mergeResult.duplicateCount} · Refund: ${parsed.stats?.refundCount || 0}${financialTextIt} · Escluse cashflow totali: ${parsed.stats?.excludedCount || 0} · FX convertite: ${parsed.stats?.fxConvertedCount || 0}${parsed.stats?.fxFallbackCount ? ` · FX fallback: ${parsed.stats.fxFallbackCount}` : ''} · Regole applicate: sì`
          : `✅ Revolut import completed · Files: ${files.length} · Currencies: ${(parsed.stats?.currencies || []).join(', ')} · Importable rows: ${incoming.length} · New: ${mergeResult.addedCount} · Duplicates skipped: ${mergeResult.duplicateCount} · Refunds: ${parsed.stats?.refundCount || 0}${financialTextEn} · Total cashflow excluded: ${parsed.stats?.excludedCount || 0} · FX converted: ${parsed.stats?.fxConvertedCount || 0}${parsed.stats?.fxFallbackCount ? ` · FX fallback: ${parsed.stats.fxFallbackCount}` : ''} · Rules applied: yes`;
        setUploadMsg(msg);
      } else if (importSource === 'mp') {
        const importedAt = new Date().toISOString();
        const importBatchId = `${importSource}-${importedAt.replace(/[^0-9]/g, '').slice(0, 14)}`;
        const parsedResults = [];
        for (const f of files) {
          const buffer = await f.arrayBuffer();
          parsedResults.push(parseMpWorkbook(buffer, { sourceFileName: f.name, ...importerHouseholdOptions() }));
        }
        const parsedIncoming = parsedResults.flatMap((r) => r.transactions || []);
        const statementKeys = [...new Set(parsedResults.flatMap((r) => r.statementKeys || []))];
        const stats = parsedResults.reduce((acc, r) => {
          const s = r.stats || {};
          acc.parsedSheets += s.parsedSheets || 0;
          acc.rowsRead += s.rowsRead || 0;
          acc.rowsInPeriod += s.rowsInPeriod || 0;
          acc.refundCount += s.refundCount || 0;
          acc.excludedCount += s.excludedCount || 0;
          acc.financialExcludedCount += s.financialExcludedCount || 0;
          Object.entries(s.excludedBreakdown || {}).forEach(([k,v]) => { acc.excludedBreakdown[k] = (acc.excludedBreakdown[k] || 0) + Number(v || 0); });
          (s.currencies || []).forEach((c) => acc.currenciesSet.add(c));
          return acc;
        }, { parsedSheets: 0, rowsRead: 0, rowsInPeriod: 0, refundCount: 0, excludedCount: 0, financialExcludedCount: 0, excludedBreakdown: {}, currenciesSet: new Set() });
        stats.currencies = [...stats.currenciesSet].sort();
        delete stats.currenciesSet;
        const mpAccountOption = getMpAccountOption(importAccountId);
        const accountNames = [...new Set(parsedIncoming.map((tx) => tx.accountName).filter(Boolean))];
        const incoming = parsedIncoming.map((tx) => normalizeImportedTx({ ...tx, source: importSource, importBatchId, importedAt }, { ...importOption, ...mpAccountOption, source: importSource }));
        const mergeResult = mergeTransactions(store.transactions, incoming, []);
        const historyItem = {
          id: importBatchId,
          importedAt,
          source: importSource,
          accountName: mpAccountOption.accountName || accountNames.join(', ') || 'MP',
          accountOwnershipId: mpAccountOption.id,
          sourceFileName: files.map((f) => f.name).join(', '),
          filesRead: files.length,
          parsedSheets: stats.parsedSheets,
          rowsRead: stats.rowsInPeriod || incoming.length,
          addedCount: mergeResult.addedCount,
          duplicateCount: mergeResult.duplicateCount,
          refundCount: stats.refundCount || 0,
          excludedCount: stats.excludedCount || 0,
          financialExcludedCount: stats.financialExcludedCount || 0,
          excludedBreakdown: stats.excludedBreakdown || {},
          currencies: stats.currencies || [],
          rulesApplied: true
        };
        const nextStore = applyRulesRetroactively({ ...store, version: TARGET_STORE_VERSION, meta: { ...(store?.meta || {}), baselineId: EMPTY_STORE.meta.baselineId }, importHistory: [historyItem, ...getImportHistory(store)].slice(0, 5000), transactions: mergeResult.transactions });
        await saveStore(nextStore);
        setRawFilteredRenderLimit(RAW_FILTER_RENDER_STEP);
        setRawVirtualScrollTop(0);
        const financialBreakdown = formatFinancialBreakdown(stats.excludedBreakdown || {}, currentLang);
        const activeAccountName = mpAccountOption.accountName || accountNames.join(', ') || 'MP';
        const msg = currentLang === 'it'
          ? `✅ Import MP completato · Account: ${activeAccountName} · File: ${files.length} · Righe importabili: ${incoming.length} · Nuove: ${mergeResult.addedCount} · Duplicate ignorate: ${mergeResult.duplicateCount} · Entrate/movimenti esclusi: ${stats.excludedCount || 0}${financialBreakdown ? ` (${financialBreakdown})` : ''} · Refund: ${stats.refundCount || 0} · Regole applicate: sì`
          : `✅ MP import completed · Account: ${activeAccountName} · Files: ${files.length} · Importable rows: ${incoming.length} · New: ${mergeResult.addedCount} · Duplicates skipped: ${mergeResult.duplicateCount} · Income/movements excluded: ${stats.excludedCount || 0}${financialBreakdown ? ` (${financialBreakdown})` : ''} · Refunds: ${stats.refundCount || 0} · Rules applied: yes`;
        setUploadMsg(msg);
      } else if (importSource === 'fineco') {
        const importedAt = new Date().toISOString();
        const importBatchId = `${importSource}-${importedAt.replace(/[^0-9]/g, '').slice(0, 14)}`;
        const parsedResults = [];
        for (const f of files) {
          const buffer = await f.arrayBuffer();
          parsedResults.push(parseFinecoWorkbook(buffer, { sourceFileName: f.name, ...importerHouseholdOptions() }));
        }
        const parsedIncoming = parsedResults.flatMap((r) => r.transactions || []);
        const statementKeys = [...new Set(parsedResults.flatMap((r) => r.statementKeys || []))];
        const stats = parsedResults.reduce((acc, r) => {
          const s = r.stats || {};
          acc.parsedSheets += s.parsedSheets || 0;
          acc.rowsRead += s.rowsRead || 0;
          acc.rowsInPeriod += s.rowsInPeriod || 0;
          acc.refundCount += s.refundCount || 0;
          acc.excludedCount += s.excludedCount || 0;
          acc.financialExcludedCount += s.financialExcludedCount || 0;
          Object.entries(s.excludedBreakdown || {}).forEach(([k,v]) => { acc.excludedBreakdown[k] = (acc.excludedBreakdown[k] || 0) + Number(v || 0); });
          (s.currencies || []).forEach((c) => acc.currenciesSet.add(c));
          return acc;
        }, { parsedSheets: 0, rowsRead: 0, rowsInPeriod: 0, refundCount: 0, excludedCount: 0, financialExcludedCount: 0, excludedBreakdown: {}, currenciesSet: new Set() });
        stats.currencies = [...stats.currenciesSet].sort();
        delete stats.currenciesSet;
        const accountNames = [...new Set(parsedIncoming.map((tx) => tx.accountName).filter(Boolean))];
        const incoming = parsedIncoming.map((tx) => normalizeImportedTx({ ...tx, source: importSource, importBatchId, importedAt }, importOption));
        const mergeResult = mergeTransactions(store.transactions, incoming, []);
        const historyItem = {
          id: importBatchId,
          importedAt,
          source: importSource,
          accountName: accountNames.join(', ') || 'Fineco',
          sourceFileName: files.map((f) => f.name).join(', '),
          filesRead: files.length,
          parsedSheets: stats.parsedSheets,
          rowsRead: stats.rowsInPeriod || incoming.length,
          addedCount: mergeResult.addedCount,
          duplicateCount: mergeResult.duplicateCount,
          refundCount: stats.refundCount || 0,
          excludedCount: stats.excludedCount || 0,
          financialExcludedCount: stats.financialExcludedCount || 0,
          excludedBreakdown: stats.excludedBreakdown || {},
          currencies: stats.currencies || [],
          rulesApplied: true
        };
        const nextStore = applyRulesRetroactively({ ...store, version: TARGET_STORE_VERSION, meta: { ...(store?.meta || {}), baselineId: EMPTY_STORE.meta.baselineId }, importHistory: [historyItem, ...getImportHistory(store)].slice(0, 5000), transactions: mergeResult.transactions });
        await saveStore(nextStore);
        setRawFilteredRenderLimit(RAW_FILTER_RENDER_STEP);
        setRawVirtualScrollTop(0);
        const financialBreakdown = formatFinancialBreakdown(stats.excludedBreakdown || {}, currentLang);
        const msg = currentLang === 'it'
          ? `✅ Import Fineco completato · Account rilevati: ${accountNames.join(', ') || 'Fineco'} · File: ${files.length} · Righe importabili: ${incoming.length} · Nuove: ${mergeResult.addedCount} · Duplicate ignorate: ${mergeResult.duplicateCount} · Entrate/movimenti esclusi: ${stats.excludedCount || 0}${financialBreakdown ? ` (${financialBreakdown})` : ''} · Refund: ${stats.refundCount || 0} · Regole applicate: sì`
          : `✅ Fineco import completed · Detected accounts: ${accountNames.join(', ') || 'Fineco'} · Files: ${files.length} · Importable rows: ${incoming.length} · New: ${mergeResult.addedCount} · Duplicates skipped: ${mergeResult.duplicateCount} · Income/movements excluded: ${stats.excludedCount || 0}${financialBreakdown ? ` (${financialBreakdown})` : ''} · Refunds: ${stats.refundCount || 0} · Rules applied: yes`;
        setUploadMsg(msg);
      } else {
        const buffer = await file.arrayBuffer();
        const { transactions: parsedIncoming, statementKeys, stats } = parseAmexMonthlyWorkbook(buffer);
        const importedAt = new Date().toISOString();
        const importBatchId = `${importSource}-${importedAt.replace(/[^0-9]/g, '').slice(0, 14)}`;
        const incoming = parsedIncoming.map((tx) => normalizeImportedTx({ ...tx, source: importSource, accountName: 'Amex', importBatchId, sourceFileName: file.name, importedAt }, importOption));
        const mergeResult = mergeTransactions(store.transactions, incoming, statementKeys);
        const historyItem = {
          id: importBatchId,
          importedAt,
          source: importSource,
          accountName: 'Amex',
          sourceFileName: file.name,
          statementKeys,
          parsedSheets: stats?.parsedSheets || 0,
          rowsRead: incoming.length,
          addedCount: mergeResult.addedCount,
          duplicateCount: mergeResult.duplicateCount,
          refundCount: stats?.refundCount || 0,
          excludedCount: stats?.excludedCount || 0,
          rejectedCount: stats?.rejectedCount || 0,
          rejectedExamples: stats?.rejectedExamples || [],
          rulesApplied: true
        };
        const nextStore = applyRulesRetroactively({ ...store, version: TARGET_STORE_VERSION, meta: { ...(store?.meta || {}), baselineId: EMPTY_STORE.meta.baselineId }, importHistory: [historyItem, ...getImportHistory(store)].slice(0, 5000), transactions: mergeResult.transactions });
        await saveStore(nextStore);
        setRawFilteredRenderLimit(RAW_FILTER_RENDER_STEP);
        setRawVirtualScrollTop(0);
        const rejectedWarning = stats?.rejectedCount
          ? (currentLang === 'it'
              ? ` · ⚠️ Righe rifiutate: ${stats.rejectedCount}${stats.rejectedExamples?.length ? ` (${stats.rejectedExamples.map((row)=>`${row.reason} riga ${row.rowNumber}`).join(', ')})` : ''}`
              : ` · ⚠️ Rejected rows: ${stats.rejectedCount}${stats.rejectedExamples?.length ? ` (${stats.rejectedExamples.map((row)=>`${row.reason} row ${row.rowNumber}`).join(', ')})` : ''}`)
          : '';
        const msg = currentLang === 'it'
          ? `✅ Import Amex completato · File: ${file.name} · Fogli letti: ${stats?.parsedSheets || 0} · Righe lette: ${incoming.length} · Nuove: ${mergeResult.addedCount} · Duplicate ignorate: ${mergeResult.duplicateCount} · Refund: ${stats?.refundCount || 0} · Escluse cashflow: ${stats?.excludedCount || 0}${rejectedWarning} · Regole applicate: sì`
          : `✅ Amex import completed · File: ${file.name} · Sheets read: ${stats?.parsedSheets || 0} · Rows read: ${incoming.length} · New: ${mergeResult.addedCount} · Duplicates skipped: ${mergeResult.duplicateCount} · Refunds: ${stats?.refundCount || 0} · Cashflow excluded: ${stats?.excludedCount || 0}${rejectedWarning} · Rules applied: yes`;
        setUploadMsg(msg);
      }
    } catch (err) {
      console.error(err);
      setUploadMsg(`❌ ${err?.message || T('fileImportError')}`);
    } finally {
      setUploading(false);
      e.target.value = '';
    }
  };

  const exportData = () => {
    if (!store) return;
    const stamp = new Date().toISOString().slice(0,19).replace(/[:T]/g, '-');
    const fullBackup = normalizeStoreShape(store);
    fullBackup.meta = { ...(fullBackup.meta || {}), fullBackupExportedAt: new Date().toISOString(), fullBackupMode: 'full-replace' };
    const { users, ...withoutUsers } = fullBackup;
    downloadJson('homefin-backup-' + stamp + '.json', withoutUsers);
  };

  const handleBackupImport = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const text = await file.text();
      const parsed = JSON.parse(text);
      if (!parsed || !Array.isArray(parsed.transactions)) throw new Error(T('invalidBackup'));
      const msg = `${T('restoreBackupConfirm')}\n\n- ${parsed.transactions.length} ${T('transactions')}\n- ${(parsed.rules || []).length} ${T('rulesCount')}\n- ${Object.keys(parsed.customCategories || {}).length} ${T('customCategoriesCount')}\n- ${Object.keys(parsed.categoryOverrides || {}).length} ${T('overridesCount')}\n\n${T('restoreBackupWarning')}`;
      if (!window.confirm(msg)) return;
      const { users, ...withoutUsers } = parsed;
      const normalized = normalizeStoreShape({ ...withoutUsers, household: withoutUsers.household || store?.household });
      const restored = await apiReplace({ ...normalized, users: undefined });
      setStore(normalizeStoreShape(restored || normalized));
      setUploadMsg(T('backupImported'));
    } catch (err) {
      console.error(err);
      setUploadMsg('❌ ' + (err?.message || T('backupImportError')));
    } finally {
      e.target.value = '';
    }
  };

  const saveUserProfile = async (profile, passwordA = '', passwordB = '') => {
    if (!store || !profile?.id) return;
    if (!validateEmail(profile.email)) { alert(T('invalidEmail')); return; }
    const users = getUsers(store);
    const old = users[profile.id] || {};
    const nextProfile = { ...old, ...profile };
    const hasPasswordChange = passwordA || passwordB;
    if (passwordA || passwordB) {
      if (passwordA !== passwordB) { alert(T('passwordsDontMatch')); return; }
      if (passwordA.length < 8) { alert(T('passwordTooShort')); return; }
    }
    const next = { ...store, users: { ...users, [profile.id]: nextProfile } };
    try {
      const saved = await apiUpdateProfile(nextProfile, hasPasswordChange ? passwordA : '');
      const normalized = normalizeStoreShape(saved || next);
      setStore(normalized);
    } catch {
      alert(currentLang === 'it' ? 'Profilo non salvato. Verifica i permessi o rieffettua il login.' : 'Profile was not saved. Check permissions or log in again.');
      return;
    }
    if (profile.id === currentUserId && nextProfile.themeMode && THEMES[nextProfile.themeMode]) { setThemeMode(nextProfile.themeMode); lsSet(LS.theme, nextProfile.themeMode); }
    setUploadMsg(T('profileUpdated'));
  };

  const setCurrentLanguage = async (language) => {
    const nextLanguage = language === 'it' ? 'it' : 'en';
    if (!store || !currentUserId) return;
    lsSet(LS.lang, nextLanguage);
    const users = getUsers(store);
    const current = users[currentUserId] || {};
    const next = { ...store, users: { ...users, [currentUserId]: { ...current, language: nextLanguage } } };
    await saveStore(next);
    setStore(next);
  };

  const deleteCategorySafe = async (categoryKey) => {
    if (!store || !categoryKey || categoryKey === 'altro') return;
    const cfg = categoryConfig[categoryKey];
    const label = cfg?.label || categoryKey;
    const ok = window.confirm(`${T('deleteCategoryConfirmStart')} "${label}"?\n\n${T('deleteCategoryConfirmBody')}`);
    if (!ok) return;
    const mapCat = (value) => value === categoryKey || normalizeCategoryKey(value) === normalizeCategoryKey(categoryKey) ? 'altro' : value;
    const nextTransactions = (store.transactions || []).map((tx) => ({
      ...tx,
      category: mapCat(tx.category),
      ruleCategory: mapCat(tx.ruleCategory),
      personalFlag: normalizePersonalFlag(tx.personalFlag),
    }));
    const nextRules = getRules(store).map((rule) => ({ ...rule, category: mapCat(rule.category) || rule.category }));
    const nextOverrides = {};
    Object.entries(getOverrides(store)).forEach(([id, cat]) => { nextOverrides[id] = mapCat(cat); });
    const nextHistory = (store.overrideHistory || []).map((item) => ({ ...item, category: mapCat(item.category) }));
    const nextCustomCategories = { ...getCustomCategories(store) };
    const nextCustomizations = { ...getCategoryCustomizations(store) };
    delete nextCustomCategories[categoryKey];
    delete nextCustomizations[categoryKey];
    const next = { ...store, transactions: nextTransactions, rules: nextRules, categoryOverrides: nextOverrides, overrideHistory: nextHistory, customCategories: nextCustomCategories, categoryCustomizations: nextCustomizations, meta: { ...(store.meta || {}), lastDeletedCategoryV19: categoryKey, lastDeletedCategoryV19At: new Date().toISOString() } };
    await saveStore(next);
    setUploadMsg(`✅ ${T('category')} "${label}" ${T('remappedToOther')}`);
  };

  const saveUsers = async (users) => {
    if (!store) return;
    const currentUsers = getUsers(store);
    const nextUsers = { ...(users || {}) };
    const firstAdminId = Object.keys(currentUsers)[0];
    if (firstAdminId && currentUsers[firstAdminId] && !nextUsers[firstAdminId]) {
      nextUsers[firstAdminId] = currentUsers[firstAdminId];
    }
    const deletedNow = Object.keys(currentUsers).filter((id) => id !== firstAdminId && !nextUsers[id]);
    const activeIds = new Set(Object.keys(nextUsers));
    const deletedUserIds = [...new Set([...(store.meta?.deletedUserIds || []), ...deletedNow])].filter((id) => !activeIds.has(id));
    const next = {
      ...store,
      users: nextUsers,
      meta: { ...(store.meta || {}), deletedUserIds, usersUpdatedAt: new Date().toISOString() }
    };
    await saveStore(next);
    if (currentUserId && !nextUsers[currentUserId]) logout();
    setUploadMsg(T('profileUpdated'));
  };

  const saveHousehold = async (household) => {
    if (!store) return;
    setActiveHousehold(household);
    const next = normalizeStoreShape({ ...store, household });
    await saveStore(next);
    setSelectedHolder('ALL');
  };

  const logout = () => {
    apiLogout();
    setAuthed(false);
    setCurrentUserId('');
    setShowUserMenu(false);
  };

  const savePersonalization = async ({ userId, profile, categoryCustomizations }) => {
    if (!store || !userId) return;
    const users = getUsers(store);
    const old = users[userId] || {};
    const nextProfile = { ...old, ...profile };
    const next = { ...store, users: { ...users, [userId]: nextProfile }, categoryCustomizations: { ...getCategoryCustomizations(store), ...(categoryCustomizations || {}) } };
    await saveStore(next);
    if (userId === currentUserId && nextProfile.themeMode && THEMES[nextProfile.themeMode]) { setThemeMode(nextProfile.themeMode); lsSet(LS.theme, nextProfile.themeMode); }
    setUploadMsg(T('personalizationSaved'));
  };

  const saveForecastFeedback = async (key, reaction) => {
    if (!store || !key) return;
    const current = forecastFeedbackMap(store);
    const previous = forecastReactionFor(current, key);
    const nextFeedback = { ...current };
    if (previous === reaction) {
      delete nextFeedback[key];
    } else {
      nextFeedback[key] = { reaction, userId: currentUserId || '', updatedAt: new Date().toISOString() };
    }
    await saveStore({
      ...store,
      forecastFeedback: nextFeedback,
      meta: { ...(store.meta || {}), forecastFeedbackUpdatedAt: new Date().toISOString() }
    });
  };

  const transactions = Array.isArray(store?.transactions) ? store.transactions : [];
  const sourceOptions = useMemo(() => sourceOptionsFromTransactions(transactions), [transactions]);
  const sourceFilterKeys = useMemo(() => sourceOptions.map((opt) => opt.key), [sourceOptions]);
  const categoryFilterOptions = useMemo(() => Object.entries(categoryConfig).map(([key, cfg]) => ({ key, label: `${cfg.label || key}` })), [categoryConfig]);
  const categoryFilterKeys = useMemo(() => categoryFilterOptions.map((opt) => opt.key), [categoryFilterOptions]);
  const sourceFilteredTransactions = useMemo(() => filterTransactionsBySources(transactions, sourceFilters), [transactions, sourceFilters]);
  const scopedTransactions = useMemo(() => {
    if (selectedHolder === 'ALL') return sourceFilteredTransactions;
    return (sourceFilteredTransactions ?? [])
      .filter(tx => txMatchesSelectedHolder(tx, selectedHolder))
      .map((tx) => {
        if (!isSharedTx(tx)) return tx;
        const allocated = txUserAllocation(tx, Number(tx.amount || 0), store)[selectedHolder] || 0;
        return { ...tx, amount: allocated, holder: holderDisplayName(selectedHolder) || tx.holder, accountScope: '', split: null, scopedAllocationFromShared: true };
      });
  }, [sourceFilteredTransactions, selectedHolder]);
  const personalFilteredTransactions = useMemo(() => filterTransactionsByPersonalFlags(scopedTransactions, personalFlagFilters, store), [scopedTransactions, personalFlagFilters, store]);
  const allPersonalFilteredTransactions = useMemo(() => filterTransactionsByPersonalFlags(sourceFilteredTransactions, personalFlagFilters, store), [sourceFilteredTransactions, personalFlagFilters, store]);
  const analysisTransactions = useMemo(() => filterTransactionsByCategories(personalFilteredTransactions, categoryFilters, store), [personalFilteredTransactions, categoryFilters, store]);
  const allAnalysisTransactions = useMemo(() => filterTransactionsByCategories(allPersonalFilteredTransactions, categoryFilters, store), [allPersonalFilteredTransactions, categoryFilters, store]);
  const allSummaryData = useMemo(() => summarizeTransactions(allAnalysisTransactions, viewMode, store), [allAnalysisTransactions, viewMode, store]);
  const summaryData = useMemo(() => summarizeTransactions(analysisTransactions, viewMode, store), [analysisTransactions, viewMode, store]);
  const periods = useMemo(() => sortPeriodKeys(Object.keys(allSummaryData || {}), viewMode), [allSummaryData, viewMode]);
  const availableYears = useMemo(() => [...new Set(periods.map((key) => getPeriodYear(key, viewMode)).filter(Boolean))].sort(), [periods, viewMode]);

  useEffect(() => {
    if (!availableYears.length) return;
    setSelectedYear((prev) => {
      if (prev === 'ALL' || availableYears.includes(prev)) return prev;
      return availableYears[availableYears.length - 1];
    });
  }, [availableYears]);

  const periodsForYear = useMemo(() => {
    if (selectedYear === 'ALL') return periods;
    return periods.filter((key) => getPeriodYear(key, viewMode) === selectedYear);
  }, [periods, selectedYear, viewMode]);

  const selectedRangeKeys = useMemo(() => {
    const list = periodsForYear.length ? periodsForYear : periods;
    if (rangeStart || rangeEnd) {
      const startIdx = rangeStart ? list.indexOf(rangeStart) : 0;
      const endIdx = rangeEnd ? list.indexOf(rangeEnd) : list.length - 1;
      const a = startIdx >= 0 ? startIdx : 0;
      const b = endIdx >= 0 ? endIdx : list.length - 1;
      return list.slice(Math.min(a,b), Math.max(a,b) + 1);
    }
    return selectedPeriod === 'ALL' ? list : [selectedPeriod];
  }, [periodsForYear, periods, rangeStart, rangeEnd, selectedPeriod]);

  useEffect(() => {
    if (!periods.length) return;
    if (quickRange === 'LAST_1' && selectedPeriod === 'ALL' && !rangeStart && !rangeEnd) {
      const last = (periodsForYear.length ? periodsForYear : periods).at(-1);
      if (last) { setRangeStart(last); setRangeEnd(last); }
      return;
    }
    const validChoices = new Set(['ALL', ...periodsForYear]);
    if (selectedPeriod === 'ALL' && selectedYear === 'ALL') return;
    if (!validChoices.has(selectedPeriod)) {
      setSelectedPeriod(periodsForYear.at(-1) || 'ALL');
    }
  }, [periods, periodsForYear, selectedPeriod, selectedYear]);

  useEffect(() => {
    if (!periods.length) return;
    if (selectedYear !== 'ALL' && !periodsForYear.length) return;
    if (selectedPeriod === 'ALL') return;
    let mapped = null;
    if (viewMode === 'calendar') {
      mapped = selectedPeriod.includes('_') ? getCalendarKey(selectedPeriod.split('_')[1]) : selectedPeriod;
    } else {
      mapped = selectedPeriod.includes('_') ? selectedPeriod : getStatementPeriodKey(`${selectedPeriod}-20`);
    }
    if (mapped && periods.includes(mapped)) setSelectedPeriod(mapped);
    else setSelectedPeriod(periodsForYear.at(-1) || periods.at(-1) || 'ALL');
  }, [viewMode]);

  const displayedKeys = Array.isArray(selectedYear === 'ALL' ? periods : periodsForYear) ? (selectedYear === 'ALL' ? periods : periodsForYear) : [];
  const aggregateKeys = (Array.isArray(selectedRangeKeys) && selectedRangeKeys.length) ? selectedRangeKeys : (selectedPeriod === 'ALL' ? (displayedKeys || []) : [selectedPeriod].filter(Boolean));

  const cfoTrendModel = useMemo(() => buildCfoTrendModel({ transactions: analysisTransactions, viewMode, aggregateKeys, summaryData, store, categoryConfig, lang: currentLang }), [analysisTransactions, viewMode, aggregateKeys, summaryData, store, categoryConfig, currentLang]);
  const cashflowTrendModel = useMemo(() => buildCashflowTrendModel({ transactions: analysisTransactions, viewMode, aggregateKeys, store, categoryConfig, lang: currentLang, expenseForecast: cfoTrendModel.forecast }), [analysisTransactions, viewMode, aggregateKeys, store, categoryConfig, currentLang, cfoTrendModel.forecast]);
  const incomeModel = useMemo(() => buildIncomeModel(analysisTransactions, aggregateKeys, viewMode, store, currentLang, categoryConfig), [analysisTransactions, aggregateKeys, viewMode, store, currentLang, categoryConfig]);

  useEffect(() => {
    const timer = window.setTimeout(() => setRawFilters(rawDraftFilters), RAW_FILTER_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [rawDraftFilters]);

  const rawRows = useMemo(() => buildRawRows(analysisTransactions, store, categoryConfig, currentLang), [analysisTransactions, store, categoryConfig, currentLang]);
  const rawDataFilterActive = useMemo(() => Object.values(rawFilters || {}).some((value) => String(value || '').trim()) || selectedYear !== 'ALL' || selectedPeriod !== 'ALL' || !!rangeStart || !!rangeEnd || selectedHolder !== 'ALL' || personalFlagFilters.length > 0 || sourceFilters.length > 0 || categoryFilters.length > 0, [rawFilters, selectedYear, selectedPeriod, rangeStart, rangeEnd, selectedHolder, personalFlagFilters, sourceFilters, categoryFilters]);
  const rawPerformanceSignature = `${JSON.stringify(rawFilters)}|${selectedYear}|${selectedPeriod}|${rangeStart}|${rangeEnd}|${selectedHolder}|${personalFlagFilters.join(',')}|${sourceFilters.join(',')}|${categoryFilters.join(',')}|${rawSort.key}|${rawSort.dir}|${viewMode}`;

  useEffect(() => {
    setRawFilteredRenderLimit(RAW_FILTER_RENDER_STEP);
    setRawVirtualScrollTop(0);
  }, [rawPerformanceSignature]);

  const scopedRawRows = useMemo(() => {
    const validKeys = new Set(aggregateKeys);
    const periodFilterActive = selectedYear !== 'ALL' || selectedPeriod !== 'ALL' || !!rangeStart || !!rangeEnd;
    const byPeriod = periodFilterActive
      ? rawRows.filter((row) => {
          const key = viewMode === 'calendar' ? row.calendarKey : row.statementKey;
          return key && validKeys.has(key);
        })
      : rawRows;
    return byPeriod.filter((row) => txMatchesFilters(row, rawFilters));
  }, [rawRows, aggregateKeys, selectedYear, selectedPeriod, rangeStart, rangeEnd, viewMode, rawFilters]);

  const sortedScopedRawRows = useMemo(() => {
    const rows = [...scopedRawRows];
    if (!rawSort?.key || !rawSort?.dir) return rows;
    const dir = rawSort.dir === 'asc' ? 1 : -1;
    const valueForSort = (row) => {
      switch (rawSort.key) {
        case 'date': return row.date || '';
        case 'desc': return row.desc || '';
        case 'holder': return row.holder || '';
        case 'source': return row.sourceLabel || row.source || '';
        case 'paese': return row.paese || '';
        case 'amount': return Number(row.amount || 0);
        case 'category': return row.category || row.categoryKey || '';
        case 'personalFlag': return row.personalFlagLabel || row.personalFlag || '';
        case 'cashflow': return row.cashflowLabel || '';
        case 'subscription': return row.subscription || '';
        case 'calendar': return row.calendarKey || row.calendarLabel || '';
        case 'statement': return row.statementKey || row.statementLabel || '';
        case 'ref': return row.ref || '';
        default: return row[rawSort.key] || '';
      }
    };
    rows.sort((a,b) => {
      const av = valueForSort(a); const bv = valueForSort(b);
      if (typeof av === 'number' || typeof bv === 'number') return (Number(av || 0) - Number(bv || 0)) * dir;
      return String(av || '').localeCompare(String(bv || ''), undefined, { numeric:true, sensitivity:'base' }) * dir;
    });
    return rows;
  }, [scopedRawRows, rawSort]);

  const renderedRawRows = useMemo(() => sortedScopedRawRows.slice(0, rawDataFilterActive ? rawFilteredRenderLimit : RAW_BASE_RENDER_LIMIT), [sortedScopedRawRows, rawDataFilterActive, rawFilteredRenderLimit]);
  const rawRowsLimited = !rawDataFilterActive && sortedScopedRawRows.length > RAW_BASE_RENDER_LIMIT;
  const rawFilteredRowsLimited = rawDataFilterActive && sortedScopedRawRows.length > rawFilteredRenderLimit;
  const rawFilteredSubtotal = useMemo(() => scopedRawRows.reduce((sum, row) => row.cashflowType === 'expense' ? round2(sum + Number(row.amount || 0)) : sum, 0), [scopedRawRows]);
  const selectedRawSet = useMemo(() => new Set(selectedRawIds), [selectedRawIds]);
  const rawVirtualWindow = useMemo(() => {
    const total = renderedRawRows.length;
    const viewport = RAW_VIRTUAL_MAX_HEIGHT;
    const start = Math.max(0, Math.floor(rawVirtualScrollTop / RAW_VIRTUAL_ROW_HEIGHT) - RAW_VIRTUAL_OVERSCAN);
    const visibleCount = Math.ceil(viewport / RAW_VIRTUAL_ROW_HEIGHT) + RAW_VIRTUAL_OVERSCAN * 2;
    const end = Math.min(total, start + visibleCount);
    return {
      rows: renderedRawRows.slice(start, end),
      start,
      end,
      topPad: start * RAW_VIRTUAL_ROW_HEIGHT,
      bottomPad: Math.max(0, (total - end) * RAW_VIRTUAL_ROW_HEIGHT),
    };
  }, [renderedRawRows, rawVirtualScrollTop]);

  if (loading) return <AppShellLoader />;
  if (needsSetup) return <SetupWizard onComplete={handleSetupComplete} />;
  if (!authed) return <Login onLogin={handleLogin} />;
  if (!store) return null;

  const allCur = aggregateSummary(aggregateKeys, allSummaryData);
  const cur = aggregateSummary(aggregateKeys, summaryData);
  const rangeLabel = (rangeStart || rangeEnd)
    ? formatRangeLabel((rangeStart || selectedRangeKeys[0]), (rangeEnd || selectedRangeKeys.at(-1)), viewMode, currentLang)
    : (selectedPeriod === 'ALL'
      ? (selectedYear === 'ALL' ? T('allHistory') : `${T('fullYearPrefix')} ${selectedYear}`)
      : periodLabel(selectedPeriod, viewMode, currentLang));
  const members = householdMembers();
  const userCards = members.map((m) => ({ id: m.id, name: m.name, value: allCur.byHolder?.[m.id] || 0 }));
  const incomeUserCards = userCards.map((u) => ({ ...u, value: incomeModel.byHolder?.[u.id] || 0 }));
  const userAccentFor = (id, fallbackIndex = 0) => { const idx = members.findIndex((m) => m.id === id); return memberColor(theme, idx >= 0 ? idx : fallbackIndex); };
  const labelFor = (key) => periodDropdownLabel(key, viewMode, currentLang);
  const personalFilterLabels = { personale: T('personalOnly'), comune: T('commonOnly') };
  const sourceFilterLabels = Object.fromEntries(sourceOptions.map((opt) => [opt.key, opt.label]));
  const categoryFilterLabels = Object.fromEntries(categoryFilterOptions.map((opt) => [opt.key, opt.label]));
  const personalFilterLabel = summarizeMultiFilterLabel(personalFlagFilters, T('all'), personalFilterLabels, currentLang);
  const sourceFilterLabel = summarizeMultiFilterLabel(sourceFilters, T('all'), sourceFilterLabels, currentLang);
  const categoryFilterLabel = summarizeMultiFilterLabel(categoryFilters, T('allCategories'), categoryFilterLabels, currentLang);
  const applyDefaultLastMonth = () => { const list = periodsForYear.length ? periodsForYear : periods; const last = list.at(-1) || ''; setSelectedYear('ALL'); setSelectedPeriod('ALL'); setRangeStart(last); setRangeEnd(last); setQuickRange('LAST_1'); };
  const applyAllPeriods = () => { setSelectedYear('ALL'); setSelectedPeriod('ALL'); setRangeStart(''); setRangeEnd(''); setQuickRange('ALL'); };
  const resetPeriodFilters = () => applyAllPeriods();
  const resetAllFilters = () => { resetPeriodFilters(); setPersonalFlagFilters([]); setSourceFilters([]); setCategoryFilters([]); setSelectedHolder('ALL'); setTrendCategory('ALL'); setPieCategoryFilter('ALL'); setRawDraftFilters(EMPTY_RAW_FILTERS); setRawFilters(EMPTY_RAW_FILTERS); setRawSort({ key:'date', dir:'desc' }); setRawFilteredRenderLimit(RAW_FILTER_RENDER_STEP); setRawVirtualScrollTop(0); setSelectedRawIds([]); setBulkEdit({ holder:'', category:'', personalFlag:'', cashflow:'', subscription:'' }); };
  const applyLastPeriods = (count, key = '') => { const list = periodsForYear.length ? periodsForYear : periods; const slice = list.slice(Math.max(0, list.length - count)); setSelectedPeriod('ALL'); setRangeStart(slice[0] || ''); setRangeEnd(slice.at(-1) || ''); setQuickRange(key || `LAST_${count}`); };
  const applyYtd = () => { const y = new Date().getFullYear().toString(); const nextYear = availableYears.includes(y) ? y : (availableYears.at(-1) || 'ALL'); setSelectedYear(nextYear); setSelectedPeriod('ALL'); setRangeStart(''); setRangeEnd(''); setQuickRange('YTD'); };
  const selectCustomRangePeriod = (key) => {
    if (!key) return;
    setSelectedPeriod('ALL');
    setQuickRange('CUSTOM');
    if (!rangeStart || (rangeStart && rangeEnd)) { setRangeStart(key); setRangeEnd(''); return; }
    const list = periodsForYear.length ? periodsForYear : periods;
    const startIdx = list.indexOf(rangeStart);
    const endIdx = list.indexOf(key);
    if (startIdx >= 0 && endIdx >= 0 && endIdx < startIdx) { setRangeStart(key); setRangeEnd(rangeStart); }
    else setRangeEnd(key);
  };
  const isPeriodInCustomRange = (key) => {
    if (!rangeStart && !rangeEnd) return false;
    const list = periodsForYear.length ? periodsForYear : periods;
    const a = rangeStart ? list.indexOf(rangeStart) : 0;
    const b = rangeEnd ? list.indexOf(rangeEnd) : a;
    const idx = list.indexOf(key);
    if (idx < 0 || a < 0 || b < 0) return false;
    return idx >= Math.min(a,b) && idx <= Math.max(a,b);
  };
  const customRangeOptions = periodsForYear.length ? periodsForYear : periods;
  const customRangeStartValue = rangeStart || customRangeOptions[0] || '';
  const customRangeEndValue = rangeEnd || customRangeOptions.at(-1) || '';
  const setCustomRangeStart = (key) => {
    const next = key || customRangeOptions[0] || '';
    setSelectedPeriod('ALL');
    setQuickRange('CUSTOM');
    setRangeStart(next);
    if (!rangeEnd) setRangeEnd(customRangeOptions.at(-1) || next);
  };
  const setCustomRangeEnd = (key) => {
    const next = key || customRangeOptions.at(-1) || '';
    setSelectedPeriod('ALL');
    setQuickRange('CUSTOM');
    if (!rangeStart) setRangeStart(customRangeOptions[0] || next);
    setRangeEnd(next);
  };
  const openDataWithFilters = ({ category = '', source = '', subscription = '', search = '', recurringKey = '', rawFilters: rawFilterPatch = {} } = {}) => {
    setShowUserMenu(false);
    setActiveTab('raw');
    setShowFilters(false);
    setShowMobileFilters(false);
    setSelectedRawIds([]);
    setRawFilteredRenderLimit(RAW_FILTER_RENDER_STEP);
    setRawVirtualScrollTop(0);
    setCategoryFilters(category ? [category] : []);
    setSourceFilters(source ? [normalizeSource(source)] : []);
    const nextRaw = { ...EMPTY_RAW_FILTERS };
    Object.assign(nextRaw, rawFilterPatch || {});
    if (subscription) nextRaw.subscription = subscription;
    if (search) nextRaw.desc = search;
    if (recurringKey) nextRaw.desc = String(recurringKey).split('|')[0] || recurringKey;
    setRawDraftFilters(nextRaw);
    setRawFilters(nextRaw);
  };
  const chartPeriodKeys = aggregateKeys.length ? aggregateKeys : displayedKeys;
  const trendData = chartPeriodKeys.map((p) => {
    if (trendCategory !== 'ALL') {
      const keyForTx = (tx) => periodKeyForTx(tx, viewMode);
      const txs = analysisTransactions.filter(tx => keyForTx(tx) === p && categoryForTx(tx, store) === trendCategory && !shouldIgnore(tx));
      const row = { month: labelFor(p) };
      let total = 0;
      members.forEach((m) => { const v = txs.reduce((a,tx)=>a+(txUserAllocation(tx, Number(tx.amount||0), store)[m.id] || 0),0); total += v; row[m.name] = Math.round(v); });
      row[categoryConfig[trendCategory]?.label || trendCategory] = Math.round(total);
      return row;
    }
    const row = { month: labelFor(p), [T('totalSpend')]: Math.round(summaryData[p]?.total || 0) };
    members.forEach((m) => { row[m.name] = Math.round(summaryData[p]?.byHolder?.[m.id] || 0); });
    return row;
  });
  const trendLineKey = trendCategory === 'ALL' ? T('totalSpend') : (categoryConfig[trendCategory]?.label || trendCategory);
  const categoryTrendData = chartPeriodKeys.map(p => {
    const row = { month: labelFor(p) };
    Object.keys(categoryConfig).forEach(k => { row[categoryConfig[k].label] = Math.round(summaryData[p]?.categories?.[k] || 0); });
    return row;
  });
  const allSubs = [...new Set(displayedKeys.flatMap((p) => Object.keys(summaryData[p]?.subs || {})))].filter((s) => s !== 'Quota Assoc.');
  const subsTrendData = chartPeriodKeys.map((p) => {
    const row = { month: labelFor(p) };
    allSubs.forEach((s) => { row[s] = summaryData[p]?.subs?.[s]?.total || 0; });
    return row;
  });
  const catPieData = Object.entries(cur.categories || {}).filter(([k,v]) => v > 5 && (pieCategoryFilter === 'ALL' || k === pieCategoryFilter)).sort(([,a],[,b]) => b-a).map(([k,v]) => ({ key:k, name: categoryConfig[k]?.label || k, value: Math.round(v), icon: categoryConfig[k]?.icon || '📋', color: categoryConfig[k]?.color || '#888' }));
  const topCategoryRows = Object.entries(cur.categories||{}).sort(([,a],[,b])=>b-a).slice(0, Number(categoryLimit));
  const totalSubs = Object.values(cur.subs || {}).reduce((a,s) => a + s.total, 0);
  const selectedKeySetForOverview = new Set(aggregateKeys || []);
  const overviewTx = (analysisTransactions || []).filter((tx) => selectedKeySetForOverview.has(periodKeyForTx(tx, viewMode)) && !shouldIgnore(tx));
  const overviewSharedTotal = overviewTx.filter((tx, idx) => personalFlagForTx(tx, store, idx) === 'comune').reduce((sum, tx) => round2(sum + Number(tx.amount || 0)), 0);
  const overviewPersonalTotal = overviewTx.filter((tx, idx) => personalFlagForTx(tx, store, idx) === 'personale').reduce((sum, tx) => round2(sum + Number(tx.amount || 0)), 0);
  const overviewPeopleSplit = overviewTx.reduce((acc, tx, idx) => {
    const amount = Number(tx.amount || 0);
    const flag = personalFlagForTx(tx, store, idx);
    const alloc = txUserAllocation(tx, amount, store, idx);
    for (const id of members.map((m) => m.id)) {
      acc[id] = acc[id] || { shared: 0, personal: 0 };
      if (flag === 'comune') acc[id].shared = round2(acc[id].shared + Number(alloc[id] || 0));
      else acc[id].personal = round2(acc[id].personal + Number(alloc[id] || 0));
    }
    return acc;
  }, {});
  const overviewPeopleCategorySplit = overviewTx.reduce((acc, tx, idx) => {
    const flag = personalFlagForTx(tx, store, idx) === 'comune' ? 'shared' : 'personal';
    const cat = categoryForTx(tx, store, idx);
    const cfg = categoryConfig[cat] || { label: cat, icon: '📋' };
    const amount = Number(tx.amount || 0);
    const alloc = txUserAllocation(tx, amount, store, idx);
    for (const id of members.map((m) => m.id)) {
      const value = Number(alloc[id] || 0);
      if (!value) continue;
      acc[id] = acc[id] || { shared: {}, personal: {} };
      acc[id][flag][cat] = acc[id][flag][cat] || { key: cat, label: cfg.label || cat, icon: cfg.icon || '📋', value: 0 };
      acc[id][flag][cat].value = round2(acc[id][flag][cat].value + value);
    }
    return acc;
  }, {});
  const overviewAvgPerPeriod = aggregateKeys.length ? round2(cur.total / aggregateKeys.length) : 0;
  const overviewTopCategory = Object.entries(cur.categories || {}).sort(([,a],[,b])=>b-a)[0] || null;
  const overviewAccountSources = {};
  const overviewAccountRows = Object.entries(overviewTx.reduce((acc, tx) => {
    const source = sourceLabel(tx.source || tx.accountName || 'amex');
    const account = tx.accountName || source;
    const key = account === source || account.toLowerCase().startsWith(source.toLowerCase()) ? account : `${source} · ${account}`;
    overviewAccountSources[key] = overviewAccountSources[key] || tx.source || tx.accountName || 'amex';
    acc[key] = round2((acc[key] || 0) + Number(tx.amount || 0));
    return acc;
  }, {})).sort(([,a],[,b])=>b-a).slice(0, 8);
  const overviewUserRows = userCards
    .map((u, idx) => ({ key: u.id, label: u.name, value: Math.round(cur.byHolder?.[u.id] || 0), shared: round2(overviewPeopleSplit[u.id]?.shared || 0), personal: round2(overviewPeopleSplit[u.id]?.personal || 0), sharedCategories: Object.values(overviewPeopleCategorySplit[u.id]?.shared || {}).sort((a,b)=>b.value-a.value).slice(0,3), personalCategories: Object.values(overviewPeopleCategorySplit[u.id]?.personal || {}).sort((a,b)=>b.value-a.value).slice(0,3), color: userAccentFor(u.id, idx) }))
    .filter((row)=>row.value || cur.total);
  const overviewExecutiveNotes = [
    `${T('averagePerPeriod')}: ${fmtDec(overviewAvgPerPeriod)}`,
    overviewTopCategory ? `${T('topCategory')}: ${categoryConfig[overviewTopCategory[0]]?.label || overviewTopCategory[0]} (${Math.round((overviewTopCategory[1] || 0) / (cur.total || 1) * 100)}%)` : '',
    `${T('shared')}: ${fmtDec(overviewSharedTotal)} · ${T('personalLabel')}: ${fmtDec(overviewPersonalTotal)}`
  ].filter(Boolean);
  const geoData = getGeoData(rawRows.filter((row) => {
    const validKeys = new Set(aggregateKeys);
    return selectedPeriod === 'ALL' ? (selectedYear === 'ALL' || getPeriodYear(viewMode === 'calendar' ? row.calendarKey : row.statementKey, viewMode) === selectedYear) : validKeys.has(viewMode === 'calendar' ? row.calendarKey : row.statementKey);
  }), store);
  const noteRows = (() => {
    const unique = members.map((m) => ({ id: m.id, name: m.name }));
    const keyForTx = (tx) => periodKeyForTx(tx, viewMode);
    const visibleUsers = selectedHolder === 'ALL' ? unique : unique.filter((u) => u.id === selectedHolder);
    return (chartPeriodKeys || []).flatMap((periodKey) => visibleUsers.map((u) => {
      const totals = (allAnalysisTransactions ?? [])
        .filter((tx) => tx && keyForTx(tx) === periodKey && txMatchesSelectedHolder(tx, u.id))
        .reduce((acc, tx, idx) => {
          const type = cashflowTypeForTx(tx, store);
          const amount = Number(tx.amount || 0);
          if (!Number.isFinite(amount) || type === 'excluded') return acc;
          const alloc = txUserAllocation(tx, type === 'income' ? Math.abs(amount) : amount, store, idx);
          const value = Number(alloc[u.id] || 0);
          if (!value) return acc;
          if (type === 'income') {
            acc.income = round2(acc.income + value);
            return acc;
          }
          const flag = personalFlagForTx(tx, store, idx);
          if (flag === 'comune') acc.sharedSpend = round2(acc.sharedSpend + value);
          else acc.personalSpend = round2(acc.personalSpend + value);
          acc.spend = round2(acc.sharedSpend + acc.personalSpend);
          return acc;
        }, { spend: 0, sharedSpend: 0, personalSpend: 0, income: 0 });
      const noteKey = `${viewMode}:${periodKey}:${u.id}`;
      const saved = store?.notes?.[noteKey] || {};
      return { noteKey, periodKey, month: periodLabel(periodKey, viewMode, currentLang), userId: u.id, user: u.name, ...totals, note: saved.note || '' };
    }));
  })();

  const updateNote = async (noteKey, patch) => {
    if (!store || !noteKey) return;
    const notes = { ...(store.notes || {}) };
    notes[noteKey] = { ...(notes[noteKey] || {}), ...patch, updatedAt: new Date().toISOString() };
    await saveStore({ ...store, notes });
  };

  const overrideCashflowType = async (row, type) => {
    if (!store || !row) return;
    const cashflowType = normalizeCashflowTypeValue(type);
    if (!cashflowType) return;
    const now = new Date().toISOString();
    const targetKey = row.rowId || row.incomeRowKey || stableIncomeTxKey(row);
    let matched = false;
    let matchedTxForLearning = null;
    const compatOverride = legacyIncomeOverrideForCashflowType(cashflowType);
    const nextTransactions = (store.transactions || []).map((tx, idx) => {
      const candidateKey = rowKey(tx, idx);
      const sameRef = row.ref && tx.ref && row.ref === tx.ref;
      const sameStableKey = targetKey && candidateKey === targetKey;
      if (!sameRef && !sameStableKey) return tx;
      matched = true;
      if (!matchedTxForLearning) matchedTxForLearning = { ...tx, ...row };
      return {
        ...tx,
        incomeRowKey: candidateKey,
        incomeCategory: row.incomeCategoryKey || tx.incomeCategory || 'other',
        ...cashflowPatchForType(cashflowType, now),
      };
    });
    if (!matched) return;
    const learnedRule = makeIncomeLearningRule(matchedTxForLearning || row, cashflowType, now);
    const incomeLearningRules = learnedRule
      ? [
          ...getIncomeLearningRules(store).filter((rule) => incomeLearningRuleIdentity(rule) !== incomeLearningRuleIdentity(learnedRule)),
          learnedRule
        ].slice(-INCOME_LEARNING_MAX_RULES)
      : getIncomeLearningRules(store);
    await saveStore({
      ...store,
      transactions: nextTransactions,
      incomeLearningRules,
      incomeOverrideHistory: [
        ...(Array.isArray(store.incomeOverrideHistory) ? store.incomeOverrideHistory : []),
        { txId: targetKey, ref: row.ref || '', desc: row.desc || '', override: compatOverride, cashflowType, learned: !!learnedRule, at: now }
      ].slice(-300)
    });
  };
  const navTabs = [
    ['overview', T('overview'), 'overview'],
    ['income', T('income'), 'income'],
    ['trends', T('trends'), 'trends'],
    ['raw', T('data'), 'data'],
    ['notes', T('notesTab'), 'notes'],
  ];
  const mobileTabs = navTabs.filter(([id]) => id !== 'notes');
  const pageTitle = (navTabs.find(([id]) => id === activeTab) || [null, T('profile')])[1];
  const goTab = (id) => { setShowUserMenu(false); setShowFilters(false); setShowMobileFilters(false); setActiveTab(id); window.scrollTo?.(0, 0); };
  const toggleThemeMode = () => setThemeMode((prev) => { const next = prev === 'dark' ? 'light' : 'dark'; lsSet(LS.theme, next); return next; });
  const quickRangeOptions = [
    ['ALL', T('quickAll'), applyAllPeriods],
    ['YTD', 'YTD', applyYtd],
    ['LAST_12', '12M', () => applyLastPeriods(12, 'LAST_12')],
    ['LAST_6', '6M', () => applyLastPeriods(6, 'LAST_6')],
    ['LAST_3', '3M', () => applyLastPeriods(3, 'LAST_3')],
    ['LAST_1', '1M', () => applyLastPeriods(1, 'LAST_1')],
  ];
  const activeFilterCount = [personalFlagFilters.length > 0, sourceFilters.length > 0, categoryFilters.length > 0, viewMode === 'calendar', !!(rangeStart || rangeEnd) && quickRange === 'CUSTOM'].filter(Boolean).length;
  const tabs = [
    ['overview', T('overview'), 'overview'],
    ['income', T('income'), 'income'],
    ['trends', T('trends'), 'trends'],
    ['notes', T('notesTab'), 'notes'],
    ['raw', T('data'), 'data'],
    ['profile', T('profile'), 'profile'],
  ];
  const chartTooltipStyle = { background: theme.tooltipBg, border: `1px solid ${theme.tooltipBorder}`, borderRadius: 12, fontSize: 12, color: theme.text };
  const S = {
    card: { background: theme.panel, borderRadius: 18, padding: 20, border: `1px solid ${theme.border}`, marginBottom: 16, boxShadow: theme.shadow },
    cardTitle: { fontSize: 15, fontWeight: 800, color: theme.text, marginBottom: 14, letterSpacing: 0, lineHeight: 1.2, fontFamily:"'Hanken Grotesk','Inter',system-ui" },
    input: { width:'100%', background: theme.inputBg || theme.input, border:`1px solid ${theme.border}`, borderRadius: 12, padding:'11px 13px', color: theme.text, fontSize:13, outline:'none', boxSizing:'border-box', fontFamily:"'Inter',system-ui", boxShadow:'inset 0 1px 0 rgba(255,255,255,0.03)' },
  };

  const rules = getRules(store);
  const ruleFieldOptions = getRuleFieldOptions(transactions, currentLang);
  const suggestions = getRuleSuggestions(store);
  const addRule = async (seed = {}) => {
    const rawValue = Object.prototype.hasOwnProperty.call(seed, 'value') ? seed.value : '';
    const value = String(rawValue || '').trim();
    const rawCategory = Object.prototype.hasOwnProperty.call(seed, 'category') ? seed.category : '';
    const category = String(rawCategory || '').trim() ? resolveCategoryInput(rawCategory, categoryConfig) : '';
    if (String(rawCategory || '').trim() && !category) {
      alert(T('invalidCategory'));
      return;
    }
    let personalFlag = Object.prototype.hasOwnProperty.call(seed, 'personalFlag') ? seed.personalFlag : 'no_change';
    if (personalFlag !== 'personale' && personalFlag !== 'comune') personalFlag = 'no_change';
    const cashflowType = normalizeCashflowTypeValue(seed.cashflowType);
    const nextRule = {
      id: makeRuleId(),
      field: seed.field || 'desc',
      operator: seed.operator || 'contains',
      value,
      category,
      personalFlag,
      cashflowType,
      enabled: true,
      createdAt: new Date().toISOString()
    };
    await saveStore({ ...store, rules: [nextRule, ...rules] });
    setVisibleRulesCount((n) => Math.max(10, n));
  };
  const updateRule = async (id, patch) => saveStore({ ...store, rules: rules.map((r) => r.id === id ? { ...r, ...patch } : r) });
  const deleteRule = async (id) => saveStore({ ...store, rules: rules.filter((r) => r.id !== id) });
  const dismissSuggestion = async (sug) => { const actionKey = sug.category ? `cat:${sug.category}` : `flag:${sug.personalFlag || 'no_change'}`; const key = normalizeText(sug.signature) + '|' + actionKey; await saveStore({ ...store, dismissedSuggestions: [...new Set([...(store.dismissedSuggestions || []), key])] }); };
  const applyRetro = async () => { const next = applyRulesRetroactively(store); await saveStore(next); setUploadMsg(`${T('retroApplied')}: ${next.meta?.lastRetroAppliedCount || 0} ${T('transactions')}`); };
  const sortedRules = [...rules].sort((a,b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')) || String(b.id || '').localeCompare(String(a.id || '')));
  const visibleRules = sortedRules.slice(0, visibleRulesCount);
  const overrideCategory = async (row, category, storeOverride = null) => {
    const sourceStore = storeOverride || store;
    const tx = transactions.find((t, idx) => txId(t, idx) === row.id || t.ref === row.ref);
    if (!tx) return;
    const historyItem = { txId: row.id, signature: merchantSignature(tx.desc), desc: tx.desc, category, at: new Date().toISOString() };
    await saveStore({ ...sourceStore, categoryOverrides: { ...getOverrides(sourceStore), [row.id]: category }, overrideHistory: [...(sourceStore.overrideHistory || []), historyItem].slice(-300) });
  };
  const handleRawCategoryChange = async (row, value) => {
    if (value !== '__new_category__') return overrideCategory(row, value);
    const label = window.prompt(T('newCategoryPrompt'));
    const created = makeCustomCategory(label, categoryConfig);
    if (!created) return;
    const nextStore = { ...store, customCategories: { ...getCustomCategories(store), [created.key]: created.cfg } };
    await overrideCategory(row, created.key, nextStore);
  };


  const updateRawDraftFilter = (key, value) => setRawDraftFilters((filters) => ({ ...filters, [key]: value }));
  const applyRawDraftFiltersNow = () => setRawFilters(rawDraftFilters);
  const handleRawFilterKeyDown = (event) => { if (event.key === 'Enter') applyRawDraftFiltersNow(); };

  const holderOptions = [...members.map((m) => m.name), ...(members.length > 1 ? [SHARED_HOLDER_LABEL] : [])];
  const rawFilterInputStyle = (key) => ({
    ...S.input,
    borderColor: rawDraftFilters[key] ? theme.accent : theme.border,
    boxShadow: rawDraftFilters[key] ? `0 0 0 1px ${theme.accent}55` : 'none',
    background: rawDraftFilters[key] ? theme.accentSoft : theme.inputBg,
  });
  const rawAmountFilterStyle = rawDraftFilters.amountMin || rawDraftFilters.amountMax ? { ...S.input, borderColor: theme.accent, boxShadow: `0 0 0 1px ${theme.accent}55`, background: theme.accentSoft } : S.input;
  const toggleRawSort = (key) => setRawSort((cur) => {
    if (cur.key !== key) return { key, dir: key === 'date' || key === 'amount' ? 'desc' : 'asc' };
    if (cur.dir === 'asc') return { key, dir: 'desc' };
    if (cur.dir === 'desc') return { key: '', dir: '' };
    return { key, dir: 'asc' };
  });
  const rawSortIcon = (key) => rawSort.key === key ? (rawSort.dir === 'asc' ? '↑' : rawSort.dir === 'desc' ? '↓' : '↕') : '↕';
  const rawHeader = (label, key) => <button className={`hf-sort-button ${rawSort.key === key ? 'is-active' : ''}`} onClick={() => toggleRawSort(key)}>{label}<span>{rawSortIcon(key)}</span></button>;
  const toggleRawRowSelection = (id) => setSelectedRawIds((ids) => ids.includes(id) ? ids.filter((x) => x !== id) : [...ids, id]);
  const toggleSelectVisibleRawRows = () => {
    const visibleIds = renderedRawRows.map((r) => r.id);
    const allVisibleSelected = visibleIds.length > 0 && visibleIds.every((id) => selectedRawSet.has(id));
    setSelectedRawIds(allVisibleSelected ? selectedRawIds.filter((id) => !visibleIds.includes(id)) : [...new Set([...selectedRawIds, ...visibleIds])]);
  };
  const clearRawSelection = () => setSelectedRawIds([]);
  const updateManualTxDraft = (patch) => setManualTxDraft((draft) => ({ ...draft, ...patch }));
  const addManualTransaction = async () => {
    if (!isCurrentAdmin || !store) return;
    const amount = Number(String(manualTxDraft.amount || '').replace(',', '.'));
    const desc = String(manualTxDraft.desc || '').trim();
    const date = String(manualTxDraft.date || '').trim();
    if (!date || !desc || !Number.isFinite(amount)) {
      setUploadMsg(T('manualEntryMissing'));
      return;
    }
    const now = new Date().toISOString();
    const source = normalizeSource(manualTxDraft.source || manualTxDraft.accountName || 'amex');
    const ref = `manual-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const tx = {
      ref,
      date,
      desc,
      description: desc,
      amount: round2(amount),
      holder: canonicalHolderDisplay(manualTxDraft.holder || householdMembers()[0]?.name || ''),
      source,
      accountName: manualTxDraft.accountName || sourceLabel(source),
      category: manualTxDraft.category || 'altro',
      personalFlag: normalizePersonalFlag(manualTxDraft.personalFlag || 'personale'),
      statementKey: getStatementPeriodKey(date),
      calendarKey: getCalendarKey(date),
      importedAt: now,
      sourceFileName: 'Manual entry',
      manualEntry: true,
      createdBy: currentUserId || '',
      createdAt: now,
      ...cashflowPatchForType(manualTxDraft.cashflow || 'expense', now),
    };
    await saveStore({
      ...store,
      transactions: [...transactions, tx],
      rawEditHistory: [
        ...(Array.isArray(store.rawEditHistory) ? store.rawEditHistory : []),
        { action: 'add', rowId: ref, desc, amount: tx.amount, at: now, userId: currentUserId || '' }
      ].slice(-300),
      meta: { ...(store.meta || {}), lastManualTransactionEditAt: now }
    });
    setManualTxDraft((draft) => ({ ...draft, date: isoDate(new Date()), desc: '', amount: '' }));
    setShowManualTxForm(false);
    setUploadMsg(T('manualEntrySaved'));
  };
  const deleteSelectedRawRows = async () => {
    if (!isCurrentAdmin || !store || !selectedRawIds.length) return;
    if (!window.confirm(T('deleteRowsConfirm').replace('{count}', String(selectedRawIds.length)))) return;
    const ids = new Set(selectedRawIds.filter(Boolean));
    const selectedRows = sortedScopedRawRows.filter((r) => ids.has(r.id));
    const selectedRefs = new Set(selectedRows.map((r) => r.ref).filter(Boolean));
    const now = new Date().toISOString();
    const nextTransactions = (transactions || []).filter((tx, idx) => {
      const id = txId(tx, idx);
      return !ids.has(id) && !(tx.ref && selectedRefs.has(tx.ref));
    });
    const deletedCount = (transactions || []).length - nextTransactions.length;
    if (!deletedCount) return;
    await saveStore({
      ...store,
      transactions: nextTransactions,
      rawEditHistory: [
        ...(Array.isArray(store.rawEditHistory) ? store.rawEditHistory : []),
        { action: 'delete', count: deletedCount, rowIds: [...ids].slice(0, 50), at: now, userId: currentUserId || '' }
      ].slice(-300),
      meta: { ...(store.meta || {}), lastManualTransactionEditAt: now }
    });
    setSelectedRawIds([]);
  };
  const updateRawTransactionsByRows = async (rowIds, patchFactory, historyKey = 'rawEditHistory') => {
    const ids = new Set(rowIds || []);
    if (!ids.size) return 0;
    const selectedRows = sortedScopedRawRows.filter((r) => ids.has(r.id));
    const selectedRefs = new Set(selectedRows.map((r) => r.ref).filter(Boolean));
    let touched = 0;
    const now = new Date().toISOString();
    const nextTransactions = (transactions || []).map((tx, idx) => {
      const id = txId(tx, idx);
      const match = ids.has(id) || (tx.ref && selectedRefs.has(tx.ref));
      if (!match) return tx;
      touched += 1;
      return { ...tx, ...patchFactory(tx, idx, now) };
    });
    if (!touched) return 0;
    await saveStore({
      ...store,
      transactions: nextTransactions,
      [historyKey]: [
        ...(Array.isArray(store?.[historyKey]) ? store[historyKey] : []),
        { count: touched, rowIds: [...ids].slice(0, 50), at: now }
      ].slice(-300),
      meta: { ...(store.meta || {}), lastRawBulkEditAt: now }
    });
    return touched;
  };
  const overrideHolder = async (row, holder) => {
    const normalizedHolder = canonicalHolderDisplay(holder);
    await updateRawTransactionsByRows([row.id], (_tx, _idx, now) => ({ holder: normalizedHolder, holderManualOverrideV2413: true, holderUpdatedAtV2413: now }), 'holderOverrideHistory');
  };
  const applyBulkRawEdit = async () => {
    const ids = selectedRawIds.filter(Boolean);
    if (!ids.length) return;
    const selectedRows = sortedScopedRawRows.filter((r) => ids.includes(r.id));
    let nextStore = store;
    const now = new Date().toISOString();
    if (bulkEdit.category) {
      nextStore = { ...nextStore, categoryOverrides: { ...getOverrides(nextStore) } };
      selectedRows.forEach((row) => { nextStore.categoryOverrides[row.id] = bulkEdit.category; });
      nextStore.overrideHistory = [...(nextStore.overrideHistory || []), { txId: 'bulk', count: selectedRows.length, category: bulkEdit.category, at: now }].slice(-300);
    }
    const idsSet = new Set(ids);
    const selectedRefs = new Set(selectedRows.map((r) => r.ref).filter(Boolean));
    const nextTransactions = (transactions || []).map((tx, idx) => {
      const id = txId(tx, idx);
      if (!idsSet.has(id) && !(tx.ref && selectedRefs.has(tx.ref))) return tx;
      const patch = {};
      if (bulkEdit.holder) { patch.holder = canonicalHolderDisplay(bulkEdit.holder); patch.holderManualOverrideV2413 = true; patch.holderUpdatedAtV2413 = now; }
      if (bulkEdit.personalFlag) { patch.personalFlag = normalizePersonalFlag(bulkEdit.personalFlag); patch.personalFlagManualOverrideV19 = true; patch.personalFlagUpdatedAtV19 = now; }
      if (bulkEdit.cashflow) { Object.assign(patch, cashflowPatchForType(bulkEdit.cashflow, now)); }
      if (bulkEdit.subscription !== '') { patch.subscriptionOverride = bulkEdit.subscription === '__clear__' ? '' : bulkEdit.subscription; patch.subscriptionManualOverrideAt = now; }
      return Object.keys(patch).length ? { ...tx, ...patch } : tx;
    });
    if (bulkEdit.cashflow) {
      const learnedRules = selectedRows.map((row) => makeIncomeLearningRule(row, bulkEdit.cashflow, now)).filter(Boolean);
      if (learnedRules.length) {
        const identities = new Set(learnedRules.map(incomeLearningRuleIdentity));
        nextStore.incomeLearningRules = [
          ...getIncomeLearningRules(nextStore).filter((rule) => !identities.has(incomeLearningRuleIdentity(rule))),
          ...learnedRules
        ].slice(-INCOME_LEARNING_MAX_RULES);
      }
    }
    nextStore = {
      ...nextStore,
      transactions: nextTransactions,
      rawBulkEditHistory: [...(Array.isArray(nextStore.rawBulkEditHistory) ? nextStore.rawBulkEditHistory : []), { count: ids.length, bulkEdit, at: now }].slice(-300),
      meta: { ...(nextStore.meta || {}), lastRawBulkEditAt: now }
    };
    await saveStore(nextStore);
    setBulkEdit({ holder:'', category:'', personalFlag:'', cashflow:'', subscription:'' });
    setSelectedRawIds([]);
  };

  const overridePersonalFlag = async (row, personalFlag) => {
    const normalizedFlag = normalizePersonalFlag(personalFlag);
    let touched = false;
    const nextTransactions = (transactions || []).map((tx, idx) => {
      const id = txId(tx, idx);
      const isMatch = id === row.id || (row.ref && tx.ref === row.ref);
      if (!isMatch) return tx;
      touched = true;
      return {
        ...tx,
        personalFlag: normalizedFlag,
        personalFlagManualOverrideV19: true,
        personalFlagUpdatedAtV19: new Date().toISOString(),
      };
    });
    if (!touched) return;
    await saveStore({
      ...store,
      transactions: nextTransactions,
      personalFlagOverrideHistory: [
        ...(Array.isArray(store.personalFlagOverrideHistory) ? store.personalFlagOverrideHistory : []),
        { txId: row.id, ref: row.ref || '', desc: row.desc || '', personalFlag: normalizedFlag, at: new Date().toISOString() }
      ].slice(-300),
      meta: { ...(store.meta || {}), lastPersonalFlagManualEditV19At: new Date().toISOString() }
    });
  };

  const overrideCashflowExclusion = async (row, type) => {
    const cashflowType = normalizeCashflowTypeValue(type);
    if (!cashflowType) return;
    let touched = false;
    let matchedTxForLearning = null;
    const now = new Date().toISOString();
    const nextTransactions = (transactions || []).map((tx, idx) => {
      const id = txId(tx, idx);
      const fallbackId = tx.ref || `${tx.date}-${idx}-${Number(tx.amount || 0)}`;
      const isMatch = id === row.id || fallbackId === row.id || (row.ref && tx.ref === row.ref);
      if (!isMatch) return tx;
      touched = true;
      if (!matchedTxForLearning) matchedTxForLearning = { ...tx, ...row };
      return {
        ...tx,
        ...cashflowPatchForType(cashflowType, now),
      };
    });
    if (!touched) return;
    const learnedRule = makeIncomeLearningRule(matchedTxForLearning || row, cashflowType, now);
    const incomeLearningRules = learnedRule
      ? [
          ...getIncomeLearningRules(store).filter((rule) => incomeLearningRuleIdentity(rule) !== incomeLearningRuleIdentity(learnedRule)),
          learnedRule
        ].slice(-INCOME_LEARNING_MAX_RULES)
      : getIncomeLearningRules(store);
    await saveStore({
      ...store,
      transactions: nextTransactions,
      incomeLearningRules,
      cashflowExclusionHistory: [
        ...(Array.isArray(store.cashflowExclusionHistory) ? store.cashflowExclusionHistory : []),
        { txId: row.id, ref: row.ref || '', desc: row.desc || '', cashflowType, override: legacyIncomeOverrideForCashflowType(cashflowType), learned: !!learnedRule, excludeFromCashflow: cashflowType !== 'expense', at: now }
      ].slice(-300),
      meta: { ...(store.meta || {}), lastCashflowExclusionEditAt: now }
    });
  };


  return (
    <>
    <div className="hf-app hfx" data-theme={theme.name}>
      <aside className="hfx-sidebar" aria-label={T('sections')}>
        <div className="hfx-brand"><img src="/logo.png" alt="" className="hfx-logo" /><span>homefin</span></div>
        <nav className="hfx-nav">
          {navTabs.map(([id, label, icon]) => <button key={id} type="button" className={`hfx-nav-item ${activeTab === id ? 'is-active' : ''}`} aria-current={activeTab === id ? 'page' : undefined} data-tab-id={id} onClick={() => goTab(id)}><Icon name={icon} size={16} /><span>{label}</span></button>)}
        </nav>
        <div className="hfx-side-group">
          <div className="hfx-side-label">{T('household')}</div>
          {members.map((m, idx) => <button key={m.id} type="button" className={`hfx-member ${selectedHolder === m.id ? 'is-active' : ''}`} onClick={() => setSelectedHolder(selectedHolder === m.id ? 'ALL' : m.id)}><span className="hfx-dot" style={{ background: memberColor(theme, idx) }} />{m.name}</button>)}
        </div>
        <div className="hfx-side-foot">
          <button type="button" className={`hfx-nav-item ${activeTab === 'profile' ? 'is-active' : ''}`} data-tab-id="profile" onClick={() => goTab('profile')}><Icon name="customization" size={16} /><span>{T('profile')}</span></button>
          <div className="hfx-user">
            <span className="hfx-avatar" aria-hidden="true">{initials(currentUser.name || currentUserId)}</span>
            <span className="hfx-user-name">{currentUser.name || currentUserId}</span>
            <button type="button" className="hfx-icon-btn" onClick={toggleThemeMode} title={themeMode === 'dark' ? T('light') : T('dark')} aria-label={themeMode === 'dark' ? T('light') : T('dark')}><Icon name="theme" size={15} /></button>
            <button type="button" className="hfx-icon-btn" onClick={() => setCurrentLanguage(currentLang === 'en' ? 'it' : 'en')} title={T('language')} aria-label={T('language')}><span className="hfx-lang">{currentLang.toUpperCase()}</span></button>
            <button type="button" className="hfx-icon-btn" onClick={logout} title={T('logout')} aria-label={T('logout')}><Icon name="logout" size={15} /></button>
          </div>
        </div>
        <input ref={fileRef} className="hf-file-input" type="file" accept=".xlsx,.xls,.csv,text/csv" multiple onChange={handleUpload} />
        <input ref={backupRef} className="hf-file-input" type="file" accept="application/json,.json" onChange={handleBackupImport} />
      </aside>

      <div className="hfx-main">
        <header className="hfx-topbar">
          <div className="hfx-title">
            <img src="/logo.png" alt="" className="hfx-logo hfx-mobile-only" />
            <h1>{pageTitle}</h1>
            {activeTab !== 'profile' && <span className="hfx-range">{rangeLabel}</span>}
          </div>
          {activeTab !== 'profile' && <div className="hfx-toolbar">
            <div className="hfx-seg hfx-desktop-only" role="group" aria-label={T('user')}>
              <button type="button" className={selectedHolder === 'ALL' ? 'is-active' : ''} aria-pressed={selectedHolder === 'ALL'} onClick={() => setSelectedHolder('ALL')}>{T('all')}</button>
              {members.map((m, idx) => <button key={m.id} type="button" className={selectedHolder === m.id ? 'is-active' : ''} aria-pressed={selectedHolder === m.id} onClick={() => setSelectedHolder(m.id)}><span className="hfx-dot" style={{ background: memberColor(theme, idx) }} />{m.name}</button>)}
            </div>
            <div className="hfx-seg hfx-desktop-only" role="group" aria-label={T('quickRange')}>
              {quickRangeOptions.map(([key, label, fn]) => { const disabled = activeTab === 'trends' && key === 'ALL'; return <button key={key} type="button" className={quickRange === key ? 'is-active' : ''} aria-pressed={quickRange === key} disabled={disabled} onClick={disabled ? undefined : fn}>{label}</button>; })}
            </div>
            <button type="button" className={`hfx-btn ${showFilters ? 'is-active' : ''}`} onClick={() => { setShowFilters((v) => !v); setShowMobileFilters(true); }} aria-expanded={showFilters}><Icon name="filters" size={15} /><span>{T('filters')}</span>{activeFilterCount > 0 && <span className="hfx-badge">{activeFilterCount}</span>}</button>
          </div>}
        </header>

        {uploadMsg && (() => { const tone = /^\s*❌/.test(uploadMsg) ? 'is-error' : /^\s*✅/.test(uploadMsg) ? 'is-success' : ''; const text = String(uploadMsg).replace(/^\s*(?:✅|❌|📖)\s*/u, '').replace(/⚠️\s*/gu, ''); return <div className={`hf-toast hfx-toast ${tone}`} role={tone === 'is-error' ? 'alert' : 'status'}><span className="hfx-toast-dot" aria-hidden="true" /><span>{text}</span><button type="button" onClick={()=>setUploadMsg('')} aria-label={T('close')} className="hfx-toast-close"><Icon name="close" size={14} /></button></div>; })()}

      {showUserMenu ? <UserMenuModal store={store} currentUserId={currentUserId} theme={theme} lang={currentLang} onClose={() => setShowUserMenu(false)} onSave={saveUserProfile} inputStyle={S.input} onRefresh={refresh} syncing={syncing} onImportExcel={() => fileRef.current?.click()} uploading={uploading} onExportData={exportData} onImportBackup={() => backupRef.current?.click()} importSourceId={importSourceId} onImportSourceChange={(id)=>{ setImportSourceId(id); lsSet(LS.importSource, id); }} importAccountId={importAccountId} onImportAccountChange={(id)=>{ setImportAccountId(id); lsSet(LS.importAccount, id); }} onSaveHousehold={saveHousehold} onSaveFormat={saveCustomFormat} onDeleteFormat={deleteCustomFormat} onSaveFormatAndImport={saveFormatAndImport} onSavePersonalization={savePersonalization} onDeleteCategory={deleteCategorySafe} onSaveUsers={saveUsers} onLogout={logout} onOpenRawData={(filters)=>{ setShowUserMenu(false); filters ? openDataWithFilters(filters) : setActiveTab('raw'); }} onSaveStore={saveStore} onTimeMachineRestored={(next)=>setStore(next)} onApplyRulesRetroactively={applyRetro} /> : <div className="mc hf-content">
        {activeTab !== 'profile' && <>
        {activeTab !== 'overview' && <div className="hfx-strip">
          {(activeTab === 'income'
            ? [{ id: 'ALL', label: T('totalIncome'), value: fmtDec(incomeModel.total) }, ...incomeUserCards.map((u) => ({ id: u.id, label: u.name, value: fmtDec(u.value), share: incomeModel.total ? Math.round(u.value / incomeModel.total * 100) : 0 }))]
            : [{ id: 'ALL', label: T('totalSpend'), value: fmt(allCur.total) }, ...userCards.map((u) => ({ id: u.id, label: u.name, value: fmt(u.value), share: allCur.total ? Math.round(u.value / allCur.total * 100) : 0 }))]
          ).map((item, idx) => <button key={item.id} type="button" className={`hfx-strip-item ${selectedHolder === item.id ? 'is-active' : ''}`} onClick={() => setSelectedHolder(item.id)}>
            <span className="hfx-strip-label">{idx > 0 && <span className="hfx-dot" style={{ background: memberColor(theme, idx - 1) }} />}{item.label}</span>
            <span className="hfx-strip-value">{item.value}</span>
            {item.share != null && <span className="hfx-strip-sub">{item.share}%</span>}
          </button>)}
        </div>}

        {showFilters && <div className="hfx-scrim" onClick={() => { setShowFilters(false); setShowMobileFilters(false); }} />}
        <div className={`hfx-filters ${showFilters ? '' : 'is-hidden'}`} role="dialog" aria-modal="false" aria-label={T('filters')}>
          <div className="hfx-sheet-grip hfx-mobile-only" aria-hidden="true" />
          <div className="hfx-filters-head"><h2>{T('filters')}</h2><div><button type="button" className="hfx-link" onClick={resetAllFilters}>{T('resetFilters')}</button><button type="button" className="hfx-icon-btn" aria-label={T('close')} onClick={() => { setShowFilters(false); setShowMobileFilters(false); }}><Icon name="close" size={16} /></button></div></div>
          <div className="hfx-frow">
            <div className="hfx-flabel">{T('calendarType')}</div>
            <div className="hfx-seg">
              {[[ 'statement', T('amexPeriod') ], [ 'calendar', T('calendar') ]].map(([mode,label]) => <button type="button" key={mode} className={viewMode===mode ? 'is-active' : ''} aria-pressed={viewMode===mode} onClick={()=>setViewMode(mode)}>{label}</button>)}
            </div>
          </div>
          <div className="hfx-frow">
            <div className="hfx-flabel">{T('quickRange')}</div>
            <div className="hfx-seg hfx-seg-wrap">
              {[
                ['ALL', T('quickAll'), applyAllPeriods],
                ['YTD', T('quickYtd'), applyYtd],
                ['LAST_1', T('quickLastMonth'), () => applyLastPeriods(1, 'LAST_1')],
                ['LAST_3', T('quickLast3'), () => applyLastPeriods(3, 'LAST_3')],
                ['LAST_6', T('quickLast6'), () => applyLastPeriods(6, 'LAST_6')],
                ['LAST_12', T('quickLast12'), () => applyLastPeriods(12, 'LAST_12')],
              ].map(([key,label,fn]) => { const disabled = activeTab === 'trends' && key === 'ALL'; return <button type="button" key={key} className={quickRange===key ? 'is-active' : ''} aria-pressed={quickRange===key} onClick={disabled ? undefined : fn} disabled={disabled}>{label}</button>; })}
            </div>
          </div>
          <div className="hfx-frow">
            <div className="hfx-flabel">{T('customRange')}</div>
            <div className="hfx-frange">
              <label><span>{T('start')}</span>
                <select className="hfx-input" value={customRangeStartValue} onChange={(e)=>setCustomRangeStart(e.target.value)}>
                  {customRangeOptions.map((key)=><option key={key} value={key}>{periodDropdownLabel(key, viewMode, currentLang)}</option>)}
                </select>
              </label>
              <label><span>{T('end')}</span>
                <select className="hfx-input" value={customRangeEndValue} onChange={(e)=>setCustomRangeEnd(e.target.value)}>
                  {customRangeOptions.map((key)=><option key={key} value={key}>{periodDropdownLabel(key, viewMode, currentLang)}</option>)}
                </select>
              </label>
            </div>
          </div>
          <div className="hfx-frow">
            <div className="hfx-flabel">{T('personalFlag')}</div>
            <div className="hfx-seg">
              <button type="button" className={!personalFlagFilters.length ? 'is-active' : ''} aria-pressed={!personalFlagFilters.length} onClick={()=>setPersonalFlagFilters([])}>{T('all')}</button>
              {[['personale', T('personalOnly')], ['comune', T('commonOnly')]].map(([key,label]) => { const on = personalFlagFilters.length > 0 && isFilterValueSelected(personalFlagFilters,key); return <button type="button" key={key} className={on ? 'is-active' : ''} aria-pressed={on} onClick={()=>setPersonalFlagFilters((prev)=>toggleFilterValue(prev, key, ['personale','comune']))}>{label}</button>; })}
            </div>
          </div>
          <div className="hfx-frow">
            <div className="hfx-flabel">{T('source')}</div>
            <div className="hfx-chips">
              <button type="button" className={`hfx-chip ${!sourceFilters.length ? 'is-active' : ''}`} aria-pressed={!sourceFilters.length} onClick={()=>setSourceFilters([])}>{T('all')}</button>
              {sourceOptions.map((opt) => { const on = sourceFilters.length > 0 && isFilterValueSelected(sourceFilters,opt.key); return <button type="button" key={opt.key} className={`hfx-chip ${on ? 'is-active' : ''}`} aria-pressed={on} onClick={()=>setSourceFilters((prev)=>toggleFilterValue(prev, opt.key, sourceFilterKeys))}>{opt.label}</button>; })}
            </div>
          </div>
          <div className="hfx-frow is-top">
            <div className="hfx-flabel">{T('category')}</div>
            <div className="hfx-chips">
              <button type="button" className={`hfx-chip ${isAllCategoriesActive(categoryFilters) ? 'is-active' : ''}`} aria-pressed={isAllCategoriesActive(categoryFilters)} onClick={()=>setCategoryFilters((prev)=>toggleAllCategoryFilters(prev))}>{T('allCategories')}</button>
              {categoryFilterOptions.map((opt) => { const on = !isAllCategoriesActive(categoryFilters) && isCategoryFilterValueSelected(categoryFilters,opt.key); const cfg = categoryConfig[opt.key]; return <button type="button" key={opt.key} className={`hfx-chip ${on ? 'is-active' : ''}`} aria-pressed={on} onClick={()=>setCategoryFilters((prev)=>toggleCategoryFilterValue(prev, opt.key, categoryFilterKeys))}>{cfg?.color && <span className="hfx-dot" style={{ background: cfg.color }} />}{cfg?.label || opt.key}</button>; })}
            </div>
          </div>
        </div>

        </>}

        {activeTab === 'profile' && <UserMenuModal store={store} currentUserId={currentUserId} theme={theme} lang={currentLang} onClose={() => setActiveTab('overview')} embedded={true} onSave={saveUserProfile} inputStyle={S.input} onRefresh={refresh} syncing={syncing} onImportExcel={() => fileRef.current?.click()} uploading={uploading} onExportData={exportData} onImportBackup={() => backupRef.current?.click()} importSourceId={importSourceId} onImportSourceChange={(id)=>{ setImportSourceId(id); lsSet(LS.importSource, id); }} importAccountId={importAccountId} onImportAccountChange={(id)=>{ setImportAccountId(id); lsSet(LS.importAccount, id); }} onSaveHousehold={saveHousehold} onSaveFormat={saveCustomFormat} onDeleteFormat={deleteCustomFormat} onSaveFormatAndImport={saveFormatAndImport} onSavePersonalization={savePersonalization} onDeleteCategory={deleteCategorySafe} onSaveUsers={saveUsers} onLogout={logout} onOpenRawData={(filters)=>{ setShowUserMenu(false); filters ? openDataWithFilters(filters) : setActiveTab('raw'); }} onSaveStore={saveStore} onTimeMachineRestored={(next)=>setStore(next)} onApplyRulesRetroactively={applyRetro} />}

        {activeTab === 'overview' && <div className="hfx-page">
          {!periods.length ? <section className="hfx-panel hfx-empty">
            <h2>{T('noData')}</h2>
            <p>{T('goUpload')}</p>
            <button type="button" className="hfx-btn is-primary" onClick={() => goTab('profile')}>{T('importExcel')}</button>
          </section> : <>
          <section className="hfx-hero">
            <div className="hfx-hero-main">
              <div className="hfx-eyebrow">{T('totalSpend')}</div>
              <div className="hfx-hero-value hfx-num">{fmtDec(cur.total)}</div>
              <div className="hfx-hero-meta">
                {cfoTrendModel.previousKeys.length
                  ? <><span className={`hfx-delta ${cfoTrendModel.delta > 0 ? 'is-up' : 'is-down'}`}>{formatDeltaText(cfoTrendModel.delta, cfoTrendModel.pct, fmtDec)}</span><span>{T('vsPrevious')}</span></>
                  : <span>{T('notEnoughHistory')}</span>}
                <span className="hfx-sep" aria-hidden="true" />
                <span>{T('shared')} <b className="hfx-num">{fmtDec(overviewSharedTotal)}</b></span>
                <span>{T('personalLabel')} <b className="hfx-num">{fmtDec(overviewPersonalTotal)}</b></span>
              </div>
            </div>
            <dl className="hfx-kpis">
              <div><dt>{T('income')}</dt><dd className="hfx-num">{fmtDec(cashflowTrendModel.current.income || 0)}</dd></div>
              <div><dt>{T('net')}</dt><dd className={`hfx-num ${(cashflowTrendModel.current.net || 0) >= 0 ? 'is-pos' : 'is-neg'}`}>{fmtDec(cashflowTrendModel.current.net || 0)}</dd></div>
              <div><dt>{T('savingsRate')}</dt><dd className="hfx-num">{cashflowTrendModel.current.income ? `${Math.round((cashflowTrendModel.current.net || 0) / cashflowTrendModel.current.income * 100)}%` : '—'}</dd></div>
              <div><dt>{T('avgPerPeriod')}</dt><dd className="hfx-num">{fmtDec(overviewAvgPerPeriod)}</dd></div>
            </dl>
          </section>

          <div className="hfx-grid hfx-grid-main">
            <section className="hfx-panel">
              <header className="hfx-panel-head">
                <h2>{T('monthlySpending')}</h2>
                <div className="hfx-legend">{members.map((m, idx) => <span key={m.id}><span className="hfx-dot" style={{ background: memberColor(theme, idx) }} />{m.name}</span>)}</div>
              </header>
              <div className="hfx-chart">
                <ResponsiveContainer width="100%" height={260}>
                  <BarChart data={trendData} margin={{ top: 8, right: 4, left: 0, bottom: 0 }} barCategoryGap="28%">
                    <CartesianGrid vertical={false} stroke={theme.border} />
                    <XAxis dataKey="month" tickLine={false} axisLine={false} tick={{ fill: theme.subtext, fontSize: 11 }} />
                    <YAxis width={56} tickLine={false} axisLine={false} tick={{ fill: theme.subtext, fontSize: 11 }} tickFormatter={amountTick} />
                    <Tooltip cursor={{ fill: theme.chipBg }} formatter={(v) => fmt(v)} contentStyle={chartTooltipStyle} labelStyle={{ color: theme.text }} itemStyle={{ color: theme.text }} />
                    {members.map((m, idx) => <Bar key={m.id} dataKey={m.name} stackId="people" fill={memberColor(theme, idx)} radius={idx === members.length - 1 ? [3, 3, 0, 0] : 0} isAnimationActive={false} />)}
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </section>

            <section className="hfx-panel">
              <header className="hfx-panel-head"><h2>{T('people')}</h2></header>
              <div className="hfx-people">
                {overviewUserRows.map((row) => { const pct = cur.total ? Math.round(row.value / cur.total * 100) : 0; const sharedPct = row.value ? (row.shared / row.value) * 100 : 0; return <button key={row.key} type="button" className={`hfx-person ${selectedHolder === row.key ? 'is-active' : ''}`} onClick={() => setSelectedHolder(selectedHolder === row.key ? 'ALL' : row.key)}>
                  <div className="hfx-person-head"><span><span className="hfx-dot" style={{ background: row.color }} />{row.label}</span><span className="hfx-num">{fmtDec(row.value)} <em>{pct}%</em></span></div>
                  <div className="hfx-split" aria-hidden="true"><i style={{ width: `${sharedPct}%`, background: row.color }} /><i style={{ width: `${100 - sharedPct}%`, background: row.color, opacity: 0.4 }} /></div>
                  <div className="hfx-person-meta"><span>{T('shared')} <b className="hfx-num">{fmtDec(row.shared)}</b></span><span>{T('personalLabel')} <b className="hfx-num">{fmtDec(row.personal)}</b></span></div>
                </button>; })}
              </div>
              <p className="hfx-footnote">{T('sharedAllocationNote')}</p>
            </section>
          </div>

          <div className="hfx-grid hfx-grid-split">
            <section className="hfx-panel">
              <header className="hfx-panel-head">
                <h2>{T('categories')}</h2>
                <select className="hfx-select" value={categoryLimit} onChange={(e)=>setCategoryLimit(e.target.value)} aria-label={T('topCategories')}>{[5,10,15,25,50].map((n)=><option key={n} value={n}>Top {n}</option>)}</select>
              </header>
              <ol className="hfx-rank">
                {topCategoryRows.map(([k, v]) => { const cfg = categoryConfig[k] || { label: k, color: '#888' }; const pct = cur.total ? Math.round(v / cur.total * 100) : 0; return <li key={k}><button type="button" onClick={() => openDataWithFilters({ category: k })}>
                  <span className="hfx-rank-name"><span className="hfx-dot" style={{ background: cfg.color }} />{cfg.label}</span>
                  <span className="hfx-rank-bar" aria-hidden="true"><i style={{ width: `${Math.max(pct, 1)}%`, background: cfg.color }} /></span>
                  <span className="hfx-num hfx-rank-value">{fmtDec(v)}</span>
                  <span className="hfx-num hfx-rank-pct">{pct}%</span>
                </button></li>; })}
              </ol>
            </section>

            <div className="hfx-stack">
              <section className="hfx-panel">
                <header className="hfx-panel-head"><h2>{T('byAccountSource')}</h2></header>
                {overviewAccountRows.length ? <ol className="hfx-rank is-compact">
                  {overviewAccountRows.map(([name, value]) => { const pct = cur.total ? Math.round(value / cur.total * 100) : 0; return <li key={name}><button type="button" onClick={() => openDataWithFilters({ source: overviewAccountSources[name] || name })}>
                    <span className="hfx-rank-name">{name}</span>
                    <span className="hfx-num hfx-rank-value">{fmtDec(value)}</span>
                    <span className="hfx-num hfx-rank-pct">{pct}%</span>
                  </button></li>; })}
                </ol> : <p className="hfx-footnote">{T('noDataInRange')}</p>}
              </section>
              {totalSubs > 0 && <section className="hfx-panel">
                <header className="hfx-panel-head"><h2>{T('subscriptions')}</h2><span className="hfx-num hfx-muted">{fmtDec(totalSubs)}</span></header>
                <ol className="hfx-rank is-compact">
                  {Object.entries(cur.subs || {}).sort(([, a], [, b]) => b.total - a.total).slice(0, 8).map(([name, info]) => <li key={name}><button type="button" onClick={() => openDataWithFilters({ subscription: name })}>
                    <span className="hfx-rank-name">{name}</span>
                    <span className="hfx-num hfx-rank-value">{fmtDec(info.total)}</span>
                    <span className="hfx-num hfx-rank-pct">×{info.count}</span>
                  </button></li>)}
                </ol>
              </section>}
            </div>
          </div>
          </>}
        </div>}

        {activeTab === 'income' && <>
          <div className="mstack hf-dashboard-grid is-balanced">
            <div className="hf-card">
              <div className="hf-card-title"><IconLabel icon="income">{T('incomeTrend')} · {rangeLabel}</IconLabel></div>
              <ResponsiveContainer width="100%" height={280}>
                <BarChart data={incomeModel.trend} margin={{top:5,right:8,left:-14,bottom:5}}>
                  <CartesianGrid vertical={false} stroke={theme.border} />
                  <XAxis dataKey="month" tickLine={false} axisLine={false} tick={{fill:theme.subtext,fontSize:11}} />
                  <YAxis tickLine={false} axisLine={false} tick={{fill:theme.subtext,fontSize:11}} tickFormatter={amountTick} />
                  <Tooltip formatter={(v)=>fmt(v)} contentStyle={chartTooltipStyle} labelStyle={{ color: theme.text }} itemStyle={{ color: theme.text }} />
                  <Bar dataKey={T('income')} fill={theme.accent} radius={[3,3,0,0]} maxBarSize={44} isAnimationActive={false} />
                </BarChart>
              </ResponsiveContainer>
            </div>
            <div className="hf-card">
              <div className="hf-card-title">{T('incomeCategoryBreakdown')}</div>
              {incomeModel.categoryRows.length ? incomeModel.categoryRows.map((row)=>{ const pct = incomeModel.total ? Math.round(row.value / incomeModel.total * 100) : 0; return <div key={row.key} className="hf-progress-row"><div className="hf-progress-head"><span>{row.label}</span><b>{fmtDec(row.value)} <span className="hf-data-muted">({pct}%)</span></b></div><div className="hf-progress-track"><div className="hf-progress-bar" style={{width:`${Math.min(100,pct)}%`,background:theme.accent}} /></div></div>; }) : <div className="hf-empty-text">{T('noIncomeInRange')}</div>}
            </div>
          </div>

          <div className="mstack hf-dashboard-grid is-balanced">
            <div className="hf-card">
              <div className="hf-card-title">{T('incomeSourceBreakdown')}</div>
              {incomeModel.sourceRows.length ? incomeModel.sourceRows.slice(0,8).map((row)=>{ const pct = incomeModel.total ? Math.round(row.value / incomeModel.total * 100) : 0; return <div key={row.label} className="hf-list-row"><div className="hf-list-row-head"><b>{row.label}</b><b>{fmtDec(row.value)}</b></div><div className="hf-bar-row"><div className="hf-progress-track" style={{flex:1,height:6}}><div className="hf-progress-bar" style={{width:`${Math.min(100,pct)}%`,background:theme.accentAlt}} /></div><span className="hf-small-pct">{pct}%</span></div></div>; }) : <div className="hf-empty-text">{T('noIncomeInRange')}</div>}
            </div>
            <div className="hf-card">
              <div className="hf-card-title"><IconLabel icon="warning">{T('incomeReview')}</IconLabel></div>
              {incomeModel.ambiguousRows.length ? incomeModel.ambiguousRows.map((row)=><div key={row.rowId} className="hf-income-review-row"><div><b>{row.desc || '—'}</b><div className="hf-list-meta">{row.date} · {row.sourceName} · {row.incomeCategoryLabel}</div></div><div className="hf-income-actions"><b>{fmtDec(row.incomeAmount)}</b><button className="hf-income-toggle is-income" onClick={()=>overrideCashflowType(row, 'income')}>{T('cashflowIncome')}</button><button className="hf-income-toggle is-not-income" onClick={()=>overrideCashflowType(row, 'excluded')}>{T('cashflowExcluded')}</button><button className="hf-income-toggle" onClick={()=>overrideCashflowType(row, 'expense')}>{T('cashflowExpense')}</button></div></div>) : <div className="hf-empty-text">{T('noIncomeReview')}</div>}
            </div>
          </div>

          <div className="hf-card hf-data-card">
            <div className="hf-card-title"><IconLabel icon="data">{T('incomeMovements')} · {rangeLabel}</IconLabel></div>
            <div className="hf-table-wrap">
              <table className="hf-data-table hf-income-table">
                <thead><tr><th>{T('date')}</th><th>{T('description')}</th><th>{T('source')}</th><th>{T('category')}</th><th>{T('amount')}</th><th>{T('actions')}</th></tr></thead>
                <tbody>
                  {incomeModel.rows.map((row)=><tr key={row.rowId}><td>{row.date}</td><td><b>{row.desc || '—'}</b><div className="hf-list-meta">{row.holder || row.periodLabel}</div></td><td>{row.sourceName}</td><td><span>{row.incomeCategoryLabel}</span>{row.incomeInfo.learned ? <span className="hf-learned-pill">{T('learned')}</span> : null}</td><td className="hf-data-strong">{fmtDec(row.incomeAmount)}</td><td><div className="hf-income-actions"><button className="hf-income-toggle is-active is-income" onClick={()=>overrideCashflowType(row, 'income')}>{T('cashflowIncome')}</button><button className="hf-income-toggle is-not-income" onClick={()=>overrideCashflowType(row, 'excluded')}>{T('cashflowExcluded')}</button><button className="hf-income-toggle" onClick={()=>overrideCashflowType(row, 'expense')}>{T('cashflowExpense')}</button></div></td></tr>)}
                  {!incomeModel.rows.length && <tr><td colSpan="6"><div className="hf-empty-text">{T('noIncomeInRange')}</div></td></tr>}
                </tbody>
              </table>
            </div>
          </div>
        </>}

        {activeTab === 'trends' && <>
          <dl className="hfx-kpi-strip">
            <div><dt>{T('income')}</dt><dd className="hfx-num">{fmtDec(cashflowTrendModel.current.income || 0)}</dd><span>{cashflowTrendModel.current.incomeCount || 0} {T('incomeMovements').toLowerCase()}</span></div>
            <div><dt>{T('expenseOut')}</dt><dd className="hfx-num">{fmtDec(cashflowTrendModel.current.expense || 0)}</dd><span>{rangeLabel}</span></div>
            <div><dt>{T('netCashflow')}</dt><dd className={`hfx-num ${(cashflowTrendModel.current.net || 0) >= 0 ? 'is-pos' : 'is-neg'}`}>{fmtDec(cashflowTrendModel.current.net || 0)}</dd><span>{cashflowTrendModel.previousKeys.length ? formatDeltaText(cashflowTrendModel.deltas.net, safePct(cashflowTrendModel.deltas.net, cashflowTrendModel.previous.net || 0), fmtDec) : T('notEnoughHistory')}</span></div>
            <div><dt>{T('cashflowCoverage')}</dt><dd className="hfx-num">{cashflowTrendModel.coverage || 0}%</dd><span>{T('coverageHelp')}</span></div>
          </dl>

          {cashflowTrendModel.forecast && <div className="hf-card">
            <div className="hf-card-head">
              <div>
                <div className="hf-card-title"><IconLabel icon="forecast">{T('projectedCashflow')}</IconLabel></div>
                <div className="hf-section-copy">{T('forecastCurrentHelp')}</div>
              </div>
              <div className={`hf-forecast-value hfx-num ${(cashflowTrendModel.forecast.net || 0) >= 0 ? 'is-pos' : 'is-neg'}`}>{fmtDec(cashflowTrendModel.forecast.net)}</div>
            </div>
            <div className="hf-forecast-grid">
              {[
                [T('projectedIncome'), cashflowTrendModel.forecast.income, false],
                [T('projectedExpense'), cashflowTrendModel.forecast.expense, false],
                [T('projectedNet'), cashflowTrendModel.forecast.net, false],
                [T('cashflowCoverage'), `${cashflowTrendModel.forecast.coverage || 0}%`, false],
              ].map(([label,value,expandable]) => <button key={label} type="button" className={`hf-forecast-tile ${expandable ? 'is-clickable' : ''}`.trim()} onClick={expandable ? ()=>setForecastExpanded((v)=>!v) : undefined}><div className="hf-forecast-label">{label}</div><div className="hf-kpi-value hfx-num">{typeof value === 'number' ? fmtDec(value) : value}</div>{expandable && <div className="hf-list-meta">{forecastExpanded ? T('collapseRecurring') : T('expandRecurring')}</div>}</button>)}
            </div>
            <div className="hf-forecast-grid" style={{marginTop:12}}>
              {[
                [T('actualSoFar'), cfoTrendModel.forecast?.actual || 0, false],
                [T('expectedRecurring'), cfoTrendModel.forecast?.expectedRecurring || 0, true],
                [T('projectedVariable'), cfoTrendModel.forecast?.variableForecast || 0, false],
                [T('daysElapsed'), cfoTrendModel.forecast ? `${cfoTrendModel.forecast.daysElapsed}/${cfoTrendModel.forecast.daysTotal}` : '—', false],
              ].map(([label,value,expandable]) => <button key={label} type="button" className={`hf-forecast-tile ${expandable ? 'is-clickable' : ''}`.trim()} onClick={expandable ? ()=>setForecastExpanded((v)=>!v) : undefined}><div className="hf-forecast-label">{label}</div><div className="hf-kpi-value hfx-num">{typeof value === 'number' ? fmtDec(value) : value}</div>{expandable && <div className="hf-list-meta">{forecastExpanded ? T('collapseRecurring') : T('expandRecurring')}</div>}</button>)}
            </div>
            {cfoTrendModel.forecast && <div className="hf-detail-grid" style={{marginTop:14}}>
              {(cfoTrendModel.forecast.upcoming || []).slice(0, forecastExpanded ? undefined : 6).map((g)=>{ const reaction = forecastReactionFor(cfoTrendModel.forecast.feedback, g.key); return <div key={g.key} className="hf-upcoming-tile"><button type="button" className="hf-upcoming-main" onClick={()=>openDataWithFilters({ recurringKey:g.key, search:g.label })}><div className="hf-list-row-head"><b>{g.label}</b><b>{fmtDec(g.amount)}</b></div><div className="hf-list-meta">{g.confidence.toUpperCase()} · {T('expectedAroundDay')} {g.expectedDay} · {g.status === 'missing' ? T('notPostedYet') : T('upcoming')}</div></button><div className="hf-feedback-row"><button type="button" className={`hf-feedback-btn ${reaction === 'up' ? 'is-up' : ''}`.trim()} title={T('forecastThumbUp')} onClick={()=>saveForecastFeedback(g.key, 'up')}><Icon name="thumbUp" size={16} /></button><button type="button" className={`hf-feedback-btn ${reaction === 'down' ? 'is-down' : ''}`.trim()} title={T('forecastThumbDown')} onClick={()=>saveForecastFeedback(g.key, 'down')}><Icon name="thumbDown" size={16} /></button></div></div>; })}
              {!(cfoTrendModel.forecast.upcoming || []).length && <div className="hf-empty-text">{T('noUpcomingRecurring')}</div>}
            </div>}
          </div>}

          <div className="hf-card">
            <div className="hf-section-head">
              <div className="hf-card-title"><IconLabel icon="trends">{T('incomeExpenseTrend')} · {rangeLabel}</IconLabel></div>
            </div>
            <ResponsiveContainer width="100%" height={320}>
              <LineChart data={cashflowTrendModel.trend.slice(-12)} margin={{top:5,right:8,left:-14,bottom:5}}>
                <CartesianGrid vertical={false} stroke={theme.border} />
                <XAxis dataKey="month" tickLine={false} axisLine={false} tick={{fill:theme.subtext,fontSize:11}} />
                <YAxis tickLine={false} axisLine={false} tick={{fill:theme.subtext,fontSize:11}} tickFormatter={amountTick} />
                <Tooltip formatter={(v)=>fmt(v)} contentStyle={chartTooltipStyle} labelStyle={{ color: theme.text }} itemStyle={{ color: theme.text }} />
                <Line type="monotone" dataKey={T('income')} stroke={theme.accent} strokeWidth={2} dot={false} activeDot={{ r:4 }} isAnimationActive={false} />
                <Line type="monotone" dataKey={T('expenseOut')} stroke={(theme.name === 'light' ? '#C2412D' : '#F2836B')} strokeWidth={2} dot={false} activeDot={{ r:4 }} isAnimationActive={false} />
                <Line type="monotone" dataKey={T('netCashflow')} stroke={theme.subtext} strokeWidth={1.5} strokeDasharray="4 3" dot={false} activeDot={{ r:4 }} isAnimationActive={false} />
                <Legend iconType="plainline" wrapperStyle={{ fontSize: 12, color: theme.subtext, paddingTop: 8 }} />
              </LineChart>
            </ResponsiveContainer>
          </div>

          <div className="grid-two hf-dashboard-grid is-drivers">
            <div className="hf-card">
              <div className="hf-card-title"><IconLabel icon="insights">{T('automaticInsights')}</IconLabel></div>
              <div className="hf-detail-grid">{[...cashflowTrendModel.insights, ...cfoTrendModel.insights.slice(0,2)].map((txt,idx)=><div key={idx} className="hf-mini-card">{txt}</div>)}</div>
              <div className="hf-muted-line">{T('yoyHelp')}</div>
            </div>
            <div className="hf-card">
              <div className="hf-card-title"><IconLabel icon="forecast">{T('cashflowBridge')}</IconLabel></div>
              {[
                [T('income'), cashflowTrendModel.current.income, cashflowTrendModel.previous.income],
                [T('expenseOut'), cashflowTrendModel.current.expense, cashflowTrendModel.previous.expense],
                [T('netCashflow'), cashflowTrendModel.current.net, cashflowTrendModel.previous.net],
              ].map(([label,current,previous])=>{ const delta = round2(Number(current || 0) - Number(previous || 0)); return <div key={label} className="hf-list-row"><div className="hf-list-row-head"><b>{label}</b><b className={`hfx-num ${(label === T('expenseOut') ? delta <= 0 : delta >= 0) ? 'is-pos' : 'is-neg'}`}>{formatDeltaText(delta, safePct(delta, Number(previous || 0)), fmtDec)}</b></div><div className="hf-list-meta">{T('currentLabel')} {fmtDec(current)} · {T('previousLabel')} {fmtDec(previous)}</div></div>; })}
            </div>
          </div>

          <div className="grid-two hf-dashboard-grid is-balanced" style={{marginTop:18}}>
            <div className="hf-card">
              <div className="hf-card-title"><IconLabel icon="income">{T('incomeDrivers')}</IconLabel></div>
              {cashflowTrendModel.topRows(cashflowTrendModel.incomeCategories).map((row)=><div key={row.key} className="hf-list-row"><div className="hf-list-row-head"><b>{row.label}</b><b className="hfx-num">{fmtDec(row.value)}</b></div></div>)}
              {!cashflowTrendModel.topRows(cashflowTrendModel.incomeCategories).length && <div className="hf-empty-text">{T('noIncomeInRange')}</div>}
            </div>
            <div className="hf-card">
              <div className="hf-card-title"><IconLabel icon="category">{T('expenseDrivers')}</IconLabel></div>
              {cashflowTrendModel.topRows(cashflowTrendModel.expenseCategories).map((row)=><div key={row.key} className="hf-list-row"><div className="hf-list-row-head"><b>{row.label}</b><b className="hfx-num">{fmtDec(row.value)}</b></div></div>)}
            </div>
          </div>
        </>}

        {activeTab === 'raw' && <div className="hfx-page hfx-data">
          <div className="hfx-data-bar">
            <label className="hfx-search"><Icon name="search" size={15} /><input type="search" value={rawDraftFilters.desc} onChange={(e)=>updateRawDraftFilter('desc', e.target.value)} onKeyDown={handleRawFilterKeyDown} onBlur={applyRawDraftFiltersNow} placeholder={T('merchantDesc')} aria-label={T('merchantDesc')} /></label>
            <div className="hfx-data-sum"><b className="hfx-num">{fmtDec(rawFilteredSubtotal)}</b><span>{scopedRawRows.length} {T('filteredRows')}</span></div>
            {isCurrentAdmin && <button type="button" className={`hfx-btn ${showManualTxForm ? 'is-primary' : ''}`} onClick={()=>showManualTxForm ? addManualTransaction() : setShowManualTxForm(true)}>{!showManualTxForm && <Icon name="plus" size={14} />}<span>{showManualTxForm ? T('saveTransaction') : T('addTransaction')}</span></button>}
          </div>
          {isCurrentAdmin && showManualTxForm && <div className="hf-manual-row-form">
            <input type="date" value={manualTxDraft.date} onChange={(e)=>updateManualTxDraft({date:e.target.value})} style={S.input} />
            <input value={manualTxDraft.desc} onChange={(e)=>updateManualTxDraft({desc:e.target.value})} placeholder={T('description')} style={S.input} />
            <input value={manualTxDraft.amount} onChange={(e)=>updateManualTxDraft({amount:e.target.value})} placeholder={T('amount')} style={S.input} />
            <select value={manualTxDraft.holder} onChange={(e)=>updateManualTxDraft({holder:e.target.value})} style={S.input}>{holderOptions.map((h)=><option key={h} value={h}>{h}</option>)}</select>
            <select value={manualTxDraft.source} onChange={(e)=>{ const opt = ACCOUNT_IMPORT_OPTIONS.find((item)=>item.source===e.target.value) || ACCOUNT_IMPORT_OPTIONS[0]; updateManualTxDraft({source:opt.source, accountName:opt.accountName}); }} style={S.input}>{ACCOUNT_IMPORT_OPTIONS.map((opt)=><option key={opt.id} value={opt.source}>{sourceLabel(opt.source)}</option>)}</select>
            <select value={manualTxDraft.category} onChange={(e)=>updateManualTxDraft({category:e.target.value})} style={S.input}>{Object.entries(categoryConfig).map(([key,cfg])=><option key={key} value={key}>{cfg.label}</option>)}</select>
            <select value={manualTxDraft.personalFlag} onChange={(e)=>updateManualTxDraft({personalFlag:e.target.value})} style={S.input}><option value="personale">{T('personal')}</option><option value="comune">{T('common')}</option></select>
            <select value={manualTxDraft.cashflow} onChange={(e)=>updateManualTxDraft({cashflow:e.target.value})} style={S.input}><option value="expense">{T('cashflowExpense')}</option><option value="income">{T('cashflowIncome')}</option><option value="excluded">{T('cashflowExcluded')}</option></select>
            <button className="profile-primary-btn" onClick={addManualTransaction}>{T('saveTransaction')}</button>
            <button className="profile-secondary-btn" onClick={()=>setShowManualTxForm(false)}>{T('cancel')}</button>
          </div>}
          {selectedRawIds.length > 0 && <div className="hf-bulk-bar">
            <div className="hf-bulk-count">{selectedRawIds.length} {T('selectedRows')}</div>
            <select value={bulkEdit.holder} onChange={(e)=>setBulkEdit((b)=>({...b,holder:e.target.value}))} style={S.input}><option value="">{T('holderNoChange')}</option>{holderOptions.map((h)=><option key={h} value={h}>{h}</option>)}</select>
            <select value={bulkEdit.category} onChange={(e)=>setBulkEdit((b)=>({...b,category:e.target.value}))} style={S.input}><option value="">{T('categoryNoChange')}</option>{Object.entries(categoryConfig).map(([key,cfg])=><option key={key} value={key}>{cfg.label}</option>)}</select>
            <select value={bulkEdit.personalFlag} onChange={(e)=>setBulkEdit((b)=>({...b,personalFlag:e.target.value}))} style={S.input}><option value="">{T('flagNoChange')}</option><option value="comune">{T('common')}</option><option value="personale">{T('personal')}</option></select>
            <select value={bulkEdit.cashflow} onChange={(e)=>setBulkEdit((b)=>({...b,cashflow:e.target.value}))} style={S.input}><option value="">{T('cashflowNoChange')}</option><option value="expense">{T('cashflowExpense')}</option><option value="income">{T('cashflowIncome')}</option><option value="excluded">{T('cashflowExcluded')}</option></select>
            <select value={bulkEdit.subscription} onChange={(e)=>setBulkEdit((b)=>({...b,subscription:e.target.value}))} style={S.input}><option value="">{T('subscriptionNoChange')}</option><option value="__clear__">{T('clear')}</option><option value="manual">{T('manualSubscription')}</option></select>
            <button className="profile-primary-btn" onClick={applyBulkRawEdit}>{T('apply')}</button>
            {isCurrentAdmin && <button className="hf-icon-danger-btn" onClick={deleteSelectedRawRows}><Icon name="delete" /> {T('deleteSelectedRows')}</button>}
            <button className="profile-secondary-btn" onClick={clearRawSelection}>{T('clear')}</button>
          </div>}
          {rawRowsLimited && <div className="hf-data-notice">{T('latestRowsNotice').replace('{count}', RAW_BASE_RENDER_LIMIT)}</div>}
          {rawFilteredRowsLimited && <div className="hf-data-notice is-muted"><span>{T('filteredRowsNotice').replace('{shown}', renderedRawRows.length).replace('{total}', sortedScopedRawRows.length)}</span><button className="profile-secondary-btn" onClick={()=>setRawFilteredRenderLimit(sortedScopedRawRows.length)}>{T('showAll')}</button></div>}
          <section className="hfx-panel hfx-table-panel hfx-desktop-only">
          <div className="hf-table-wrap hfx-table-wrap" onScroll={(event)=>setRawVirtualScrollTop(event.currentTarget.scrollTop)}>
            <table className="hf-data-table hf-raw-data-table">
              <thead>
                <tr className="hf-data-head-row">
                  <th style={{ width:42 }}><input type="checkbox" checked={renderedRawRows.length > 0 && renderedRawRows.every((r)=>selectedRawSet.has(r.id))} onChange={toggleSelectVisibleRawRows} title={T('selectVisible')} /></th>
                  {[[T('date'),'date'],[T('description'),'desc'],[T('holder'),'holder'],[T('source'),'source'],[T('country'),'paese'],[T('amount'),'amount'],[T('category'),'category'],[T('flag'),'personalFlag'],[T('cashflow'),'cashflow']].map(([col,key]) => <th key={key}>{rawHeader(col, key)}</th>)}
                </tr>
                <tr className="hf-data-filter-row">
                  <th><button className="hf-sort-button" onClick={()=>setSelectedRawIds([])}>{T('clear')}</button></th>
                  <th><input value={rawDraftFilters.date} onChange={(e)=>updateRawDraftFilter('date', e.target.value)} onKeyDown={handleRawFilterKeyDown} placeholder={T('filter')} style={rawFilterInputStyle('date')} /></th>
                  <th><input value={rawDraftFilters.desc} onChange={(e)=>updateRawDraftFilter('desc', e.target.value)} onKeyDown={handleRawFilterKeyDown} placeholder={T('merchantDesc')} style={rawFilterInputStyle('desc')} /></th>
                  <th><input value={rawDraftFilters.holder} onChange={(e)=>updateRawDraftFilter('holder', e.target.value)} onKeyDown={handleRawFilterKeyDown} placeholder={T('holder')} style={rawFilterInputStyle('holder')} /></th>
                  <th><input value={rawDraftFilters.source} onChange={(e)=>updateRawDraftFilter('source', e.target.value)} onKeyDown={handleRawFilterKeyDown} placeholder={T('source')} style={rawFilterInputStyle('source')} /></th>
                  <th><input value={rawDraftFilters.paese} onChange={(e)=>updateRawDraftFilter('paese', e.target.value)} onKeyDown={handleRawFilterKeyDown} placeholder={T('country')} style={rawFilterInputStyle('paese')} /></th>
                  <th><div className="hf-data-amount-filter"><input value={rawDraftFilters.amountMin} onChange={(e)=>updateRawDraftFilter('amountMin', e.target.value)} onKeyDown={handleRawFilterKeyDown} placeholder={T('min')} style={rawAmountFilterStyle} /><input value={rawDraftFilters.amountMax} onChange={(e)=>updateRawDraftFilter('amountMax', e.target.value)} onKeyDown={handleRawFilterKeyDown} placeholder={T('max')} style={rawAmountFilterStyle} /></div></th>
                  <th><input value={rawDraftFilters.category} onChange={(e)=>updateRawDraftFilter('category', e.target.value)} onKeyDown={handleRawFilterKeyDown} placeholder={T('category')} style={rawFilterInputStyle('category')} /></th>
                  <th><input value={rawDraftFilters.personalFlag} onChange={(e)=>updateRawDraftFilter('personalFlag', e.target.value)} onKeyDown={handleRawFilterKeyDown} placeholder={T('personalFlag')} style={rawFilterInputStyle('personalFlag')} /></th>
                  <th><input value={rawDraftFilters.cashflow} onChange={(e)=>updateRawDraftFilter('cashflow', e.target.value)} onKeyDown={handleRawFilterKeyDown} placeholder={T('cashflow')} style={rawFilterInputStyle('cashflow')} /></th>
                </tr>
              </thead>
              <tbody>
                {rawVirtualWindow.topPad > 0 && <tr aria-hidden="true"><td colSpan={10} style={{ height: rawVirtualWindow.topPad, padding:0, border:0 }} /></tr>}
                {rawVirtualWindow.rows.map((row) => (
                  <tr key={row.id} className={`hf-data-row ${selectedRawSet.has(row.id) ? 'is-selected' : ''}`}>
                    <td><input type="checkbox" checked={selectedRawSet.has(row.id)} onChange={()=>toggleRawRowSelection(row.id)} /></td>
                    <td>{row.date}</td>
                    <td><div className="hf-data-desc">{row.desc}</div></td>
                    <td><select className="hf-data-select-holder" value={canonicalHolderDisplay(row.holder)} onChange={(e)=>overrideHolder(row, e.target.value)} style={S.input}>{holderOptions.map((h)=><option key={h} value={h}>{h}</option>)}</select></td>
                    <td className="hf-data-muted hf-data-strong">{row.sourceLabel}</td>
                    <td className="hf-data-muted hfx-td-country">{row.paese || '—'}</td>
                    <td className="hf-data-strong hfx-num hfx-td-amount">{row.amountLabel}</td>
                    <td><select className="hf-data-select-category" value={row.categoryKey} onChange={(e)=>handleRawCategoryChange(row, e.target.value)} style={{ ...S.input, '--cat': categoryConfig[row.categoryKey]?.color || theme.subtext }}>{Object.entries(categoryConfig).map(([key, cfg]) => <option key={key} value={key}>{cfg.label}</option>)}<option value="__new_category__">{T('newCategory')}</option></select></td>
                    <td><select className="hf-data-select-flag" value={row.personalFlag} onChange={(e)=>overridePersonalFlag(row, e.target.value)} style={S.input}><option value="comune">{T('common')}</option><option value="personale">{T('personal')}</option></select></td>
                    <td><select className={`hf-cashflow-select is-${row.cashflowType}`} value={row.cashflowType} onChange={(e)=>overrideCashflowExclusion(row, e.target.value)} style={S.input}><option value="expense">{T('cashflowExpense')}</option><option value="income">{T('cashflowIncome')}</option><option value="excluded">{T('cashflowExcluded')}</option></select>{row.isRefund && row.cashflowType === 'expense' ? <div className="hf-data-refund">{T('refund')}</div> : null}</td>
                  </tr>
                ))}
                {rawVirtualWindow.bottomPad > 0 && <tr aria-hidden="true"><td colSpan={10} style={{ height: rawVirtualWindow.bottomPad, padding:0, border:0 }} /></tr>}
              </tbody>
              <tfoot>
                <tr className="hf-data-footer-row">
                  <td colSpan={6} className="hf-data-strong">{T('subtotal')}</td>
                  <td className="hf-data-strong hfx-num hfx-td-amount">{fmtDec(rawFilteredSubtotal)}</td>
                  <td colSpan={3} className="hf-data-muted">{(rawRowsLimited || rawFilteredRowsLimited) ? `${renderedRawRows.length}/${scopedRawRows.length}` : scopedRawRows.length} {T('filteredTransactions')}</td>
                </tr>
              </tfoot>
            </table>
          </div>
          </section>
          <section className="hfx-txlist hfx-mobile-only" aria-label={T('transactions')}>
            {!renderedRawRows.length && <p className="hfx-muted">{T('noDataInRange')}</p>}
            {renderedRawRows.reduce((groups, row) => { const last = groups[groups.length - 1]; if (last && last.date === row.date) last.rows.push(row); else groups.push({ date: row.date, rows: [row] }); return groups; }, []).map((group) => {
              const dayTotal = group.rows.reduce((sum, row) => row.cashflowType === 'expense' ? round2(sum + Number(row.amount || 0)) : sum, 0);
              const d = new Date(`${group.date}T12:00:00`);
              const dayLabel = Number.isNaN(d.getTime()) ? group.date : d.toLocaleDateString(currentLang === 'it' ? 'it-IT' : 'en-GB', { weekday: 'short', day: 'numeric', month: 'short', year: d.getFullYear() === new Date().getFullYear() ? undefined : 'numeric' });
              return <div key={group.date} className="hfx-txgroup">
                <div className="hfx-txdate"><span>{dayLabel}</span>{dayTotal > 0 && <span className="hfx-num">{fmtDec(dayTotal)}</span>}</div>
                <ul>{group.rows.map((row) => { const cfg = categoryConfig[row.categoryKey] || { label: row.categoryKey, color: theme.subtext }; const open = expandedTxId === row.id; return <li key={row.id} className={`${open ? 'is-open' : ''} ${selectedRawSet.has(row.id) ? 'is-selected' : ''}`}>
                  <button type="button" className="hfx-tx" aria-expanded={open} onClick={()=>setExpandedTxId(open ? null : row.id)}>
                    <span className="hfx-dot" style={{ background: cfg.color }} aria-hidden="true" />
                    <span className="hfx-tx-main"><span className="hfx-tx-desc">{row.desc}</span><span className="hfx-tx-meta">{canonicalHolderDisplay(row.holder)} · {cfg.label}{row.personalFlag === 'personale' ? ` · ${T('personal')}` : ''}{row.cashflowType !== 'expense' ? ` · ${row.cashflowType === 'income' ? T('cashflowIncome') : T('cashflowExcluded')}` : ''}</span></span>
                    <span className={`hfx-tx-amt hfx-num ${row.cashflowType === 'income' ? 'is-pos' : row.cashflowType === 'excluded' ? 'is-muted' : ''}`}>{row.amountLabel}</span>
                  </button>
                  {open && <div className="hfx-tx-edit">
                    <label><span>{T('holder')}</span><select className="hfx-input" value={canonicalHolderDisplay(row.holder)} onChange={(e)=>overrideHolder(row, e.target.value)}>{holderOptions.map((h)=><option key={h} value={h}>{h}</option>)}</select></label>
                    <label><span>{T('category')}</span><select className="hfx-input" value={row.categoryKey} onChange={(e)=>handleRawCategoryChange(row, e.target.value)}>{Object.entries(categoryConfig).map(([key, c]) => <option key={key} value={key}>{c.label}</option>)}<option value="__new_category__">{T('newCategory')}</option></select></label>
                    <label><span>{T('flag')}</span><select className="hfx-input" value={row.personalFlag} onChange={(e)=>overridePersonalFlag(row, e.target.value)}><option value="comune">{T('common')}</option><option value="personale">{T('personal')}</option></select></label>
                    <label><span>{T('cashflow')}</span><select className="hfx-input" value={row.cashflowType} onChange={(e)=>overrideCashflowExclusion(row, e.target.value)}><option value="expense">{T('cashflowExpense')}</option><option value="income">{T('cashflowIncome')}</option><option value="excluded">{T('cashflowExcluded')}</option></select></label>
                    <div className="hfx-tx-facts"><span>{row.sourceLabel}</span>{row.paese && <span>{row.paese}</span>}{row.isRefund && <span>{T('refund')}</span>}</div>
                    <label className="hfx-check"><input type="checkbox" checked={selectedRawSet.has(row.id)} onChange={()=>toggleRawRowSelection(row.id)} /><span>{T('selectRow')}</span></label>
                  </div>}
                </li>; })}</ul>
              </div>;
            })}
          </section>
        </div>}

        {activeTab === 'notes' && <div className="hf-card hf-panel-card">
          <div className="hf-section-head">
            <div><div className="hf-card-title"><IconLabel icon="notes">{T('notesTab')} · {rangeLabel}</IconLabel></div><div className="hf-section-copy">{T('notesHelp')}</div></div>
          </div>
          <div className="hf-table-shell">
            <table className="hf-compact-table hf-notes-table">
              <thead><tr>{[T('notesMonth'),T('notesUser'),T('notesSpend'),T('notesSharedSpend'),T('notesPersonalSpend'),T('income'),T('notesText')].map((h)=><th key={h}>{h}</th>)}</tr></thead>
              <tbody>{noteRows.map((row)=><tr key={row.noteKey}>
                <td className="hf-note-month">{row.month}</td>
                <td className="hf-note-user">{row.user}</td>
                <td className="hf-note-amount">{fmtDec(row.spend)}</td>
                <td className="hf-note-amount">{fmtDec(row.sharedSpend)}</td>
                <td className="hf-note-amount">{fmtDec(row.personalSpend)}</td>
                <td className="hf-note-amount is-income">{fmtDec(row.income)}</td>
                <td><textarea className="hf-note-textarea" defaultValue={row.note} onBlur={(e)=>updateNote(row.noteKey,{note:e.target.value})} placeholder={T('notesText')} style={S.input} /></td>
              </tr>)}</tbody>
            </table>
          </div>
        </div>}

      </div>}
      </div>

      <nav className="hfx-tabbar" aria-label={T('sections')}>
        {mobileTabs.map(([id, label, icon]) => <button key={id} type="button" className={activeTab === id ? 'is-active' : ''} aria-current={activeTab === id ? 'page' : undefined} onClick={() => goTab(id)}><Icon name={icon} size={20} /><span>{label}</span></button>)}
        <button type="button" className={showMore || ['notes','profile'].includes(activeTab) ? 'is-active' : ''} onClick={() => setShowMore(true)}><Icon name="more" size={20} /><span>{T('more')}</span></button>
      </nav>
      {showMore && <>
        <div className="hfx-scrim is-mobile" onClick={() => setShowMore(false)} />
        <div className="hfx-sheet" role="dialog" aria-label={T('more')}>
          <div className="hfx-sheet-grip" />
          {[['notes', T('notesTab'), 'notes'], ['profile', T('profile'), 'customization']].map(([id, label, icon]) => <button key={id} type="button" className="hfx-sheet-item" onClick={() => { goTab(id); setShowMore(false); }}><Icon name={icon} size={18} /><span>{label}</span></button>)}
          <div className="hfx-sheet-sep" />
          <div className="hfx-sheet-label">{T('user')}</div>
          <div className="hfx-seg hfx-seg-full" role="group">
            <button type="button" className={selectedHolder === 'ALL' ? 'is-active' : ''} onClick={() => setSelectedHolder('ALL')}>{T('all')}</button>
            {members.map((m, idx) => <button key={m.id} type="button" className={selectedHolder === m.id ? 'is-active' : ''} onClick={() => setSelectedHolder(m.id)}><span className="hfx-dot" style={{ background: memberColor(theme, idx) }} />{m.name}</button>)}
          </div>
          <div className="hfx-sheet-sep" />
          <button type="button" className="hfx-sheet-item" onClick={toggleThemeMode}><Icon name="theme" size={18} /><span>{themeMode === 'dark' ? T('light') : T('dark')}</span></button>
          <button type="button" className="hfx-sheet-item" onClick={() => setCurrentLanguage(currentLang === 'en' ? 'it' : 'en')}><Icon name="language" size={18} /><span>{currentLang === 'en' ? 'Italiano' : 'English'}</span></button>
          <button type="button" className="hfx-sheet-item is-danger" onClick={logout}><Icon name="logout" size={18} /><span>{T('logout')}</span></button>
        </div>
      </>}
    </div>
    </>
  );
}
