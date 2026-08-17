"use client";

import { useEffect, useRef, useState } from "react";

import { DEPLOYMENT, shortAddress } from "@/lib/chain";
import {
  checkEndpoint,
  customEndpoints,
  forgetEndpoint,
  isDefaultEndpoint,
  lcdUrl,
  normaliseUrl,
  useEndpoint,
  type EndpointHealth,
} from "@/lib/endpoint";

import { Alert, Check, Close, Copy, Moon, Spinner, Sun } from "./Icon";
import { Portal } from "./Portal";
import { useTheme } from "./Theme";

/**
 * Settings: which node, and which theme.
 *
 * The endpoint picker is the point. The app is a static export talking to one LCD baked in
 * at build time, so an outage at that node takes the interface down while the protocol
 * carries on. Letting a user point somewhere else is the difference between "the app is
 * broken" and "try another node".
 *
 * Every endpoint is judged by a request, never by being on a list, and the check reports
 * which chain the node actually serves — pointing a pulsar build at a mainnet node is the
 * mistake worth catching loudly rather than letting it fail later as an empty screen.
 */
export function SettingsDialog({ onClose }: { onClose: () => void }) {
  const panel = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    // No scrim to catch an outside click, so listen for one directly — and let it through
    // to whatever it was aimed at, which is the point of not blocking the page.
    const onDown = (e: MouseEvent) => {
      const target = e.target as Node;
      if (!panel.current || panel.current.contains(target)) return;
      if (target instanceof Element && target.closest('[aria-label="Settings"]')) return;
      onClose();
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("mousedown", onDown);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("mousedown", onDown);
    };
  }, [onClose]);

  return (
    <Portal>
      <div className="drawer" ref={panel} role="dialog" aria-label="Settings">
        <div className="drawer-head">
          <h2 className="h2" style={{ flex: 1 }}>
            Settings
          </h2>
          <button className="icon-btn" onClick={onClose} aria-label="Close settings">
            <Close />
          </button>
        </div>
        <div className="drawer-body">
          <SettingsBody />
        </div>
      </div>
    </Portal>
  );
}

/**
 * The settings themselves, without a container.
 *
 * Separated so the account panel can host them: once a wallet is connected, settings live
 * behind the gear in that panel rather than taking a second slot in the bar. They keep
 * their own place in the bar while disconnected, because choosing a node is exactly what
 * somebody needs when nothing is working — including, sometimes, connecting.
 */
export function SettingsBody() {
  const { theme, toggle } = useTheme();
  const [current, setCurrent] = useState("");
  const [known, setKnown] = useState<string[]>([]);
  const [draft, setDraft] = useState("");
  const [health, setHealth] = useState<Record<string, EndpointHealth | "checking">>({});

  useEffect(() => {
    setCurrent(lcdUrl());
    setKnown([DEPLOYMENT.lcdUrl, ...customEndpoints()]);
  }, []);

  const check = async (url: string) => {
    setHealth((h) => ({ ...h, [url]: "checking" }));
    const result = await checkEndpoint(url);
    setHealth((h) => ({ ...h, [url]: result }));
    return result;
  };

  // Measure everything on the list once, so the choice is informed rather than a guess.
  useEffect(() => {
    if (known.length === 0) return;
    void Promise.all(known.map((url) => check(url)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [known.join("|")]);

  const add = async () => {
    const url = normaliseUrl(draft);
    if (!url) {
      setHealth((h) => ({
        ...h,
        __draft: {
          url: draft,
          ok: false,
          latencyMs: null,
          chainId: null,
          height: null,
          error: "That is not a valid https address",
        },
      }));
      return;
    }
    setDraft("");
    setKnown((list) => (list.includes(url) ? list : [...list, url]));
    await check(url);
  };

  const draftError = health.__draft;

  return (
    <>
      <section className="stack" style={{ gap: "var(--s-3)" }}>
        <div className="row">
          <span className="k">Appearance</span>
          <button className="btn btn--quiet btn--sm" onClick={toggle}>
            {theme === "dark" ? <Moon size={14} /> : <Sun size={14} />}
            {theme === "dark" ? "Dark" : "Light"}
          </button>
        </div>
      </section>

      <hr className="divider" />

      <section className="stack" style={{ gap: "var(--s-3)" }}>
        <div>
          <h3 className="h3">Node</h3>
          <p className="hint" style={{ marginTop: 4 }}>
            Reads and transactions go through this endpoint. The contract does not care
            which one you use, so if the default is slow or down, point it elsewhere.
          </p>
        </div>

        <div className="stack" style={{ gap: "var(--s-2)" }}>
          {known.map((url) => (
            <EndpointRow
              key={url}
              url={url}
              isCurrent={url === current}
              isDefault={url === DEPLOYMENT.lcdUrl}
              health={health[url]}
              onUse={() => useEndpoint(url === DEPLOYMENT.lcdUrl ? null : url)}
              onRecheck={() => void check(url)}
              onForget={() => {
                forgetEndpoint(url);
                setKnown((list) => list.filter((u) => u !== url));
              }}
            />
          ))}
        </div>

        <div className="field">
          <label htmlFor="endpoint">Add an endpoint</label>
          <div style={{ display: "flex", gap: "var(--s-2)" }}>
            <input
              id="endpoint"
              className="input"
              placeholder="https://lcd.example.com"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && void add()}
              spellCheck={false}
            />
            <button className="btn btn--quiet btn--sm" onClick={() => void add()}>
              Add
            </button>
          </div>
          {draftError && draftError !== "checking" && (
            <span className="hint" style={{ color: "var(--bad)" }}>
              {draftError.error}
            </span>
          )}
        </div>
      </section>

      <hr className="divider" />

      <section className="stack" style={{ gap: "var(--s-2)" }}>
        <h3 className="h3">Deployment</h3>
        <dl className="stack" style={{ gap: "var(--s-2)", margin: 0 }}>
          <div className="row">
            <dt>Network</dt>
            <dd className="num">{DEPLOYMENT.chainId}</dd>
          </div>
          <CopyRow label="Staking contract" value={DEPLOYMENT.core.address} />
          <CopyRow label="dSCRT token" value={DEPLOYMENT.token.address} />
        </dl>
        {!isDefaultEndpoint() && (
          <p className="hint">
            You are on a custom node. Clear it by choosing the default above.
          </p>
        )}
      </section>
    </>
  );
}

function EndpointRow({
  url,
  isCurrent,
  isDefault,
  health,
  onUse,
  onRecheck,
  onForget,
}: {
  url: string;
  isCurrent: boolean;
  isDefault: boolean;
  health: EndpointHealth | "checking" | undefined;
  onUse: () => void;
  onRecheck: () => void;
  onForget: () => void;
}) {
  const host = (() => {
    try {
      return new URL(url).host;
    } catch {
      return url;
    }
  })();

  return (
    <div
      className="well"
      style={{
        padding: "var(--s-3)",
        borderColor: isCurrent ? "var(--accent)" : undefined,
        display: "flex",
        alignItems: "center",
        gap: "var(--s-3)",
      }}
    >
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: "flex", alignItems: "center", gap: "var(--s-2)" }}>
          <span style={{ fontWeight: 560, fontSize: 13.5 }}>{host}</span>
          {isDefault && <span className="pill">default</span>}
          {isCurrent && (
            <span className="pill pill--accent">
              <Check size={11} /> in use
            </span>
          )}
        </div>
        <div className="hint" style={{ marginTop: 2, display: "flex", gap: 8 }}>
          {health === "checking" || health === undefined ? (
            <span style={{ display: "inline-flex", alignItems: "center", gap: 5 }}>
              <Spinner size={11} /> checking
            </span>
          ) : health.ok ? (
            <>
              <span style={{ color: "var(--good)" }}>{health.latencyMs} ms</span>
              <span>block {health.height?.toLocaleString()}</span>
            </>
          ) : (
            <span
              style={{ color: "var(--bad)", display: "inline-flex", alignItems: "center", gap: 5 }}
            >
              <Alert size={11} /> {health.error}
            </span>
          )}
        </div>
      </div>

      {!isCurrent && (
        <button
          className="btn btn--quiet btn--sm"
          onClick={onUse}
          disabled={health !== "checking" && health !== undefined && !health.ok}
        >
          Use
        </button>
      )}
      {!isCurrent && !isDefault && (
        <button className="icon-btn" onClick={onForget} aria-label={`Remove ${host}`}>
          <Close size={14} />
        </button>
      )}
      {isCurrent && (
        <button className="btn btn--quiet btn--sm" onClick={onRecheck}>
          Recheck
        </button>
      )}
    </div>
  );
}

function CopyRow({ label, value }: { label: string; value: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="row">
      <dt>{label}</dt>
      <dd>
        <button
          className="mini"
          title={value}
          onClick={() => {
            void navigator.clipboard.writeText(value);
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          }}
        >
          {copied ? <Check size={11} /> : <Copy size={11} />} {shortAddress(value)}
        </button>
      </dd>
    </div>
  );
}
