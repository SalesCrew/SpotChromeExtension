# Spot Fragebogen Assistant

Chrome extension for reviewing Spot questionnaire text answers with the OpenAI API. It reads the visible Spot question context, asks the model for concise corrections/improvements, and renders clean replacement suggestions directly below each text input.

## Recommended Setup

Use the small server proxy in `server/` for production. There is no database. The server only forwards the current field batch to OpenAI and returns structured suggestions, so the API key stays on your server instead of every worker's browser.

```powershell
cd "C:\Users\kilia\OneDrive\Documents\Spot Extension\server"
Copy-Item .env.example .env
notepad .env
npm start
```

Or set the key only for the current PowerShell session:

```powershell
$env:OPENAI_API_KEY = "sk-..."
npm start
```

Then load the extension:

1. Open `chrome://extensions`.
2. Enable Developer mode.
3. Click Load unpacked.
4. Select `C:\Users\kilia\OneDrive\Documents\Spot Extension\extension`.
5. Open the extension options and keep the server URL as `https://spotchromeextension-production.up.railway.app/v1/review`.

## Model Note

The current OpenAI docs list `gpt-5.5` as the latest flagship model, and list the lower-cost smaller variants as `gpt-5.4-mini` and `gpt-5.4-nano`. I set the default to `gpt-5.4-nano` for the lowest-latency/cost setup. If OpenAI releases or your account has access to `gpt-5.5-nano`, put that exact model string into the extension options or `OPENAI_MODEL`.

## Direct Mode

The extension also supports direct browser-to-OpenAI calls. This is convenient for testing, but not ideal for company rollout because every installed browser needs an API key stored locally in Chrome extension storage.

## Spot Behavior

The pasted Spot page uses disabled/read-only inputs on the controlling view. The extension can still insert the suggested text into the page field for review, but Spot may require an editable mode or the right permissions before that changed value can be saved server-side.

## What It Checks

- Grammar, typos, punctuation, and casing.
- One-word or very short answers are not flagged only because a final period is missing.
- Too-short answers when the question expects prose.
- Too-short improvements expand the original answer by one or two concise sentences, using only the answer and question context.
- Informal or unbusinesslike wording.
- Short answers that make sense in context, such as dates, times, IDs, names, or numbers, are marked as nothing to improve.

The UI shows `Keine Tippfehler` and `Nichts zu verbessern` when no edit is needed.

## Railway Hosting

This backend can run on Railway without a database. Deploy the repo as a Node.js service and set these service variables in Railway:

```env
OPENAI_API_KEY=sk-...
OPENAI_MODEL=gpt-5.4-nano
ALLOWED_ORIGIN=*
```

Railway provides `PORT` automatically, and the root `npm start` command runs `server/server.js`. After deployment, generate a public Railway domain and put this in the extension options:

```text
https://spotchromeextension-production.up.railway.app/v1/review
```
