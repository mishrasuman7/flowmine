# FlowMine — Chrome Extension

Manifest V3 extension that observes browser metadata and, in a later milestone, executes generated skills.

## Build

```bash
pnpm install
pnpm build      # one-shot, writes ./dist
pnpm watch      # rebuild on save
```

Load `dist/` into Chrome via `chrome://extensions` → **Load unpacked**.

## Files

| File | Purpose |
|------|---------|
| `manifest.json`  | MV3 manifest copied verbatim into `dist/`. |
| `background.ts`  | Service worker. Captures events, buffers in `chrome.storage.local`, flushes to `/api/events` every 60 s. |
| `popup.ts` / `popup.html` | Settings UI: team id, user id, API URL, last-flush diagnostics. |
| `types.ts`       | Local copy of `BrowserEvent` / `BrowserEventType` matching `web/lib/types.ts`. |
| `build.mjs`      | esbuild driver: bundles `background.ts` and `popup.ts`, copies static assets into `dist/`. |
