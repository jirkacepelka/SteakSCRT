/**
 * Shown when the build has no deployment to talk to.
 *
 * Named variables rather than a generic "something went wrong": whoever sees this is the
 * person deploying the app, and the fix is entirely in their hands.
 */
export function Unconfigured() {
  return (
    <div className="panel" style={{ maxWidth: 540, margin: "0 auto" }}>
      <p className="h2">No deployment configured</p>
      <p className="note">
        This build has no contract addresses, so every query would go nowhere. Set these in
        the hosting environment and rebuild — <code>scripts/deploy.mjs</code> prints them
        ready to paste after a deploy.
      </p>
      <pre className="payload" style={{ marginTop: 14 }}>
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
  );
}
