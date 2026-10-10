# Sample statements

Fictional files in every format homefin imports. All people, accounts, merchants and amounts are invented (household: "Alex Example" and "Sam Example").

| File | Import as | Notes |
| --- | --- | --- |
| `amex-sample.xlsx` | Amex | Two cardholders, one refund, one card-settlement row (auto-excluded) |
| `revolut-sample.csv` | Revolut | Pick any account at import; top-up, pocket transfer and pending rows are skipped/excluded |
| `mp-sample.xlsx` | MP | Joint account → detected as **Shared** when both names are household members |
| `fineco-sample.xlsx` | Fineco | Personal account; salary, card statement and transfer to the other member are excluded |
| `generic-us-bank.csv` | Learn format | Comma CSV, MM/DD/YYYY, separate Debit/Credit columns, a pending row (skipped), payroll (income), transfer to a member (excluded) |
| `generic-de-bank.csv` | Learn format | Semicolon CSV with title rows above the header, DD.MM.YYYY, `1.234,56`, negative = money out, a refund |
| `generic-card.xlsx` | Learn format | Credit card: positive = spend, "Card member" column (owner per row), "05 Sep 2026" dates, a refund and a payment (excluded) |
| `generic-indicator-bank.csv` | Learn format | Amount + DR/CR indicator column, ISO dates |

The `generic-*` files have no built-in importer: use **Profile → Data → Learn format** with any of them to see detection, the live preview and automatic recognition at work.

To match owners, create the household with members named `Alex` and `Sam` (names are matched as whole words, so no keywords are needed). Don't give both members the same keyword: a holder matching two members counts as shared/unmatched.

Regenerate with `npm run samples`; check parsing with `npm run check:samples`.
