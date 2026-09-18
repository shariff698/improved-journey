# Ridgeline — Deriv Trading Bot

A browser-based trading dashboard for [Deriv](https://deriv.com) synthetic indices. Connect your account, watch live ticks, place manual Rise/Fall trades, or turn on one of three simple auto-trade strategies with martingale money management. Plain HTML/CSS/JS — no build step, no backend, deploys anywhere as a static site.

⚠️ **This trades with real or demo money on your Deriv account.** Start on a **demo account** and small stakes until you've watched it run for a while. Nothing here is financial advice — you're responsible for every trade it places.

## How it works

The app connects directly from your browser to Deriv's public WebSocket API (`wss://ws.derivws.com`). Your API token is used only to authorize that connection — it is never sent anywhere except Deriv's own servers, and it isn't stored unless you tick "Remember on this device" (which just saves it in your browser's `localStorage`).

## 1. Get a Deriv App ID and API token

1. **App ID** — register a free app at [Deriv API — Register Application](https://developers.deriv.com/docs/getting-started). If you just want to test quickly, Deriv's public demo App ID `1089` works for most read/trade calls.
2. **API token** — go to [app.deriv.com/account/api-token](https://app.deriv.com/account/api-token), create a token with the **Read**, **Trade**, and **Trading information** scopes, and copy it. Treat it like a password.

## 2. Run it locally

No dependencies to install. Any static file server works, e.g.:

```bash
npx serve .
# or
python3 -m http.server 8080
```

Then open the printed local URL in your browser.

## 3. Deploy to GitHub

```bash
git init
git add .
git commit -m "Initial commit: Ridgeline Deriv bot"
git branch -M main
git remote add origin https://github.com/<your-username>/<your-repo>.git
git push -u origin main
```

## 4. Deploy to Vercel

**Option A — Vercel dashboard**
1. Push the repo to GitHub (above).
2. Go to [vercel.com/new](https://vercel.com/new) and import the repository.
3. Framework preset: **Other** (it's a static site — no build command needed).
4. Deploy.

**Option B — Vercel CLI**
```bash
npm i -g vercel
vercel
```

Either way, Vercel serves `index.html`, `style.css`, and `app.js` as-is. The included `vercel.json` just enables clean URLs.

## Using the dashboard

1. Enter your **App ID** and **API token**, then **Connect**.
2. Pick a **symbol** (volatility index), **contract type**, **duration**, and **stake**.
3. Either:
   - Click **Buy Rise** / **Buy Fall** to place trades manually, or
   - Configure an **auto-trade strategy** and click **Start auto-trade**.

### Auto-trade strategies

| Strategy | Logic |
|---|---|
| Alternate | Flips direction after every completed trade |
| Trend follow | Compares the average of the first vs. second half of the last *N* ticks and trades with the slope |
| Counter-streak | Fades a run of 4+ same-direction ticks, betting on reversion |

### Money management

- **Flat** — every trade uses the same stake.
- **Martingale** — multiplies the stake by a chosen factor after each loss, up to a max number of steps, then resets. This increases risk fast — the max-steps cap and stop-loss field exist so a losing streak can't run away from you.

Set an optional **take-profit** / **stop-loss** in USD and auto-trade stops itself once either is hit.

## Customizing

- Add symbols: extend the `<optgroup>` list in `index.html` with any [Deriv-supported symbol](https://developers.deriv.com/docs/available-symbols).
- Add a strategy: add a function to the `Strategy` object in `app.js` and a case in `maybeAutoTrade()`.
- Everything else (colors, spacing, type) lives in `style.css` as CSS custom properties at the top of the file.

## File structure

```
.
├── index.html      UI markup
├── style.css       Theming and layout
├── app.js          Deriv WebSocket client, strategy engine, UI wiring
├── vercel.json     Deployment config
└── README.md
```
