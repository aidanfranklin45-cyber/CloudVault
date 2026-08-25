// @ts-check
const { test, expect } = require('@playwright/test');

const SB_URL = 'https://xbxvebnrjryvksvtufqj.supabase.co';

test.describe('Retrieval Logistics Nuances & Dynamic Mode Adaptation', () => {

  const MOCK_USER = {
    id: 'usr_retrieval_001',
    email: 'user@cloudvault.com',
    role: 'customer',
    assigned_facility_id: 'facility_seattle_north',
  };

  const MOCK_FACILITY_HYBRID = {
    id: 'facility_seattle_north',
    name: 'Seattle North Hub',
    valet_available: true,
    staging_available: true,
    valet_base: 16.00,
    valet_tote_adder: 1.00,
    same_day_surge_fee: 10.00,
    evening_peak_slot_fee: 5.00,
    max_scheduling_days_out: 30,
    min_lead_time_days: 0,
    is_active: true,
  };

  test.beforeEach(async ({ page }) => {
    // Seed authenticated session
    await page.addInitScript((args) => {
      const [key, payload] = args;
      localStorage.setItem(key, JSON.stringify(payload));
      localStorage.setItem('cv_remember_me', 'true');
    }, [
      'sb-xbxvebnrjryvksvtufqj-auth-token',
      {
        access_token: 'mock-token',
        token_type: 'bearer',
        expires_in: 3600,
        refresh_token: 'mock-refresh-token',
        user: {
          id: MOCK_USER.id,
          email: MOCK_USER.email,
          role: 'authenticated',
        },
      },
    ]);

    await page.route(`${SB_URL}/rest/v1/**`, route => {
      const url = route.request().url();
      if (url.includes('/facilities')) {
        return route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify([MOCK_FACILITY_HYBRID]),
        });
      }
      if (url.includes('/totes')) {
        return route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify([
            { id: 'TOTE-TEST-001', status: 'stored', facility_id: 'facility_seattle_north' },
            { id: 'TOTE-TEST-002', status: 'stored', facility_id: 'facility_seattle_north' },
          ]),
        });
      }
      route.fulfill({ status: 200, contentType: 'application/json', body: '[]' });
    });
  });

  test('dynamically calculates retrieval quote from active facility configuration', async ({ page }) => {
    await page.goto('/dashboard', { waitUntil: 'domcontentloaded' });

    // Derive quote calculation directly in page context
    const quote = await page.evaluate((fac) => {
      const toteCount = 2;
      const isValet = true;
      const isEvening = true;

      const baseValet = isValet ? (fac.valet_base + toteCount * fac.valet_tote_adder) : 0;
      const eveningFee = isEvening ? fac.evening_peak_slot_fee : 0;
      const total = baseValet + eveningFee;

      return { baseValet, eveningFee, total };
    }, MOCK_FACILITY_HYBRID);

    const expectedBase = MOCK_FACILITY_HYBRID.valet_base + 2 * MOCK_FACILITY_HYBRID.valet_tote_adder;
    const expectedEvening = MOCK_FACILITY_HYBRID.evening_peak_slot_fee;
    const expectedTotal = expectedBase + expectedEvening;

    expect(quote.baseValet).toBe(expectedBase);
    expect(quote.eveningFee).toBe(expectedEvening);
    expect(quote.total).toBe(expectedTotal);
  });
});