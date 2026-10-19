# gsc-mcp-ts

A [Model Context Protocol](https://modelcontextprotocol.io) server for **Google Search Console**, written in TypeScript on [Hono](https://hono.dev). It is a port of [mcp-gsc](https://github.com/AminForou/mcp-gsc) by Amin Foroutan, with 21 tools covering properties, search analytics, URL inspection, and sitemaps.

It runs in three places from one codebase:

| Entrypoint | File | Transport | Typical use |
|---|---|---|---|
| Cloudflare Workers | `src/index.ts` | Streamable HTTP at `/mcp` | Remote deployment behind Cloudflare Access |
| Node | `src/node.ts` | Streamable HTTP at `/mcp` | Self-hosting, Docker, local HTTP testing |
| stdio | `src/stdio.ts` | stdio | Desktop MCP clients on your own machine |

Search Console access uses a Google OAuth refresh token for a single Google account per deployment. On Workers you can authorize Google **from the deployed Worker itself** (`/auth/google`). No local tooling or copied tokens are needed.

## Contents

- [Deploy to Cloudflare Workers](#deploy-to-cloudflare-workers)
- [Authorizing Google inside the Worker](#authorizing-google-inside-the-worker)
- [Running on Node or stdio](#running-on-node-or-stdio)
- [Client configuration](#client-configuration)
- [Environment variables](#environment-variables)
- [Tools and scope tiers](#tools-and-scope-tiers)
- [Development](#development)

## Deploy to Cloudflare Workers

You need:

- a Cloudflare account with a zone (domain) for the Worker's hostname,
- Cloudflare Zero Trust (the free plan is enough) for Cloudflare Access,
- a Google Cloud project with the **Google Search Console API** enabled.

### 1. Create the Google OAuth client

In Google Cloud Console, go to **APIs & Services → Credentials → Create credentials → OAuth client ID**:

- Application type: **Web application**. A *Desktop* client cannot be used here because it does not accept an `https://` redirect URI.
- Authorized redirect URI: `https://<your-host>/auth/google/callback`, for example `https://gsc-mcp.example.com/auth/google/callback`.

On the **OAuth consent screen**, add the scope `https://www.googleapis.com/auth/webmasters.readonly` (or `.../auth/webmasters` for the full tier). Then publish the app **In production**: refresh tokens issued while it is in *Testing* expire after 7 days.

### 2. Configure `wrangler.jsonc`

[`wrangler.jsonc`](wrangler.jsonc) is a working template. Replace every `REPLACE_ME` value:

| Field | Value |
|---|---|
| `routes[0].pattern` | Your hostname, e.g. `gsc-mcp.example.com` (`custom_domain: true` creates the DNS record) |
| `kv_namespaces[0].id` | Output of `npx wrangler kv namespace create GSC_TOKENS` |
| `vars.MCP_ALLOWED_HOSTS` | The same hostname |
| `vars.CF_ACCESS_TEAM_DOMAIN` | `https://<team>.cloudflareaccess.com` |
| `vars.CF_ACCESS_AUD` | The Access application's AUD tag (step 4) |
| `vars.GSC_SCOPES` | `readonly` (default) or `full` |

### 3. Set secrets and deploy

```bash
npm install
npx wrangler login
npx wrangler kv namespace create GSC_TOKENS           # put the id into wrangler.jsonc
npx wrangler secret put GOOGLE_CLIENT_ID
npx wrangler secret put GOOGLE_CLIENT_SECRET
openssl rand -base64 32 | npx wrangler secret put TOKEN_ENCRYPTION_KEY
npm run deploy                                        # typecheck + tests + wrangler deploy
```

`npm run deploy:dry-run` bundles and checks the config without uploading.

`TOKEN_ENCRYPTION_KEY` encrypts the stored Google refresh token. If you lose or change it, the stored token becomes unreadable and you must authorize again. If `GSC_TOKENS` is bound but the key is missing or malformed, the Worker fails closed: `/mcp` and `/auth/*` answer 503 and `/health` reports `ok: false`.

### 4. Put Cloudflare Access in front

In Zero Trust, go to **Access → Applications → Add an application → Self-hosted**:

1. **Application domain**: your hostname. Leave the path empty so `/mcp` and `/auth/*` are both covered.
2. Add an **Allow** policy for the people who may use the server and authorize Google (for example *Emails*: `you@example.com`).
3. For non-interactive clients (CI, scripts, agents), create a service token under **Access → Service auth → Service Tokens**. Then add a policy with action **Service Auth** that includes that token. Keep the Client ID and Client Secret.
4. Copy the application's **AUD tag** into `CF_ACCESS_AUD` and redeploy.

The Worker verifies the `Cf-Access-Jwt-Assertion` header on every request: signature against the team JWKS, issuer, audience, and expiry. User tokens map to the email and service tokens to their common name. `CF_ACCESS_ALLOWED_EMAILS` and `CF_ACCESS_ALLOWED_SERVICE_TOKENS` can narrow the Access policy further on the server side.

Bearer mode (`MCP_AUTH_MODE=bearer` plus the secret `MCP_AUTH_TOKEN`, at least 32 bytes) works without Access. The modes can be combined (`cf-access,bearer`), and then both must pass. `none` is refused on Workers.

### 5. Authorize Google

Open `https://<your-host>/auth/google` in a browser and approve the consent screen. See the next section for details.

## Authorizing Google inside the Worker

| Route | Method | What it does |
|---|---|---|
| `/auth/google` | GET | Redirects to Google consent with `access_type=offline`, `prompt=consent`, the scope from `GSC_SCOPES`, a random `state`, and a PKCE S256 challenge |
| `/auth/google/callback` | GET | Validates `state`, exchanges the code with the PKCE verifier, stores the refresh token encrypted, and shows a success page (the token is never displayed) |
| `/auth/google/status` | GET | Shows the active token source, granted scope, Google account email, stored-at time, and the redirect URI in use. No secrets |
| `/auth/google/revoke` | POST | Revokes the stored token at Google and deletes it from KV (the status page has a **Disconnect** button) |

Browsers (`Accept: text/html`) get a small HTML page; other clients get JSON (or add `?format=json`).

**Protection.** Every `/auth/*` route goes through the same `MCP_AUTH_MODE` check and `MCP_ALLOWED_HOSTS` allowlist as `/mcp`; nothing under `/auth/` is reachable unauthenticated. With Cloudflare Access, a browser arrives carrying the Access JWT, so the interactive flow just works. The pending `state` is bound to the identity that started the flow, so the callback must come from the same Access user (or the same bearer token). `revoke` is POST-only and rejects cross-site requests (`Origin` / `Sec-Fetch-Site`).

**State and PKCE.** `state` and the PKCE verifier are 32 random bytes each. The verifier never leaves the Worker: it is stored encrypted in KV under the state key with a 10-minute TTL, and it is deleted the first time the callback reads it.

**Storage.** One Google account per deployment, in the `GSC_TOKENS` namespace:

| KV key | Contents |
|---|---|
| `google:refresh-token` | JSON with the AES-256-GCM encrypted refresh token, plus plaintext `scope`, `client_id`, `email`, `stored_at` |
| `google:oauth-state:<state>` | Encrypted pending request (PKCE verifier, initiating identity, redirect URI), TTL 600 s |

Ciphertexts use a fresh 96-bit IV and are bound to their key name with AES-GCM additional data.

**Token precedence.** A token stored in KV wins. If KV holds nothing, `GOOGLE_REFRESH_TOKEN` from the environment is used (backward compatible). A KV token that cannot be decrypted is reported as an error; the Worker does not silently fall back to the env token. `/health` (`google_token_source`), `/auth/google/status`, and `get_capabilities` report which source is active.

**Re-authorizing.** Open `/auth/google` again. The new token replaces the stored one. When Google answers `invalid_grant` (token revoked, expired, or unused for 6 months), tool errors say to re-open `/auth/google`. After changing `GSC_SCOPES`, re-authorize so the stored grant covers the new scope; the status page shows `covers_required_scope`.

**Redirect URI.** By default it is `https://<request host>/auth/google/callback`, and the host must be listed in `MCP_ALLOWED_HOSTS`. Set `GOOGLE_REDIRECT_URI` to pin it explicitly. Either way it must exactly match an authorized redirect URI on the Google client.

**Bearer-only deployments.** A browser cannot attach a bearer header, so authorize with `curl`:

```bash
curl -si -H "Authorization: Bearer $MCP_AUTH_TOKEN" https://<host>/auth/google | grep -i ^location
# open that URL, approve; the browser then lands on /auth/google/callback?... and gets 401.
# Copy that full callback URL from the address bar and replay it with the token:
curl -s -H "Authorization: Bearer $MCP_AUTH_TOKEN" 'https://<host>/auth/google/callback?state=...&code=...'
```

**Disconnecting.** `POST /auth/google/revoke` (or the button) revokes the grant at Google and deletes the KV entry. If Google cannot be reached, the entry is still deleted and the response includes a warning with the link to remove access manually. A `GOOGLE_REFRESH_TOKEN` secret is not touched; remove it with `npx wrangler secret delete GOOGLE_REFRESH_TOKEN`.

## Running on Node or stdio

The `/auth/google` routes are **disabled on Node** (they answer 404). Node and stdio keep the local loopback flow:

```bash
npm install
# OAuth client JSON (type "Desktop app") downloaded from Google Cloud Console
npm run auth -- --scopes readonly --client-secrets ~/Downloads/client_secret_xxx.json --out gsc-credentials.json
export GSC_CREDENTIALS_FILE=$PWD/gsc-credentials.json
```

- HTTP: `MCP_AUTH_MODE=bearer MCP_AUTH_TOKEN=$(openssl rand -hex 32) npm run dev` serves `http://127.0.0.1:3001/mcp`. Binding a non-loopback `MCP_HOST` requires `MCP_ALLOWED_HOSTS`. `MCP_AUTH_MODE=none` is only allowed on loopback.
- stdio: `npm run dev:stdio`. There is no HTTP authentication, and credentials come from the environment or `GSC_CREDENTIALS_FILE`.

Explicit `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` / `GOOGLE_REFRESH_TOKEN` env vars win over the file.

## Client configuration

**Remote (Workers behind Access), clients that support custom headers.** Use a service token:

```json
{
  "mcpServers": {
    "gsc": {
      "type": "http",
      "url": "https://gsc-mcp.example.com/mcp",
      "headers": {
        "CF-Access-Client-Id": "<client-id>.access",
        "CF-Access-Client-Secret": "<client-secret>"
      }
    }
  }
}
```

Claude Code:

```bash
claude mcp add --transport http gsc https://gsc-mcp.example.com/mcp \
  --header "CF-Access-Client-Id: <client-id>.access" \
  --header "CF-Access-Client-Secret: <client-secret>"
```

**Remote with bearer mode.** Replace the two headers with `"Authorization": "Bearer <MCP_AUTH_TOKEN>"`.

**Local stdio** (for example Claude Desktop's `claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "gsc": {
      "command": "npx",
      "args": ["tsx", "/path/to/gsc-mcp-ts/src/stdio.ts"],
      "env": { "GSC_CREDENTIALS_FILE": "/path/to/gsc-credentials.json" }
    }
  }
}
```

**Scripts.** `scripts/smoke.ts` (exercises all tools) and `scripts/export.ts` (writes one tool's JSON result to a file) read `MCP_URL`, plus `MCP_AUTH_TOKEN` and/or `CF_ACCESS_CLIENT_ID` + `CF_ACCESS_CLIENT_SECRET`:

```bash
MCP_URL=https://gsc-mcp.example.com/mcp CF_ACCESS_CLIENT_ID=... CF_ACCESS_CLIENT_SECRET=... \
  npx tsx scripts/smoke.ts --site sc-domain:example.com --page https://example.com/
MCP_URL=https://gsc-mcp.example.com/mcp CF_ACCESS_CLIENT_ID=... CF_ACCESS_CLIENT_SECRET=... \
  npx tsx scripts/export.ts get_search_analytics out.json --site_url sc-domain:example.com --days 28
```

## Environment variables

On Workers, set plain values under `vars` in `wrangler.jsonc` and sensitive values with `wrangler secret put`. On Node, use the process environment.

| Name | Entry | Kind | Default | Purpose |
|---|---|---|---|---|
| `MCP_AUTH_MODE` | HTTP | var | (required) | `cf-access`, `bearer`, `none` (loopback Node only); comma-combine for "all must pass". `oauth` is not implemented |
| `MCP_AUTH_TOKEN` | HTTP | secret | | Static token for `bearer` (≥ 32 bytes) |
| `MCP_BEARER_HEADER` | HTTP | var | `authorization` | Read the raw bearer token from another header, e.g. `x-api-key` |
| `CF_ACCESS_TEAM_DOMAIN` | HTTP | var | | `https://<team>.cloudflareaccess.com` (required for `cf-access`) |
| `CF_ACCESS_AUD` | HTTP | var | | Access application AUD tag(s), comma-separated (required for `cf-access`) |
| `CF_ACCESS_ALLOWED_EMAILS` | HTTP | var | | Optional server-side email allowlist |
| `CF_ACCESS_ALLOWED_SERVICE_TOKENS` | HTTP | var | | Optional service-token common-name allowlist |
| `MCP_ALLOWED_HOSTS` | HTTP | var | | Host header allowlist (DNS-rebinding protection). Required on Workers and for non-loopback Node; also gates the derived OAuth redirect URI |
| `MCP_ALLOWED_ORIGINS` | HTTP | var | Workers: `MCP_ALLOWED_HOSTS` | Origin header allowlist |
| `MCP_HOST` / `MCP_PORT` (`PORT`) | Node | var | `127.0.0.1` / `3001` | Bind address and port |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | all | secret | | Google OAuth client (Web application type for `/auth/google`) |
| `GOOGLE_REFRESH_TOKEN` | all | secret | | Refresh token; on Workers only used when nothing is stored in KV |
| `GSC_TOKENS` | Workers | KV binding | | Enables `/auth/google`; stores the encrypted refresh token |
| `TOKEN_ENCRYPTION_KEY` | Workers | secret | | Base64 of 32 random bytes; required when `GSC_TOKENS` is bound |
| `GOOGLE_REDIRECT_URI` | Workers | var | derived from host | Explicit `https://<host>/auth/google/callback` |
| `GSC_CREDENTIALS_FILE` | Node, stdio | var | | JSON written by `npm run auth` (or Google's `token.json`) |
| `GSC_SCOPES` | all | var | `readonly` | `readonly` or `full` (`webmasters`) |
| `GSC_ALLOW_DESTRUCTIVE` | all | var | `false` | With `GSC_SCOPES=full`, enables add/delete tools |
| `GSC_DATA_STATE` | all | var | `all` | `all` (matches the GSC UI) or `final` |
| `GSC_SKIP_OAUTH` | all | var | | Accepted for compatibility with mcp-gsc and ignored (no service accounts) |

Script-only: `MCP_URL`, `CF_ACCESS_CLIENT_ID`, `CF_ACCESS_CLIENT_SECRET`.

`GET /health` is unauthenticated. It returns `ok`, `version`, `google_token_configured`, `google_token_available`, and `google_token_source` (`kv` | `env` | `none`), never secret values or error details.

## Tools and scope tiers

All 21 tools are always registered. Tools above the current tier return upgrade guidance flagged `isError: true` instead of calling Google.

| Tier | Enabled by | Tools |
|---|---|---|
| read | default (`GSC_SCOPES=readonly`) | `get_capabilities`, `get_creator_info`, `reauthenticate`, `list_properties`, `get_site_details`, `get_search_analytics`, `get_performance_overview`, `get_advanced_search_analytics`, `compare_search_periods`, `get_search_by_page_query`, `inspect_url_enhanced`, `batch_url_inspection`, `check_indexing_issues`, `get_sitemaps`, `list_sitemaps_enhanced`, `get_sitemap_details`, `manage_sitemaps` (`list`, `details`) |
| write | `GSC_SCOPES=full` | `submit_sitemap`, `manage_sitemaps` (`submit`) |
| destructive | `GSC_SCOPES=full` + `GSC_ALLOW_DESTRUCTIVE=true` | `add_site`, `delete_site`, `delete_sitemap`, `manage_sitemaps` (`delete`) |

Start with `get_capabilities`: it reports the tier, auth status, token source, and the AI Overviews / AI Mode boundary (that data is not exposed by the Search Console API).

## Development

```bash
npm install
npm run typecheck
npm test                 # node:test via tsx
npm run deploy:dry-run   # bundle the Worker without uploading
```

`npx wrangler dev` runs the Worker locally with a local KV simulation. Note that it rewrites the Host header to the hostname in `routes`, so keep that hostname in `MCP_ALLOWED_HOSTS`.
