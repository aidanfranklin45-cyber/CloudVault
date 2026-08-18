import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
import fs from 'fs';

const SUPABASE_URL = 'https://xbxvebnrjryvksvtufqj.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InhieHZlYm5yanJ5dmtzdnR1ZnFqIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Mzg1Mjg2NzgsImV4cCI6MjA1NDEwNDY3OH0.5DfgD5V_qOq0f9Lw1P49wE-pP86WpG1-s-EfZ-77n4U';

const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

async function testQueries() {
    const queryFacilityId = 'facility_yakima';
    const statuses = ['stored', 'pending-stage', 'staged', 'pending-dispatch', 'out-for-delivery', 'with-customer'];

    console.log("--- Testing inventory query ---");
    const facRes = await supabase.from('inventory').select('*, users!uid(name, onboarding_status)').eq('facility_id', queryFacilityId).in('status', statuses);
    console.log("facRes count:", facRes.data?.length, "error:", facRes.error);

    console.log("--- Testing access_requests query ---");
    const facManifestsRes = await supabase.from('access_requests').select('id, uid, pin, fulfillment_type, additional_totes, target_date, time_slot, surge_tier, surge_fee, request_type, status, requested_items, requested_tote_codes, driver_name, vehicle_info, requested_at, assigned_room')
        .eq('facility_id', queryFacilityId)
        .not('status', 'in', '("completed","cancelled","returned-to-vault")');
    console.log("facManifestsRes count:", facManifestsRes.data?.length, "error:", facManifestsRes.error);
}

testQueries().catch(console.error);
