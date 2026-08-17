/**
 * The mark for one of the two tokens.
 *
 * Small enough to be a one-liner and still worth its own file: the amount field's symbol
 * flips with the tab, so an icon hard-coded beside it is wrong half the time. Reading the
 * symbol is the only way the two stay in step.
 *
 * Both marks are opaque squares rather than transparent glyphs, so they are clipped to a
 * circle at the point of use — see `.token img`, `.holding img` — which is also what keeps
 * a coin looking like a coin next to a wallet balance.
 */

const MARKS: Record<string, string> = {
  SCRT: "/brand/scrt.png",
  dSCRT: "/brand/dSCRT.png",
};

export function TokenIcon({ symbol, size }: { symbol: string; size: number }) {
  const src = MARKS[symbol] ?? MARKS.SCRT;
  // Decorative: the symbol is always spelled out beside it, so alt text would be read
  // twice by a screen reader and add nothing the second time.
  return <img src={src} alt="" width={size} height={size} />;
}
