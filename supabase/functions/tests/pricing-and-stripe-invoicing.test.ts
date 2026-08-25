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
    const { quote, stripeInvoice } = generateStripeInvoicePayload(db, {
      facilityId: "facility_seattle_north",
      toteCount: 12, // Tier 2 ($3.50/tote)
      isValet: true,  // $16 + 12*$1 = $28
      customerId: "cus_customer_123",
    });

    // 12 * $3.50 = $42.00 storage + $28.00 valet = $70.00 gross
    assertEquals(quote.unitRate, 3.50);
    assertEquals(quote.storageAmount, 42.00);
    assertEquals(quote.valetAmount, 28.00);
    assertEquals(quote.grossSubtotal, 70.00);
    assertEquals(quote.discountAmount, 0.00);
    // 10.25% tax on $70.00 = $7.17 -> Total = $77.17
    assertEquals(quote.taxAmount, 7.17);
    assertEquals(quote.totalAmount, 77.17);
    assertEquals(stripeInvoice.total, 7717); // In cents for Stripe
  });

  await t.step("Source 2: Applies coupon discount from promo_codes DB and reconciles in Stripe invoice", () => {
    const { quote, stripeInvoice } = generateStripeInvoicePayload(db, {
      facilityId: "facility_seattle_north",
      toteCount: 10,
      isValet: false,
      promoCode: "SUMMER20",
      customerId: "cus_customer_123",
    });

    // 10 totes @ $3.50 = $35.00 gross
    // 20% discount on $35.00 = $7.00
    // Taxable = $28.00, Tax (10.25%) = $2.87, Total = $30.87
    assertEquals(quote.grossSubtotal, 35.00);
    assertEquals(quote.discountAmount, 7.00);
    assertEquals(quote.taxAmount, 2.87);
    assertEquals(quote.totalAmount, 30.87);
    assertEquals(stripeInvoice.applied_promo, "SUMMER20");
    assertEquals(stripeInvoice.total, 3087);
  });

  await t.step("Source 1 Update Propagation: Admin changes facility rates and quotes update dynamically", () => {
    // Admin updates Seattle Tier 1 rate from $5.10 to $5.75 and Valet Base to $18.00 in Supabase
    const seattle = db.facilities.find((f) => f.id === "facility_seattle_north")!;
    seattle.tier1_rate = 5.75;
    seattle.valet_base = 18.00;

    const { quote } = generateStripeInvoicePayload(db, {
      facilityId: "facility_seattle_north",
      toteCount: 5, // Tier 1 ($5.75/tote)
      isValet: true,  // $18 + 5*$1 = $23
      customerId: "cus_customer_123",
    });

    // 5 * $5.75 = $28.75 storage + $23.00 valet = $51.75 gross + 10.25% tax ($5.30) = $57.05
    assertEquals(quote.unitRate, 5.75);
    assertEquals(quote.storageAmount, 28.75);
    assertEquals(quote.valetAmount, 23.00);
    assertEquals(quote.grossSubtotal, 51.75);
    assertEquals(quote.totalAmount, 57.05);
  });
});