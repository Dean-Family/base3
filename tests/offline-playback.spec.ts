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

test.describe('Offline UI - Integration', () => {
  test.beforeEach(async ({ page, context }) => {
    // Intercept music to keep it fast
    await context.route('**/music/**', (r) => r.fulfill({ status: 200, body: Buffer.alloc(1024), contentType: 'audio/mp4' }));
    
    await page.goto('/');
    await scorchedEarth(page);
    await page.reload();
    
    // Wait for real SW
    await expect.poll(() => page.evaluate(() => !!navigator.serviceWorker?.controller), { timeout: 20000 }).toBeTruthy();
  });

  test.afterEach(async ({ page }) => {
    await scorchedEarth(page);
  });

  test('OfflineUI - Successful Save - Button Transitions to Saved', async ({ page }) => {
    const track = page.locator('.track').first();
    const saveBtn = track.locator('.save-offline');
    
    await saveBtn.click();
    
    // UI should transition to Saved
    await expect(saveBtn).toHaveText('Saved', { timeout: 15000 });
    await expect(saveBtn).toBeDisabled();
    
    const removeBtn = track.locator('.remove-offline');
    await expect(removeBtn).not.toBeDisabled();
  });

  test('StorageManager - Persistence Request - Only Triggers on User Gesture', async ({ page }) => {
    // Mock navigator.storage.persist to track calls
    await page.evaluate(() => {
      (window as any).__persistCount = 0;
      if (navigator.storage && navigator.storage.persist) {
        const original = navigator.storage.persist.bind(navigator.storage);
        navigator.storage.persist = async () => {
          (window as any).__persistCount++;
          return true;
        };
      }
    });

    // Interaction triggers it (first save click in index.html logic)
    await page.locator('.save-offline').first().click();

    const count = await page.evaluate(() => (window as any).__persistCount);
    expect(count).toBe(1);
  });

  test('InstallFlow - BeforeInstallPrompt - Defers Android Install', async ({ page }) => {
    const prevented = await page.evaluate(() => {
      let isPrevented = false;
      const event = new Event('beforeinstallprompt') as any;
      event.preventDefault = () => { isPrevented = true; };
      window.dispatchEvent(event);
      return isPrevented;
    });
    expect(prevented).toBe(true);
  });
});
