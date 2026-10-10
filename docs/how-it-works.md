# How homefin counts money

## Sign convention

- Positive amounts are **spend**; negative amounts are **refunds/credits**.
- Refunds stay in the totals (they reduce spend) unless the row is excluded from cash flow.

## Cash-flow types

Every transaction has one of three types:

- **Expense** — counts as spending (refunds are expenses with a negative amount, so they reduce spending).
- **Income** — money in; shown in the Income tab and in net cash flow, never in spending.
- **Excluded** — stays in the Data table but doesn't count anywhere (internal transfers, card settlements, investments…).

The type is resolved in this order: a manual change in the Data/Income tab → a learned income/not-income decision for similar rows (same merchant signature, source, account and holder) → a categorization rule that sets a cash-flow type → the type set by the importer.

## Cash flow: what counts as spend

Included:

- Card purchases, debit-card payments, direct debits (SDD/SEPA), payments to third parties, cash withdrawals.
- Bank fees, stamp duty and taxes, unless they belong to a securities account.
- Loan instalments.

Excluded automatically:

| Reason | Examples |
| --- | --- |
| `card_payment` | Amex balance settlement, credit-card statement totals debited from a bank account |
| `internal_transfer` | Transfers between accounts owned by household members, top-ups to other banks/brokers, giroconti |
| `income` | Salary, incoming transfers (built-in bank importers exclude them; learned formats can classify them as **Income**) |
| `investment` | Securities purchases/sales, dividends, coupons, broker flows |
| `deposit` / `transfer` / `exchange` / `interest` | Revolut top-ups, transfers and pockets, currency exchanges, interest |
| `zero_amount` | Rows with no amount |

Transfers to your own accounts are recognised by the household members' **names and owner keywords**, so keep those up to date.

## Allocation: who spent it

Every included row has a flag:

- **Personal** — 100% to the row's holder.
- **Shared** — split across household members by the household split (equal or custom percentages, Profile → Household).

Holder rules:

- **Amex:** the holder is the cardholder printed on the statement. Shared/personal is decided only by the flag (rules or manual edits), never by the card.
- **Bank accounts (MP, Fineco):** if the account's holder text matches one member, rows default to *personal* for that member; if it matches two or more, the account is labelled **Shared** and rows default to *shared*.
- **Revolut** and **MP CSV:** you pick the account owner (a member or *Shared*) at import time.
- **Learned formats:** the owner chosen in the format (a member, *Shared*, or per row from the holder column).
- **Shared** is an account label only — never an extra member.
- A holder that matches no member is allocated to the first member and reported under **Data Health → Holders not matched to a member**.

When you filter the dashboard to one member, shared rows show only that member's share.

## Periods

- **Amex period:** 21st of one month to the 20th of the next, labelled by the closing month.
- **Calendar month:** 1st to last day.

Bank and Revolut rows are bucketed by date in either view.

## Categories and rules

A row's category is resolved in this order:

1. Manual override from the Data table.
2. First enabled rule that matches (rules can also set the personal/shared flag).
3. Category stored at import time.
4. Built-in keyword categorizer.
5. *Other*.

Repeating the same manual change (3+ times for a merchant) produces a rule suggestion.
