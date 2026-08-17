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

import { AccountDrawer } from "./Account";
import { Spinner, Wallet as WalletIcon } from "./Icon";
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
  const { address, connecting, connectWallet } = useWallet();
  const [open, setOpen] = useState(false);

  if (!address) {
    return (
      <button className="btn btn--sm" onClick={connectWallet} disabled={connecting}>
        {connecting ? <Spinner size={14} /> : <WalletIcon size={14} />}
        {connecting ? "Connecting" : "Connect"}
      </button>
    );
  }

  return (
    <>
      <button
        className="btn btn--quiet btn--sm"
        data-account-toggle
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
      >
        <span className="dot" style={{ color: "var(--good)" }} />
        <span className="num">{shortAddress(address)}</span>
      </button>
      {open && <AccountDrawer onClose={() => setOpen(false)} />}
    </>
  );
}
