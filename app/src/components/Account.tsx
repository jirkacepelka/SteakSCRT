"use client";

import { useEffect, useState } from "react";

import { DENOM, fromMicro, getPermit, shortAddress } from "@/lib/chain";
import { fetchScrtBalance, fetchTokenBalance } from "@/lib/protocol";

import { Check, Close, Copy, Spinner } from "./Icon";
import { readable, useToast } from "./Toast";
import { useWallet } from "./Wallet";

/**
 * The account panel.
 *
 * What a wallet button should open: the address, what you hold, and the way out. The
 * dropdown it replaces had the address and a disconnect and nothing else, which meant the
 * one question people actually click a wallet to answer — how much have I got — was
 * answered nowhere.
 *
 * SCRT is a public bank balance and loads on its own. dSCRT is private contract state and
 * needs a signature, so it is offered rather than taken: opening this panel must never
 * make a wallet ask for anything.
 */
export function AccountDialog({ onClose }: { onClose: () => void }) {
  const { address, disconnect } = useWallet();
  const toast = useToast();

  const [scrt, setScrt] = useState<string | null>(null);
  const [dscrt, setDscrt] = useState<string | null>(null);
  const [loadingDscrt, setLoadingDscrt] = useState(false);
  const [copied, setCopied] = useState(false);
  const { connection } = useWallet();

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  useEffect(() => {
    if (!connection || !address) return;
    void fetchScrtBalance(connection.client, address)
      .then(setScrt)
      .catch(() => undefined);
  }, [connection, address]);

  const revealDscrt = async () => {
    if (!connection || !address) return;
    setLoadingDscrt(true);
    try {
      setDscrt(await fetchTokenBalance(connection.client, await getPermit(address)));
    } catch (e) {
      toast.show("error", readable(e));
    } finally {
      setLoadingDscrt(false);
    }
  };

  if (!address) return null;

  return (
    <div className="scrim" onClick={onClose}>
      <div
        className="dialog"
        role="dialog"
        aria-modal="true"
        aria-label="Account"
        style={{ maxWidth: 400 }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="dialog-head">
          <span className="pill pill--good">
            <span className="dot" />
            Connected
          </span>
          <button className="icon-btn" onClick={onClose} aria-label="Close">
            <Close />
          </button>
        </div>

        <div className="dialog-body">
          <button
            className="btn btn--ghost"
            style={{ justifyContent: "space-between", fontFamily: "var(--font-mono)" }}
            onClick={() => {
              void navigator.clipboard.writeText(address);
              setCopied(true);
              setTimeout(() => setCopied(false), 1500);
            }}
          >
            <span style={{ fontSize: 13 }}>{shortAddress(address)}</span>
            {copied ? <Check size={15} /> : <Copy size={15} />}
          </button>

          <div className="stack" style={{ gap: "var(--s-3)" }}>
            <div className="row">
              <span className="k">SCRT</span>
              <span className="v num">
                {scrt !== null ? fromMicro(scrt) : <span className="skel" style={{ width: 70, height: 14 }} />}
              </span>
            </div>
            <div className="row">
              <span className="k">dSCRT</span>
              <span className="v num">
                {dscrt !== null ? (
                  fromMicro(dscrt)
                ) : (
                  <button className="mini" onClick={revealDscrt} disabled={loadingDscrt}>
                    {loadingDscrt ? <Spinner size={11} /> : null} Sign to reveal
                  </button>
                )}
              </span>
            </div>
          </div>

          <p className="hint">
            Your dSCRT balance is private contract state. Reading it needs a signature —
            free, and not a transaction — which is why it is not shown automatically.
          </p>

          <button
            className="btn btn--ghost"
            onClick={() => {
              disconnect();
              onClose();
            }}
          >
            Disconnect
          </button>

          <p className="hint">
            Drops this session and the cached permit from your browser. Keplr decides what it
            shares with a site, so nothing here can revoke its access.
          </p>
        </div>
      </div>
    </div>
  );
}

export { DENOM };
