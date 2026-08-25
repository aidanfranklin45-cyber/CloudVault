// @ts-check
const { test, expect } = require('@playwright/test');

const SB_URL = 'https://xbxvebnrjryvksvtufqj.supabase.co';

test.describe('Admin Facility Pricing Matrix & Dynamic Propagation', () => {

  const MOCK_ADMIN_USER = {
    id: 'usr_admin_001',
    email: 'admin@cloudvault.com',
    role: 'manager',
    assigned_facility_id: 'facility_seattle_north',
  };

  const MOCK_FACILITIES = [
    {
      id: 'facility_seattle_north',
      name: 'Seattle North Hub',
      city: 'Seattle',
      state: 'WA',
      tier1_rate: 5.10,
      tier2_rate: 3.50,
      tier3_rate: 2.50,
      tier4_rate: 1.00,
      valet_base: 16.00,
      valet_tote_adder: 1.00,
      tax_rate_pct: 10.25,
      is_active: true,
    },
    {
      id: 'facility_yakima',
      name: 'Yakima Valley Hub',
      city: 'Yakima',
      state: 'WA',
      tier1_rate: 4.50,
      tier2_rate: 3.00,
      tier3_rate: 2.00,
      tier4_rate: 0.85,
      valet_base: 12.00,
      valet_tote_adder: 0.75,
      tax_rate_pct: 8.30,
      is_active: true,
    },
  ];

  test.beforeEach(async ({ page }) => {
    // Seed admin auth session into storage
    await page.addInitScript((args) => {
      const [key, payload] = args;
      localStorage.setItem(key, JSON.stringify(payload));
      localStorage.setItem('cv_remember_me', 'true');
      localStorage.setItem('cloudvault_user_role', 'manager');
    }, [
      'sb-xbxvebnrjryvksvtufqj-auth-token',
      {
        access_token: 'mock-admin-token',
        token_type: 'bearer',
        expires_in: 3600,
        refresh_token: 'mock-refresh-token',
        user: {
          id: MOCK_ADMIN_USER.id,
          email: MOCK_ADMIN_USER.email,
          role: 'authenticated',
          user_metadata: { role: 'manager' },
        },
      },
    ]);

    // Mock network routes
    await page.route(`${SB_URL}/auth/v1/**`, route => {
      const url = route.request().url();
      if (url.includes('/user')) {
        return route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify(MOCK_ADMIN_USER),
        });
      }
      route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
    });

    await page.route(`${SB_URL}/rest/v1/**`, route => {
      const url = route.request().url();
      if (url.includes('/facilities')) {
        return route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify(MOCK_FACILITIES),
        });
      }
      if (url.includes('/users')) {
        return route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify([MOCK_ADMIN_USER]),
        });
      }
      route.fulfill({ status: 200, contentType: 'application/json', body: '[]' });
    });
  });

  test('dynamically resolves pricing matrices per facility in admin context', async ({ page }) => {
    await page.goto('/admin', { waitUntil: 'domcontentloaded' });

    // Test dynamic calculation for Seattle
    const seattleCalc = await page.evaluate((facs) => {
      const seattle = facs.find(f => f.id === 'facility_seattle_north');
      const rate = window.getTierRate(5, seattle);
      const valet = window.getValetFee(5, seattle);
      return { rate, valet };
    }, MOCK_FACILITIES);

    expect(seattleCalc.rate.tier).toBe(1);
    expect(seattleCalc.rate.rate).toBe(5.10);
    expect(seattleCalc.valet).toBe(21.00); // 16 + 5*1

    // Test dynamic calculation for Yakima
    const yakimaCalc = await page.evaluate((facs) => {
      const yakima = facs.find(f => f.id === 'facility_yakima');
      const rate = window.getTierRate(5, yakima);
      const valet = window.getValetFee(5, yakima);
      return { rate, valet };
    }, MOCK_FACILITIES);

    expect(yakimaCalc.rate.tier).toBe(1);
    expect(yakimaCalc.rate.rate).toBe(4.50);
    expect(yakimaCalc.valet).toBe(15.75); // 12 + 5*0.75
  });
});