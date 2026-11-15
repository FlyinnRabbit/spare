# Spare

Scan your shopping tickets, track every euro, and squeeze a little more savings out of each month.

- **Scan tickets** (photo) or **paste online orders**. AI reads the items and categories, and you can correct anything.
- **Need / Want**: tag items once and the app remembers them.
- **Shrinking trip cap**: each shopping trip you finish under the cap makes the next cap €0.50 smaller. Going over relaxes it by one step and tells you which "want" to leave on the shelf next time.
- **Shopping list**: needs are counted first, then wants. Anything that doesn't fit is struck out with the exact amount you're short.
- **Rising savings goal**: hit the monthly goal and next month's goal goes up by €10.
- **Accounts + sync**: the same data on PC (website) and phone (Android app), stored in your own Cloudflare D1 database.

```
web/        the app (HTML/JS), served as the website and bundled into the APK
worker/     Cloudflare Worker: accounts, sync, receipt reading (+ D1 schema)
resources/  app icon
.github/    GitHub Actions: build the APK, deploy the Worker
```

## Setup (about 10 minutes, all in the browser)

### 1. Cloudflare database
1. Cloudflare dashboard → **Storage & Databases → D1 → Create database**. Name it `spare`.
2. Copy its **Database ID**.

### 2. Cloudflare API token
1. Dashboard → profile icon → **My Profile → API Tokens → Create Token**.
2. Use the **Edit Cloudflare Workers** template, then **add** the permission `Account → D1 → Edit`.
3. Copy the token. Also copy your **Account ID** (on the dashboard's Workers & Pages overview, right sidebar).

### 3. GitHub secrets
In this repo: **Settings → Secrets and variables → Actions → New repository secret**:

| Secret | Value |
|---|---|
| `CLOUDFLARE_API_TOKEN` | the token from step 2 |
| `CLOUDFLARE_ACCOUNT_ID` | your account ID |
| `D1_DATABASE_ID` | the database ID from step 1 |

Then go to **Actions → Deploy to Cloudflare → Run workflow**. When it finishes, the log shows your address, e.g. `https://spare.<your-subdomain>.workers.dev`. That's the PC version: open it and **create your account**.

### 4. Android app
1. Same settings page → **Variables** tab → **New repository variable**: `SPARE_API_URL` = your Worker address from step 3.
2. **Actions → Android APK → Run workflow** (it also runs on every push).
3. Open **Releases** on your phone, download **Spare.apk** and install it. The first time, Android asks you to allow installs from your browser.
4. Log in with the same account.

Every new build installs over the previous one (same signing key), and your data stays in the cloud.

### 5. Close sign-ups (recommended)
Once your account exists, set `ALLOW_SIGNUP = "false"` in `worker/wrangler.toml` and commit. The Worker redeploys by itself.

## Optional

- **Better ticket reading with Claude**: by default tickets are read by Cloudflare Workers AI (Llama 4 Scout, free daily allowance). To use Claude instead, add a secret named `ANTHROPIC_API_KEY` to the Worker (Cloudflare dashboard → Workers → spare → Settings → Variables and Secrets). It uses the Anthropic API, which is billed separately from a Claude Pro subscription.
- **Own domain**: uncomment the `routes` line in `worker/wrangler.toml`, e.g. `spare.watchtvrabbit.dev`.
- **Moving data from the claude.ai version**: there, Settings → *Copy backup*; here, Settings → *Restore…* and paste.
- **Your own signing key**: the repo ships a debug keystore so every build has the same signature. To use a private one, add it base64-encoded as the `ANDROID_KEYSTORE_B64` secret.

## Running locally
```
cd worker
npx wrangler d1 execute spare --local --file=schema.sql
npx wrangler dev        # http://localhost:8787
```
