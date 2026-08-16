import { Alert } from "./Icon";

/**
 * Shown when the build has no deployment to talk to.
 *
 * Names the variables rather than saying "something went wrong": whoever sees this is the
 * person deploying the app, and the fix is entirely in their hands. Without it the first
 * symptom is a JSON parse error, because every query goes to a path that serves the app's
 * own HTML back.
 */
export function Unconfigured() {
  return (
    <div className="centred">
      <div className="card" style={{ width: "min(520px, 100%)", padding: "var(--s-6)" }}>
        <div className="notice notice--warn" style={{ marginBottom: "var(--s-4)" }}>
          <Alert size={16} />
          <span>This build has no contract addresses, so every query would go nowhere.</span>
        </div>
        <p className="prose">
          Set these in the hosting environment and rebuild — they are compiled into the
          bundle, so saving them is not enough on its own.{" "}
          <code>scripts/deploy.mjs</code> prints them ready to paste.
        </p>
        <pre className="payload" style={{ marginTop: "var(--s-4)" }}>
          {[
            "NEXT_PUBLIC_CHAIN_ID",
            "NEXT_PUBLIC_LCD_URL",
            "NEXT_PUBLIC_CORE_ADDRESS",
            "NEXT_PUBLIC_CORE_CODE_HASH",
            "NEXT_PUBLIC_TOKEN_ADDRESS",
            "NEXT_PUBLIC_TOKEN_CODE_HASH",
          ].join("\n")}
        </pre>
      </div>
    </div>
  );
}
