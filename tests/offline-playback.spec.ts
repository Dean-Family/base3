import { test, expect, type Page } from '@playwright/test';

/**
 * RULE 3: Scorched Earth Teardown
 */
async function scorchedEarth(page: Page) {
  await page.evaluate(async () => {
    if (navigator.serviceWorker) {
      const regs = await navigator.serviceWorker.getRegistrations();
      for (const reg of regs) await reg.unregister();
    }
    const dbs = ['base3', 'base3-media'];
    for (const name of dbs) {
      const req = window.indexedDB.deleteDatabase(name);
      await new Promise((res) => {
        req.onsuccess = res; req.onerror = res; req.onblocked = res;
        setTimeout(res, 1000);
      });
    }
    window.localStorage.clear();
  });
}

/**
 * RULE 4: Service Worker Telemetry
 */
async function setupTelemetry(page: Page) {
  await page.evaluate(() => { (window as any).telemetryLog = []; });
  const cbName = `onTel_${Math.floor(Math.random() * 1e9)}`;
  await page.exposeFunction(cbName, (d: any) => {
    (window as any).telemetryLog?.push(d);
  });
  
  const browserScript = (name: string) => {
    if (navigator.serviceWorker) {
      navigator.serviceWorker.addEventListener('message', (e) => {
        if (e.data?.isTelemetry) {
          if (!(window as any).telemetryLog) (window as any).telemetryLog = [];
          (window as any).telemetryLog.push(e.data);
          (window as any)[name](e.data);
        }
      });
    }
  };

  await page.addInitScript(browserScript, cbName);
  await page.evaluate(browserScript, cbName);

  return {
    waitFor: async (type: string, timeout = 30000) => {
      await page.waitForFunction((t) => 
        (window as any).telemetryLog && (window as any).telemetryLog.some((m: any) => m.type === t), 
        type, { timeout }
      );
    }
  };
}

test.describe('Offline UI - Integration', () => {
  test.beforeEach(async ({ page, context }) => {
    await context.route('**/music/**', (r) => r.fulfill({ status: 200, body: Buffer.alloc(1024), contentType: 'audio/mp4' }));
    await page.goto('/');
    await scorchedEarth(page);
    await page.reload();
    await expect.poll(() => page.evaluate(() => !!navigator.serviceWorker?.controller), { timeout: 20000 }).toBeTruthy();
  });

  test.afterEach(async ({ page }) => {
    await scorchedEarth(page);
  });

  test('OfflineUI - Successful Save - Button Transitions to Saved', async ({ page }) => {
    const tel = await setupTelemetry(page);
    const track = page.locator('.track', { hasText: 'Lead with Your Hips' });
    const saveBtn = track.locator('.save-offline');
    
    await saveBtn.click();
    await tel.waitFor('IDB_WRITE_COMPLETE');
    
    // UI should transition to Saved
    await expect(saveBtn).toHaveText('Saved', { timeout: 15000 });
    await expect(saveBtn).toBeDisabled();
    
    const removeBtn = track.locator('.remove-offline');
    await expect(removeBtn).not.toBeDisabled();
  });

  test('StorageManager - Persistence Request - Only Triggers on User Gesture', async ({ page }) => {
    await page.evaluate(() => {
      (window as any).__persistCount = 0;
      if (navigator.storage && navigator.storage.persist) {
        navigator.storage.persist = async () => {
          (window as any).__persistCount++;
          return true;
        };
      }
    });

    await page.locator('.save-offline').first().click();
    const count = await page.evaluate(() => (window as any).__persistCount);
    expect(count).toBe(1);
  });

  test('InstallFlow - BeforeInstallPrompt - Defers Android Install', async ({ page }) => {
    // Wait for the app to be fully initialized
    await page.waitForFunction(() => (window as any).swReady !== undefined);

    const prevented = await page.evaluate(async () => {
      let isPrevented = false;
      // We need to use a custom event that supports preventDefault
      const event = new Event('beforeinstallprompt', { cancelable: true }) as any;
      event.preventDefault = () => { isPrevented = true; };
      
      window.dispatchEvent(event);
      return isPrevented;
    });
    expect(prevented).toBe(true);
  });
});
