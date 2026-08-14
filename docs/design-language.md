# Frontend design language

The design is the user's own, drawn in Penpot and read out of the exported file rather
than approximated from a screenshot. This document records what the file specifies, so a
later change to the app can be checked against the design instead of against taste.

Source: `Untitled (3).penpot`, read with the `penpot-files` skill (`tokens`, then
`context` per page). Everything below is transcribed from it; the *reasoning* is ours.

## Tokens

Transcribed into `app/src/app/globals.css` as custom properties.

| Token | Value | Role |
|---|---|---|
| `--bg` | `#0a0a0a` | page ground |
| `--panel` | `#121212` | the one opaque surface — tooltips, code blocks, select menus |
| `--surface-1` | `rgba(255,255,255,.05)` | panels and stat tiles |
| `--surface-2` | `rgba(255,255,255,.10)` | inputs, chips, the nav bar |
| `--hairline` | `rgba(255,255,255,.12)` | rules and table borders |
| `--ink` / `--ink-quiet` / `--ink-faint` | `#fff` / white 55% / white 35% | three levels of text |
| `--accent` | `#81d0eb` | every action, and every data mark |
| `--accent-ink` | `#0a0a0a` | text on the accent |
| `--good` / `--warn` / `--bad` | `#7fdca4` / `#e8c07d` / `#ef8b7b` | state only, never a data series |
| `--r-lg` / `--r-md` / `--r-pill` | `15px` / `10px` / `1000px` | the three radii in the file |
| `--shell-w` | `1000px` | content column |

Type is **Geist**, 700 for anything structural, tabular numerals wherever a figure could
be compared to the one above it (`.numeral`).

Surfaces are white at 5% and 10% over near-black rather than three separate greys. Panels
therefore read as depth rather than as boxes, and a panel nested in a panel still works —
which is what lets the staking form and the withdrawal table sit in the same column
without a border between them.

## Structure

Nav bar (`--surface-2`, `--r-lg`) holding the wordmark and three tabs — **Staking**,
**Statistics**, **Governance** — with the active one underlined in the accent rather than
filled. Below it a `--shell-w` column, mostly a two-up grid that collapses to one at
820px.

Three tabs is the whole app. An earlier build had Portfolio and Validators as separate
pages; the design has neither, so claims fold into the staking page beside the form (you
look at them for the same reason you came) and the validator set moved to Statistics
(you look at it to judge the protocol, not to act).

## Colour in the charts

One accent, no categorical palette. A line chart with a single series needs no legend —
the panel heading names it — and the validator bars carry identity in the label beside
each bar. Introducing a second hue would mean inventing a categorical ramp that has to
survive a colourblindness check, to encode something the labels already encode.

`--good`/`--warn`/`--bad` stay reserved for state: a stale-totals warning, a claim that
is ready. If one of them ever appears in a chart, the chart is wrong.

## Screens

**Staking.** Stake/Unstake segmented toggle, amount field with 25/50/75/Max chips,
balance, live conversion, exchange rate and fee. Beside it: when a withdrawal requested
now would actually pay out, the user's own claims (behind a permit), and the privacy note.

The maturity panel is stated on the screen rather than in a tooltip. Someone pressing
"unstake" expecting a swap, and finding their money gone for three weeks, has been misled
by the interface rather than by the chain — so the window it joins, the date it closes,
and the date it becomes claimable are all on the page before they sign.

**Statistics.** TVL, exchange rate, an APY *observed from the rate's own history* rather
than quoted from the nominal staking APR, and supply. Then a TVL chart and a rate chart,
both replayed from the chain at past block heights (`app/src/lib/history.ts`) because the
contract stores no history and we did not want an indexer. Then validator distribution
against the 25% ceiling, the withdrawal queue, and the protocol parameters.

TVL is SCRT-denominated only. A USD line would move with the SCRT price and read as
protocol growth, which it is not.

**Governance.** One toggle, **Onchain | Governor**, because the page serves two audiences.
Onchain builds the proposal JSON a voter submits; Governor is the manager's console —
weights, rebalance, fee, pause — and shows who the manager is even when you are not them.

## Non-negotiable copy

The privacy disclaimer appears in the UI, not only in the docs: dSCRT balances and
transfers are private; deposits, withdrawals, the exchange rate and TVL are public.
Users must not infer more privacy than the chain actually gives them.
