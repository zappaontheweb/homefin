// Generates fictional sample statements in each supported import format.
// Usage: npm run samples   (writes into ./samples)
// All names, accounts and merchants are invented. Household used: "Alex Example" and "Sam Example".
import * as XLSX from 'xlsx';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const outDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'samples');
mkdirSync(outDir, { recursive: true });

function writeWorkbook(name, sheetName, rows) {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows), sheetName);
  writeFileSync(join(outDir, name), XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }));
  console.log(`wrote samples/${name}`);
}

// --- American Express (Italy) monthly spending report, .xlsx ---
// Header row must start with "Data" | "Descrizione"; a title row carries the statement period.
writeWorkbook('amex-sample.xlsx', 'Riepilogo', [
  ['Riepilogo spese dal 21 agosto 2026 a 20 settembre 2026'],
  [],
  ['Data', 'Descrizione', 'Titolare', 'Importo', 'Riferimento', 'Paese'],
  ['22/08/2026', 'CORNER MARKET', 'ALEX EXAMPLE', 54.3, 'AMX-DEMO-001', 'ITALY'],
  ['24/08/2026', 'TRATTORIA DEMO', 'SAM EXAMPLE', 62.0, 'AMX-DEMO-002', 'ITALY'],
  ['27/08/2026', 'NETFLIX.COM', 'ALEX EXAMPLE', 13.99, 'AMX-DEMO-003', 'NETHERLANDS'],
  ['30/08/2026', 'CITY TAXI CO', 'SAM EXAMPLE', 18.5, 'AMX-DEMO-004', 'ITALY'],
  ['02/09/2026', 'HOTEL SEASIDE', 'ALEX EXAMPLE', 245.0, 'AMX-DEMO-005', 'SPAIN'],
  ['05/09/2026', 'AMAZON MARKETPLACE', 'SAM EXAMPLE', 39.9, 'AMX-DEMO-006', 'LUXEMBOURG'],
  ['08/09/2026', 'AMAZON MARKETPLACE', 'SAM EXAMPLE', -12.5, 'AMX-DEMO-007', 'LUXEMBOURG'],
  ['12/09/2026', 'FARMACIA CENTRALE', 'ALEX EXAMPLE', 21.4, 'AMX-DEMO-008', 'ITALY'],
  ['15/09/2026', 'ADDEBITO IN C/C SALVO BUON FINE', 'ALEX EXAMPLE', 812.33, 'AMX-DEMO-009', 'ITALY'],
  ['18/09/2026', 'GLOVO ORDER', 'SAM EXAMPLE', 27.8, 'AMX-DEMO-010', 'ITALY'],
]);

// --- Revolut account statement, .csv (one file per account; pick the account at import time) ---
const revolutRows = [
  ['Type', 'Product', 'Started Date', 'Completed Date', 'Description', 'Amount', 'Fee', 'Currency', 'State', 'Balance'],
  ['TOPUP', 'Current', '2026-09-01 08:00:00', '2026-09-01 08:00:05', 'Top-up by *0000', '500.00', '0.00', 'EUR', 'COMPLETED', '500.00'],
  ['CARD_PAYMENT', 'Current', '2026-09-02 12:10:00', '2026-09-03 09:00:00', 'Blue Bean Caffe', '-4.20', '0.00', 'EUR', 'COMPLETED', '495.80'],
  ['CARD_PAYMENT', 'Current', '2026-09-04 19:30:00', '2026-09-05 09:00:00', 'Greenleaf Supermarket', '-86.45', '0.00', 'EUR', 'COMPLETED', '409.35'],
  ['CARD_PAYMENT', 'Current', '2026-09-07 20:00:00', '2026-09-08 09:00:00', 'Spotify', '-10.99', '0.00', 'EUR', 'COMPLETED', '398.36'],
  ['CARD_REFUND', 'Current', '2026-09-09 10:00:00', '2026-09-09 10:00:01', 'Greenleaf Supermarket', '6.10', '0.00', 'EUR', 'COMPLETED', '404.46'],
  ['TRANSFER', 'Current', '2026-09-10 09:00:00', '2026-09-10 09:00:01', 'To pocket Holiday', '-100.00', '0.00', 'EUR', 'COMPLETED', '304.46'],
  ['CARD_PAYMENT', 'Current', '2026-09-12 13:00:00', '', 'Pending Merchant', '-9.99', '0.00', 'EUR', 'PENDING', '304.46'],
];
writeFileSync(join(outDir, 'revolut-sample.csv'), revolutRows.map((r) => r.map((c) => (/[",]/.test(c) ? `"${c.replace(/"/g, '""')}"` : c)).join(',')).join('\n') + '\n');
console.log('wrote samples/revolut-sample.csv');

// --- MP (Mediobanca Premier) current-account export, .xlsx ---
// Metadata block ("Rapporto", "Intestatari", ...) followed by the movements table.
writeWorkbook('mp-sample.xlsx', 'Movimenti', [
  ['Rapporto', 'DEMO-0001'],
  ['Intestatari', 'ALEX EXAMPLE, SAM EXAMPLE'],
  ['Divisa', 'EUR'],
  [],
  ['Data contabile', 'Data valuta', 'Tipologia', 'Entrate', 'Uscite', 'Divisa'],
  ['01/09/2026', '01/09/2026', 'Bonifico - RENT DEMO LANDLORD', '', '950,00', 'EUR'],
  ['03/09/2026', '03/09/2026', 'Stipendio - DEMO EMPLOYER SRL', '2.400,00', '', 'EUR'],
  ['09/09/2026', '09/09/2026', 'SDD - INTERNET PROVIDER DEMO', '', '29,90', 'EUR'],
  ['15/09/2026', '15/09/2026', 'Addebito carta American Express', '', '812,33', 'EUR'],
  ['18/09/2026', '18/09/2026', 'SDD - ELECTRIC UTILITY DEMO', '', '84,12', 'EUR'],
  ['20/09/2026', '20/09/2026', 'Bonifico - giroconto verso Revolut', '', '300,00', 'EUR'],
]);

// --- Fineco current-account export, .xlsx ---
writeWorkbook('fineco-sample.xlsx', 'Movimenti', [
  ['Conto Corrente: DEMO-0002'],
  ['Intestazione Conto Corrente: SAM EXAMPLE'],
  ['Periodo dal 01/09/2026 al 30/09/2026'],
  [],
  ['Data Operazione', 'Data Valuta', 'Entrate', 'Uscite', 'Descrizione', 'Descrizione Completa', 'Stato', 'Moneymap'],
  ['02/09/2026', '02/09/2026', '', '45,00', 'Pagamento Visa Debit', 'GYM & SPA DEMO', 'Contabilizzato', 'Sport'],
  ['05/09/2026', '05/09/2026', '', '23,70', 'Pagamento Visa Debit', 'CORNER MARKET', 'Contabilizzato', 'Spesa'],
  ['10/09/2026', '10/09/2026', '1.800,00', '', 'Bonifico', 'Stipendio DEMO EMPLOYER SRL', 'Contabilizzato', 'Entrate'],
  ['12/09/2026', '12/09/2026', '', '200,00', 'Bonifico', 'Bonifico a favore di ALEX EXAMPLE', 'Contabilizzato', 'Trasferimenti'],
  ['16/09/2026', '16/09/2026', '', '60,00', 'Prelievo', 'Prelievo Bancomat', 'Contabilizzato', 'Contanti'],
  ['22/09/2026', '22/09/2026', '', '310,45', 'Addebito', 'Utilizzo carta di credito estratto conto', 'Contabilizzato', 'Carte'],
]);

// --- Generic exports for "Learn format" (any provider) ---
const csv = (rows, delim = ',') => rows.map((r) => r.map((c) => (String(c).includes(delim) || String(c).includes('"') ? `"${String(c).replace(/"/g, '""')}"` : c)).join(delim)).join('\n') + '\n';

// US-style bank: MM/DD/YYYY, separate debit / credit columns, a pending row.
writeFileSync(join(outDir, 'generic-us-bank.csv'), csv([
  ['Posting Date', 'Description', 'Debit', 'Credit', 'Balance', 'Status'],
  ['09/02/2026', 'CORNER MARKET #12', '42.10', '', '1957.90', 'Posted'],
  ['09/03/2026', 'PAYROLL DEMO EMPLOYER', '', '2,350.00', '4307.90', 'Posted'],
  ['09/14/2026', 'CITY WATER UTILITY', '61.75', '', '4246.15', 'Posted'],
  ['09/15/2026', 'TRANSFER TO SAM EXAMPLE', '300.00', '', '3946.15', 'Posted'],
  ['09/21/2026', 'BLUE BEAN CAFFE', '4.50', '', '3941.65', 'Pending'],
]));
console.log('wrote samples/generic-us-bank.csv');

// German bank: title rows, semicolons, DD.MM.YYYY, 1.234,56 and negative = money out.
writeFileSync(join(outDir, 'generic-de-bank.csv'), [
  'Kontoumsätze;;;',
  'Konto: DEMO-0003;;;',
  ';;;',
  csv([
    ['Buchungstag', 'Verwendungszweck', 'Betrag', 'Währung'],
    ['01.09.2026', 'Miete Demo Vermieter', '-1.150,00', 'EUR'],
    ['04.09.2026', 'Supermarkt Demo', '-87,45', 'EUR'],
    ['10.09.2026', 'Gehalt Demo Arbeitgeber', '3.100,00', 'EUR'],
    ['18.09.2026', 'Rückerstattung Onlineshop', '19,99', 'EUR'],
    ['25.09.2026', 'Kreditkarte Abrechnung american express', '-640,20', 'EUR'],
  ], ';').trimEnd(),
].join('\n') + '\n');
console.log('wrote samples/generic-de-bank.csv');

// Credit card (XLSX): positive = spend, cardholder column, "05 Sep 2026" dates, a refund.
writeFileSync(join(outDir, 'generic-card.xlsx'), (() => {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([
    ['Card statement — demo'],
    ['Date', 'Merchant', 'Card member', 'Amount', 'Category'],
    ['05 Sep 2026', 'TRATTORIA DEMO', 'ALEX EXAMPLE', 58.4, 'Restaurants'],
    ['07 Sep 2026', 'SKYLINE AIRWAYS', 'SAM EXAMPLE', 212.0, 'Travel'],
    ['11 Sep 2026', 'AMAZON MARKETPLACE', 'ALEX EXAMPLE', 35.99, 'Shopping'],
    ['12 Sep 2026', 'AMAZON MARKETPLACE REFUND', 'ALEX EXAMPLE', -35.99, 'Shopping'],
    ['19 Sep 2026', 'PAYMENT RECEIVED - THANK YOU', 'ALEX EXAMPLE', -306.41, ''],
  ]), 'Transactions');
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
})());
console.log('wrote samples/generic-card.xlsx');

// Bank with an amount column plus a DR/CR indicator column.
writeFileSync(join(outDir, 'generic-indicator-bank.csv'), csv([
  ['Value Date', 'Narrative', 'Amount', 'DR/CR', 'Ccy'],
  ['2026-09-01', 'Gym & Spa Demo', '45.00', 'DR', 'EUR'],
  ['2026-09-05', 'Salary Demo Employer', '2100.00', 'CR', 'EUR'],
  ['2026-09-08', 'Pharmacy Demo', '12.30', 'DR', 'EUR'],
  ['2026-09-09', 'Bank transfer to Alex Example', '150.00', 'DR', 'EUR'],
]));
console.log('wrote samples/generic-indicator-bank.csv');
