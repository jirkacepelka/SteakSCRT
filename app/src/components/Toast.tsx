"use client";

import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from "react";

import { Alert, Check, Close, Spinner } from "./Icon";

/**
 * Transient feedback, out of the way of the form.
 *
 * The previous build printed status text inside the card, which pushed the button around
 * mid-transaction and left an error sitting where the next amount was about to be typed.
 * Toasts keep the card still. Anything that is a lasting condition rather than an event —
 * a stale cache, a missing permit — stays inline where it belongs; this is only for "that
 * worked" and "that did not".
 */

export type ToastKind = "pending" | "ok" | "error";

interface Toast {
  id: number;
  kind: ToastKind;
  message: string;
}

interface ToastApi {
  /** Show a toast. Returns its id so a pending one can be resolved in place. */
  show: (kind: ToastKind, message: string) => number;
  resolve: (id: number, kind: ToastKind, message: string) => void;
  dismiss: (id: number) => void;
}

const Ctx = createContext<ToastApi | null>(null);

/** How long each kind stays. Errors wait to be read; successes do not need to. */
const LIFETIME: Record<ToastKind, number | null> = {
  pending: null,
  ok: 5_000,
  error: 12_000,
};

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);

  const dismiss = useCallback((id: number) => {
    setToasts((all) => all.filter((t) => t.id !== id));
  }, []);

  const schedule = useCallback(
    (id: number, kind: ToastKind) => {
      const ms = LIFETIME[kind];
      if (ms !== null) setTimeout(() => dismiss(id), ms);
    },
    [dismiss],
  );

  const show = useCallback(
    (kind: ToastKind, message: string) => {
      const id = Date.now() + Math.random();
      setToasts((all) => [...all, { id, kind, message }]);
      schedule(id, kind);
      return id;
    },
    [schedule],
  );

  const resolve = useCallback(
    (id: number, kind: ToastKind, message: string) => {
      setToasts((all) => all.map((t) => (t.id === id ? { ...t, kind, message } : t)));
      schedule(id, kind);
    },
    [schedule],
  );

  const api = useMemo(() => ({ show, resolve, dismiss }), [show, resolve, dismiss]);

  return (
    <Ctx.Provider value={api}>
      {children}
      <div className="toasts" role="status" aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} className="toast">
            <span
              style={{
                color:
                  t.kind === "ok"
                    ? "var(--good)"
                    : t.kind === "error"
                      ? "var(--bad)"
                      : "var(--ink-3)",
                display: "flex",
                marginTop: 1,
              }}
            >
              {t.kind === "pending" ? <Spinner /> : t.kind === "ok" ? <Check /> : <Alert />}
            </span>
            <div className="toast-body">{t.message}</div>
            <button className="toast-close" onClick={() => dismiss(t.id)} aria-label="Dismiss">
              <Close size={14} />
            </button>
          </div>
        ))}
      </div>
    </Ctx.Provider>
  );
}

export function useToast(): ToastApi {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useToast must be used inside ToastProvider");
  return ctx;
}

/**
 * Turn a thrown chain error into something a person can act on.
 *
 * Node errors arrive as a wall of JSON with the useful sentence buried in the middle, and
 * a user who sees that assumes the app is broken rather than that they were, say, out of
 * gas.
 */
export function readable(error: unknown): string {
  const raw = describe(error);

  if (/request rejected|user denied|rejected by the user/i.test(raw)) {
    return "You rejected the request in your wallet.";
  }
  if (/insufficient funds|insufficient fee/i.test(raw)) {
    return "Not enough SCRT to cover the transaction fee.";
  }
  if (/out of gas/i.test(raw)) {
    return "The transaction ran out of gas. Please report this — the limit should cover it.";
  }
  if (/above the .* ceiling/i.test(raw)) {
    return "The protocol is at its deposit ceiling. It reopens as people withdraw.";
  }
  if (/below the minimum/i.test(raw)) {
    return "That is below the minimum deposit.";
  }
  if (/deposits are paused/i.test(raw)) {
    return "Deposits are paused. Withdrawals and claims are unaffected.";
  }
  if (/nothing to claim/i.test(raw)) {
    return "There is nothing to claim yet.";
  }
  if (/has not matured/i.test(raw)) {
    return "That window has not finished unbonding yet.";
  }
  if (/Failed to fetch|NetworkError|ECONNREFUSED/i.test(raw)) {
    return "Could not reach the node. Try another endpoint in settings.";
  }

  // Contracts put their reason in `encrypted:` or after the last colon; take the tail
  // rather than the framing.
  const tail = raw.split("failed to execute message").pop() ?? raw;
  return tail.length > 220 ? `${tail.slice(0, 220)}…` : tail.trim();
}

/**
 * Get a string out of whatever was thrown.
 *
 * `String(error)` on a plain object gives `[object Object]`, and that is what a user saw:
 * a toast saying nothing at all. Not everything that reaches here is an `Error` — secret.js
 * rejects with bare objects, and a failed decryption throws something with neither a name
 * nor a message — so this digs for the fields those things actually carry before falling
 * back to serialising the whole thing, which is ugly but is never nothing.
 */
function describe(error: unknown): string {
  if (typeof error === "string") return error;
  if (error instanceof Error) return error.message;

  if (error && typeof error === "object") {
    const bag = error as Record<string, unknown>;
    for (const key of ["message", "rawLog", "raw_log", "error", "reason", "details"]) {
      const value = bag[key];
      if (typeof value === "string" && value.trim()) return value;
    }
    try {
      const json = JSON.stringify(error);
      if (json && json !== "{}") return json;
    } catch {
      // Circular, or something exotic. Fall through.
    }
  }

  return "Something went wrong, and whatever threw it said nothing useful.";
}
