// Fictional demo data for first-run exploration. Every merchant, amount and
// reference below is invented; holders are taken from the configured household.

const MERCHANTS = [
  { desc: 'CORNER MARKET', min: 25, max: 140, perMonth: 6, shared: true },
  { desc: 'GREENLEAF SUPERMARKET', min: 40, max: 180, perMonth: 3, shared: true },
  { desc: 'TRATTORIA DEMO', min: 30, max: 95, perMonth: 3, shared: false },
  { desc: 'BLUE BEAN CAFFE', min: 3, max: 12, perMonth: 8, shared: false },
  { desc: 'CITY TAXI CO', min: 9, max: 35, perMonth: 2, shared: false },
  { desc: 'FARMACIA CENTRALE', min: 8, max: 60, perMonth: 1, shared: true },
  { desc: 'AMAZON MARKETPLACE', min: 12, max: 120, perMonth: 3, shared: false },
  { desc: 'GLOVO ORDER', min: 18, max: 45, perMonth: 2, shared: true },
  { desc: 'HOTEL SEASIDE', min: 120, max: 380, perMonth: 0.2, shared: true },
  { desc: 'SKYLINE AIRWAYS', min: 90, max: 420, perMonth: 0.15, shared: true },
  { desc: 'GYM & SPA DEMO', min: 45, max: 45, perMonth: 1, shared: false, fixedDay: 3 },
];
const SUBSCRIPTIONS = [
  { desc: 'NETFLIX.COM', amount: 13.99, day: 5, shared: true },
  { desc: 'SPOTIFY', amount: 10.99, day: 12, shared: false },
];
const BANK_RECURRING = [
  { desc: 'SDD - ELECTRIC UTILITY DEMO', min: 60, max: 110, day: 18 },
  { desc: 'SDD - INTERNET PROVIDER DEMO', min: 29.9, max: 29.9, day: 9 },
  { desc: 'BONIFICO - RENT DEMO LANDLORD', min: 950, max: 950, day: 1 },
];

// Small deterministic PRNG so the demo looks the same on every install.
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const pad2 = (n) => String(n).padStart(2, '0');
const iso = (d) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
const round2 = (n) => Math.round(n * 100) / 100;

export function buildDemoTransactions(members = [], { months = 6, today = new Date() } = {}) {
  const people = members.length ? members : [{ id: 'alex', name: 'Alex' }, { id: 'sam', name: 'Sam' }];
  const rand = mulberry32(42);
  const pick = (min, max) => round2(min + (max - min) * rand());
  const txs = [];
  let seq = 0;
  const push = (tx) => { seq += 1; txs.push({ ref: `demo-${String(seq).padStart(4, '0')}`, paese: 'ITALY', ...tx }); };
  const sharedAccount = people.length > 1;

  for (let m = months - 1; m >= 0; m -= 1) {
    const monthStart = new Date(today.getFullYear(), today.getMonth() - m, 1);
    const daysInMonth = new Date(monthStart.getFullYear(), monthStart.getMonth() + 1, 0).getDate();
    const lastDay = m === 0 ? today.getDate() : daysInMonth;
    const dayDate = (day) => new Date(monthStart.getFullYear(), monthStart.getMonth(), Math.min(day, lastDay));
    const randomDay = () => 1 + Math.floor(rand() * lastDay);

    for (const merchant of MERCHANTS) {
      let count = Math.floor(merchant.perMonth) + (rand() < merchant.perMonth % 1 ? 1 : 0);
      for (let i = 0; i < count; i += 1) {
        const owner = people[Math.floor(rand() * people.length)];
        const date = iso(dayDate(merchant.fixedDay || randomDay()));
        if (merchant.fixedDay && merchant.fixedDay > lastDay) continue;
        push({ date, desc: merchant.desc, holder: owner.name, amount: pick(merchant.min, merchant.max), source: 'amex', accountName: 'Amex', personalFlag: merchant.shared ? 'comune' : 'personale' });
      }
    }
    for (const sub of SUBSCRIPTIONS) {
      if (sub.day > lastDay) continue;
      push({ date: iso(dayDate(sub.day)), desc: sub.desc, holder: people[0].name, amount: sub.amount, source: 'amex', accountName: 'Amex', personalFlag: sub.shared ? 'comune' : 'personale' });
    }
    for (const bill of BANK_RECURRING) {
      if (bill.day > lastDay) continue;
      push({
        date: iso(dayDate(bill.day)),
        desc: bill.desc,
        holder: sharedAccount ? 'Shared' : people[0].name,
        amount: pick(bill.min, bill.max),
        source: 'mp',
        accountName: sharedAccount ? 'MP shared' : `MP ${people[0].name}`,
        accountScope: sharedAccount ? 'shared' : people[0].id,
        personalFlag: sharedAccount ? 'comune' : 'personale',
        paese: '',
      });
    }
    // Salaries land on the bank account as income (negative amount = money in).
    people.forEach((person, idx) => {
      if (27 > lastDay) return;
      push({ date: iso(dayDate(27)), desc: `SALARY DEMO EMPLOYER ${idx + 1}`, holder: person.name, amount: -pick(2100, 2400), source: 'mp', accountName: `MP ${person.name}`, accountScope: person.id, personalFlag: 'personale', cashflowType: 'income', excludeFromCashflow: true, paese: '' });
    });
    // A refund now and then, to show negative amounts.
    if (rand() < 0.5) {
      push({ date: iso(dayDate(randomDay())), desc: 'AMAZON MARKETPLACE REFUND', holder: people[0].name, amount: -pick(10, 60), source: 'amex', accountName: 'Amex', personalFlag: 'personale', isRefund: true });
    }
    // Amex statement settlement on the bank account: excluded from cashflow automatically.
    if (lastDay >= 25) {
      push({ date: iso(dayDate(25)), desc: 'ADDEBITO IN C/C SALVO BUON FINE', holder: people[0].name, amount: pick(800, 1600), source: 'amex', accountName: 'Amex', personalFlag: 'personale', excludeFromCashflow: true, excludeReason: 'card_payment' });
    }
  }
  return txs.sort((a, b) => a.date.localeCompare(b.date));
}

export function buildDemoStore(members = []) {
  return {
    version: 6,
    meta: { demoData: true, demoGeneratedAt: new Date().toISOString() },
    transactions: buildDemoTransactions(members),
    rules: [
      { id: 'demo-rule-glovo', field: 'desc', operator: 'contains', value: 'GLOVO', category: 'delivery', personalFlag: 'comune', enabled: true, createdAt: new Date().toISOString() },
    ],
  };
}
