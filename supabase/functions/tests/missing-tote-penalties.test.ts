import { assertEquals, assertExists } from "std/assert";

interface FacilityAuditConfig {
  id: string;
  name: string;
  missing_tote_fee: number;
}

function calculateMissingTotePenalty(facility: FacilityAuditConfig, missingCount: number) {
  if (!facility || facility.missing_tote_fee == null) {
    throw new Error(`Facility '${facility?.id || "unknown"}' is missing dynamic missing_tote_fee configuration.`);
  }

  const count = Math.max(1, Number(missingCount) || 1);
  const unitPenalty = Number(facility.missing_tote_fee);
  const totalPenalty = Number((count * unitPenalty).toFixed(2));

  return {
    unitPenalty,
    missingCount: count,
    totalPenalty,
    chargeRecord: {
      charge_type: "missing_tote_penalty",
      amount: totalPenalty,
      description: `Unreturned Tote Replacement Fee (${count} @ $${unitPenalty.toFixed(2)})`,
      facility_id: facility.id,
    },
  };
}

Deno.test("Missing Tote Penalty - Dynamic Facility Fee Scaling", async (t) => {
  await t.step("scales missing tote penalties strictly from dynamic facility config across 20 randomized facilities", () => {
    for (let i = 0; i < 20; i++) {
      const randomFee = Number((15.00 + Math.random() * 20.00).toFixed(2)); // $15.00 - $35.00
      const facility: FacilityAuditConfig = {
        id: `facility_audit_${i}`,
        name: `Audit Facility ${i}`,
        missing_tote_fee: randomFee,
      };

      const testCounts = [1, 2, 3, 5, 10, 25];
      for (const count of testCounts) {
        const assessment = calculateMissingTotePenalty(facility, count);

        // Derive expected values dynamically (Zero magic numbers)
        const expectedTotal = Number((count * facility.missing_tote_fee).toFixed(2));
        assertEquals(assessment.unitPenalty, facility.missing_tote_fee);
        assertEquals(assessment.totalPenalty, expectedTotal);
        assertEquals(assessment.chargeRecord.amount, expectedTotal);
      }
    }
  });

  await t.step("fails fast if facility missing_tote_fee is undefined", () => {
    const invalidFacility = { id: "facility_missing_fee", name: "Incomplete" } as any;
    let errorThrown = false;
    try {
      calculateMissingTotePenalty(invalidFacility, 2);
    } catch (err: any) {
      errorThrown = true;
      assertEquals(err.message.includes("missing dynamic missing_tote_fee configuration"), true);
    }
    assertEquals(errorThrown, true);
  });
});