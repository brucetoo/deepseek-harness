---
name: browser-task
description: Operate a public webpage through visible approved browser controls. Use for forms, buttons, links, and rendered page checks. Do not use for login, secrets, uploads, downloads, or private pages.
---

# Public Browser Task

Reject the task before opening a browser when it requires login, credentials, secrets, private or account-specific pages, uploads, downloads, popups, screenshots, canvas interaction, or coordinate-based control.

For a supported public-page task:

1. Call `browser_open` with the exact HTTP or HTTPS URL.
2. Read the returned ARIA snapshot and choose one element by its exact accessible `role` and `name`. Supply `index` only when the snapshot contains several exact matches.
3. Perform one `browser_click`, `browser_fill`, or `browser_select` action. Never put a password, token, private key, personal identifier, or other secret in `browser_fill`.
4. Inspect the fresh observation returned by the action. Use `browser_wait` only when the page is still updating, then inspect that returned observation.
5. Repeat the observe-one-action-observe sequence until the public task is complete.
6. Always call `browser_close`, including after an action fails or the user rejects approval.

Do not claim an action succeeded unless the observation after that action shows the expected state.
