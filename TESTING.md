# Testing Architecture

This project uses a Playwright-based test suite designed specifically for Progressive Web Apps (PWAs) with complex Service Worker and IndexedDB interactions.

## Core Mandates

To ensure reliable testing of real background APIs without the flakiness typical of PWA environments, the following rules MUST be followed:

### 1. Strict Naming Conventions
All tests must use the format: `[Component] - [Action/State] - [Expected Background Result]`.
*Example:* `MediaDownloader - Network Drop Mid-Save - Cleans Up Orphaned State`

### 2. Execution & Isolation
Real-storage tests must run sequentially.
*   **Config:** Use `playwright.real.config.ts`.
*   **Parallelism:** `fullyParallel: false` and `workers: 1` are mandatory to prevent Service Worker registration deadlocks and database connection conflicts.

### 3. Scorched Earth Teardown
Every test must start with a clean slate. The `beforeEach` hook must:
1.  Unregister all active Service Workers.
2.  Delete all origin-level IndexedDB databases (e.g., `base3`, `base3-media`).
3.  Clear all Cache Storage.
4.  Clear LocalStorage/SessionStorage.

### 4. Service Worker Telemetry
Do not use brittle timeouts. The Service Worker broadcasts state changes via `broadcastTelemetry`.
*   **Listening:** Tests use a robust `setupTelemetry` helper that captures these messages in the browser and exposes them to the test runner via `page.waitForFunction`.
*   **Signals:** Listen for `IDB_WRITE_COMPLETE`, `IDB_RECORD_DELETED`, or `UI_UPDATE`.

### 5. Chaos Testing
The suite includes tests that intentionally fracture state (e.g., mid-download reloads or network drops) to verify that the application recovers cleanly and does not leave partial/corrupt data in IndexedDB.

## Running Tests

To run the full suite with the correct isolation settings:

```bash
npx playwright test -c playwright.real.config.ts
```

## Debugging
*   **SW Logs:** Service Worker `console.log` and `console.error` calls are forwarded as telemetry (`SW_LOG`) and will appear in the test runner's console.
*   **UI Status:** The `UI_UPDATE` telemetry signal is used to ensure the page's React/UI logic is synchronized with the background worker state.
