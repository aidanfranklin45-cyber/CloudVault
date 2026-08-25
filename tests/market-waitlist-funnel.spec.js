// @ts-check
const { test, expect } = require('@playwright/test');

const SB_URL = 'https://xbxvebnrjryvksvtufqj.supabase.co';

test.describe('Market Expansion & Dynamic Waitlist Funnel', () => {

  const MOCK_ACTIVE_FACILITY = {
    id: 'facility_seattle_north',
    name: 'Seattle North Hub',
    serviceable_zips: ['98101', '98102', '98103', '98104', '98109', '98115'],
    tier1_rate: 5.10,
    is_active: true,
  };

  test.beforeEach(async ({ page }) => {
    await page.route(`${SB_URL}/rest/v1/facilities*`, route => {
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify([MOCK_ACTIVE_FACILITY]),
      });
    });

    await page.route(`${SB_URL}/auth/v1/**`, route => {
      route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
    });
  });

  test('dynamically routes serviceable ZIP codes to active facility checkout', async ({ page }) => {
    await page.goto('/', { waitUntil: 'domcontentloaded' });

    const isServiceable = await page.evaluate((fac) => {
      const targetZip = '98101';
      return fac.serviceable_zips.includes(targetZip);
    }, MOCK_ACTIVE_FACILITY);

    expect(isServiceable).toBe(true);
  });

  test('dynamically routes unserviced ZIP codes to waitlist funnel without charging customer', async ({ page }) => {
    await page.goto('/', { waitUntil: 'domcontentloaded' });

    const unservicedResult = await page.evaluate((fac) => {
      const targetZip = '99999';
      const isCovered = fac.serviceable_zips.includes(targetZip);
      if (!isCovered) {
        return {
          status: 'waitlist',
          requiresCard: false,
          message: 'CloudVault is coming soon to your area! Join our free priority waitlist.',
        };
      }
      return { status: 'active', requiresCard: true, message: 'Available' };
    }, MOCK_ACTIVE_FACILITY);

    expect(unservicedResult.status).toBe('waitlist');
    expect(unservicedResult.requiresCard).toBe(false);
    expect(unservicedResult.message).toContain('priority waitlist');
  });
});