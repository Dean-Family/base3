import { test, expect, type Page, type BrowserContext } from '@playwright/test';

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
  // Initialize log in browser
  await page.evaluate(() => { (window as any).telemetryLog = []; });
  
  const cbName = `onTel_${Math.floor(Math.random() * 1e9)}`;
  // exposeFunction is ONLY for Node-side logging
  await page.exposeFunction(cbName, (d: any) => {
    console.log(`[TELEMETRY] ${d.type}`, d);
  });
  
  const browserScript = (name: string) => {
    if (navigator.serviceWorker) {
      navigator.serviceWorker.addEventListener('message', (e) => {
        if (e.data?.isTelemetry) {
          if (!(window as any).telemetryLog) (window as any).telemetryLog = [];
          (window as any).telemetryLog.push(e.data);
          (window as any)[name](e.data); // Log to Node too
        }
      });
    }
  };

  await page.addInitScript(browserScript, cbName);
  await page.evaluate(browserScript, cbName);

  return {
    waitFor: async (type: string, timeout = 30000) => {
      console.log(`[TEST] Waiting for telemetry: ${type}...`);
      await page.waitForFunction((t) => 
        (window as any).telemetryLog && (window as any).telemetryLog.some((m: any) => m.type === t), 
        type, { timeout }
      );
      const msg = await page.evaluate((t) => (window as any).telemetryLog.find((m:any) => m.type === t), type);
      console.log(`[TEST] Telemetry ${type} detected.`);
      return msg;
    }
  };
}

test.describe('Real Storage - Media Persistence', () => {
  test.beforeEach(async ({ page, context }) => {
    page.on('console', msg => { if (!msg.text().includes('GET /')) console.log(`[BROWSER] ${msg.text()}`); });
    
    await context.route('**/music/**', async (route) => {
      if (route.request().url().includes('Lead_with_Your_Hips')) return route.continue();
      await route.fulfill({ status: 200, body: Buffer.alloc(1024), contentType: 'audio/mp4' });
    });

    await page.goto('/');
    await scorchedEarth(page);
    await page.reload();
    await expect.poll(() => page.evaluate(() => !!navigator.serviceWorker?.controller), { timeout: 20000 }).toBeTruthy();
  });

  test.afterEach(async ({ page }) => { await scorchedEarth(page); });

  test('MediaDownloader - Successful Save - Persists Audio In IDB', async ({ page }) => {
    const tel = await setupTelemetry(page);
    const track = page.locator('.track', { hasText: 'Lead with Your Hips' });
    const saveBtn = track.locator('.save-offline');
    
    await page.context().route('**/music/Lead_with_Your_Hips.*', (r) => r.fulfill({ status: 200, body: Buffer.alloc(1024), contentType: 'audio/mp4' }));

    await saveBtn.click();
    await tel.waitFor('IDB_WRITE_COMPLETE');
    
    // Wait for UI to sync
    await expect(saveBtn).toHaveText('Saved', { timeout: 10000 });
    
    const count = await page.evaluate(async () => {
      const db = await new Promise<IDBDatabase>((res) => { const r = indexedDB.open('base3-media', 1); r.onsuccess = () => res(r.result); });
      const c = await new Promise<number>((res) => { const r = db.transaction('tracks').objectStore('tracks').count(); r.onsuccess = () => res(r.result); });
      db.close(); return c;
    });
    expect(count).toBe(1);
  });

  test('MediaDownloader - Manual Removal - Purges All Related Storage', async ({ page }) => {
    const tel = await setupTelemetry(page);
    const track = page.locator('.track', { hasText: 'Lead with Your Hips' });
    const saveBtn = track.locator('.save-offline');
    const removeBtn = track.locator('.remove-offline');
    
    await page.context().route('**/music/Lead_with_Your_Hips.*', (r) => r.fulfill({ status: 200, body: Buffer.alloc(1024), contentType: 'audio/mp4' }));

    await saveBtn.click();
    await tel.waitFor('IDB_WRITE_COMPLETE');
    await expect(saveBtn).toHaveText('Saved', { timeout: 10000 });

    await removeBtn.click();
    await tel.waitFor('IDB_RECORD_DELETED');
    await expect(saveBtn).toHaveText('Save for offline', { timeout: 10000 });
    
    const count = await page.evaluate(async () => {
      const db = await new Promise<IDBDatabase>((res) => { const r = indexedDB.open('base3-media', 1); r.onsuccess = () => res(r.result); });
      const c = await new Promise<number>((res) => { const r = db.transaction('tracks').objectStore('tracks').count(); r.onsuccess = () => res(r.result); });
      db.close(); return c;
    });
    expect(count).toBe(0);
  });

  test('MediaDownloader - Network Drop Mid-Save - Cleans Up Orphaned State', async ({ page, context }) => {
    const tel = await setupTelemetry(page);
    await context.route('**/music/Lead_with_Your_Hips.*', async (route) => {
      await new Promise(res => setTimeout(res, 3000));
      await route.fulfill({ status: 200, body: Buffer.alloc(1024), contentType: 'audio/mp4' });
    });

    const track = page.locator('.track', { hasText: 'Lead with Your Hips' });
    const saveBtn = track.locator('.save-offline');
    await saveBtn.click();
    await expect(saveBtn).toHaveText(/Cancel/, { timeout: 5000 });
    
    await context.setOffline(true);
    await saveBtn.click(); // Abort
    await expect(saveBtn).toHaveText('Save for offline', { timeout: 10000 });
    await context.setOffline(false);

    const count = await page.evaluate(async () => {
      const db = await new Promise<IDBDatabase>((res) => { const r = indexedDB.open('base3-media', 1); r.onsuccess = () => res(r.result); });
      const c = await new Promise<number>((res) => { const r = db.transaction('tracks').objectStore('tracks').count(); r.onsuccess = () => res(r.result); });
      db.close(); return c;
    });
    expect(count).toBe(0);
  });

  test('MediaDownloader - Page Reload Mid-Save - Prevents Partial IDB Corruption', async ({ page, context }) => {
    const tel = await setupTelemetry(page);
    await context.route('**/music/Lead_with_Your_Hips.*', async (route) => {
      await new Promise(res => setTimeout(res, 5000));
      await route.fulfill({ status: 200, body: Buffer.alloc(1024), contentType: 'audio/mp4' });
    });

    const track = page.locator('.track', { hasText: 'Lead with Your Hips' });
    const saveBtn = track.locator('.save-offline');
    await saveBtn.click();
    await expect(saveBtn).toHaveText(/Cancel/, { timeout: 5000 });

    await page.reload();
    // After reload, verify IDB is clean
    const count = await page.evaluate(async () => {
      try {
        const db = await new Promise<IDBDatabase>((res) => { const r = indexedDB.open('base3-media', 1); r.onsuccess = () => res(r.result); });
        const c = await new Promise<number>((res) => { const r = db.transaction('tracks').objectStore('tracks').count(); r.onsuccess = () => res(r.result); });
        db.close(); return c;
      } catch(e) { return 0; }
    });
    expect(count).toBe(0);
  });
});
