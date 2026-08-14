const crypto = require('crypto');

const SUPABASE_URL = "https://xbxvebnrjryvksvtufqj.supabase.co";
const SUPABASE_ANON_KEY = "sb_publishable_-cW5neaZRGmicOHaHw1n3g_laY5yFZQ";

function hashBadgeToken(token) {
    return crypto.createHash('sha256').update(token.trim()).digest('hex');
}

function generateBadgeToken() {
    return `CV-AUTH-${crypto.randomBytes(16).toString('hex').toUpperCase()}`;
}

async function rpc(functionName, params) {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${functionName}`, {
        method: 'POST',
        headers: {
            'apikey': SUPABASE_ANON_KEY,
            'Authorization': `Bearer ${SUPABASE_ANON_KEY}`,
            'Content-Type': 'application/json'
        },
        body: JSON.stringify(params)
    });

    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch (e) { json = text; }

    if (!res.ok) {
        return { data: null, error: { message: json.message || text, status: res.status } };
    }
    return { data: json, error: null };
}

async function runTests() {
    console.log('--- Starting Silent 2D Barcode Scan-to-Login & Badge Verification Tests ---');

    const workerUserId = '48e84105-39d8-4c98-b541-db6e1069b295'; // Seattle Worker (role: warehouse_worker)
    const customerUserId = '44c04303-d2c2-47f7-93f0-9f30fa882293'; // Lola (role: customer)

    // Test 1: Issue badge to valid worker
    const workerToken = generateBadgeToken();
    const workerHash = hashBadgeToken(workerToken);
    console.log(`\n[Test 1] Issuing badge to Worker (${workerUserId}) with token: ${workerToken}`);
    const { data: issueData, error: issueErr } = await rpc('issue_employee_badge', {
        p_user_id: workerUserId,
        p_token_hash: workerHash,
        p_badge_label: 'Seattle Worker Primary Badge'
    });

    if (issueErr) {
        console.error('❌ Test 1 Failed: Issue badge error:', issueErr);
        process.exit(1);
    }
    console.log('✓ Test 1 Passed: Badge issued successfully:', issueData);

    // Test 2: Verify badge authentication with valid token hash
    console.log(`\n[Test 2] Verifying badge login with valid hash: ${workerHash}`);
    const { data: authData, error: authErr } = await rpc('verify_employee_badge_login', {
        p_token_hash: workerHash
    });

    if (authErr || !authData.success) {
        console.error('❌ Test 2 Failed: Auth verification error:', authErr);
        process.exit(1);
    }
    console.log('✓ Test 2 Passed: Authenticated worker:', authData.user);
    if (authData.user.role !== 'warehouse_worker') {
        console.error(`❌ Test 2 Failed: Expected warehouse_worker, got ${authData.user.role}`);
        process.exit(1);
    }

    // Test 3: Attempt to issue badge to a customer account (Strict RBAC check)
    const customerToken = generateBadgeToken();
    const customerHash = hashBadgeToken(customerToken);
    console.log(`\n[Test 3] Attempting to issue badge to Customer account (${customerUserId})`);
    const { data: custIssueData, error: custIssueErr } = await rpc('issue_employee_badge', {
        p_user_id: customerUserId,
        p_token_hash: customerHash,
        p_badge_label: 'Illegal Customer Badge'
    });

    if (custIssueErr) {
        console.log('✓ Test 3 Passed: Customer badge issuance was correctly blocked by database constraint:', custIssueErr.message);
    } else {
        console.error('❌ Test 3 Failed: Customer badge issuance should have been blocked!', custIssueData);
        process.exit(1);
    }

    // Test 4: Verify login with invalid / unknown token hash
    const fakeHash = hashBadgeToken(generateBadgeToken());
    console.log(`\n[Test 4] Attempting login with unknown token hash: ${fakeHash}`);
    const { data: fakeAuthData, error: fakeAuthErr } = await rpc('verify_employee_badge_login', {
        p_token_hash: fakeHash
    });

    if (fakeAuthErr) {
        console.log('✓ Test 4 Passed: Fake token was correctly rejected:', fakeAuthErr.message);
    } else {
        console.error('❌ Test 4 Failed: Fake token should have been rejected!', fakeAuthData);
        process.exit(1);
    }

    // Test 5: Revoke badge and verify that subsequent login fails
    console.log(`\n[Test 5] Revoking badge (${issueData.badge_id}) and attempting verification`);
    const { data: revokeData, error: revokeErr } = await rpc('revoke_employee_badge', {
        p_badge_id: issueData.badge_id
    });

    if (revokeErr) {
        console.error('❌ Test 5 Failed: Revocation error:', revokeErr);
        process.exit(1);
    }
    console.log('✓ Badge revoked successfully:', revokeData);

    const { data: postRevokeAuth, error: postRevokeErr } = await rpc('verify_employee_badge_login', {
        p_token_hash: workerHash
    });

    if (postRevokeErr) {
        console.log('✓ Test 5 Passed: Revoked badge login correctly rejected:', postRevokeErr.message);
    } else {
        console.error('❌ Test 5 Failed: Revoked badge should not have authenticated!', postRevokeAuth);
        process.exit(1);
    }

    // Test 6: Re-issue badge to worker so they have a fresh active badge for manual use
    console.log('\n[Test 6] Re-issuing fresh active badge for Seattle Worker');
    const freshToken = generateBadgeToken();
    const freshHash = hashBadgeToken(freshToken);
    const { data: reissuedData, error: reissuedErr } = await rpc('issue_employee_badge', {
        p_user_id: workerUserId,
        p_token_hash: freshHash,
        p_badge_label: 'Seattle Worker Production Badge'
    });
    if (reissuedErr) {
        console.error('❌ Test 6 Failed:', reissuedErr);
        process.exit(1);
    }
    console.log('✓ Test 6 Passed: Fresh badge enrolled:', {
        badge_id: reissuedData.badge_id,
        raw_token: freshToken
    });

    console.log('\n========================================');
    console.log('🎉 ALL 6 AUTOMATED SECURITY & AUTH TESTS PASSED!');
    console.log('========================================\n');
}

runTests().catch(err => {
    console.error('Test runner fatal error:', err);
    process.exit(1);
});
