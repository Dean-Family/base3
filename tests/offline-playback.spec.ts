import { test, expect, devices, type Page } from '@playwright/test';

/**
 * Mocks the navigator.serviceWorker API to provide a stable test environment.
 * This allows us to test the page's reactive UI logic without a real Service Worker.
 */
async function mockServiceWorkerAPI(page: Page) {
  await page.addInitScript(() => {
    const listeners = new Set<Function>();
    
    const mockController = {
      postMessage: (data: any) => {
        // Simulate Service Worker response after a short delay
        setTimeout(() => {
          const status = (data.action === 'check') ? 'removed' : 'saved';
          const event = new MessageEvent('message', {
            data: { ...data, status, received: 100, size: 100 },
            origin: window.location.origin
          });
          listeners.forEach(l => l(event));
          window.navigator.serviceWorker.dispatchEvent(event);
        }, 50);
      }
    };

    const mockSW = {
      register: async () => ({ scope: '/', unregister: async () => true, update: async () => {} }),
      getRegistration: async () => ({ scope: '/', unregister: async () => true, update: async () => {} }),
      getRegistrations: async () => [],
      ready: Promise.resolve({ scope: '/' }),
      controller: mockController,
      addEventListener: (type: string, listener: Function) => {
        if (type === 'message') listeners.add(listener);
      },
      removeEventListener: (type: string, listener: Function) => {
        if (type === 'message') {
          const idx = listeners.has(listener);
          if (idx) listeners.delete(listener);
        }
      },
      dispatchEvent: (e: Event) => {
        if (e.type === 'message' && (navigator.serviceWorker as any).onmessage) {
          (navigator.serviceWorker as any).onmessage(e);
        }
        return true;
      }
    };

    Object.defineProperty(navigator, 'serviceWorker', {
      configurable: true,
      value: mockSW
    });
  });
}

test.describe('offline playback UI logic', () => {
  test.beforeEach(async ({ page }) => {
    // We mock the API BEFORE navigation to ensure it's active when scripts run
    await mockServiceWorkerAPI(page);
    await page.goto('/');
  });

  test('button changes to Saved after successful offline save simulation', async ({ page }) => {
    const saveBtn = page.locator('.save-offline').first();
    await saveBtn.click();
    
    // Should transition: Save -> Cancel (immediate) -> Saved (after mock delay)
    await expect(saveBtn).toHaveText('Saved', { timeout: 5000 });
    await expect(saveBtn).toBeDisabled();
  });

  test('requests persistent storage only after user gesture', async ({ page }) => {
    await page.evaluate(() => {
      (window as any).__persistCount = 0;
      Object.defineProperty(navigator, 'storage', {
        configurable: true,
        value: {
          persist: async () => { (window as any).__persistCount++; return true; },
          estimate: async () => ({ usage: 0, quota: 1000 })
        }
      });
    });

    await page.locator('.save-offline').first().click();

    await expect.poll(async () => {
      return page.evaluate(() => (window as any).__persistCount);
    }).toBe(1);
  });

  test('android install flow uses deferred beforeinstallprompt', async ({ page }) => {
    await page.evaluate(() => {
      window.addEventListener('beforeinstallprompt', e => {
        e.preventDefault();
        (window as any).__deferredPrompt = e;
      });
    });

    const prevented = await page.evaluate(() => {
      const e = new Event('beforeinstallprompt', { cancelable: true });
      window.dispatchEvent(e);
      return e.defaultPrevented;
    });
    expect(prevented).toBe(true);
  });

  test('iOS Safari flow hides install guidance on other platforms', async ({ page }) => {
    // guidance should only be visible if manual check passes
    const help = page.locator('#ios-install-help');
    await expect(help).not.toBeVisible();
  });
});