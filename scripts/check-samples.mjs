// Parses every file in ./samples with the real importers and checks the results.
// Usage: npm run check:samples   (exits non-zero on any mismatch)
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { parseAmexMonthlyWorkbook } from '../src/importers/amexImporter.js';
import { parseRevolutCsvFiles } from '../src/importers/revolutImporter.js';
import { parseMpWorkbook } from '../src/importers/mpImporter.js';
import { parseFinecoWorkbook } from '../src/importers/finecoImporter.js';
import { readCustomImportFiles, analyzeFiles, draftFormatFromAnalysis, parseWithFormat, findMatchingFormat, headerSignature } from '../src/importers/customImporter.js';

const dir = join(dirname(fileURLToPath(import.meta.url)), '..', 'samples');
const read = (name) => readFileSync(join(dir, name));
const asFile = (name) => new File([read(name)], name);
const household = {
  members: [
    { id: 'alex', name: 'Alex', keywords: [] },
    { id: 'sam', name: 'Sam', keywords: [] },
  ],
  sharedLabel: 'Shared',
};
const sum = (txs, pred) => Math.round(txs.filter(pred).reduce((s, t) => s + t.amount, 0) * 100) / 100;

function report(label, txs, extra = '') {
  if (!txs.length) throw new Error(`${label}: no transactions parsed`);
  const spend = sum(txs, (t) => !t.excludeFromCashflow);
  console.log(`${label.padEnd(22)} rows=${String(txs.length).padStart(2)} spend=€${spend.toFixed(2).padStart(8)} ${extra}`);
  return spend;
}

// Built-in importers
report('amex', parseAmexMonthlyWorkbook(read('amex-sample.xlsx')).transactions);
report('revolut', (await parseRevolutCsvFiles([asFile('revolut-sample.csv')], { account: { accountName: 'Revolut Sam', holder: 'Sam', accountScope: 'sam', personalFlag: 'personale' } })).transactions);
report('mp', parseMpWorkbook(read('mp-sample.xlsx'), { sourceFileName: 'mp-sample.xlsx', ...household }).transactions);
report('fineco', parseFinecoWorkbook(read('fineco-sample.xlsx'), { sourceFileName: 'fineco-sample.xlsx', ...household }).transactions);

// Learn format: detect → draft → parse, with no manual corrections.
async function learn(name, expect) {
  const tables = await readCustomImportFiles([asFile(name)]);
  const best = analyzeFiles(tables);
  const draft = { ...draftFormatFromAnalysis(best, { fileName: name, members: household.members }), id: `custom_${name.replace(/\W+/g, '_')}`, headers: best.analysis.headers };
  draft.headerSignature = headerSignature(draft.headers);
  Object.assign(draft, expect.overrides || {});
  const { transactions: txs, stats } = await parseWithFormat(tables, draft, household);
  const m = draft.mapping;
  const detected = `[${m.amountMode} ${draft.dateOrder} '${draft.decimal}' ${draft.signMode} owner=${draft.owner}]`;
  const spend = report(`learn:${name}`, txs, detected);
  const income = sum(txs, (t) => t.cashflowType === 'income');
  assert.equal(txs.length, expect.rows, `${name}: rows`);
  assert.equal(spend, expect.spend, `${name}: spend`);
  assert.equal(income, expect.income ?? 0, `${name}: income`);
  if (expect.skipped) assert.deepEqual(stats.skipped, expect.skipped, `${name}: skipped`);
  if (expect.check) expect.check(txs, draft);
  // Re-parsing the same file must produce identical references (dedupe across imports).
  const again = await parseWithFormat(tables, draft, household);
  assert.deepEqual(again.transactions.map((t) => t.ref), txs.map((t) => t.ref), `${name}: stable refs`);
  // The saved format must recognise its own file.
  assert.ok(findMatchingFormat(tables, { [draft.id]: draft }), `${name}: recognised`);
  return draft;
}

await learn('generic-us-bank.csv', {
  rows: 4, spend: 61.75 + 42.10, income: -2350, skipped: { status: 1 },
  check: (txs, f) => {
    assert.equal(f.mapping.amountMode, 'split');
    assert.equal(f.dateOrder, 'MDY');
    assert.ok(txs.find((t) => /TRANSFER TO SAM/.test(t.desc)).excludeFromCashflow, 'own transfer excluded');
  },
  overrides: {},
});
await learn('generic-de-bank.csv', {
  rows: 5, spend: 1150 + 87.45 - 19.99, income: -3100,
  overrides: {},
  check: (txs, f) => {
    assert.equal(f.decimal, ',');
    assert.equal(f.headerIndex, 3);
    assert.equal(txs[0].date, '2026-09-01');
  },
});
await learn('generic-card.xlsx', {
  rows: 5, spend: 58.4 + 212 + 35.99 - 35.99,
  check: (txs, f) => {
    assert.equal(f.signMode, 'positive_is_expense');
    assert.equal(f.owner, 'column');
    assert.equal(txs.find((t) => /SKYLINE/.test(t.desc)).holder, 'Sam');
    assert.ok(txs.find((t) => /PAYMENT RECEIVED/.test(t.desc)).excludeFromCashflow, 'card settlement excluded');
  },
});
await learn('generic-indicator-bank.csv', {
  rows: 4, spend: 45 + 12.3, income: -2100,
  check: (txs, f) => { assert.equal(f.mapping.amountMode, 'indicator'); },
});
// MP and Fineco exports can also be learned generically (metadata rows above the table).
await learn('mp-sample.xlsx', { rows: 6, spend: 950 + 29.9 + 84.12, income: -2400, overrides: {} , check: () => {} }).catch((e) => { throw e; });

console.log('All sample files parsed and checked successfully.');
