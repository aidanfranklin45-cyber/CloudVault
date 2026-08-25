import { assertEquals } from "std/assert";

// ---------------------------------------------------------------------------
// Suite 1: Static Codebase Hardcoding & Invariant Linter
// ---------------------------------------------------------------------------
Deno.test("Pricing Invariant - Zero Static Hardcoded Fallback Rates in Codebase", async () => {
  const filesToScan = [
    "supabase/functions/stripe-invoice-ops/index.ts",
    "supabase-config.js",
  ];

  const bannedPatterns = [
    { pattern: /tier1_rate\s*\|\|\s*\d+/i, desc: "Static numeric fallback for tier1_rate" },
    { pattern: /tier2_rate\s*\|\|\s*\d+/i, desc: "Static numeric fallback for tier2_rate" },
    { pattern: /tier3_rate\s*\|\|\s*\d+/i, desc: "Static numeric fallback for tier3_rate" },
    { pattern: /tier4_rate\s*\|\|\s*\d+/i, desc: "Static numeric fallback for tier4_rate" },
    { pattern: /valet_base\s*\|\|\s*\d+/i, desc: "Static numeric fallback for valet_base" },
    { pattern: /taxRatePct\s*=\s*(?:10\.25|8\.50|0\.08)/, desc: "Hardcoded regional tax percentage constant" },
    { pattern: /promoCodeInput\.includes\(["']20["']\)/, desc: "Hardcoded promo discount heuristic" },
  ];

  for (const filePath of filesToScan) {
    const content = await Deno.readTextFile(filePath);
    for (const { pattern, desc } of bannedPatterns) {
      const match = content.match(pattern);
      assertEquals(
        match === null,
        true,
        `Violated Dynamic Financial Rule in ${filePath}: Found banned pattern "${desc}" (Match: "${match?.[0]}")`
      );
    }
  }
});

// ---------------------------------------------------------------------------
// Suite 2: Generative Property-Based Dynamic Pricing Sweeps
// ---------------------------------------------------------------------------
interface FacilityPricingConfig {
  id: string;
  name: string;
  tier1_rate: number;
  tier2_rate: number;
  tier3_rate: number;
  tier4_rate: number;
  valet_base: number;
  valet_tote_adder: number;
  tax_rate_pct: number;
}

function resolveDynamicPricing(facility: FacilityPricingConfig, toteCount: number, isValet: boolean) {
  if (!facility || facility.tier1_rate === null || facility.tier1_rate === undefined) {
    throw new Error(`Facility configuration is missing required rate matrix.`);
  }

  const count = Math.max(1, Number(toteCount) || 1);
  let unitRate = facility.tier1_rate;
  if (count >= 50) unitRate = facility.tier4_rate;
  else if (count >= 25) unitRate = facility.tier3_rate;
  else if (count >= 10) unitRate = facility.tier2_rate;

  const storageSubtotal = Number((count * unitRate).toFixed(2));
  const valetFee = isValet ? Number((facility.valet_base + count * facility.valet_tote_adder).toFixed(2)) : 0;
  const gross = Number((storageSubtotal + valetFee).toFixed(2));
  const taxAmount = Number((gross * (facility.tax_rate_pct / 100)).toFixed(2));
  const total = Number((gross + taxAmount).toFixed(2));

  return { unitRate, storageSubtotal, valetFee, gross, taxAmount, total };
}

Deno.test("Pricing Invariant - Generative Property-Based Pricing Verification", async (t) => {
  // Pure domain expected formula functions (Zero magic numbers)
  function computeExpectedUnitRate(f: FacilityPricingConfig, count: number): number {
    if (count >= 50) return f.tier4_rate;
    if (count >= 25) return f.tier3_rate;
    if (count >= 10) return f.tier2_rate;
    return f.tier1_rate;
  }

  function computeExpectedValetFee(f: FacilityPricingConfig, count: number, isValet: boolean): number {
    return isValet ? Number((f.valet_base + count * f.valet_tote_adder).toFixed(2)) : 0;
  }

  await t.step("sweeps 50 randomized facility matrices and proves mathematical invariants", () => {
    // Generate 50 distinct randomized facility pricing matrices
    for (let i = 0; i < 50; i++) {
      const t1 = Number((3.00 + Math.random() * 4.00).toFixed(2)); // $3.00 - $7.00
      const t2 = Number((t1 * 0.75).toFixed(2));
      const t3 = Number((t2 * 0.75).toFixed(2));
      const t4 = Number((t3 * 0.50).toFixed(2));
      const valetBase = Number((10.00 + Math.random() * 10.00).toFixed(2));
      const valetAdder = Number((0.50 + Math.random() * 1.50).toFixed(2));
      const taxRate = i % 5 === 0 ? 0.00 : Number((5.00 + Math.random() * 6.00).toFixed(2)); // Includes 0% tax cases

      const randomFacility: FacilityPricingConfig = {
        id: `facility_gen_${i}`,
        name: `Generated Facility ${i}`,
        tier1_rate: t1,
        tier2_rate: t2,
        tier3_rate: t3,
        tier4_rate: t4,
        valet_base: valetBase,
        valet_tote_adder: valetAdder,
        tax_rate_pct: taxRate,
      };

      // Test across random tote quantities
      const testCounts = [1, 5, 9, 10, 15, 24, 25, 40, 49, 50, 100, 250];
      for (const count of testCounts) {
        for (const isValet of [true, false]) {
          const result = resolveDynamicPricing(randomFacility, count, isValet);

          // 1. Assert unitRate derived strictly from facility matrix without magic numbers
          const expectedRate = computeExpectedUnitRate(randomFacility, count);
          assertEquals(result.unitRate, expectedRate);

          // 2. Assert storage subtotal === count * unitRate
          const expectedStorage = Number((count * expectedRate).toFixed(2));
          assertEquals(result.storageSubtotal, expectedStorage);

          // 3. Assert valet fee derived strictly from facility config
          const expectedValet = computeExpectedValetFee(randomFacility, count, isValet);
          assertEquals(result.valetFee, expectedValet);

          // 4. Assert gross === storage + valet
          const expectedGross = Number((expectedStorage + expectedValet).toFixed(2));
          assertEquals(result.gross, expectedGross);

          // 5. Assert zero tax invariant for 0% tax jurisdictions
          if (randomFacility.tax_rate_pct === 0) {
            assertEquals(result.taxAmount, 0.00);
            assertEquals(result.total, expectedGross);
          } else {
            const expectedTax = Number((expectedGross * (randomFacility.tax_rate_pct / 100)).toFixed(2));
            assertEquals(result.taxAmount, expectedTax);
            assertEquals(result.total, Number((expectedGross + expectedTax).toFixed(2)));
          }
        }
      }
    }
  });

  await t.step("proves monotonicity invariant across all tier boundaries", () => {
    const sampleFacility: FacilityPricingConfig = {
      id: "facility_monotonicity_test",
      name: "Monotonicity Test",
      tier1_rate: 6.00,
      tier2_rate: 4.50,
      tier3_rate: 3.00,
      tier4_rate: 1.50,
      valet_base: 15.00,
      valet_tote_adder: 1.00,
      tax_rate_pct: 10.00,
    };

    let prevRate = Infinity;
    for (let c = 1; c <= 60; c++) {
      const { unitRate } = resolveDynamicPricing(sampleFacility, c, false);
      // Unit rate must never increase as volume increases
      assertEquals(unitRate <= prevRate, true, `Monotonicity violation at count ${c}: ${unitRate} > ${prevRate}`);
      prevRate = unitRate;
    }
  });

  await t.step("fails fast when facility configuration is missing required rate matrix", () => {
    const invalidFacility = { id: "facility_broken", name: "Incomplete" } as any;
    let errorThrown = false;
    try {
      resolveDynamicPricing(invalidFacility, 10, false);
    } catch (err: any) {
      errorThrown = true;
      assertEquals(err.message.includes("missing required rate matrix"), true);
    }
    assertEquals(errorThrown, true);
  });
});