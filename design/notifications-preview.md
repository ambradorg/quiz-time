# Notification center — visual concept

Open `/notifications-preview` while the Next.js app is running. The route needs no sign-in and is deliberately separate from the real app. Existing app environment configuration still applies; the preview itself does not query the database.

## Recommended first version

An in-app bell with an unread badge and a notification center:

- **Study reminders:** cards due for spaced review, grouped by study set.
- **Study sets ready:** successful flashcard generation, with a link to the set.
- **Learning milestones:** occasional encouragement at meaningful thresholds.
- **Sync updates:** confirmation after offline answers sync, not after every answer.

Keep updates in the inbox during a quiz rather than displaying interrupting pop-ups. Browser push and email should be separate, explicit opt-ins in a later phase.

## What the preview demonstrates

- Four sample notifications, with three initially unread.
- All/unread filters, individual and bulk read actions, and an empty state.
- Bell open/close, Escape to close, and focus returned to the bell.
- Sample action destinations (not real study sessions).
- Preference switches held only in component state; they do not filter existing history or affect account settings.
- A reset button and responsive desktop/mobile layouts.

`notifications-preview.png` is a screenshot of the initial state. All names, counts, times, and achievements are sample data. No delivery, persistence, scheduling, permissions, database changes, or integration with the main app has been implemented.

## Validation

With the development server running and Playwright Chromium installed:

```sh
node --test scripts/notifications-preview.test.mjs
npm run typecheck
npx eslint src/app/notifications-preview scripts/notifications-preview.test.mjs
```

The browser test supports `PREVIEW_BASE_URL` and `CHROMIUM_EXECUTABLE_PATH` for custom environments. It checks read counts, filters, the empty state, preferences, sample navigation, focus restoration, Escape dismissal, and horizontal overflow at 320, 390, 768, and 1440 pixels.

## Update: the concept shipped

The in-app bell + inbox and the outside-app web push reminder are now real
features (see README → "Notifications (daily review reminders)"). This page
remains as the standalone, no-sign-in design showcase; the live notification
center lives behind the bell in the signed-in app
(`src/components/notification-center.tsx`), and `notification-center-app.png`
in this folder shows it in the real app shell.
