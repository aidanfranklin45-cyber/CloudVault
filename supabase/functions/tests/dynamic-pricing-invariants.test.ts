import { assertEquals, assertRejects, assertExists } from "std/assert";

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
// Suite 2: Dynamic Facility Resolution & Fail-Fast Behavior
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

Deno.test("Pricing Invariant - Dynamic Facility Pricing Calculations", async (t) => {
  const seattleFacility: FacilityPricingConfig = {
    id: "facility_seattle_north",
    name: "Seattle North",
    tier1_rate: 5.10,
    tier2_rate: 3.50,
    tier3_rate: 2.50,
    tier4_rate: 1.00,
    valet_base: 16.00,
    valet_tote_adder: 1.00,
    tax_rate_pct: 10.25,
  };

  const yakimaFacility: FacilityPricingConfig = {
    id: "facility_yakima",
    name: "Yakima Valley",
    tier1_rate: 4.50,
    tier2_rate: 3.00,
    tier3_rate: 2.00,
    tier4_rate: 0.85,
    valet_base: 12.00,
    valet_tote_adder: 0.75,
    tax_rate_pct: 8.30,
  };

  const portlandFacility: FacilityPricingConfig = {
    id: "facility_portland",
    name: "Portland Central",
    tier1_rate: 5.25,
    tier2_rate: 3.75,
    tier3_rate: 2.75,
    tier4_rate: 1.10,
    valet_base: 15.00,
    valet_tote_adder: 1.25,
    tax_rate_pct: 0.00, // Oregon 0% sales tax
  };

  await t.step("computes Seattle rates across tiers dynamically", () => {
    // 5 totes (Tier 1 @ $5.10) + Valet ($16 + 5*$1) = $25.50 + $21.00 = $46.50 + 10.25% tax ($4.77) = $51.27
    const quote = resolveDynamicPricing(seattleFacility, 5, true);
    assertEquals(quote.unitRate, 5.10);
    assertEquals(quote.storageSubtotal, 25.50);
    assertEquals(quote.valetFee, 21.00);
    assertEquals(quote.gross, 46.50);
    assertEquals(quote.taxAmount, 4.77);
    assertEquals(quote.total, 51.27);
  });

  await t.step("computes Yakima regional rates dynamically", () => {
    // 30 totes (Tier 3 @ $2.00) without valet = $60.00 + 8.30% tax ($4.98) = $64.98
    const quote = resolveDynamicPricing(yakimaFacility, 30, false);
    assertEquals(quote.unitRate, 2.00);
    assertEquals(quote.storageSubtotal, 60.00);
    assertEquals(quote.valetFee, 0.00);
    assertEquals(quote.taxAmount, 4.98);
    assertEquals(quote.total, 64.98);
  });

  await t.step("computes Portland 0% tax dynamically", () => {
    // 15 totes (Tier 2 @ $3.75) + Valet ($15 + 15*$1.25 = $33.75) = $56.25 + $33.75 = $90.00 + 0% tax = $90.00
    const quote = resolveDynamicPricing(portlandFacility, 15, true);
    assertEquals(quote.unitRate, 3.75);
    assertEquals(quote.storageSubtotal, 56.25);
    assertEquals(quote.valetFee, 33.75);
    assertEquals(quote.taxAmount, 0.00);
    assertEquals(quote.total, 90.00);
  });

  await t.step("fails fast when facility rate configuration is missing", () => {
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