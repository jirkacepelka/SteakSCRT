"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { fromMicro, getPermit, hasPermit, rateToNumber, shortAddress } from "@/lib/chain";
import { fetchScrtBalance, fetchState, fetchTokenBalance } from "@/lib/protocol";

import { ArrowRight, Check, Copy, LogOut, Settings, Spinner } from "./Icon";
import { Portal } from "./Portal";
import { SettingsBody } from "./Settings";
import { TokenIcon } from "./TokenIcon";
import { readable, useToast } from "./Toast";
import { useWallet } from "./Wallet";

/**
 * The account panel.
 *
 * Floats beside the page rather than over it. You open this to check a balance while doing
 * something else, and an overlay that dims the screen would say "deal with me first" —
 * which an account panel has no business saying.
 *
 * What it holds: the address, what you have of each token, and the way out. No fiat
 * figures anywhere. Quoting a dollar value means trusting a price feed this app has no
 * other reason to call, and a wrong one is worse than none — so the position is denominated
 * in SCRT, which is the unit the protocol actually reasons in.
 *
 * SCRT loads on its own because a bank balance is public. dSCRT is private contract state,
 * so it waits behind a button until a permit exists — opening a panel must never make a
 * wallet ask for a signature. Once one is signed the button has nothing left to protect
 * against, and the balance simply loads.
 */
export function AccountDrawer({ onClose }: { onClose: () => void }) {
  const { address, connection, disconnect } = useWallet();
  const toast = useToast();
  const panel = useRef<HTMLDivElement>(null);

  const [scrt, setScrt] = useState<string | null>(null);
  const [dscrt, setDscrt] = useState<string | null>(null);
  const [rate, setRate] = useState(1);
  const [revealing, setRevealing] = useState(false);
  const [copied, setCopied] = useState(false);
  // Settings live behind the gear here rather than in the bar, so the chrome carries one
  // control per session concern instead of two.
  const [view, setView] = useState<"account" | "settings">("account");

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    /*
     * Close on a click elsewhere, without an overlay to catch it. A scrim would swallow
     * that first click; this way it reaches whatever the user was aiming at, which is the
     * whole point of the panel not blocking the page.
     */
    const onDown = (e: MouseEvent) => {
      const target = e.target as Node;
      if (panel.current && !panel.current.contains(target)) {
        // The wallet button itself toggles, so let it handle its own click.
        if (!(target instanceof Element) || !target.closest("[data-account-toggle]")) {
          onClose();
        }
      }
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("mousedown", onDown);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("mousedown", onDown);
    };
  }, [onClose]);

  useEffect(() => {
    if (!connection || !address) return;
    void fetchScrtBalance(connection.client, address).then(setScrt).catch(() => undefined);
    void fetchState()
      .then((s) => setRate(rateToNumber(s.exchange_rate)))
      .catch(() => undefined);
  }, [connection, address]);

  /**
   * Read the private balance.
   *
   * `quiet` is for the automatic attempt. A failure the user asked for is news; the same
   * failure on an attempt they never made is noise, and it would arrive as an error toast
   * over whatever they were actually doing. When the quiet path fails it leaves the button
   * exactly where it was, which is both the honest signal and the way to retry.
   */
  const reveal = useCallback(
    async (quiet = false) => {
      if (!connection || !address) return;
      setRevealing(true);
      try {
        setDscrt(await fetchTokenBalance(connection.client, await getPermit(address)));
      } catch (e) {
        if (!quiet) toast.show("error", readable(e));
      } finally {
        setRevealing(false);
      }
    },
    [connection, address, toast],
  );

  /*
   * Reveal without being asked, once a permit exists.
   *
   * The button is there so that opening this panel never triggers a signature prompt — and
   * with a permit already signed, no prompt is possible. Making somebody click it anyway
   * meant asking permission that had already been given, on every reload, for a query that
   * costs nothing.
   *
   * Guarded per address rather than left to the effect's dependencies: a re-render must not
   * turn one balance query into several.
   */
  const autoRevealed = useRef<string | null>(null);
  useEffect(() => {
    if (!connection || !address) return;
    if (!hasPermit(address)) return;
    if (autoRevealed.current === address) return;
    autoRevealed.current = address;
    void reveal(true);
  }, [connection, address, reveal]);

  if (!address) return null;

  const totalScrt =
    scrt !== null && dscrt !== null ? Number(scrt) + Number(dscrt) * rate : null;

  return (
    <Portal>
      <div className="drawer" ref={panel} role="dialog" aria-label="Account">
        <div className="drawer-head">
          {view === "settings" && (
            <button
              className="icon-btn"
              onClick={() => setView("account")}
              aria-label="Back to account"
              title="Back"
              style={{ transform: "rotate(180deg)" }}
            >
              <ArrowRight size={16} />
            </button>
          )}
          <button
            className="addr"
            onClick={() => {
              void navigator.clipboard.writeText(address);
              setCopied(true);
              setTimeout(() => setCopied(false), 1500);
            }}
            title="Copy address"
          >
            <img src="/brand/scrt.png" alt="" width={22} height={22} />
            <span style={{ flex: 1, textAlign: "left" }}>{shortAddress(address)}</span>
            {copied ? <Check size={14} /> : <Copy size={14} />}
          </button>
          <button
            className="icon-btn"
            onClick={() => setView((v) => (v === "settings" ? "account" : "settings"))}
            aria-label="Settings"
            title="Settings"
            aria-pressed={view === "settings"}
            style={view === "settings" ? { color: "var(--accent)", borderColor: "var(--accent)" } : undefined}
          >
            <Settings size={16} />
          </button>
          <button
            className="icon-btn"
            onClick={() => {
              disconnect();
              onClose();
            }}
            aria-label="Disconnect"
            title="Disconnect"
          >
            <LogOut size={16} />
          </button>
        </div>

        <div className="drawer-body">
          {view === "settings" ? (
            <SettingsBody />
          ) : (
            <>

          <div>
            <p className="stat-label" style={{ marginBottom: 4 }}>
              Total
            </p>
            <div className="stat-value num">
              {totalScrt !== null ? (
                <>
                  {fromMicro(totalScrt, 2)}
                  <span className="stat-unit">SCRT</span>
                </>
              ) : scrt !== null ? (
                <>
                  {fromMicro(scrt, 2)}
                  <span className="stat-unit">SCRT</span>
                </>
              ) : (
                <span className="skel" style={{ width: 120, height: 24 }} />
              )}
            </div>
            {totalScrt === null && scrt !== null && (
              <p className="hint" style={{ marginTop: 4 }}>
                Your staked position is not counted until you reveal it below.
              </p>
            )}
          </div>

          <div>
            <p className="stat-label" style={{ marginBottom: "var(--s-2)" }}>
              Holdings
            </p>

            <div className="holding">
              <TokenIcon symbol="SCRT" size={30} />
              <span className="holding-name">
                <strong>SCRT</strong>
                <span className="hint">Liquid, in your wallet</span>
              </span>
              <span className="holding-value">
                <span className="num" style={{ fontWeight: 560 }}>
                  {scrt !== null ? fromMicro(scrt) : <span className="skel" style={{ width: 60, height: 14 }} />}
                </span>
              </span>
            </div>

            <div className="holding">
              <TokenIcon symbol="dSCRT" size={30} />
              <span className="holding-name">
                <strong>dSCRT</strong>
                <span className="hint">Staked, earning</span>
              </span>
              <span className="holding-value">
                {dscrt !== null ? (
                  <>
                    <span className="num" style={{ fontWeight: 560 }}>
                      {fromMicro(dscrt)}
                    </span>
                    <span className="hint num">≈ {fromMicro(Number(dscrt) * rate, 2)} SCRT</span>
                  </>
                ) : (
                  <button
                    className="mini"
                    // Wrapped, not `onClick={reveal}` — that hands the click event in as
                    // `quiet` and silences the very errors this click is asking to see.
                    onClick={() => void reveal()}
                    disabled={revealing}
                  >
                    {revealing ? <Spinner size={11} /> : null} Reveal
                  </button>
                )}
              </span>
            </div>
          </div>

              <p className="hint" style={{ marginTop: "auto" }}>
                Your dSCRT balance is private contract state. Revealing it costs a
                signature, not a transaction — and the signature stays in this browser.
              </p>
            </>
          )}
        </div>
      </div>
    </Portal>
  );
}
