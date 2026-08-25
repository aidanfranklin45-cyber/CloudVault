// @ts-check
const { test, expect } = require('@playwright/test');

test.describe('Warehouse Tote Management & Prefix Generator', () => {

  test('generates standardized serialized tote codes for each facility prefix', async ({ page }) => {
    await page.goto('/login', { waitUntil: 'domcontentloaded' });

    const facilityPrefixes = [
      { facilityId: 'facility_seattle_north', expectedPrefix: 'CV-SEA-' },
      { facilityId: 'facility_yakima',        expectedPrefix: 'CV-YAK-' },
      { facilityId: 'facility_portland',      expectedPrefix: 'CV-PDX-' },
      { facilityId: 'facility_denver',        expectedPrefix: 'CV-DEN-' },
      { facilityId: 'facility_spokane',       expectedPrefix: 'CV-SPO-' },
      { facilityId: 'facility_austin',        expectedPrefix: 'CV-ATX-' },
    ];

    for (const { facilityId, expectedPrefix } of facilityPrefixes) {
      const code = await page.evaluate((fid) => {
        return window.generateToteCode(fid);
      }, facilityId);

      expect(code.startsWith(expectedPrefix)).toBe(true);
      expect(code).toMatch(/^CV-[A-Z]{3,4}-[A-HJ-NP-Z2-9]{4}$/);
    }
  });

  test('validates generated tote codes have high entropy and avoid ambiguous characters', async ({ page }) => {
    await page.goto('/login', { waitUntil: 'domcontentloaded' });

    const results = await page.evaluate(() => {
      const set = new Set();
      const codes = [];
      for (let i = 0; i < 100; i++) {
        const c = window.generateToteCode('facility_seattle_north');
        codes.push(c);
        set.add(c);
      }
      return { total: codes.length, unique: set.size, sample: codes.slice(0, 10) };
    });

    // High entropy across 100 generated items
    expect(results.unique).toBeGreaterThanOrEqual(99);

    // Assert ambiguous characters '0', 'O', '1', 'I' are never present in suffix
    for (const code of results.sample) {
      const suffix = code.split('-')[2];
      expect(suffix).not.toMatch(/[0O1I]/);
    }
  });
});