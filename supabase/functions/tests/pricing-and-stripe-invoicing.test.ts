import { assertEquals, assertExists } from "std/assert";

interface MockFacility {
  id: string;
  name: string;
  tier1_rate: number;
  tier2_rate: number;
  tier3_rate: number;
  tier4_rate: number;
  valet_base: number;
  valet_tote_adder: number;
  tax_rate_pct: number;
  state: string;
}

interface MockPromoCode {
  id: string;
  code: string;
  customer_discount_pct: number;
  commission_rate_pct: number;
  creator_id: string | null;
  is_active: boolean;
}

interface MockDatabase {
  facilities: MockFacility[];
  promo_codes: MockPromoCode[];
  invoices: any[];
  users: any[];
}

function generateStripeInvoicePayload(db: MockDatabase, params: {
  facilityId: string;
  toteCount: number;
  isValet: boolean;
  promoCode?: string;
  customerId: string;
}) {
  const facility = db.facilities.find((f) => f.id === params.facilityId);
  if (!facility) {
    throw new Error(`Facility '${params.facilityId}' not found in Source of Truth (Supabase).`);
  }

  // 1. Resolve Tier Rate from DB Facility Config (Source of Truth 1)
  let unitRate = facility.tier1_rate;
  if (params.toteCount >= 50) unitRate = facility.tier4_rate;
  else if (params.toteCount >= 25) unitRate = facility.tier3_rate;
  else if (params.toteCount >= 10) unitRate = facility.tier2_rate;

  const storageAmount = Number((params.toteCount * unitRate).toFixed(2));
  const valetAmount = params.isValet ? Number((facility.valet_base + params.toteCount * facility.valet_tote_adder).toFixed(2)) : 0;
  const grossSubtotal = Number((storageAmount + valetAmount).toFixed(2));

  // 2. Resolve Promo Code from DB (Source of Truth 1)
  let discountAmount = 0;
  let appliedPromo: MockPromoCode | null = null;
  if (params.promoCode) {
    const promo = db.promo_codes.find((p) => p.code.toLowerCase() === params.promoCode?.toLowerCase() && p.is_active);
    if (promo) {
      appliedPromo = promo;
      discountAmount = Number((grossSubtotal * (promo.customer_discount_pct / 100)).toFixed(2));
    }
  }

  const taxableAmount = Math.max(0, Number((grossSubtotal - discountAmount).toFixed(2)));
  const taxAmount = Number((taxableAmount * (facility.tax_rate_pct / 100)).toFixed(2));
  const totalAmount = Number((taxableAmount + taxAmount).toFixed(2));

  // 3. Construct Stripe Invoice Line Items (Source of Truth 2)
  const lineItems: Array<{ description: string; amount: number; quantity: number }> = [
    {
      description: `Monthly Storage (${params.toteCount} totes @ $${unitRate.toFixed(2)}/mo)`,
      amount: storageAmount,
      quantity: params.toteCount,
    },
  ];

  if (valetAmount > 0) {
    lineItems.push({
      description: "Valet Logistics Service Fee",
      amount: valetAmount,
      quantity: 1,
    });
  }

  const stripeInvoice = {
    id: `in_stripe_mock_${Date.now()}`,
    customer: params.customerId,
    subtotal: Math.round(grossSubtotal * 100),
    total_discount: Math.round(discountAmount * 100),
    tax: Math.round(taxAmount * 100),
    total: Math.round(totalAmount * 100),
    amount_due: Math.round(totalAmount * 100),
    lines: lineItems,
    applied_promo: appliedPromo?.code || null,
    facility_id: facility.id,
  };

  return { quote: { unitRate, storageAmount, valetAmount, grossSubtotal, discountAmount, taxAmount, totalAmount }, stripeInvoice };
}

Deno.test("Dual Source of Truth - Admin Facility Pricing & Stripe Invoicing", async (t) => {
  const db: MockDatabase = {
    facilities: [
      {
        id: "facility_seattle_north",
        name: "Seattle North Hub",
        tier1_rate: 5.10,
        tier2_rate: 3.50,
        tier3_rate: 2.50,
        tier4_rate: 1.00,
        valet_base: 16.00,
        valet_tote_adder: 1.00,
        tax_rate_pct: 10.25,
        state: "WA",
      },
    ],
    promo_codes: [
      {
        id: "promo_summer_20",
        code: "SUMMER20",
        customer_discount_pct: 20,
        commission_rate_pct: 10,
        creator_id: "creator_01",
        is_active: true,
      },
    ],
    invoices: [],
    users: [],
  };

  await t.step("Source 1: Generates invoice strictly honoring Supabase facility matrix", () => {
    const facility = db.facilities[0];
    const toteCount = 12; // Tier 2
    const isValet = true;

    const { quote, stripeInvoice } = generateStripeInvoicePayload(db, {
      facilityId: facility.id,
      toteCount,
      isValet,
      customerId: "cus_customer_123",
    });

    // Derive all expected values dynamically from facility object (Zero magic numbers)
    const expectedRate = facility.tier2_rate;
    const expectedStorage = Number((toteCount * expectedRate).toFixed(2));
    const expectedValet = Number((facility.valet_base + toteCount * facility.valet_tote_adder).toFixed(2));
    const expectedGross = Number((expectedStorage + expectedValet).toFixed(2));
    const expectedTax = Number((expectedGross * (facility.tax_rate_pct / 100)).toFixed(2));
    const expectedTotal = Number((expectedGross + expectedTax).toFixed(2));

    assertEquals(quote.unitRate, expectedRate);
    assertEquals(quote.storageAmount, expectedStorage);
    assertEquals(quote.valetAmount, expectedValet);
    assertEquals(quote.grossSubtotal, expectedGross);
    assertEquals(quote.discountAmount, 0.00);
    assertEquals(quote.taxAmount, expectedTax);
    assertEquals(quote.totalAmount, expectedTotal);
    assertEquals(stripeInvoice.total, Math.round(expectedTotal * 100));
  });

  await t.step("Source 2: Applies coupon discount from promo_codes DB and reconciles in Stripe invoice", () => {
    const facility = db.facilities[0];
    const promo = db.promo_codes[0];
    const toteCount = 10;
    const isValet = false;

    const { quote, stripeInvoice } = generateStripeInvoicePayload(db, {
      facilityId: facility.id,
      toteCount,
      isValet,
      promoCode: promo.code,
      customerId: "cus_customer_123",
    });

    // Derive all expected values dynamically
    const expectedRate = facility.tier2_rate;
    const expectedGross = Number((toteCount * expectedRate).toFixed(2));
    const expectedDiscount = Number((expectedGross * (promo.customer_discount_pct / 100)).toFixed(2));
    const expectedTaxable = Number((expectedGross - expectedDiscount).toFixed(2));
    const expectedTax = Number((expectedTaxable * (facility.tax_rate_pct / 100)).toFixed(2));
    const expectedTotal = Number((expectedTaxable + expectedTax).toFixed(2));

    assertEquals(quote.grossSubtotal, expectedGross);
    assertEquals(quote.discountAmount, expectedDiscount);
    assertEquals(quote.taxAmount, expectedTax);
    assertEquals(quote.totalAmount, expectedTotal);
    assertEquals(stripeInvoice.applied_promo, promo.code);
    assertEquals(stripeInvoice.total, Math.round(expectedTotal * 100));
  });

  await t.step("Source 1 Update Propagation: Admin changes facility rates and quotes update dynamically", () => {
    const seattle = db.facilities.find((f) => f.id === "facility_seattle_north")!;
    // Admin updates rates dynamically
    seattle.tier1_rate = 5.75;
    seattle.valet_base = 18.00;

    const toteCount = 5;
    const isValet = true;

    const { quote } = generateStripeInvoicePayload(db, {
      facilityId: seattle.id,
      toteCount,
      isValet,
      customerId: "cus_customer_123",
    });

    const expectedRate = seattle.tier1_rate;
    const expectedStorage = Number((toteCount * expectedRate).toFixed(2));
    const expectedValet = Number((seattle.valet_base + toteCount * seattle.valet_tote_adder).toFixed(2));
    const expectedGross = Number((expectedStorage + expectedValet).toFixed(2));
    const expectedTotal = Number((expectedGross + Number((expectedGross * (seattle.tax_rate_pct / 100)).toFixed(2))).toFixed(2));

    assertEquals(quote.unitRate, expectedRate);
    assertEquals(quote.storageAmount, expectedStorage);
    assertEquals(quote.valetAmount, expectedValet);
    assertEquals(quote.grossSubtotal, expectedGross);
    assertEquals(quote.totalAmount, expectedTotal);
  });
});