# Deploying the frontend

The app is a static export with no server. Every read is a contract query and every write is
signed in the user's wallet, so the built output can be served from Vercel, any static host,
or IPFS. Nothing about it is privileged, and hosting it grants the host no power over the
protocol.

## Vercel

Import the repository, then set:

| Setting | Value |
|---|---|
| Root Directory | `app` |
| Framework | Next.js (detected) |
| Build command | default |
| Output directory | **leave empty** |

Leave the output directory alone even though the build really does write to `app/out`.
Vercel understands `output: "export"` natively: it runs the Next.js builder, reads
`.next` for the route manifest, and serves the exported files itself. Pointing it at `out`
instead makes it look for `routes-manifest.json` in a directory that only ever holds
static HTML, and the deploy fails with *"The file `app/out/routes-manifest.json` couldn't
be found"* — a build that succeeded, rejected at the publish step.

Then add the environment variables below for every environment you want to build. They are
all `NEXT_PUBLIC_*` and end up in the bundle — that is intended. A contract address is not a
secret, and the deployment they point at is public on chain.

`scripts/deploy.mjs` prints this block ready to paste after a deploy:

```
NEXT_PUBLIC_CHAIN_ID=pulsar-3
NEXT_PUBLIC_LCD_URL=https://pulsar.lcd.secretnodes.com
NEXT_PUBLIC_CORE_ADDRESS=secret1...
NEXT_PUBLIC_CORE_CODE_HASH=...
NEXT_PUBLIC_TOKEN_ADDRESS=secret1...
NEXT_PUBLIC_TOKEN_CODE_HASH=...
```

Point Preview deployments at pulsar-3 and Production at mainnet, and a mistake in a preview
cannot touch real funds.

### Root Directory matters

The repository is a workspace: the contracts, keeper and tests share its root. Building from
the root would try to build all of it. Setting Root Directory to `app` makes Vercel install
and build only the frontend.

## Anywhere else

```bash
npm --prefix app run build
```

Serve `app/out`. It is plain files — no Node runtime, no rewrites, no server.

## Two things that only break in a browser

Worth knowing before changing the app, because neither shows up in `tsc` or in tests:

**`Buffer` does not exist.** It is a Node API and Next does not polyfill it. Encoding the
withdrawal hook with `Buffer.from(...).toString("base64")` typechecked, passed every test,
and threw `Buffer is not defined` for any user who tried to withdraw. Use `toBase64` from
`src/lib/chain.ts`.

**Keplr is injected, not imported.** Anything touching `window.keplr` has to run in a client
component and after mount. The static export renders every page at build time, where no
wallet exists.
