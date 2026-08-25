import { assertEquals, assertExists } from "std/assert";

interface FacilityRetrievalConfig {
  id: string;
  name: string;
  valet_base: number;
  valet_tote_adder: number;
  same_day_surge_fee: number;
  same_day_peak_surge_fee: number;
  evening_peak_slot_fee: number;
  next_day_promo_free: boolean;
  max_scheduling_days_out: number;
  min_lead_time_days: number;
}

function calculateRetrievalQuote(params: {
  facility: FacilityRetrievalConfig;
  toteCount: number;
  isValet: boolean;
  orderTimestamp: Date;
  targetDate: string; // YYYY-MM-DD
  timeSlot: string;   // e.g. "09:00 AM - 12:00 PM" | "03:00 PM - 06:00 PM"
}) {
  const { facility, toteCount, isValet, orderTimestamp, targetDate, timeSlot } = params;

  // 1. Calculate Days Out
  const orderDateStr = orderTimestamp.toISOString().split("T")[0];
  const orderMs = new Date(orderDateStr).getTime();
  const targetMs = new Date(targetDate).getTime();
  const daysOut = Math.round((targetMs - orderMs) / (1000 * 60 * 60 * 24));

  if (daysOut < facility.min_lead_time_days) {
    throw new Error(`Target date violates minimum lead time of ${facility.min_lead_time_days} days.`);
  }
  if (daysOut > facility.max_scheduling_days_out) {
    throw new Error(`Target date exceeds maximum scheduling horizon of ${facility.max_scheduling_days_out} days.`);
  }

  // 2. Base Logistics Fee
  const baseFee = isValet ? Number((facility.valet_base + toteCount * facility.valet_tote_adder).toFixed(2)) : 0;

  // 3. 6:00 PM (18:00:00) Cutoff & Surge Fee Resolution
  const orderHour = orderTimestamp.getHours();
  const isPastCutoff = orderHour >= 18;
  const isSameDay = daysOut === 0;
  const isNextDay = daysOut === 1;

  let surgeFee = 0;
  if (isSameDay || (isNextDay && isPastCutoff)) {
    surgeFee = facility.same_day_surge_fee;
  } else if (isNextDay && !isPastCutoff && facility.next_day_promo_free) {
    surgeFee = 0;
  }

  // 4. Evening Slot Adder
  const isEveningSlot = timeSlot.includes("03:00 PM") || timeSlot.includes("06:00 PM") || timeSlot.toLowerCase().includes("evening");
  const eveningAdder = isEveningSlot ? facility.evening_peak_slot_fee : 0;

  const totalQuote = Number((baseFee + surgeFee + eveningAdder).toFixed(2));

  return { baseFee, surgeFee, eveningAdder, totalQuote, daysOut, isPastCutoff };
}

Deno.test("Retrieval Surge Matrix - 6 PM Cutoff & Peak Boundary Invariants", async (t) => {
  const facility: FacilityRetrievalConfig = {
    id: "facility_seattle_hub",
    name: "Seattle Hub",
    valet_base: 16.00,
    valet_tote_adder: 1.00,
    same_day_surge_fee: 10.00,
    same_day_peak_surge_fee: 15.00,
    evening_peak_slot_fee: 5.00,
    next_day_promo_free: true,
    max_scheduling_days_out: 30,
    min_lead_time_days: 0,
  };

  await t.step("Next-day ordered before 6:00 PM enjoys $0 surge fee", () => {
    // Ordered at 2:30 PM (14:30) for next day morning slot
    const orderTime = new Date("2026-08-25T14:30:00");
    const quote = calculateRetrievalQuote({
      facility,
      toteCount: 4,
      isValet: true,
      orderTimestamp: orderTime,
      targetDate: "2026-08-26",
      timeSlot: "09:00 AM - 12:00 PM",
    });

    const expectedBase = Number((facility.valet_base + 4 * facility.valet_tote_adder).toFixed(2));
    assertEquals(quote.isPastCutoff, false);
    assertEquals(quote.surgeFee, 0.00);
    assertEquals(quote.eveningAdder, 0.00);
    assertEquals(quote.baseFee, expectedBase);
    assertEquals(quote.totalQuote, expectedBase);
  });

  await t.step("Next-day ordered after 6:00 PM incurs same-day surge fee", () => {
    // Ordered at 6:45 PM (18:45) for next day morning slot
    const orderTime = new Date("2026-08-25T18:45:00");
    const quote = calculateRetrievalQuote({
      facility,
      toteCount: 4,
      isValet: true,
      orderTimestamp: orderTime,
      targetDate: "2026-08-26",
      timeSlot: "09:00 AM - 12:00 PM",
    });

    const expectedBase = Number((facility.valet_base + 4 * facility.valet_tote_adder).toFixed(2));
    const expectedSurge = facility.same_day_surge_fee;
    assertEquals(quote.isPastCutoff, true);
    assertEquals(quote.surgeFee, expectedSurge);
    assertEquals(quote.totalQuote, Number((expectedBase + expectedSurge).toFixed(2)));
  });

  await t.step("Evening slot dynamically attaches evening_peak_slot_fee", () => {
    const orderTime = new Date("2026-08-25T10:00:00");
    const quote = calculateRetrievalQuote({
      facility,
      toteCount: 2,
      isValet: true,
      orderTimestamp: orderTime,
      targetDate: "2026-08-28", // 3 days out
      timeSlot: "03:00 PM - 06:00 PM",
    });

    const expectedBase = Number((facility.valet_base + 2 * facility.valet_tote_adder).toFixed(2));
    const expectedEvening = facility.evening_peak_slot_fee;
    assertEquals(quote.eveningAdder, expectedEvening);
    assertEquals(quote.totalQuote, Number((expectedBase + expectedEvening).toFixed(2)));
  });

  await t.step("Enforces max scheduling horizon boundary", () => {
    const orderTime = new Date("2026-08-25T10:00:00");
    let errorThrown = false;
    try {
      calculateRetrievalQuote({
        facility,
        toteCount: 1,
        isValet: true,
        orderTimestamp: orderTime,
        targetDate: "2026-10-01", // 37 days out -> exceeds 30
        timeSlot: "09:00 AM - 12:00 PM",
      });
    } catch (err: any) {
      errorThrown = true;
      assertEquals(err.message.includes("exceeds maximum scheduling horizon"), true);
    }
    assertEquals(errorThrown, true);
  });
});