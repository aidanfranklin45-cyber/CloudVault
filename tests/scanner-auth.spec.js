// @ts-check
const { test, expect } = require('@playwright/test');

// ---------------------------------------------------------------------------
// Supabase project base URL — all REST/RPC traffic goes here.
// ---------------------------------------------------------------------------
const SB_URL = 'https://xbxvebnrjryvksvtufqj.supabase.co';

// URL pattern for login page — `serve` may strip the .html extension
// so accept both /login and /login.html
const LOGIN_URL_RE  = /\/login(\.html)?$/;
const ADMIN_URL_RE  = /\/admin(\.html)?/;

// ---------------------------------------------------------------------------
// Helper: fire individual keystrokes at a controlled inter-key delay.
// Does NOT use page.keyboard.type() because that bypasses the key-timing
// logic the scanner listener reads from Date.now().
// ---------------------------------------------------------------------------
/**
 * @param {import('@playwright/test').Page} page
 * @param {string} str    Characters to send (do NOT include the final Enter)
 * @param {number} delayMs  Pause between each keydown (ms)
 */
async function typeAtSpeed(page, str, delayMs) {
  for (const char of str) {
    await page.keyboard.press(char);
    await page.waitForTimeout(delayMs);
  }
}

// ---------------------------------------------------------------------------
// Test suite: HID Scanner Auth — login.html
//
// Strategy:
//   1. Load /login.html with ALL its real scripts (supabase-config.js,
//      initGlobalBadgeScanner, authenticateEmployeeBadge) unchanged.
//   2. Mock Supabase network calls at the HTTP layer using page.route so no
//      real database traffic leaves the browser.
//   3. Dispatch real keydown events at controlled speeds to exercise the
//      scanner's BURST_THRESHOLD_MS=60 discrimination logic directly.
// ---------------------------------------------------------------------------
test.describe('HID Scanner Auth — login.html global keystroke interceptor', () => {

  test.beforeEach(async ({ page }) => {
    // ---- Intercept: Supabase Auth /token (sign-in, session refresh) ----
    await page.route(`${SB_URL}/auth/v1/**`, route => {
      // Return a minimal "no session" response for all auth endpoints
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ data: { session: null, user: null }, error: null }),
      });
    });

    // ---- Intercept: REST table reads (e.g. public.users profile fetch) ----
    await page.route(`${SB_URL}/rest/v1/**`, async route => {
      const url = route.request().url();

      // Badge authentication RPC — return a successful employee payload
      if (url.includes('/rpc/verify_employee_badge_login')) {
        return route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            success: true,
            badge_id: 'BADGE-TEST-001',
            user: {
              id: 'emp-001',
              name: 'Test Worker',
              role: 'warehouse_worker',
              assigned_facility_id: 'facility_seattle_north',
            },
          }),
        });
      }

      // User profile lookup — return empty (no active session)
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify([]),
      });
    });

    // ---- Intercept: PostHog analytics (keep tests clean) ----
    await page.route('**posthog**', route => route.abort());

    // ---- Load the real page ----
    await page.goto('/login.html', { waitUntil: 'domcontentloaded', timeout: 15_000 });
  });

  // -------------------------------------------------------------------------
  // Test 1: Rapid HID scanner burst (<30ms/key) with CV-AUTH- prefix
  //         → the real scanner listener detects avgInterval < 60ms
  //         → authenticateEmployeeBadge fires against (mocked) Supabase RPC
  //         → onBadgeSuccess callback routes the page to admin.html
  // -------------------------------------------------------------------------
  test('rapid scanner burst with CV-AUTH- prefix triggers silent auth routing to admin.html', async ({ page }) => {
    await expect(page).toHaveURL(LOGIN_URL_RE);

    // Wait for navigation to admin.html triggered by the scanner's setTimeout(400ms)
    const navPromise = page.waitForURL(ADMIN_URL_RE, { timeout: 6_000 });

    // Send CV-AUTH- badge string at hardware speed (15ms/key — well under 60ms threshold)
    await typeAtSpeed(page, 'CV-AUTH-BADGE0042', 15);
    await page.keyboard.press('Enter');

    await navPromise;
    expect(page.url()).toMatch(ADMIN_URL_RE);
  });

  // -------------------------------------------------------------------------
  // Test 2: Slow human typing (>60ms/key) in the email input field
  //         → the real listener's avgInterval check sees > BURST_THRESHOLD_MS
  //         → the keystrokes are NOT consumed as a scanner event
  //         → the text remains in the input and the page stays on login.html
  // -------------------------------------------------------------------------
  test('slow human typing in email field is NOT intercepted as a scanner event', async ({ page }) => {
    const emailInput = page.locator('#auth-email');
    await emailInput.waitFor({ state: 'visible' });
    await emailInput.click();

    // Type at 80ms/key — deliberately above the 60ms BURST_THRESHOLD_MS
    await typeAtSpeed(page, 'CV-AUTH-HUMAN', 80);

    // The real scanner resets its buffer when gaps > 150ms (2.5x threshold);
    // pressing Enter now will NOT trigger badge auth because the buffer was reset
    // or the avgInterval is too slow for isHardwareBurst to be true.
    // The email field must still contain the typed text.
    const inputValue = await emailInput.inputValue();
    expect(inputValue).toContain('CV-AUTH-HUMAN');

    // Page must not have navigated away
    expect(page.url()).toMatch(LOGIN_URL_RE);
  });

  // -------------------------------------------------------------------------
  // Test 3: Rapid burst WITHOUT CV-AUTH- prefix
  //         → isAuthScan is false; it is a hardware burst but NOT an auth badge
  //         → on login.html (no onToteScan callback) the page stays put
  // -------------------------------------------------------------------------
  test('rapid non-badge barcode burst does NOT navigate to admin.html', async ({ page }) => {
    let navigatedToAdmin = false;
    page.on('framenavigated', frame => {
      if (frame === page.mainFrame() && frame.url().match(ADMIN_URL_RE)) {
        navigatedToAdmin = true;
      }
    });

    // SHELF- prefix — a warehouse barcode, not a badge
    await typeAtSpeed(page, 'SHELF-01-A99', 10);
    await page.keyboard.press('Enter');

    // Give enough time for any erroneous navigation to occur
    await page.waitForTimeout(800);

    expect(navigatedToAdmin).toBe(false);
    expect(page.url()).toMatch(LOGIN_URL_RE);
  });

  // -------------------------------------------------------------------------
  // Test 4: Badge RPC returns failure (e.g. revoked badge)
  //         → the real onBadgeError callback fires a toast, no navigation
  // -------------------------------------------------------------------------
  test('rejected badge (RPC failure) shows error toast and stays on login.html', async ({ page }) => {
    // Override: make verify_employee_badge_login return a failure
    await page.route(`${SB_URL}/rest/v1/rpc/verify_employee_badge_login`, route => {
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ success: false, user: null }),
      });
    });

    let navigatedToAdmin = false;
    page.on('framenavigated', frame => {
      if (frame === page.mainFrame() && frame.url().match(ADMIN_URL_RE)) {
        navigatedToAdmin = true;
      }
    });

    await typeAtSpeed(page, 'CV-AUTH-REVOKED01', 15);
    await page.keyboard.press('Enter');

    await page.waitForTimeout(1_000);

    expect(navigatedToAdmin).toBe(false);
    expect(page.url()).toMatch(LOGIN_URL_RE);

    // The badge scan toast should be visible with an error state
    const toast = page.locator('#cv-badge-scan-toast');
    await expect(toast).toBeVisible({ timeout: 3_000 });
  });
});
