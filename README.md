# Expense Tracker

Scan a receipt, speak an expense, or type it in. Everything lands in a Google Sheet; receipt photos go into a Drive folder next to it.

```
Your phone (installable web app)  ──►  Google Apps Script (your own tiny backend)  ──►  Google Sheet + Drive "Receipts" folder
        instant local copy                       └─► Claude API (reads receipts / spoken text)
```

- `docs/` is the phone app (served by GitHub Pages) (host it anywhere static, e.g. GitHub Pages).
- `backend/` is the Apps Script code (`Code.gs`, `appsscript.json`).

## Setup (about 15 minutes, one time)

### 1. Get an Anthropic API key
1. Go to **console.anthropic.com** and sign in (this is separate from a Claude chat subscription).
2. **Billing**: add a small prepaid credit balance (a few dollars lasts a long time; a receipt scan is typically around a cent or less).
3. **API keys** → **Create key**. Copy it (it starts with `sk-ant-`). You only see it once.

### 2. Create the backend
1. Go to **script.google.com** → **New project**. Name it "Expense Tracker backend".
2. Replace the contents of `Code.gs` with `backend/Code.gs`.
3. **Project Settings** (gear) → tick **Show "appsscript.json" manifest file in editor**. Open `appsscript.json` and replace it with `backend/appsscript.json`.
4. Select the function **`setup`** and click **Run**. Approve the permissions (Google warns the app is unverified because you wrote it: **Advanced → Go to project**).
5. Open **Execution log**. Copy the **APP TOKEN** it prints. You can re-print it any time by running `showToken`.
   This creates `Expense Tracker/` in your Drive containing the **Expenses** sheet and a **Receipts** folder.
6. **Project Settings → Script Properties → Add property**: name `ANTHROPIC_API_KEY`, value = your key.
7. **Deploy → New deployment → Web app**: Execute as **Me**, Who has access **Anyone**. Deploy and copy the **Web app URL** (ends in `/exec`).
   "Anyone" only means the URL is reachable. Every request must carry your secret token, so strangers can't read or write anything.

> After editing `Code.gs` later, use **Deploy → Manage deployments → Edit → New version** so the URL stays the same.

### 3. Host the app
Put the contents of `docs/` on any HTTPS static host. GitHub Pages is the easiest (free). The app files contain no secrets.

### 4. Install on your Android phone
1. Open this link once in Chrome (fill in your two values):
   `https://YOUR-APP-URL/?u=YOUR_WEB_APP_URL&t=YOUR_APP_TOKEN`
   The app saves them and removes them from the address bar.
2. Chrome menu **⋮ → Install app** (or **Add to Home screen**).
3. Open it from the icon. Allow **camera** and **microphone** when asked (choose "Allow every time" or "While using the app" so the camera opens instantly).

## Using it
- **Open the app**: the camera is live. Tap the shutter. Claude reads the date, vendor, total, currency and suggests a category. Check it and tap **Save**.
- **Enter manually**: the button above the shutter.
- **Mic button**: say "forty-five ringgit fuel at Petronas yesterday for the business".
- **Foreign currency**: pick the currency; the app looks up the rate for that date and shows the MYR amount. Overwrite the **Charged in MYR** box with your card statement figure for exactness.
- **For**: Personal plus any businesses. Add more in **Settings → Businesses**, or from the "For" dropdown, or the chip at the top-left of the camera.
- **Summary tab**: period, business/personal, categories, search, sort (largest/smallest/newest/oldest), group by category / entity / time, and Pie / Column / Bar / Line charts. Tap a breakdown row to filter on it.
- **Offline**: expenses save instantly on the phone and sync when you're back online (the badge on the camera screen shows status).

## Sheet columns
`ID · Date · Entity · Category · Vendor · Details · Amount · Currency · Rate to MYR · Amount MYR · Source · Receipt link · Receipt file ID · Created · Updated`

You can sort/pivot the sheet freely, but avoid deleting the ID column. Edits you make directly in the sheet appear in the app on the next sync.

## Privacy and cost
- Receipt photos and spoken text are sent to Anthropic's API (through your own backend) only to be read. They are not otherwise shared.
- The Apps Script runs as you, in your Google account. The token is the only gate, so don't share the setup link.
