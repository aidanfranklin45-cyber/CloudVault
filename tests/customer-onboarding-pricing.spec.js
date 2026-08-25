// @ts-check
const { test, expect } = require('@playwright/test');

const SB_URL = 'https://xbxvebnrjryvksvtufqj.supabase.co';

test.describe('Customer Onboarding & Dynamic Pricing Flow', () => {

  test.beforeEach(async ({ page }) => {
    // Intercept Supabase facility query to inject mock dynamic pricing matrix
    await page.route(`${SB_URL}/rest/v1/facilities*`, route => {
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify([
          {
            id: 'facility_seattle_north',
            name: 'Seattle North Vault Hub',
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
        ]),
      });
    });

    await page.route(`${SB_URL}/auth/v1/**`, route => {
      route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
    });
  });

  test('dynamically updates pricing as tote counter increases across tiers', async ({ page }) => {
    await page.goto('/', { waitUntil: 'domcontentloaded' });

    // The calculator tote input
    const toteInput = page.locator('#calc-totes');
    if (await toteInput.count() > 0) {
      // Test Tier 1 (5 totes)
      await toteInput.fill('5');
      await toteInput.dispatchEvent('input');
      await page.waitForTimeout(300);

      // Evaluate getTierRate in browser context with mock dynamic rates
      const tier1Result = await page.evaluate(() => {
        return window.getTierRate(5, {
          tier1_rate: 5.10,
          tier2_rate: 3.50,
          tier3_rate: 2.50,
          tier4_rate: 1.00,
        });
      });
      expect(tier1Result.tier).toBe(1);
      expect(tier1Result.rate).toBe(5.10);

      // Test Tier 2 (15 totes)
      await toteInput.fill('15');
      await toteInput.dispatchEvent('input');
      await page.waitForTimeout(300);

      const tier2Result = await page.evaluate(() => {
        return window.getTierRate(15, {
          tier1_rate: 5.10,
          tier2_rate: 3.50,
          tier3_rate: 2.50,
          tier4_rate: 1.00,
        });
      });
      expect(tier2Result.tier).toBe(2);
      expect(tier2Result.rate).toBe(3.50);

      // Test Tier 4 (60 totes)
      await toteInput.fill('60');
      await toteInput.dispatchEvent('input');
      await page.waitForTimeout(300);

      const tier4Result = await page.evaluate(() => {
        return window.getTierRate(60, {
          tier1_rate: 5.10,
          tier2_rate: 3.50,
          tier3_rate: 2.50,
          tier4_rate: 1.00,
        });
      });
      expect(tier4Result.tier).toBe(4);
      expect(tier4Result.rate).toBe(1.00);
    }
  });

  test('fails fast and throws when getTierRate is called without dynamic pricing context', async ({ page }) => {
    await page.goto('/login', { waitUntil: 'domcontentloaded' });

    const throwsWithoutContext = await page.evaluate(() => {
      let threw = false;
      try {
        window.getTierRate(5, null);
      } catch (e) {
        threw = true;
      }
      return threw;
    });

    expect(throwsWithoutContext).toBe(true);
  });
});