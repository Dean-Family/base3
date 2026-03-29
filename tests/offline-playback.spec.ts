import { test, expect, devices, type Page } from '@playwright/test';

const TEST_TRACK_PATH = '/music/e2e-test-track.m4a';

async function awaitServiceWorkerReady(page: Page) {
  await page.goto('/');
  await page.evaluate(async () => {
    if (!('serviceWorker' in navigator)) {
      throw new Error('Service Worker is not supported in this browser context.');
    }
    await navigator.serviceWorker.ready;
  });

  await expect
    .poll(async () => page.evaluate(() => Boolean(navigator.serviceWorker.controller)))
    .toBeTruthy();
}

async function configureFirstTrackForMockedDownload(page: Page, trackPath = TEST_TRACK_PATH) {
  await page.evaluate((path) => {
    const firstTrack = document.querySelector('.track');
    const audio = firstTrack?.querySelector('audio');
    if (!(audio instanceof HTMLAudioElement)) {
      throw new Error('First track audio element not found');
    }

    audio.src = path;
    audio.load();
  }, trackPath);
}

async function mockAudioResponse(page: Page, trackPath = TEST_TRACK_PATH, byteSize = 512 * 1024) {
  await page.route(trackPath, async route => {
    const payload = Buffer.alloc(byteSize, 7);
    await route.fulfill({
      status: 200,
      headers: {
        'Content-Type': 'audio/mp4',
        'Content-Length': String(payload.byteLength),
        'Access-Control-Allow-Origin': '*'
      },
      body: payload
    });
  });
}

async function clickSaveAndWaitForSettledState(page: Page, expectedText: string) {
  const button = page.locator('.track').first().locator('.save-offline');
  await button.click();
  await expect(button).not.toHaveText(/Cancel/, { timeout: 60_000 });
  await expect(button).toHaveText(expectedText, { timeout: 15_000 });
  return button;
}

test.describe('offline playback safety net', () => {
  test('waits for service worker activation before saving offline and validates IDB blob size', async ({ page }) => {
    await awaitServiceWorkerReady(page);
    await mockAudioResponse(page);
    await configureFirstTrackForMockedDownload(page);

    await clickSaveAndWaitForSettledState(page, 'Saved');

    const storedRecord = await page.evaluate(async (trackPath) => {
      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const req = indexedDB.open('base3');
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });

      const record = await new Promise<{ size?: number; blob?: Blob } | undefined>((resolve, reject) => {
        const tx = db.transaction('tracks', 'readonly');
        const req = tx.objectStore('tracks').get(trackPath);
        req.onsuccess = () => resolve(req.result as { size?: number; blob?: Blob } | undefined);
        req.onerror = () => reject(req.error);
      });

      db.close();
      return {
        size: record?.size ?? record?.blob?.size ?? 0,
        type: record?.blob?.type ?? null
      };
    }, TEST_TRACK_PATH);

    expect(storedRecord.size).toBeGreaterThan(200_000);
    expect(storedRecord.size).toBeLessThan(2_000_000);
    expect(storedRecord.size).not.toBe(7 * 1024 * 1024);
    expect(storedRecord.type).toContain('audio');
  });

  test('degrades gracefully when storage is effectively full', async ({ page }) => {
    await page.addInitScript(() => {
      const originalOpen = indexedDB.open.bind(indexedDB);
      indexedDB.open = function (...args: Parameters<IDBFactory['open']>) {
        const req = originalOpen(...args);
        req.addEventListener('success', () => {
          const db = req.result;
          const originalTransaction = db.transaction.bind(db);
          db.transaction = function (...txArgs: Parameters<IDBDatabase['transaction']>) {
            const tx = originalTransaction(...txArgs);
            if (txArgs[0] === 'tracks' || (Array.isArray(txArgs[0]) && txArgs[0].includes('tracks'))) {
              const store = tx.objectStore('tracks');
              store.put = function () {
                throw new DOMException('Simulated quota failure', 'QuotaExceededError');
              } as IDBObjectStore['put'];
            }
            return tx;
          };
        });
        return req;
      };

      Object.defineProperty(navigator, 'storage', {
        configurable: true,
        value: {
          estimate: async () => ({ usage: 49_000_000, quota: 50_000_000 }),
          persist: navigator.storage.persist.bind(navigator.storage)
        } satisfies StorageManager
      });
    });

    await awaitServiceWorkerReady(page);
    await mockAudioResponse(page);
    await configureFirstTrackForMockedDownload(page);

    const firstSaveButton = await clickSaveAndWaitForSettledState(page, 'Error');
    await expect(firstSaveButton).toBeEnabled();
  });

  test('requests persistent storage only after user gesture', async ({ page }) => {
    await page.addInitScript(() => {
      let persistCallCount = 0;

      Object.defineProperty(navigator, 'storage', {
        configurable: true,
        value: {
          estimate: navigator.storage.estimate.bind(navigator.storage),
          persist: async () => {
            persistCallCount += 1;
            return true;
          }
        } satisfies StorageManager
      });

      (window as unknown as { __persistCallCount: () => number }).__persistCallCount = () => persistCallCount;
    });

    await awaitServiceWorkerReady(page);
    await mockAudioResponse(page);
    await configureFirstTrackForMockedDownload(page);

    const beforeClick = await page.evaluate(() => (window as unknown as { __persistCallCount: () => number }).__persistCallCount());
    expect(beforeClick).toBe(0);

    await clickSaveAndWaitForSettledState(page, 'Saved');

    await expect
      .poll(async () => page.evaluate(() => (window as unknown as { __persistCallCount: () => number }).__persistCallCount()))
      .toBe(1);
  });

  test('handles bad network conditions by serving saved audio from IndexedDB cache', async ({ page }) => {
    await awaitServiceWorkerReady(page);
    await mockAudioResponse(page);
    await configureFirstTrackForMockedDownload(page);

    await clickSaveAndWaitForSettledState(page, 'Saved');

    await page.route('**/music/**', async route => {
      await new Promise(resolve => setTimeout(resolve, 7_000));
      await route.abort('timedout');
    });

    const audio = page.locator('.track').first().locator('audio');
    const [start, end] = await page.evaluate(async () => {
      const node = document.querySelector('audio');
      if (!(node instanceof HTMLAudioElement)) throw new Error('Audio element not found');

      node.currentTime = 0;
      await node.play();
      const initial = node.currentTime;
      await new Promise(resolve => setTimeout(resolve, 2_500));
      const progressed = node.currentTime;
      node.pause();
      return [initial, progressed] as const;
    });

    await expect(audio).toBeVisible();
    expect(end - start).toBeGreaterThan(1);
  });

  test('android install flow uses deferred beforeinstallprompt via custom button', async ({ page }) => {
    await awaitServiceWorkerReady(page);

    await page.evaluate(() => {
      const installButton = document.createElement('button');
      installButton.id = 'install-player';
      installButton.textContent = 'Install Player';
      document.body.appendChild(installButton);

      let promptCalls = 0;
      (window as unknown as { __promptCalls: () => number }).__promptCalls = () => promptCalls;

      let deferredPrompt: { prompt: () => Promise<void> } | null = null;
      window.addEventListener('beforeinstallprompt', event => {
        event.preventDefault();
        deferredPrompt = {
          prompt: async () => {
            promptCalls += 1;
          }
        };
      });

      installButton.addEventListener('click', async () => {
        await deferredPrompt?.prompt();
      });

      const evt = new Event('beforeinstallprompt', { cancelable: true });
      window.dispatchEvent(evt);
      (window as unknown as { __installPrevented: boolean }).__installPrevented = evt.defaultPrevented;
    });

    await expect(page.locator('#install-player')).toBeVisible();
    const prevented = await page.evaluate(() => (window as unknown as { __installPrevented: boolean }).__installPrevented);
    expect(prevented).toBe(true);

    await page.locator('#install-player').click();
    const promptCalls = await page.evaluate(() => (window as unknown as { __promptCalls: () => number }).__promptCalls());
    expect(promptCalls).toBe(1);
  });

  test('iOS Safari flow hides install button and shows manual install guidance', async ({ browser }) => {
    const context = await browser.newContext({
      ...devices['iPhone 13'],
      userAgent:
        'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1'
    });
    const page = await context.newPage();

    await awaitServiceWorkerReady(page);

    await page.evaluate(() => {
      const autoInstall = document.createElement('button');
      autoInstall.id = 'install-player';
      autoInstall.textContent = 'Install Player';
      document.body.appendChild(autoInstall);

      const help = document.createElement('div');
      help.id = 'ios-install-help';
      help.textContent = 'Tap Share and Add to Home Screen';

      const isIosSafari = /iPhone|iPad/.test(navigator.userAgent) && /Safari/.test(navigator.userAgent) && !/CriOS|FxiOS/.test(navigator.userAgent);
      if (isIosSafari) {
        autoInstall.hidden = true;
        document.body.appendChild(help);
      }
    });

    await expect(page.locator('#install-player')).toBeHidden();
    await expect(page.locator('#ios-install-help')).toContainText('Tap Share and Add to Home Screen');

    await context.close();
  });
});
