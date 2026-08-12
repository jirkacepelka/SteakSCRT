# Frontend design language

Requested reference: `app.olla.finance/stake` (Aztec liquid staking).

We match the **structural and visual language**, not the branding. Olla's palette and
wordmark are theirs; cloning them would make our app look like an Olla product. What we
take is the layout grammar and the material feel, with our own accent colours.

## What the reference does

Measured from the live page:

| Role | Value |
|---|---|
| Page shell | `#111111`, very dark, edge to edge |
| Primary card | `#F8F7F0` warm cream, `border-radius: 30px` |
| Secondary cards | pastels — `#FFD8F8` pink, `#C8F2F6` cyan |
| Primary action | `#FFB0F1` pink, fully rounded pill, dark magenta `#78175C` text |
| Badge / chip | `#ECEBE5`, `border-radius: 46px` |
| Hairline on dark | `#313131` |
| Accent hairline | `#FE74E2` |
| Type | "Season Sans", falling back to the system sans stack |

Layout is two columns: one tall primary card (~544px) for the action, and a stack of
shorter cards (~340px) beside it for derived figures.

## What we build

Same grammar:

- Dark shell, large warm-cream primary card, pastel secondary cards, pill buttons.
- Generous radii (30px cards, full-round buttons), hairline dividers, no drop shadows.
- Numbers are the loudest thing on the page; labels are small and quiet.

Our palette, chosen to sit next to Secret Network's identity rather than Olla's:

| Token | Light surface | Note |
|---|---|---|
| `--shell` | `#101211` | near-black with a green cast |
| `--card` | `#F7F6F1` | warm cream, unchanged in spirit |
| `--accent` | `#7FE3B0` | Secret's green, used for the primary pill |
| `--accent-ink` | `#0C3B26` | text on the accent pill |
| `--card-yield` | `#DCF6E7` | pale green, the returns card |
| `--card-queue` | `#DDECF6` | pale blue, the withdrawal-queue card |
| `--hairline` | `#2A2E2C` | on dark |

## Screens

**Stake.** Amount input with 25/50/75/Max chips, balance, live conversion to dSCRT, the
exchange rate, and the estimated return card (Daily / Monthly / Yearly toggle).

**Unstake.** Same shape, plus the thing Olla does not have to show and we do: the
withdrawal is batched into a window. The card states plainly which window the request
joins, when that window closes, and the date the SCRT becomes claimable — 21 days at
best, 26 at worst. Hiding that behind an "unstake" button would be the single most
misleading thing this UI could do.

**Portfolio.** dSCRT balance behind a permit, its SCRT value, and a list of pending
claims with their maturity dates and a claim button per matured window.

**Validators.** The set and its weights, published rather than buried. This is the
differentiator against the incumbent, whose set routes 64% to a single operator.

## Non-negotiable copy

The privacy disclaimer from the README appears in the UI, not only in the docs: dSCRT
balances and transfers are private; deposits, withdrawals, the exchange rate and TVL are
public. Users must not infer more privacy than the chain actually gives them.
