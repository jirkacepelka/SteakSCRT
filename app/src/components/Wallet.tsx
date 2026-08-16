"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";

import { connect, forgetPermit, shortAddress, type Connection } from "@/lib/chain";

import { Check, Copy, Spinner, Wallet as WalletIcon } from "./Icon";
import { useToast, readable } from "./Toast";

interface WalletState {
  connection: Connection | null;
  address: string | null;
  connecting: boolean;
  connectWallet: () => Promise<void>;
  disconnect: () => void;
}

const WalletContext = createContext<WalletState | null>(null);

export function WalletProvider({ children }: { children: ReactNode }) {
  const [connection, setConnection] = useState<Connection | null>(null);
  const [connecting, setConnecting] = useState(false);
  const toast = useToast();

  const connectWallet = useCallback(async () => {
    setConnecting(true);
    try {
      setConnection(await connect());
    } catch (e) {
      toast.show("error", readable(e));
    } finally {
      setConnecting(false);
    }
  }, [toast]);

  /**
   * Forget the session.
   *
   * There is no such thing as disconnecting from Keplr — the extension decides what it
   * shares. What this does is drop the connection this tab holds and delete the cached
   * permit, which is the part that actually reads the user's private balances. Saying
   * "disconnect" and leaving that permit in storage would be a lie.
   */
  const disconnect = useCallback(() => {
    if (connection) forgetPermit(connection.address);
    setConnection(null);
  }, [connection]);

  // Keplr fires this when the user switches account in the extension. Without it the app
  // would keep showing the old address and quietly query the wrong position.
  useEffect(() => {
    const onChange = () => {
      if (connection) void connectWallet();
    };
    window.addEventListener("keplr_keystorechange", onChange);
    return () => window.removeEventListener("keplr_keystorechange", onChange);
  }, [connection, connectWallet]);

  const value = useMemo(
    () => ({
      connection,
      address: connection?.address ?? null,
      connecting,
      connectWallet,
      disconnect,
    }),
    [connection, connecting, connectWallet, disconnect],
  );

  return <WalletContext.Provider value={value}>{children}</WalletContext.Provider>;
}

export function useWallet(): WalletState {
  const ctx = useContext(WalletContext);
  if (!ctx) throw new Error("useWallet must be used inside WalletProvider");
  return ctx;
}

export function ConnectButton() {
  const { address, connecting, connectWallet, disconnect } = useWallet();
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);

  if (!address) {
    return (
      <button className="btn btn--sm" onClick={connectWallet} disabled={connecting}>
        {connecting ? <Spinner size={14} /> : <WalletIcon size={14} />}
        {connecting ? "Connecting" : "Connect"}
      </button>
    );
  }

  return (
    <div style={{ position: "relative" }}>
      <button
        className="btn btn--quiet btn--sm"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
      >
        <span className="dot" style={{ color: "var(--good)" }} />
        <span className="num">{shortAddress(address)}</span>
      </button>

      {open && (
        <>
          <div
            style={{ position: "fixed", inset: 0, zIndex: 40 }}
            onClick={() => setOpen(false)}
          />
          <div
            className="card"
            style={{
              position: "absolute",
              right: 0,
              top: "calc(100% + 8px)",
              zIndex: 41,
              padding: "var(--s-3)",
              width: 260,
              display: "flex",
              flexDirection: "column",
              gap: "var(--s-2)",
            }}
          >
            <button
              className="btn btn--ghost btn--sm"
              style={{ justifyContent: "space-between" }}
              onClick={() => {
                void navigator.clipboard.writeText(address);
                setCopied(true);
                setTimeout(() => setCopied(false), 1500);
              }}
            >
              <span className="num" style={{ fontSize: 12.5 }}>
                {shortAddress(address)}
              </span>
              {copied ? <Check size={14} /> : <Copy size={14} />}
            </button>
            <button
              className="btn btn--ghost btn--sm"
              onClick={() => {
                disconnect();
                setOpen(false);
              }}
            >
              Forget this session
            </button>
            <p className="hint" style={{ margin: 0 }}>
              Drops the cached permit from this browser. Keplr decides what it shares with a
              site, so this cannot revoke its access.
            </p>
          </div>
        </>
      )}
    </div>
  );
}
