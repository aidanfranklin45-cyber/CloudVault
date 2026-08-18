const SUPABASE_URL = "https://xbxvebnrjryvksvtufqj.supabase.co";
const SUPABASE_ANON_KEY = "sb_publishable_-cW5neaZRGmicOHaHw1n3g_laY5yFZQ";

async function testFetch() {
    // Test 1: inventory query
    const invUrl = `${SUPABASE_URL}/rest/v1/inventory?select=*,users!uid(name,onboarding_status)&facility_id=eq.facility_yakima&status=in.(stored,pending-stage,staged,pending-dispatch,out-for-delivery,with-customer)`;
    const r1 = await fetch(invUrl, {
        headers: {
            'apikey': SUPABASE_ANON_KEY,
            'Authorization': `Bearer ${SUPABASE_ANON_KEY}`
        }
    });
    console.log("Inventory status:", r1.status);
    const text1 = await r1.text();
    console.log("Inventory result count:", JSON.parse(text1).length, text1.slice(0, 300));

    // Test 2: access_requests query
    const reqUrl = `${SUPABASE_URL}/rest/v1/access_requests?select=id,uid,pin,fulfillment_type,additional_totes,target_date,time_slot,surge_tier,surge_fee,request_type,status,requested_items,requested_tote_codes,driver_name,vehicle_info,requested_at,assigned_room&facility_id=eq.facility_yakima&status=not.in.(completed,cancelled,returned-to-vault)`;
    const r2 = await fetch(reqUrl, {
        headers: {
            'apikey': SUPABASE_ANON_KEY,
            'Authorization': `Bearer ${SUPABASE_ANON_KEY}`
        }
    });
    console.log("Access requests status:", r2.status);
    const text2 = await r2.text();
    console.log("Access requests result:", text2);
}

testFetch();
