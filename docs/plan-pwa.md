# Plan: make the dashboard a Progressive Web App

Status: proposed, 2026-10-31. Nothing implemented yet.

## What gets converted

The PWA is the Next.js 16 dashboard in `web/`, deployed on Vercel. The Hono API and the
worker stay as they are, except for the optional push phase.

What the dashboard looks like today, and why it matters for a PWA:

| Fact | Consequence |
|---|---|
| Pages are server components that call the API with `SENTINEL_API_TOKEN` (`src/lib/api.ts`) | The browser never sees the API. Offline data must come from cached pages, not from API calls. |
| Every page and `/api/*` route is gated by Clerk (`src/proxy.ts`, `src/lib/auth.ts`) | Cached pages hold one user's compliance findings. Caches must be cleared on sign-out. |
| The proxy matcher already skips `.js`, `.png` and `.webmanifest` | `sw.js`, icons and the manifest are served without Clerk. No matcher change needed. |
| No `public/` folder, no manifest, no icons | All install assets are new. |
| Dark theme only (`<html className="dark">`) | One `theme_color` and `background_color`. |
| Builds use Turbopack | Avoid `next-pwa` and webpack-only Serwist setups. Write the service worker by hand, as the Next.js PWA guide does. |
| `refresh-while.tsx` polls `/api/runs` every 4 s and reloads | Must pause when the app is hidden or offline, or an installed app keeps polling in the background. |
| Reports come from `/api/reports/[id]`, which may redirect to a signed bucket URL | The service worker must not cache reports; signed URLs expire. |

## Phase 1: installable (about half a day)

Goal: Chrome, Edge and Android offer "Install", iOS "Add to Home Screen" gives a proper icon
and a standalone window.

1. **Icons.** Add `web/public/icons/` with 192, 512 and a 512 maskable PNG, plus
   `src/app/apple-icon.png` (180) and `src/app/icon.png`. Start from the ShieldCheck mark on the
   brand gradient; swap in real artwork later.
2. **Manifest.** Add `src/app/manifest.ts` returning `MetadataRoute.Manifest`:
   `name` "Compliance Sentinel", `short_name` "Sentinel", `start_url` "/overview",
   `scope` "/", `display` "standalone", `background_color` and `theme_color` equal to the
   `--background` token, the icons above, and `shortcuts` for Runs and Rules.
3. **Metadata.** In `src/app/layout.tsx` add `appleWebApp: { capable: true, title: "Sentinel",
   statusBarStyle: "black-translucent" }` and export `viewport` with `themeColor` and
   `viewportFit: "cover"`.
4. **Safe areas.** In `app-shell.tsx`, pad the sticky header and footer with
   `env(safe-area-inset-*)` so the notch and home bar do not cover them in standalone mode.

## Phase 2: service worker and offline fallback (about one day)

Goal: the app shell loads instantly, and a lost connection shows a clear offline page
instead of the browser's error.

1. **`web/public/sw.js`, hand-written, versioned by a `CACHE_VERSION` constant.**
   - Precache on install: `/offline`, the icons, the manifest.
   - `/_next/static/*` and fonts: cache-first. These files are content-hashed, so they never go stale.
   - Page navigations: network-first, falling back to `/offline`. Do not store the HTML.
   - Never touch: `/api/*`, RSC requests (`RSC` header or `_rsc` query), Clerk's domains and
     `/sign-in`, `/__clerk`, and any non-GET request.
   - `activate`: delete caches from older versions, then `clients.claim()`.
2. **`src/app/offline/page.tsx`.** Static, no auth, no data. Says you are offline and offers a retry.
   Exclude it from the Clerk check in the dashboard layout.
3. **Registration.** A small client component, `src/components/sw-register.tsx`, mounted in the root
   layout. Register only when `process.env.NODE_ENV === "production"` so dev chunks are never cached.
   Use `updateViaCache: "none"`.
4. **Updates.** When a new worker is waiting, show a "New version available, reload" toast, then
   post `SKIP_WAITING`. Without this, installed users run an old build until every tab closes.
5. **Headers.** In `next.config.ts`, serve `/sw.js` with `Cache-Control: no-cache` and
   `Content-Type: application/javascript`.
6. **Sign-out.** In `user-menu.tsx`, before Clerk's sign-out, call `caches.keys()` and delete every
   cache, so no findings remain on a shared machine.
7. **Polling.** In `refresh-while.tsx`, skip polls while `document.hidden` or `!navigator.onLine`, and
   poll once on `visibilitychange` and `online`.

## Phase 3 (optional): read recent runs offline (about one day)

Only if offline reading is wanted. It stores sensitive data on the device, so it is a product call.

- Cache the HTML of `/overview`, `/runs` and the last 10 `/runs/[id]` pages the user opened,
  stale-while-revalidate, in a separate `pages-v1` cache with a 24 hour expiry.
- Show a "Viewing a saved copy from 10:42" banner when a page came from cache.
- Disable "Run audit", the source switches and digest controls while offline.
- Phase 2's sign-out purge already covers this cache.

## Phase 4 (optional): push alerts for critical findings (two to three days)

Today `notifyCritical` in `src/notify/index.ts` sends to Slack and email. Web push becomes a third channel.

1. **Keys.** Generate VAPID keys. Add `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY` and `VAPID_SUBJECT`
   to `.env.example` and Fly secrets, and `NEXT_PUBLIC_VAPID_PUBLIC_KEY` to Vercel.
2. **Storage.** Drizzle migration for `push_subscriptions`: id, Clerk user id, endpoint (unique),
   p256dh, auth, created_at, last_success_at.
3. **API.** In `src/web/server.ts` add `POST /push/subscriptions` and `DELETE /push/subscriptions`,
   behind the existing run-trigger token. Proxy them through new Next routes under
   `src/app/api/push/`, which attach the Clerk user id.
4. **Sending.** Add `src/notify/webpush.ts` using the `web-push` package. Payload: run id, count of
   critical findings, regulation. Delete a subscription on a 404 or 410 reply.
5. **Service worker.** Handle `push` with `showNotification`, and `notificationclick` by focusing an
   open window or opening `/runs/:id`.
6. **UI.** A "Push alerts on this device" toggle on the Settings page. Ask for permission only on that
   click, never on page load.
7. **iOS caveat.** Push works on iOS 16.4 and later, and only after "Add to Home Screen". Say so next
   to the toggle.

## Testing

- **Playwright** (`web/`, using the existing `E2E_BYPASS_CLERK` build): the manifest returns valid
  JSON with the icons; `sw.js` registers and controls the page; with `context.setOffline(true)` a
  navigation shows the offline page; `/api/*` responses never appear in `caches`.
- **Manual:** Chrome DevTools, Application panel, for installability and the worker's state. Install
  on Android Chrome and on an iPhone. On iOS, check that the Clerk sign-in stays inside the
  standalone window and that the report download still opens.
- **Lighthouse** no longer has a PWA category, so do not use it as the pass mark.

## Risks

- **Stale builds.** A bad service worker can pin users to an old version. The versioned cache,
  `no-cache` header and update toast cover this. Keep a kill-switch `sw.js` ready that unregisters
  itself.
- **Clerk in standalone mode.** Hosted sign-in or OAuth redirects can leave the standalone window on
  iOS. Test early in Phase 1.
- **Sensitive data at rest.** Phases 1 and 2 store no findings. Phase 3 does, which is why it is optional.

## Files touched

Phases 1 and 2 touch only `web/`:

- New: `public/sw.js`, `public/icons/*`, `src/app/manifest.ts`, `src/app/apple-icon.png`,
  `src/app/icon.png`, `src/app/offline/page.tsx`, `src/components/sw-register.tsx`,
  `tests/e2e/pwa.spec.ts`
- Changed: `src/app/layout.tsx`, `src/components/app-shell.tsx`, `src/components/auth/user-menu.tsx`,
  `src/components/refresh-while.tsx`, `next.config.ts`

Phase 4 also touches the root project: `src/web/server.ts`, `src/db/schema.ts`, a migration,
`src/notify/webpush.ts`, `src/notify/index.ts`, `.env.example` and `package.json`.

## Decisions needed

1. Should offline reading of recent runs (Phase 3) be in scope, given it stores findings on devices?
2. Should push alerts (Phase 4) be in scope, or are Slack and email enough?
3. Is there real icon artwork, or should the placeholder ShieldCheck icon ship first?
