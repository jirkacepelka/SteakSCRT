# Frontend design language

The design is the user's own. It is read out of Figma through the Figma MCP rather than
approximated from a screenshot, so the values below are transcribed rather than guessed.
When this document and the file disagree, the file is right.

Source: `6VEnNk41i5lNXbXKwF0no4`, frames `14:55` (staking), `15:231` (governance) and
`15:284` (the proposal modal). An earlier Penpot export of the same design was less
complete — it had no proposal list and no modal — so Figma is the reference now.

## Tokens

Transcribed into `app/src/app/globals.css`.

| Token | Value | Role |
|---|---|---|
| `--bg` | `#0a0a0a` | page ground, and the modal |
| `--panel` | `#121212` | proposal cards, tooltips, code blocks |
| `--surface-1` | `rgba(255,255,255,.05)` | panels, chips, the segmented track |
| `--surface-2` | `rgba(255,255,255,.10)` | the nav bar, inputs, the token pill |
| `--ink` / `--ink-quiet` | `#fff` / white 60% | chrome ink — nav, headings, field labels |
| `--ink-warm` / `--ink-warm-quiet` | `#f2eee1` / 60% | card ink — amounts, rows, notes |
| `--accent` | `#81d0eb` | every action, and every data mark |
| `--accent-quiet` | accent at 60% | the version in the footer, and nothing else |
| `--accent-ink` | `#000` | text on the accent |
| `--r-xl` … `--r-pill` | `20 / 15 / 10 / 1000px` | the four radii in the file |
| `--nav-w` / `--shell-w` / `--card-w` | `825 / 1000 / 540px` | the three widths |

**Two ink families.** The chrome is pure white; everything inside a card is warm off-white
`#f2eee1`. The warmth is what keeps a near-black page from reading as a terminal, and it is
the detail most easily lost when transcribing by eye.

**Two typefaces**, both loaded by `next/font` in `app/src/app/layout.tsx`: **Geist** for the
chrome (nav, headings, buttons, footer, field labels) and **Inter** for card contents. They
were previously named in CSS but never actually loaded, so every screen silently fell back
to the system sans — which was most of why the built app did not look like the file.

## Structure

A full-height column: nav, content, footer. The nav is 825px and the content 1000px, both
centred — the bar is deliberately narrower than what it sits above.

The staking screen is **one 540px card, centred in the viewport**, with no second column.
Centring is done with `margin-block: auto` rather than `justify-content: center`, because
auto margins collapse when the content outgrows the space instead of clipping its top out
of reach.

Claims live at the foot of the **Unstake** tab: you read them after requesting a withdrawal,
which is the only moment they matter, and the design has no side rail to put them in.

## Assets

Both marks are exports, not redraws.

- `app/public/brand/steak.svg` — the wordmark's icon, 30×30, stroked in the accent.
- `app/public/brand/scrt.png` — the SCRT mark, rendered at 30×30 in a pill.

One mark serves both SCRT and dSCRT: the derivative is a claim on SCRT, not a separate
asset, and inventing a second logo would suggest otherwise.

## Colour in the charts

One accent, no categorical palette. A line chart with a single series needs no legend — the
panel heading names it — and the validator bars carry identity in the label beside each bar.
A second hue would mean inventing a categorical ramp that has to survive a colourblindness
check, to encode something the labels already encode.

`--good`/`--warn`/`--bad` stay reserved for state. If one appears in a chart, the chart is
wrong.

## Screens

**Staking.** Stake/Unstake toggle, amount field with the token pill, balance, 25/50/75/Max
chips, then the rows: what you receive, the rate, the fee, and — on Unstake — the date the
SCRT becomes claimable. That date is on the screen rather than in a tooltip: someone
pressing "unstake" expecting a swap, and finding their money gone for three weeks, has been
misled by the interface rather than by the chain.

Where the design shows a fiat value under the amount, the app shows the wallet balance. A
USD figure would need a price oracle the app has no other reason to call.

**Statistics.** TVL, exchange rate, an APY *observed from the rate's own history* rather
than quoted from the nominal staking APR, and supply — then a TVL chart, a rate chart,
validator distribution against the 25% ceiling, the withdrawal queue, and the parameters.
TVL is SCRT-denominated only; a USD line would move with the price and read as growth.

**Governance.** One toggle, **Onchain | Governor**.

*Onchain* lists real proposals read from the LCD, filtered to those that would migrate one
of this protocol's contracts — including proposals that bundle ours with somebody else's,
which is the case a holder must not miss. "Explore" expands the proposal inline rather than
linking to an explorer, so what you read is what the chain would execute.

*Governor* is the manager's console — weights, rebalance, fee, pause — showing who the
manager is even when you are not them.

**Make proposal** is the modal from the file. The design left its payload field open with a
note asking what belongs there; the answer is a **code id**, because a proposal cannot carry
a binary. The reviewed wasm is uploaded first with `secretd tx compute store` and the vote
approves the number that returns. The modal builds `proposal.json` and hands over the
command; it does not sign. Submitting locks a 1000 SCRT deposit, and a wallet route for a
message type this app cannot test against a real vote is not worth that risk to the user.

## Non-negotiable copy

The privacy disclaimer appears in the UI, not only in the docs: dSCRT balances and transfers
are private; deposits, withdrawals, the exchange rate and TVL are public. Users must not
infer more privacy than the chain actually gives them.
