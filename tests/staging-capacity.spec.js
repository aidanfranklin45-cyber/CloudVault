// @ts-check
const { test, expect } = require('@playwright/test');

// ---------------------------------------------------------------------------
// Supabase project base URL Ã¢â‚¬â€ all REST/RPC traffic routes through here.
// ---------------------------------------------------------------------------
const SB_URL = 'https://xbxvebnrjryvksvtufqj.supabase.co';

// Mock facility data returned from GET /rest/v1/facilities
const MOCK_FACILITY = {
  id: 'facility_seattle_north',
  name: 'CloudVault Seattle North',
  city: 'Seattle',
  valet_enabled: true,
  staging_enabled: true,
  valet_disabled_until: null,
  staging_disabled_until: null,
  valet_disable_reason: null,
  staging_disable_reason: null,
  tier1_rate: 5.10,
  tier2_rate: 3.50,
  tier3_rate: 2.50,
  tier4_rate: 1.00,
  valet_base: 16.00,
  valet_tote_adder: 1.00,
  next_day_surge_fee: 0,
  next_day_peak_surge_fee: 0,
  same_day_surge_fee: 5,
  same_day_peak_surge_fee: 10,
  evening_peak_slot_fee: 3,
  missing_tote_fee: 25,
  next_day_promo_free: true,
  max_scheduling_days_out: 30,
  min_lead_time_days: 0,
  staging_config: {},
};

// Mock user profile returned from GET /rest/v1/users
const MOCK_USER = {
  id: '00000000-0000-0000-0000-000000000001',
  name: 'Test Customer',
  email: 'test@cloudvault.com',
  role: 'customer',
  assigned_facility_id: 'facility_seattle_north',
  subscription_tier: 'standard',
  tote_count: 5,
};

// ---------------------------------------------------------------------------
// Helper: mount network intercepts for a given staging availability payload.
// Called in beforeEach so the payload can be varied per-test.
// ---------------------------------------------------------------------------
/**
 * @param {import('@playwright/test').Page} page
 * @param {Array<{slot: string, available_rooms: number, available_capacity: number}>} availabilityRows
 */
async function setupRoutes(page, availabilityRows) {
  // ---- Auth session ----
  // The Supabase JS v2 client calls GET /auth/v1/user on load using the stored
  // access token, and fires onAuthStateChange('SIGNED_IN', session) when it gets
  // a valid user back.  We must return the full session object shape here.
  await page.route(`${SB_URL}/auth/v1/**`, route => {
    const url = route.request().url();

    // /user endpoint â€” returns the authenticated user object
    if (url.includes('/user')) {
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          id: MOCK_USER.id,
          email: MOCK_USER.email,
          role: 'authenticated',
          aud: 'authenticated',
          user_metadata: { name: MOCK_USER.name },
        }),
      });
    }

    // /token?grant_type=refresh_token â€” refresh token exchange
    if (url.includes('/token')) {
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          access_token: 'mock-access-token',
          token_type: 'bearer',
          expires_in: 3600,
          refresh_token: 'mock-refresh-token',
          user: {
            id: MOCK_USER.id,
            email: MOCK_USER.email,
            role: 'authenticated',
            aud: 'authenticated',
            user_metadata: { name: MOCK_USER.name },
          },
        }),
      });
    }

    // All other auth endpoints â€” generic 200
    route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
  });

  // ---- REST table reads ----
  await page.route(`${SB_URL}/rest/v1/**`, route => {
    const url = route.request().url();

    // get_staging_availability RPC
    if (url.includes('/rpc/get_staging_availability')) {
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(availabilityRows),
      });
    }

    // facilities table
    if (url.includes('/facilities')) {
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify([MOCK_FACILITY]),
      });
    }

    // users / profiles table
    if (url.includes('/users')) {
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify([MOCK_USER]),
      });
    }

    // Everything else â€” empty list
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify([]),
    });
  });

  // ---- Analytics noise ----
  await page.route('**posthog**', route => route.abort());
}

// ---------------------------------------------------------------------------
// Seed a valid Supabase session into localStorage so the SDK picks it up on
// page load and fires onAuthStateChange('SIGNED_IN', session) immediately,
// avoiding the redirect to login.html.
// ---------------------------------------------------------------------------
async function seedAuthSession(page) {
  const sessionPayload = {
    access_token: 'mock-access-token',
    token_type: 'bearer',
    expires_in: 3600,
    expires_at: Math.floor(Date.now() / 1000) + 3600,
    refresh_token: 'mock-refresh-token',
    user: {
      id: MOCK_USER.id,
      email: MOCK_USER.email,
      role: 'authenticated',
      aud: 'authenticated',
      user_metadata: { name: MOCK_USER.name },
    },
  };

  // Supabase JS v2 stores the session under the key 'sb-<projectRef>-auth-token'
  const storageKey = `sb-xbxvebnrjryvksvtufqj-auth-token`;
  await page.addInitScript((args) => {
    const [key, payload] = args;
    // Use localStorage so the custom storage engine finds it regardless of rememberMe flag
    localStorage.setItem(key, JSON.stringify(payload));
    // Also set rememberMe so the custom engine reads from localStorage
    localStorage.setItem('cv_remember_me', 'true');
  }, [storageKey, sessionPayload]);
}

// ---------------------------------------------------------------------------
// Helper: open the Retrieval Options modal on the real page.
// Waits for requestRetrieval to be defined (requires auth + facility load).
// ---------------------------------------------------------------------------
async function openRetrievalModal(page) {
  // Wait for requestRetrieval and toggleTote to exist in the page context (up to 10s)
  await page.waitForFunction(() => typeof requestRetrieval === 'function', { timeout: 10_000 });

  await page.evaluate(() => {
    // Ensure activeFacilityPricing has the required valet/staging fields
    // (fallback in case the facility route didn't fire in time)
    if (!window.activeFacilityPricing || !window.activeFacilityPricing.valet_base) {
      window.activeFacilityPricing = {
        id: 'facility_seattle_north',
        valet_available: true,
        staging_available: true,
        valet_base: 16,
        valet_tote_adder: 1,
        next_day_surge_fee: 0,
        next_day_peak_surge_fee: 0,
        same_day_surge_fee: 5,
        same_day_peak_surge_fee: 10,
        evening_peak_slot_fee: 3,
        missing_tote_fee: 25,
        next_day_promo_free: true,
        max_scheduling_days_out: 30,
        min_lead_time_days: 0,
        staging_config: {},
      };
    }
    // Seed at least one selected tote so the requestRetrieval guard passes
    if (typeof toggleTote === 'function') {
      toggleTote('TOTE-TEST-0001');
    }
    if (window.selectedItems instanceof Set) {
      window.selectedItems.add('TOTE-TEST-0001');
    }
    requestRetrieval();
  });

  const modal = page.locator('#retrieval-modal');
  await modal.waitFor({ state: 'visible', timeout: 10_000 });
}

// ---------------------------------------------------------------------------
// Helper: set the retrieval date picker to a future date and dispatch change
// so handleReservationDateChange() Ã¢â€ â€™ checkSlotAvailability() fires.
// ---------------------------------------------------------------------------
async function setFutureDate(page, daysAhead = 1) {
  await page.evaluate((days) => {
    const d = new Date();
    d.setDate(d.getDate() + days);
    const iso = d.toISOString().split('T')[0];
    const el = document.getElementById('retrieval-target-date');
    if (el) {
      el.value = iso;
      el.dispatchEvent(new Event('change', { bubbles: true }));
    }
  }, daysAhead);

  // Give the async checkSlotAvailability() time to resolve and update the DOM
  await page.waitForTimeout(1_200);
}

// ---------------------------------------------------------------------------
// Test suite: Staging Room Capacity Ã¢â‚¬â€ dashboard.html
// ---------------------------------------------------------------------------
test.describe('Staging Room Capacity Ã¢â‚¬â€ dashboard.html slot availability', () => {

  // -------------------------------------------------------------------------
  // Test 1: Two slots fully booked Ã¢â€ â€™ disabled + labelled "Ã°Å¸â€Â´ FULL"
  //         One slot with rooms Ã¢â€ â€™ enabled, shows room count
  // -------------------------------------------------------------------------
  test('fully booked slots are disabled and labelled FULL; available slots remain enabled', async ({ page }) => {
    await setupRoutes(page, [
      { slot: '09:00 AM - 12:00 PM', available_rooms: 0, available_capacity: 0 },
      { slot: '12:00 PM - 03:00 PM', available_rooms: 0, available_capacity: 0 },
      { slot: '03:00 PM - 06:00 PM', available_rooms: 2, available_capacity: 40 },
    ]);

    await seedAuthSession(page);
    await page.goto('/dashboard.html', { waitUntil: 'domcontentloaded', timeout: 15_000 });
    await openRetrievalModal(page);
    await setFutureDate(page, 1);

    const slotSelect = page.locator('#retrieval-time-slot');
    const options = await slotSelect.locator('option').all();

    let morningDisabled   = null;
    let afternoonDisabled = null;
    let eveningEnabled    = null;

    for (const opt of options) {
      const text     = (await opt.textContent()) ?? '';
      const disabled = await opt.evaluate(el => el.disabled);

      if (text.includes('9 AM')) {
        morningDisabled = disabled;
        expect(text).toContain('FULL');
      }
      if (text.includes('12 PM') && text.includes('3 PM')) {
        afternoonDisabled = disabled;
        expect(text).toContain('FULL');
      }
      if (text.includes('3 PM - 6 PM') || text.includes('3PM')) {
        eveningEnabled = !disabled;
        // Should show a room count when available
        expect(text).toMatch(/\d+ room/);
      }
    }

    expect(morningDisabled,   'Morning slot should be disabled').toBe(true);
    expect(afternoonDisabled, 'Afternoon slot should be disabled').toBe(true);
    expect(eveningEnabled,    'Evening slot should be enabled').toBe(true);
  });

  // -------------------------------------------------------------------------
  // Test 2: All three slots available Ã¢â€ â€™ all enabled, each shows room count
  // -------------------------------------------------------------------------
  test('all available slots are enabled and display room counts', async ({ page }) => {
    await setupRoutes(page, [
      { slot: '09:00 AM - 12:00 PM', available_rooms: 3, available_capacity: 60 },
      { slot: '12:00 PM - 03:00 PM', available_rooms: 1, available_capacity: 20 },
      { slot: '03:00 PM - 06:00 PM', available_rooms: 5, available_capacity: 100 },
    ]);

    await seedAuthSession(page);
    await page.goto('/dashboard.html', { waitUntil: 'domcontentloaded', timeout: 15_000 });
    await openRetrievalModal(page);
    await setFutureDate(page, 2); // use 2 days out to ensure no time-based disabling

    const slotSelect = page.locator('#retrieval-time-slot');
    const options = await slotSelect.locator('option').all();

    for (const opt of options) {
      const text     = (await opt.textContent()) ?? '';
      const disabled = await opt.evaluate(el => el.disabled);

      // Skip any slot disabled by the time-of-day cutoff (past/active)
      if (text.includes('Past / Active')) continue;

      expect(disabled).toBe(false);
      expect(text).toMatch(/\d+ room/);
    }
  });

  // -------------------------------------------------------------------------
  // Test 3: All slots fully booked Ã¢â€ â€™ every option disabled
  //         Use 7 days ahead to remove time-of-day from the equation.
  // -------------------------------------------------------------------------
  test('when all slots are fully booked every option is disabled', async ({ page }) => {
    await setupRoutes(page, [
      { slot: '09:00 AM - 12:00 PM', available_rooms: 0, available_capacity: 0 },
      { slot: '12:00 PM - 03:00 PM', available_rooms: 0, available_capacity: 0 },
      { slot: '03:00 PM - 06:00 PM', available_rooms: 0, available_capacity: 0 },
    ]);

    await seedAuthSession(page);
    await page.goto('/dashboard.html', { waitUntil: 'domcontentloaded', timeout: 15_000 });
    await openRetrievalModal(page);
    await setFutureDate(page, 7);

    const slotSelect = page.locator('#retrieval-time-slot');
    const options = await slotSelect.locator('option').all();

    for (const opt of options) {
      const text     = (await opt.textContent()) ?? '';
      const disabled = await opt.evaluate(el => el.disabled);
      expect(disabled, `Option "${text}" must be disabled when fully booked`).toBe(true);
    }
  });
});

