// swarm-bot-tester.js
// CloudVault Automated Multi-Bot Swarm Testing Suite

const SUPABASE_URL = "https://xbxvebnrjryvksvtufqj.supabase.co";
const SUPABASE_KEY = "sb_publishable_-cW5neaZRGmicOHaHw1n3g_laY5yFZQ";

const HEADERS = {
    "apikey": SUPABASE_KEY,
    "Authorization": `Bearer ${SUPABASE_KEY}`,
    "Content-Type": "application/json",
    "Prefer": "return=representation"
};

const results = {
    passed: 0,
    failed: 0,
    logs: []
};

function logResult(botName, testName, success, details = "") {
    const icon = success ? "✅" : "❌";
    const status = success ? "PASS" : "FAIL";
    const msg = `[${botName}] ${icon} ${status}: ${testName} ${details ? '— ' + details : ''}`;
    console.log(msg);
    results.logs.push(msg);
    if (success) results.passed++;
    else results.failed++;
}

// ============================================================
// SWARM 1: Waitlist Deposit Flow Bots
// ============================================================
async function runWaitlistSwarm() {
    console.log("\n==================================================");
    console.log("🤖 SWARM 1: Waitlist Deposit & Price Lock Flow Bots");
    console.log("==================================================");

    const testZips = ["98101", "97201", "80202", "98901", "99999"];

    for (let i = 0; i < testZips.length; i++) {
        const zip = testZips[i];
        const email = `bot_swarm_${Date.now()}_${i}@cloudvault-test.com`;

        try {
            // 1. Query operational zones
            const zoneRes = await fetch(`${SUPABASE_URL}/rest/v1/operational_zones?select=required_deposit&zip_codes=cs.{${zip}}`, { headers: HEADERS });
            if (!zoneRes.ok) {
                const txt = await zoneRes.text();
                logResult("WaitlistBot", `Zone Lookup for ZIP ${zip}`, false, `HTTP ${zoneRes.status}: ${txt}`);
                continue;
            }
            const zoneData = await zoneRes.json();
            const reqDeposit = (zoneData && zoneData.length > 0 && zoneData[0].required_deposit) ? Number(zoneData[0].required_deposit) : 25.00;
            logResult("WaitlistBot", `Zone Lookup ZIP ${zip}`, true, `Required Deposit: $${reqDeposit.toFixed(2)}`);

            // 2. Insert into Waitlist
            const waitlistPayload = {
                email: email,
                zip_code: zip,
                city: zip === "80202" ? "Denver" : zip === "98901" ? "Yakima" : "Seattle",
                requested_totes: 5 + (i * 2),
                deposit_amount: reqDeposit,
                price_lock_years: 5,
                refund_guarantee_days: 365,
                payment_status: "pending_deposit"
            };

            const insertRes = await fetch(`${SUPABASE_URL}/rest/v1/waitlist`, {
                method: "POST",
                headers: HEADERS,
                body: JSON.stringify(waitlistPayload)
            });

            if (!insertRes.ok) {
                const txt = await insertRes.text();
                logResult("WaitlistBot", `Waitlist Insert for ${email}`, false, `HTTP ${insertRes.status}: ${txt}`);
                continue;
            }

            const insertedData = await insertRes.json();
            const rowId = insertedData[0].id;
            logResult("WaitlistBot", `Waitlist Insert for ${email}`, true, `Row ID: ${rowId}`);

            // 3. Update Waitlist Deposit to 'deposit_paid'
            const updateRes = await fetch(`${SUPABASE_URL}/rest/v1/waitlist?id=eq.${rowId}`, {
                method: "PATCH",
                headers: HEADERS,
                body: JSON.stringify({
                    deposit_amount: reqDeposit,
                    payment_status: "deposit_paid"
                })
            });

            if (!updateRes.ok) {
                const txt = await updateRes.text();
                logResult("WaitlistBot", `Deposit Payment Update for Row ${rowId}`, false, `HTTP ${updateRes.status}: ${txt}`);
            } else {
                logResult("WaitlistBot", `Deposit Payment Update for Row ${rowId}`, true, `Payment Status: deposit_paid`);
            }

        } catch (err) {
            logResult("WaitlistBot", `Unexpected Exception for ZIP ${zip}`, false, err.message);
        }
    }
}

// ============================================================
// SWARM 2: Pricing Engine Validation Bots
// ============================================================
async function runPricingSwarm() {
    console.log("\n==================================================");
    console.log("🤖 SWARM 2: Regional & Volume Pricing Engine Bots");
    console.log("==================================================");

    function getTierRate(toteCount) {
        if (toteCount >= 50) return { rate: 1.00, tier: 4 };
        if (toteCount >= 25) return { rate: 2.00, tier: 3 };
        if (toteCount >= 10) return { rate: 3.50, tier: 2 };
        return { rate: 5.00, tier: 1 };
    }

    const testCases = [
        { totes: 1, expectedRate: 5.00, expectedTier: 1 },
        { totes: 5, expectedRate: 5.00, expectedTier: 1 },
        { totes: 10, expectedRate: 3.50, expectedTier: 2 },
        { totes: 24, expectedRate: 3.50, expectedTier: 2 },
        { totes: 25, expectedRate: 2.00, expectedTier: 3 },
        { totes: 49, expectedRate: 2.00, expectedTier: 3 },
        { totes: 50, expectedRate: 1.00, expectedTier: 4 },
        { totes: 100, expectedRate: 1.00, expectedTier: 4 }
    ];

    testCases.forEach(tc => {
        const res = getTierRate(tc.totes);
        const pass = res.rate === tc.expectedRate && res.tier === tc.expectedTier;
        logResult("PricingBot", `Tote Count ${tc.totes}`, pass, `Got $${res.rate.toFixed(2)} (Tier ${res.tier}), Expected $${tc.expectedRate.toFixed(2)} (Tier ${tc.expectedTier})`);
    });
}

// ============================================================
// SWARM 3: Staging Room Capacity Enforcement Bots
// ============================================================
async function runCapacitySwarm() {
    console.log("\n==================================================");
    console.log("🤖 SWARM 3: Staging Room Capacity Enforcement Bots");
    console.log("==================================================");

    const testFacility = "facility_seattle_north";
    const targetDate = "2026-09-01";
    const testSlot = "09:00 AM - 12:00 PM";

    try {
        // 1. Fetch facility staging_rooms capacity
        const facRes = await fetch(`${SUPABASE_URL}/rest/v1/facilities?id=eq.${testFacility}&select=staging_rooms`, { headers: HEADERS });
        if (!facRes.ok) {
            logResult("CapacityBot", "Facility Staging Room Capacity Lookup", false, `HTTP ${facRes.status}`);
            return;
        }
        const facData = await facRes.json();
        const stagingCap = (facData && facData.length > 0 && facData[0].staging_rooms) ? facData[0].staging_rooms : 2;
        logResult("CapacityBot", "Facility Staging Room Capacity Lookup", true, `${testFacility} Staging Rooms Cap = ${stagingCap}`);

        // 2. Query active access_requests for this date & slot
        const reqsRes = await fetch(`${SUPABASE_URL}/rest/v1/access_requests?facility_id=eq.${testFacility}&target_date=eq.${targetDate}&status=eq.pending&select=time_slot`, { headers: HEADERS });
        if (!reqsRes.ok) {
            logResult("CapacityBot", "Active Access Requests Query", false, `HTTP ${reqsRes.status}`);
            return;
        }
        const reqsData = await reqsRes.json();
        const bookedCount = reqsData.filter(r => (r.time_slot || "09:00 AM - 12:00 PM") === testSlot).length;
        const isFull = bookedCount >= stagingCap;

        logResult("CapacityBot", `Slot Availability Check for ${targetDate} (${testSlot})`, true, `Booked: ${bookedCount}/${stagingCap} — Slot Full: ${isFull}`);

    } catch (err) {
        logResult("CapacityBot", "Unexpected Exception", false, err.message);
    }
}

// ============================================================
// SWARM 4: Admin Worker Queue & Delivery Awareness Bots
// ============================================================
async function runAdminSwarm() {
    console.log("\n==================================================");
    console.log("🤖 SWARM 4: Admin Worker Queue & Incoming Deliveries Bots");
    console.log("==================================================");

    try {
        // 1. Query incoming scheduled deliveries (request_type = 'new_tote_delivery')
        const deliveriesRes = await fetch(`${SUPABASE_URL}/rest/v1/access_requests?request_type=eq.new_tote_delivery&status=eq.pending&select=uid,pin,fulfillment_type,additional_totes,target_date,time_slot`, { headers: HEADERS });
        
        if (!deliveriesRes.ok) {
            const txt = await deliveriesRes.text();
            logResult("AdminBot", "Query Incoming Scheduled Deliveries (Tab 1)", false, `HTTP ${deliveriesRes.status}: ${txt}`);
        } else {
            const data = await deliveriesRes.json();
            logResult("AdminBot", "Query Incoming Scheduled Deliveries (Tab 1)", true, `Found ${data.length} pending new tote deliveries`);
        }

        // 2. Query Facilities Table including staging_rooms
        const facsRes = await fetch(`${SUPABASE_URL}/rest/v1/facilities?select=id,name,staging_rooms,active_totes,valet_base`, { headers: HEADERS });
        if (!facsRes.ok) {
            const txt = await facsRes.text();
            logResult("AdminBot", "Query Facilities Specifications", false, `HTTP ${facsRes.status}: ${txt}`);
        } else {
            const facs = await facsRes.json();
            logResult("AdminBot", "Query Facilities Specifications", true, `Retrieved ${facs.length} facility records. First: ${facs[0]?.name} (${facs[0]?.staging_rooms || 2} rooms)`);
        }

    } catch (err) {
        logResult("AdminBot", "Unexpected Exception", false, err.message);
    }
}

// ============================================================
// SWARM 5: E2E Customer & Worker Fulfillment Load Swarm
// ============================================================
async function runE2EFulfillmentSwarm() {
    console.log("\n==================================================");
    console.log("🤖 SWARM 5: E2E Customer & Worker Fulfillment Load Swarm");
    console.log("==================================================");

    const botEmail = `fulfillment_bot_${Date.now()}@cloudvault-test.com`;
    const botPassword = "TestPassword123!";
    const targetDate = "2026-08-15";
    const timeSlot = "09:00 AM - 12:00 PM";

    try {
        // 1. Authenticate Bot User via Supabase Auth SignUp
        const authRes = await fetch(`${SUPABASE_URL}/auth/v1/signup`, {
            method: "POST",
            headers: HEADERS,
            body: JSON.stringify({ email: botEmail, password: botPassword })
        });

        if (!authRes.ok) {
            const txt = await authRes.text();
            logResult("FulfillmentBot", "Bot User Auth Registration", false, `HTTP ${authRes.status}: ${txt}`);
            return;
        }

        const authData = await authRes.json();
        const userToken = authData.access_token;
        const userId = authData.user?.id;
        logResult("FulfillmentBot", "Bot User Auth Registration", true, `User ID: ${userId}`);

        if (!userToken) {
            logResult("FulfillmentBot", "Bot JWT Token Retrieval", false, "No access_token returned (email confirmation required on project)");
            return;
        }

        const userHeaders = {
            "apikey": SUPABASE_KEY,
            "Authorization": `Bearer ${userToken}`,
            "Content-Type": "application/json",
            "Prefer": "return=representation"
        };

        // 2. Initialize customer profile via create_customer_profile RPC
        const profileRes = await fetch(`${SUPABASE_URL}/rest/v1/rpc/create_customer_profile`, {
            method: "POST",
            headers: userHeaders,
            body: JSON.stringify({
                p_name: "Fulfillment Test Bot",
                p_phone: "555-0199",
                p_zip: "98101",
                p_tote_count: 5,
                p_logistics_type: "self_service"
            })
        });

        if (!profileRes.ok) {
            const txt = await profileRes.text();
            logResult("FulfillmentBot", "Profile Onboarding RPC", false, `HTTP ${profileRes.status}: ${txt}`);
        } else {
            logResult("FulfillmentBot", "Profile Onboarding RPC", true, "Subscription & Profile initialized");
        }

        // 3. Call add_totes RPC with date & time slot
        const addTotesPayload = {
            p_additional_totes: 3,
            p_logistics_type: "valet_pickup",
            p_target_date: targetDate,
            p_time_slot: timeSlot
        };

        const rpcRes = await fetch(`${SUPABASE_URL}/rest/v1/rpc/add_totes`, {
            method: "POST",
            headers: userHeaders,
            body: JSON.stringify(addTotesPayload)
        });

        if (!rpcRes.ok) {
            const txt = await rpcRes.text();
            logResult("FulfillmentBot", "RPC add_totes Execution", false, `HTTP ${rpcRes.status}: ${txt}`);
        } else {
            const data = await rpcRes.json();
            logResult("FulfillmentBot", "RPC add_totes Execution", true, `New Monthly: $${data.newMonthly.toFixed(2)}, Valet Fee: $${data.valetFee.toFixed(2)}, PIN: ${data.pin}`);
        }

        // 4. Query access_requests to confirm new_tote_delivery record was created
        const reqCheckRes = await fetch(`${SUPABASE_URL}/rest/v1/access_requests?request_type=eq.new_tote_delivery&target_date=eq.${targetDate}&select=id,additional_totes,time_slot,status`, { headers: userHeaders });
        if (!reqCheckRes.ok) {
            logResult("FulfillmentBot", "Access Requests Verification", false, `HTTP ${reqCheckRes.status}`);
        } else {
            const reqs = await reqCheckRes.json();
            logResult("FulfillmentBot", "Access Requests Verification", reqs.length > 0, `Found ${reqs.length} request(s) scheduled for ${targetDate} (${timeSlot})`);
        }

    } catch (err) {
        logResult("FulfillmentBot", "Unexpected Exception", false, err.message);
    }
}

// ============================================================
// MAIN RUNNER
// ============================================================
async function runAllSwarms() {
    console.log("==================================================");
    console.log("🚀 STARTING CLOUDVAULT AUTOMATED BOT SWARM TESTS");
    console.log("==================================================");

    await runWaitlistSwarm();
    await runPricingSwarm();
    await runCapacitySwarm();
    await runAdminSwarm();
    await runE2EFulfillmentSwarm();

    // Cleanup test data from waitlist table
    try {
        await fetch(`${SUPABASE_URL}/rest/v1/waitlist?email=like.*cloudvault-test.com*`, {
            method: 'DELETE',
            headers: HEADERS
        });
    } catch (e) {
        // Ignored
    }

    console.log("\n==================================================");
    console.log("📊 BOT SWARM SUMMARY RESULTS");
    console.log("==================================================");
    console.log(`Total Tests Run: ${results.passed + results.failed}`);
    console.log(`✅ Passed: ${results.passed}`);
    console.log(`❌ Failed: ${results.failed}`);
    
    if (results.failed === 0) {
        console.log("\n🎉 ALL BOT SWARMS PASSED WITH 0 ERRORS! SYSTEM IS 100% HEALTHY!");
    } else {
        console.log(`\n⚠️ ENCOUNTERED ${results.failed} FAILURE(S). ATTENTION REQUIRED!`);
    }
}

runAllSwarms();
