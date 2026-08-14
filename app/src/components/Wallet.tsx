"use client";

import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from "react";

import { connect, shortAddress, type Connection } from "@/lib/chain";

interface WalletState {
  connection: Connection | null;
  address: string | null;
  connecting: boolean;
  error: string | null;
  connectWallet: () => Promise<void>;
}

const WalletContext = createContext<WalletState | null>(null);

export function WalletProvider({ children }: { children: ReactNode }) {
  const [connection, setConnection] = useState<Connection | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const connectWallet = useCallback(async () => {
    setConnecting(true);
    setError(null);
    try {
      setConnection(await connect());
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setConnecting(false);
    }
  }, []);

  const value = useMemo(
    () => ({
      connection,
      address: connection?.address ?? null,
      connecting,
      error,
      connectWallet,
    }),
    [connection, connecting, error, connectWallet],
  );

  return <WalletContext.Provider value={value}>{children}</WalletContext.Provider>;
}

export function useWallet(): WalletState {
  const ctx = useContext(WalletContext);
  if (!ctx) throw new Error("useWallet must be used inside WalletProvider");
  return ctx;
}

export function ConnectButton() {
  const { address, connecting, connectWallet, error } = useWallet();

  if (address) {
    return (
      <span className="pill pill--live" title={address}>
        {shortAddress(address)}
      </span>
    );
  }

  return (
    <button
      className="btn btn--sm"
      onClick={connectWallet}
      disabled={connecting}
      title={error ?? undefined}
    >
      {connecting ? "Connecting…" : "Connect"}
    </button>
  );
}
