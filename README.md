# gsc-mcp-ts

A [Model Context Protocol](https://modelcontextprotocol.io) server for **Google Search Console**, written in TypeScript on [Hono](https://hono.dev). It is a port of [mcp-gsc](https://github.com/AminForou/mcp-gsc) by Amin Foroutan, with 21 tools covering properties, search analytics, URL inspection, and sitemaps.

It runs in three places from one codebase:

| Entrypoint | File | Transport | Typical use |
|---|---|---|---|
| Cloudflare Workers | `src/index.ts` | Streamable HTTP at `/mcp` | Remote deployment behind Cloudflare Access |
| Node | `src/node.ts` | Streamable HTTP at `/mcp` | Self-hosting, Docker, local HTTP testing |
| stdio | `src/stdio.ts` | stdio | Desktop MCP clients on your own machine |

Search Console access uses Google OAuth refresh tokens. One deployment can hold several Google accounts, and each tool call picks the account that can access the property it is about. On Workers you can authorize Google **from the deployed Worker itself** (`/auth/google`). No local tooling or copied tokens are needed.

## Contents

- [Deploy to Cloudflare Workers](#deploy-to-cloudflare-workers)
- [Authorizing Google inside the Worker](#authorizing-google-inside-the-worker)
- [Running on Node or stdio](#running-on-node-or-stdio)
- [Client configuration](#client-configuration)
- [Environment variables](#environment-variables)
- [Tools and tool tiers](#tools-and-tool-tiers)
- [Other search engines](#other-search-engines)
- [Development](#development)

## Deploy to Cloudflare Workers

You need:

- a Cloudflare account with a zone (domain) for the Worker's hostname,
- Cloudflare Zero Trust (the free plan is enough) for Cloudflare Access,
- a Google Cloud project with the **Google Search Console API** enabled. To use the optional `ga4_*` tools, also enable the **Google Analytics Admin API** and **Google Analytics Data API**, and give the Google user at least **Viewer** on each GA4 property.

### 1. Create the Google OAuth client

In Google Cloud Console, go to **APIs & Services → Credentials → Create credentials → OAuth client ID**:

- Application type: **Web application**. A *Desktop* client cannot be used here because it does not accept an `https://` redirect URI.
- Authorized redirect URI: `https://<your-host>/auth/google/callback`, for example `https://gsc-mcp.example.com/auth/google/callback`.

On the **OAuth consent screen**, add the scope `https://www.googleapis.com/auth/webmasters.readonly` (or `.../auth/webmasters` for the full tier). If you will use the `ga4_*` tools, also add `https://www.googleapis.com/auth/analytics.readonly`. Then publish the app **In production**: refresh tokens issued while it is in *Testing* expire after 7 days.

### 2. Configure `wrangler.jsonc`

[`wrangler.jsonc`](wrangler.jsonc) is a working template. Replace every `REPLACE_ME` value:

| Field | Value |
|---|---|
| `routes[0].pattern` | Your hostname, e.g. `gsc-mcp.example.com` (`custom_domain: true` creates the DNS record) |
| `kv_namespaces[0].id` | Output of `npx wrangler kv namespace create GSC_TOKENS` |
| `vars.MCP_ALLOWED_HOSTS` | The same hostname |
| `vars.CF_ACCESS_TEAM_DOMAIN` | `https://<team>.cloudflareaccess.com`, where `<team>` is the team name shown under **Zero Trust → Settings** |
| `vars.CF_ACCESS_AUD` | The Access application's AUD tag (step 4) |
| `vars.TOOL_TIER` | Optional: `read` (default), `write`, or `destructive` |

### 3. Set secrets and deploy

```bash
npm install
npx wrangler login
npx wrangler kv namespace create GSC_TOKENS           # put the id into wrangler.jsonc
npx wrangler secret put GOOGLE_CLIENT_ID
npx wrangler secret put GOOGLE_CLIENT_SECRET
openssl rand -base64 32 | npx wrangler secret put TOKEN_ENCRYPTION_KEY
npm run deploy                                        # placeholder check + typecheck + tests + wrangler deploy
```

`npm run deploy` first runs `npm run check:wrangler`, which refuses to continue while `wrangler.jsonc` still contains a `REPLACE_ME` value or an `example.com` hostname. `npm run deploy:dry-run` bundles and checks the config without uploading (it skips the placeholder check, so it works on the unedited template).

`TOKEN_ENCRYPTION_KEY` encrypts the stored Google refresh tokens. There is no key rotation: if you lose or change the key, the stored tokens become unreadable (tools report it) and you authorize each account again at `/auth/google`, which overwrites its token.

Invalid configuration fails closed. For example, `GSC_TOKENS` bound without a valid key makes `/mcp` and `/auth/*` answer 503 with a generic message, and `/health` reports `ok: false`. The actual errors are logged once per isolate; read them with `npx wrangler tail`. A Worker without `MCP_ALLOWED_HOSTS` answers 403 to every request and logs a warning saying so.

### 4. Put Cloudflare Access in front

In Zero Trust, go to **Access → Applications → Add an application → Self-hosted**:

1. **Application domain**: your hostname. Leave the path empty so `/mcp` and `/auth/*` are both covered.
2. Add an **Allow** policy for the people who may use the server and authorize Google (for example *Emails*: `you@example.com`).
3. For non-interactive clients (CI, scripts, agents), create a service token under **Access → Service auth → Service Tokens**. Then add a policy with action **Service Auth** that includes that token. Keep the Client ID and Client Secret.
4. Copy the application's **AUD tag** into `CF_ACCESS_AUD` and redeploy.

Because the application covers the whole hostname, Access also sits in front of `/health`: an unauthenticated monitor gets the Access login redirect, not the Worker's JSON. Add a separate Access application for the path `/health` with a **Bypass** policy if you need public health checks.

On `/mcp` and every `/auth/*` route, the Worker verifies the `Cf-Access-Jwt-Assertion` header (`/health` is not checked): signature against the team JWKS, issuer, audience, and expiry. User tokens map to the email and service tokens to their common name.

The checks follow what is configured: `CF_ACCESS_TEAM_DOMAIN` + `CF_ACCESS_AUD` turn on the Access check, and the secret `MCP_AUTH_TOKEN` (at least 32 bytes) turns on a bearer check, which works without Access. With both set, both must pass. A Worker with neither refuses to serve.

### 5. Authorize Google

Open `https://<your-host>/auth/google` in a browser and approve the consent screen. See the next section for details.

**Adding a second Google account.** Open `https://<your-host>/auth/google` again and pick (or sign in to) the other account on Google's account chooser. Each authorization stores the token of the account that signed in, keyed by its email: a new email adds an account, the same email replaces only that account's token. `/auth/google/accounts` (or `get_capabilities`) lists the connected accounts.

## Authorizing Google inside the Worker

| Route | Method | What it does |
|---|---|---|
| `/auth/google` | GET | Redirects to Google consent with `access_type=offline`, `prompt=consent select_account`, the scope `TOOL_TIER` needs (plus `analytics.readonly` with `?ga4=1`), `include_granted_scopes=true` so scopes the account already granted are kept, a random `state`, and a PKCE S256 challenge |
| `/auth/google/callback` | GET | Validates `state`, exchanges the code with the PKCE verifier, and stores the refresh token encrypted. Browsers are then redirected (303) to `/auth/google/status?connected=1`, so a reload does not resubmit the code; JSON clients get the result directly. The token is never displayed |
| `/auth/google/status` | GET | Shows the default token source, every connected account (email, scope, added time, health), and the redirect URI in use. No secrets |
| `/auth/google/accounts` | GET | Connected accounts with source, scope, added time and health. No secrets. Admins only (see below) |
| `/auth/google/revoke` | POST | Removes one stored account: deletes its token from KV, then revokes it at Google. Takes `account=<email>` (query or form field); it may be omitted when only one account is stored. The status and accounts pages show a **Disconnect** button per stored account |
| `/auth/google/accounts/remove` | POST | Same as `/auth/google/revoke` |

Browsers (`Accept: text/html`) get a small HTML page; other clients get JSON (or add `?format=json`).

**Protection.** Every `/auth/*` route goes through the same authentication checks and `MCP_ALLOWED_HOSTS` allowlist as `/mcp`; nothing under `/auth/` is reachable unauthenticated. With Cloudflare Access, a browser arrives carrying the Access JWT, so the interactive flow just works. The pending `state` is bound to the identity that started the flow, so the callback must come from the same Access user (or the same bearer token). With both Access and a bearer token configured it is bound to both identities. `revoke` is POST-only and rejects cross-site requests (`Origin` / `Sec-Fetch-Site`).

**Who may connect and disconnect.** Any identity that passes the authentication checks may read `/auth/google/status`. Starting the flow, completing the callback, listing accounts at `/auth/google/accounts`, and removing an account are more restricted:

- With `GOOGLE_AUTH_ADMINS` set, only the listed identities may do them. Entries are Access user emails, Access service-token common names (`<client-id>.access`), or `static-bearer` for the `MCP_AUTH_TOKEN` holder; matching is case-insensitive. With both checks configured, one listed identity is enough.
- Without it, Access users and the bearer token holder may, but Access service tokens may not. That way a token issued to a CI job or agent cannot swap the deployment's Google account.

**State and PKCE.** `state` and the PKCE verifier are 32 random bytes each. The verifier never leaves the Worker: it is stored encrypted in KV under the state key with a 10-minute TTL, and it is deleted when the callback uses it. A callback from a different identity is refused without consuming the pending request, so it cannot cancel someone else's flow. KV has no atomic read-and-delete, so two callbacks racing on the same `state` could both read it; Google authorization codes are single-use, so at most one of them gets a token.

**Storage.** One record per Google account, in the `GSC_TOKENS` namespace:

| KV key | Contents |
|---|---|
| `google:account:<email>` | JSON with the AES-256-GCM encrypted refresh token, plus plaintext `scope`, `client_id`, `email`, `stored_at`. The email is lowercased |
| `google:accounts` | Index of stored account emails |
| `google:refresh-token` | Record written by versions with one account per deployment. It keeps working: when it names an email it is moved to `google:account:<email>` on first read (copied first, then deleted); without an email it stays and is listed as account `default` |
| `google:oauth-state:<state>` | Encrypted pending request (PKCE verifier, initiating identity, redirect URI), TTL 600 s |

Ciphertexts use a fresh 96-bit IV and are bound to their key name with AES-GCM additional data.

**Accounts and routing.** Every KV account plus `GOOGLE_REFRESH_TOKEN` from the environment (account `env`, if set) is available. Each account has its own cached access token. When several accounts are connected, the server lists each account's properties (`sites.list`, cached for 5 minutes and dropped when accounts change) and sends a call about a property to the account with the highest permission on it (`siteOwner` > `siteFullUser` > `siteRestrictedUser`). If that account gets 403, the next account that lists the property is tried. Calls about a property no account lists use the default account (the first KV account, else `env`). `list_properties` merges all accounts and shows which accounts can access each property. `add_site` has no property to route by, so with several accounts it needs its `account` argument (an email); without it the tool answers with the list of accounts. With a single account nothing changes: no extra `sites.list` calls are made.

**Token precedence.** The default account is the first KV account; `GOOGLE_REFRESH_TOKEN` is the default only when KV holds nothing (backward compatible). A KV token that cannot be decrypted is reported as an error; the Worker does not silently fall back to the env token. `/health` (`google_token_source`, and `google_accounts` with counts only, since `/health` is unauthenticated), `/auth/google/status`, and `get_capabilities` report the sources and per-account health. `get_capabilities` also warns when the stored grant does not cover the scope `TOOL_TIER` needs, or when a refresh token is present without the client credentials. A stored token issued to a different `GOOGLE_CLIENT_ID` than the configured one is refused with an error asking you to re-authorize.

**Propagation.** Workers KV is eventually consistent: a new or deleted token can take up to about 60 seconds to be visible in other Cloudflare locations. Each isolate also trusts the stored token's metadata for up to 30 seconds before checking KV again. So after re-authorizing or disconnecting, requests served elsewhere may use the previous token for up to about a minute and a half. The isolate that handled the change switches immediately. If Google rejects a cached access token with 401, the server fetches a new one and retries the call once.

**Re-authorizing.** Open `/auth/google` again and sign in as the same account. The new token replaces that account's stored token; other accounts are untouched. When Google answers `invalid_grant` (token revoked, expired, or unused for 6 months), tool errors say to re-open `/auth/google`. After raising `TOOL_TIER` to `write` or `destructive`, re-authorize so the stored grant covers the new scope; the status page shows `covers_required_scope`. To add Google Analytics to an account, open `/auth/google?ga4=1` (the status page links to it). Because of `include_granted_scopes`, a later plain `/auth/google` keeps Analytics.

**Redirect URI.** By default it is `https://<request host>/auth/google/callback`, and the host must be listed in `MCP_ALLOWED_HOSTS`. Set `GOOGLE_REDIRECT_URI` to pin it explicitly; the callback is then only accepted on that URI's host. Either way it must exactly match an authorized redirect URI on the Google client.

**Bearer-only deployments.** A browser cannot attach a bearer header, so authorize with `curl`:

```bash
curl -si -H "Authorization: Bearer $MCP_AUTH_TOKEN" https://<host>/auth/google | grep -i ^location
# open that URL, approve; the browser then lands on /auth/google/callback?... and gets 401.
# Copy that full callback URL from the address bar and replay it with the token:
curl -s -H "Authorization: Bearer $MCP_AUTH_TOKEN" 'https://<host>/auth/google/callback?state=...&code=...'
```

**Disconnecting.** `POST /auth/google/revoke?account=<email>` (or the account's **Disconnect** button on the status page) deletes that account's KV entry first and then revokes the grant at Google, so the Worker stops using the token even if Google cannot be reached. In that case the response includes a warning with the link to remove access manually. A `GOOGLE_REFRESH_TOKEN` secret is not touched; remove it with `npx wrangler secret delete GOOGLE_REFRESH_TOKEN`.

## Running on Node or stdio

The `/auth/google` routes are **disabled on Node** (they answer 404). Node and stdio keep the local loopback flow:

```bash
npm install
# OAuth client JSON (type "Desktop app") downloaded from Google Cloud Console
npm run auth -- --scopes readonly --client-secrets ~/Downloads/client_secret_xxx.json --out gsc-credentials.json
export GSC_CREDENTIALS_FILE=$PWD/gsc-credentials.json
```

- HTTP: `MCP_AUTH_TOKEN=$(openssl rand -hex 32) npm run dev` serves `http://127.0.0.1:3001/mcp`. Binding a non-loopback `MCP_HOST` requires `MCP_ALLOWED_HOSTS` and an authentication check. Without `MCP_AUTH_TOKEN` or `CF_ACCESS_*`, the server runs unauthenticated, which is only allowed on loopback.
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
| `MCP_AUTH_TOKEN` | HTTP | secret | | Static bearer token (≥ 32 bytes); setting it turns on the bearer check |
| `CF_ACCESS_TEAM_DOMAIN` | HTTP | var | | `https://<team>.cloudflareaccess.com` (set with `CF_ACCESS_AUD` to turn on the Access check) |
| `CF_ACCESS_AUD` | HTTP | var | | Access application AUD tag(s), comma-separated |
| `MCP_ALLOWED_HOSTS` | HTTP | var | | Host header allowlist (DNS-rebinding protection). Required on Workers and for non-loopback Node; also gates the derived OAuth redirect URI |
| `MCP_ALLOWED_ORIGINS` | HTTP | var | Workers: `MCP_ALLOWED_HOSTS` | Origin header allowlist |
| `MCP_HOST` / `MCP_PORT` (`PORT`) | Node | var | `127.0.0.1` / `3001` | Bind address and port |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | all | secret | | Google OAuth client (Web application type for `/auth/google`) |
| `GOOGLE_REFRESH_TOKEN` | all | secret | | Refresh token; on Workers only used when nothing is stored in KV |
| `GSC_TOKENS` | Workers | KV binding | | Enables `/auth/google`; stores the encrypted refresh tokens (one per Google account) |
| `TOKEN_ENCRYPTION_KEY` | Workers | secret | | Base64 of 32 random bytes; required when `GSC_TOKENS` is bound |
| `GOOGLE_REDIRECT_URI` | Workers | var | derived from host | Explicit `https://<host>/auth/google/callback` |
| `GOOGLE_AUTH_ADMINS` | Workers | var | | Comma-separated identities allowed to connect/disconnect Google (emails, service-token common names, `static-bearer`). Unset: everyone except Access service tokens |
| `GSC_CREDENTIALS_FILE` | Node, stdio | var | | JSON written by `npm run auth` (or Google's `token.json`) |
| `TOOL_TIER` | all | var | `read` | `read`, `write`, or `destructive` ([tiers](#tools-and-tool-tiers)); `write` and up request the full Google `webmasters` scope |
| `GSC_DATA_STATE` | all | var | `all` | `all` (matches the GSC UI) or `final` |
| `BING_API_KEY` | all | secret | | Bing Webmaster Tools API key; enables the `bing_*` tools ([details](#bing-webmaster-tools)) |
| `INDEXNOW_KEY` | all | secret | | IndexNow key; enables the `indexnow_*` tools ([details](#indexnow)) |
| `INDEXNOW_KEY_LOCATION` | all | var | `https://<host>/<key>.txt` | Key file location: an absolute URL, or a path such as `/keys/indexnow.txt` used on every host |
| `INDEXNOW_HOSTS` | all | var | | Hosts whose key file `indexnow_check_key_file` may fetch, comma-separated (e.g. `example.com,www.example.com`); the host of an absolute `INDEXNOW_KEY_LOCATION` is always allowed |
| `YANDEX_OAUTH_TOKEN` | all | secret | | Yandex OAuth token; enables the `yandex_*` tools ([details](#yandex-webmaster)) |
| `SEZNAM_API_KEY` | all | secret | | One Seznam API key, or a JSON object mapping each site to its key; enables the `seznam_*` tools ([details](#seznam-webmaster)) |

Script-only: `MCP_URL`, `CF_ACCESS_CLIENT_ID`, `CF_ACCESS_CLIENT_SECRET`.

`GET /health` is not checked by the authentication checks (but Cloudflare Access still guards it if the Access application covers the whole hostname; see step 4 of the deploy guide). It returns `ok`, `version`, `google_token_configured`, `google_token_available`, and `google_token_source` (`kv` | `env` | `none`), never secret values or error details.

## Tools and tool tiers

All 21 tools are always registered. Tools above the current tier return upgrade guidance flagged `isError: true` instead of calling Google.

| Tier | Enabled by | Tools |
|---|---|---|
| read | default (`TOOL_TIER=read`) | `get_capabilities`, `get_creator_info`, `reauthenticate`, `list_properties`, `get_site_details`, `get_search_analytics`, `get_performance_overview`, `get_advanced_search_analytics`, `compare_search_periods`, `get_search_by_page_query`, `inspect_url_enhanced`, `batch_url_inspection`, `check_indexing_issues`, `get_sitemaps`, `list_sitemaps_enhanced`, `get_sitemap_details`, `manage_sitemaps` (`list`, `details`) |
| write | `TOOL_TIER=write` | `submit_sitemap`, `manage_sitemaps` (`submit`) |
| destructive | `TOOL_TIER=destructive` | `add_site`, `delete_site`, `delete_sitemap`, `manage_sitemaps` (`delete`) |

Start with `get_capabilities`: it reports the tier, auth status, token source, the AI Overviews / AI Mode boundary (that data is not exposed by the Search Console API), and the Google Analytics API vs UI boundary.

## Google Analytics 4

Read-only `ga4_*` tools for the [Google Analytics Admin API](https://developers.google.com/analytics/devguides/config/admin/v1) and [Google Analytics Data API](https://developers.google.com/analytics/devguides/reporting/data/v1) are always registered. There is no switch: they reuse the Google OAuth tokens of Search Console (including the multi-account KV store) and work for every account that has granted Analytics. The default consent screen does not ask for Analytics, so Search Console-only deployments see no change at sign-in.

**Enable in Google Cloud**

1. In the same project as the OAuth client, enable **Google Analytics Admin API** and **Google Analytics Data API** ([API Library](https://console.cloud.google.com/apis/library)).
2. On the OAuth consent screen, add `https://www.googleapis.com/auth/analytics.readonly`.
3. In Google Analytics, the signed-in user needs at least **Viewer** on each property you will query (Admin → Property access management).
4. Grant Analytics to each account that should use it:

```bash
# Workers: open https://<host>/auth/google?ga4=1 and keep Google Analytics checked
# Node:    npm run auth -- --scopes readonly --ga4 --client-secrets … --out gsc-credentials.json
```

A `ga4_*` call for an account whose stored grant has no Analytics answers with `insufficient_granted_scope` and a `resolution` that points to step 4. When the grant is unknown (the env token, or records stored before granted scopes were recorded), the call goes to Google, which answers 403 if Analytics is missing. The callback refuses a `?ga4=1` grant that omits Analytics.

**Tools** (all read)

| Group | Tools |
|---|---|
| Admin discovery | `ga4_get_account_summaries`, `ga4_get_property_details`, `ga4_list_google_ads_links`, `ga4_list_property_annotations` |
| Data API reports | `ga4_run_report`, `ga4_run_realtime_report`, `ga4_get_custom_dimensions_and_metrics`, `ga4_check_compatibility` |
| Data API alpha | `ga4_run_funnel_report`, `ga4_run_conversions_report` |

Start with `ga4_get_account_summaries` for property IDs (`properties/123` or `123`). Report arguments accept snake_case or REST camelCase; the Worker sends camelCase JSON to Google.

**Not enabled.** Admin write (create annotation, data streams, audiences, user management) stays off: this server requests `analytics.readonly` only, not `analytics.edit`. Explorations other than funnel reports, DebugView, the advertising UI beyond the conversions report, and BigQuery export are UI-only or out of scope.

## Other search engines

Bing, IndexNow, Yandex, and Seznam are opt-in. Their tools are registered only when the engine's secret is set, and they use the same tool tiers as the Google tools: read tools always run, submit tools need `TOOL_TIER=write`, and remove tools need `TOOL_TIER=destructive`. Their keys do not depend on the Google grant; only the Google write tools need you to re-authorize Google after raising the tier. `get_capabilities` lists each engine as enabled or not configured, without showing secret values. Google Analytics 4 needs no key (see above): it uses the Google OAuth grant.

### Bing Webmaster Tools

1. Sign in to [Bing Webmaster Tools](https://www.bing.com/webmasters) and add and verify your site.
2. Open **Settings > API access**, accept the terms, and click **Generate API Key**. There is one key per user, valid for all of that user's verified sites.
3. Set it as a secret:

```bash
npx wrangler secret put BING_API_KEY      # Workers
export BING_API_KEY=...                   # Node / stdio
```

The server calls the JSON API at `https://ssl.bing.com/webmaster/api.svc/json/<Method>` (the SOAP and POX endpoints were retired on 2026-08-31). Dates come back from Bing as `/Date(ms-0700)/` and are returned as ISO 8601.

| Tier | Tools |
|---|---|
| read | `bing_list_sites`, `bing_get_query_stats`, `bing_get_page_stats`, `bing_get_traffic_stats`, `bing_get_crawl_stats`, `bing_get_crawl_issues`, `bing_get_url_info`, `bing_get_link_counts`, `bing_get_feeds`, `bing_get_url_submission_quota` |
| write | `bing_submit_urls` (up to 500 URLs per call; uses the daily quota), `bing_submit_feed` |
| destructive | `bing_remove_feed` |

Known limits:

- There is no URL inspection API for Bing. `bing_get_url_info` returns only basic index metadata.
- `GetQueryStats` and `GetPageStats` take no date range; Bing returns a fixed recent window, by week. `start_date` / `end_date` only filter the returned rows.
- In every stats tool, `data_range` is the first and last date of the rows returned (after the date filter) and `source_window` is the span of everything Bing sent. Dates must be real calendar dates, and `start_date` after `end_date` is an error.
- Average positions are returned as Bing reports them. Third-party reports say they may be scaled by 10.
- From Cloudflare Workers, Bing may answer `ThrottleIP` because Workers share egress IPs (reported by another project, not verified here). The tools say so when it happens; run the Node or stdio entry from your own machine if it persists.
- Only API-key auth is supported. Bing's OAuth 2.0 (`webmaster.read` / `webmaster.manage`) is a possible follow-up.

### IndexNow

[IndexNow](https://www.indexnow.org/documentation) tells search engines that URLs were added, updated or deleted. A submission to one participating engine is shared with the others (Bing, Yandex, Seznam, Naver, Yep and more; Google does not take part). It needs no console account, only a key file on your site.

1. Generate a key: 8-128 characters of `a-z`, `A-Z`, `0-9` and `-`, for example `uuidgen | tr -d -` or `openssl rand -hex 16`.
2. Host a UTF-8 text file containing only the key at `https://<host>/<key>.txt` on every host you will submit for. To use another path, set `INDEXNOW_KEY_LOCATION` (a path like `/keys/indexnow.txt` applies to every host; a key file outside the root only covers URLs under its directory).
3. Set the key as a secret:

```bash
npx wrangler secret put INDEXNOW_KEY      # Workers
export INDEXNOW_KEY=...                   # Node / stdio
```

| Tier | Tools |
|---|---|
| read | `indexnow_check_key_file` (fetches your key file over https and checks it holds the key; contacts no search engine) |
| write | `indexnow_submit_urls` (up to 10,000 URLs per call, all on one host) |

`indexnow_check_key_file` only contacts hosts you allowed: those listed in `INDEXNOW_HOSTS`, plus the host of an absolute `INDEXNOW_KEY_LOCATION`. Any other host is refused without a request, so the key (which is part of the default file name) is never sent to a host a caller picks. The check always uses https, follows redirects only to https on the same host (at most 3), reads at most 64 KiB, and gives up after 30 seconds.

Submissions go to `https://api.indexnow.org/indexnow` as `{host, key, urlList}`, plus `keyLocation` when `INDEXNOW_KEY_LOCATION` is set (a path is resolved to `https://<host><path>`); the host is taken from the URLs. HTTP 200 means received and 202 means received with key validation pending; neither means indexed. 403 means the key file was not found or does not match, 422 means URLs outside the host or a malformed key, and 429 means too many submissions. Avoid resubmitting unchanged URLs.

### Yandex Webmaster

Setting `YANDEX_OAUTH_TOKEN` adds 27 `yandex_*` tools for the [Yandex Webmaster API v4](https://yandex.com/dev/webmaster/doc/en/).

**Get a token** (from the [Webmaster API authorization page](https://yandex.com/dev/webmaster/doc/en/tasks/how-to-get-oauth) and Yandex ID's [manual token guide](https://yandex.com/dev/id/doc/en/tokens/debug-token)):

1. Sign in to Yandex with the account that owns the sites in Yandex Webmaster.
2. Create an app at <https://oauth.yandex.com/client/new/>: choose **For API access or debugging**, and under data access add `webmaster:hostinfo` and `webmaster:verify`. The redirect URI is fixed to `https://oauth.yandex.ru/verification_code`.
3. Copy the app's **ClientID** and open `https://oauth.yandex.com/authorize?response_type=token&client_id=<ClientID>`. Approve, and copy the token from the page you land on.
4. Store it:

```bash
npx wrangler secret put YANDEX_OAUTH_TOKEN      # Workers
export YANDEX_OAUTH_TOKEN=...                   # Node / stdio
```

The token is valid for about **6 months**. When it expires (or is revoked), the tools answer with an error that says so; repeat step 3 and put the new token. Storing a Yandex grant in KV with an in-Worker OAuth flow, like `/auth/google`, is a planned follow-up.

**Tools.** Every tool takes `host`: a `host_id` from `yandex_list_hosts` (for example `https:example.com:443`) or the site URL exactly as listed there (`https://example.com/`). The user ID that the API needs (`GET /v4/user`) is looked up once per MCP request and reused.

| Tier | Tools |
|---|---|
| read | `yandex_list_hosts`, `yandex_get_host`, `yandex_get_host_summary`, `yandex_get_popular_queries`, `yandex_get_queries_history`, `yandex_get_query_history`, `yandex_get_indexing_history`, `yandex_get_indexing_samples`, `yandex_get_in_search_history`, `yandex_get_in_search_samples`, `yandex_get_search_events_history`, `yandex_get_search_events_samples`, `yandex_get_diagnostics`, `yandex_get_sqi_history`, `yandex_get_broken_internal_links`, `yandex_get_broken_internal_links_history`, `yandex_get_external_links`, `yandex_get_external_links_history`, `yandex_list_sitemaps`, `yandex_get_sitemap`, `yandex_list_user_sitemaps`, `yandex_get_recrawl_quota`, `yandex_list_recrawl_tasks`, `yandex_get_recrawl_task` |
| write (`TOOL_TIER=write`) | `yandex_add_sitemap`, `yandex_recrawl_url` |
| destructive (`TOOL_TIER=destructive`) | `yandex_delete_sitemap` |

**Limits.** Recrawl has a per-site daily quota (`yandex_get_recrawl_quota`). When Yandex answers 429 (`QUOTA_EXCEEDED` or `TOO_MANY_REQUESTS_ERROR`), the tool reports the daily quota and the time the new quota starts; 429 is not retried, 5xx is retried twice. Query statistics come from the TOP-3000 queries; the sample endpoints return at most 50,000 URLs. Dates (`date_from`/`date_to`) are passed through as given; `YYYY-MM-DD` is the safest form. Response timestamps are returned as ISO 8601 with Yandex's original offset.

Not covered yet: adding or deleting sites, ownership verification, important URLs, RSS feeds, and the in-Worker OAuth flow.

### Seznam Webmaster

Setting `SEZNAM_API_KEY` adds 6 `seznam_*` tools for the [Seznam Webmaster](https://reporter.seznam.cz/wm/) API. Seznam publishes the API as a Swagger document at <https://reporter.seznam.cz/wm-api/swagger.json> (interactive: <https://reporter.seznam.cz/wm-api/ui/>). Seznam Webmaster is in beta: it reports page counts and per-URL details, and accepts reindex requests. It has **no search query or traffic data**.

**Keys are per site.** The API has no site parameter; the key selects the site. Generate one per site in Seznam Webmaster: sign in at <https://reporter.seznam.cz/wm/>, open the verified site, and create an access key in its **API** section. A key with read rights is enough for everything except `seznam_reindex_url`, which needs write rights. Store the key itself for one site, or a JSON object for several:

```bash
# Workers
npx wrangler secret put SEZNAM_API_KEY          # one site: paste the key
echo '{"example.cz":"<key>","https://shop.example.cz":"<key>"}' | npx wrangler secret put SEZNAM_API_KEY
# Node / stdio
export SEZNAM_API_KEY='{"example.cz":"<key>"}'
```

Site names are host names, optionally with the protocol (Seznam treats `http` and `https` as different sites); `www.` is significant. Tools take an optional `site`; it can be omitted when one site is configured, and the page tools also pick the key from the URL's host. A single key appears as the site `default`. Invalid entries in the JSON object are ignored; `get_capabilities` and `seznam_list_sites` list the configured site names (never the keys) and warn about ignored entries. If no usable key is left, Seznam shows as not configured. Keys travel in the `key` query parameter, as the API requires; they are scrubbed from every error message.

| Tier | Tools |
|---|---|
| read | `seznam_list_sites`, `seznam_get_site`, `seznam_get_documents`, `seznam_get_documents_history`, `seznam_get_document` |
| write (`TOOL_TIER=write`, key with write rights) | `seznam_reindex_url` |

There are no destructive Seznam tools; the API has no delete operations.

**Limits** (from the Swagger description): at most 5 requests per second and 100 per minute per user and site, and at most 500 reindex requests a day. 429, 502 and 503 are retried twice with backoff. HTTP 204 means "the request succeeded but the data is not available yet" (new sites usually get data within 24 hours) and is reported as `data_available: false`, not as an error. `/web/documents` returns a random sample of at most 1,000 URLs per category; the tools trim it with `url_limit`. Page timestamps (`index_timestamp`, `download_timestamp`) are passed through as Seznam returns them because their unit is not documented.

## Development

```bash
npm install
npm run typecheck
npm test                 # node:test via tsx
npm run deploy:dry-run   # bundle the Worker without uploading
npm run discovery-check  # compare src/lib/enums.ts with Google's API discovery document
```

`npx wrangler dev` runs the Worker locally with a local KV simulation. Note that it rewrites the Host header to the hostname in `routes`, so keep that hostname in `MCP_ALLOWED_HOSTS`.
