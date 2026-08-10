// supabase-config.js
// Shared Supabase initialization — imported by all pages.

const SUPABASE_URL = "https://xbxvebnrjryvksvtufqj.supabase.co";
const SUPABASE_ANON_KEY = "sb_publishable_-cW5neaZRGmicOHaHw1n3g_laY5yFZQ";

// Custom Storage Engine supporting "Remember Me" toggle (localStorage vs sessionStorage)
const customStorageEngine = {
    getItem: (key) => {
        const isRemember = localStorage.getItem('cv_remember_me') === 'true';
        if (isRemember) {
            return localStorage.getItem(key) || sessionStorage.getItem(key);
        }
        return sessionStorage.getItem(key) || localStorage.getItem(key);
    },
    setItem: (key, value) => {
        const isRemember = localStorage.getItem('cv_remember_me') === 'true';
        if (isRemember) {
            localStorage.setItem(key, value);
            sessionStorage.removeItem(key);
        } else {
            sessionStorage.setItem(key, value);
            localStorage.removeItem(key);
        }
    },
    removeItem: (key) => {
        localStorage.removeItem(key);
        sessionStorage.removeItem(key);
    }
};

// Initialize Supabase Client
const { createClient } = window.supabase;
window.supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: {
        storage: customStorageEngine,
        autoRefreshToken: true,
        persistSession: true,
        detectSessionInUrl: true
    }
});

// 30-Minute Inactivity Auto-Logout Tracker
function initInactivityTracker(timeoutMinutes = 30) {
    const isPublicPage = window.location.pathname.endsWith('login.html') || window.location.pathname.endsWith('index.html') || window.location.pathname === '/';
    if (isPublicPage) return;

    const INACTIVITY_LIMIT_MS = timeoutMinutes * 60 * 1000;
    let idleTimer = null;

    async function handleAutoLogout() {
        console.warn(`User inactive for ${timeoutMinutes} minutes. Auto-logging out...`);
        try {
            await window.supabase.auth.signOut();
        } catch (e) {
            console.error('Auto logout error:', e);
        }
        clearUserCache();
        localStorage.removeItem('cv_remember_me');
        sessionStorage.clear();
        window.location.href = 'login.html?reason=inactivity';
    }

    function resetIdleTimer() {
        if (idleTimer) clearTimeout(idleTimer);
        idleTimer = setTimeout(handleAutoLogout, INACTIVITY_LIMIT_MS);
    }

    const activityEvents = ['mousemove', 'mousedown', 'keydown', 'touchstart', 'scroll', 'click'];
    activityEvents.forEach(evt => {
        window.addEventListener(evt, resetIdleTimer, { passive: true });
    });

    resetIdleTimer();
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => initInactivityTracker(30));
} else {
    initInactivityTracker(30);
}

// Helper to get profile from public.users table with 5-minute TTL
async function getCachedUserProfile(uid) {
    const cacheKey = `cv_user_${uid}`;
    const cacheTimeKey = `cv_user_ts_${uid}`;
    const cached = localStorage.getItem(cacheKey);
    const cachedTs = localStorage.getItem(cacheTimeKey);
    const now = Date.now();
    const TTL_MS = 5 * 60 * 1000; // 5 minutes

    if (cached && cachedTs && (now - Number(cachedTs) < TTL_MS)) {
        return JSON.parse(cached);
    }

    // Cache miss or expired — read from Supabase public.users table
    const { data, error } = await supabase
        .from('users')
        .select('*')
        .eq('id', uid)
        .maybeSingle();

    if (error) {
        console.error('Error fetching user profile:', error);
        return null;
    }

    if (data) {
        localStorage.setItem(cacheKey, JSON.stringify(data));
        localStorage.setItem(cacheTimeKey, String(now));
        return data;
    }
    return null;
}

function clearUserCache() {
    Object.keys(localStorage).forEach(key => {
        if (key.startsWith('cv_user_')) localStorage.removeItem(key);
    });
}

// Utility: Generate a random 4-digit PIN (client-side)
function generatePin() {
    return String(Math.floor(1000 + Math.random() * 9000));
}

// Utility: Check 6 PM cutoff
function isPastCutoff() {
    const now = new Date();
    return now.getHours() >= 18; // 6:00 PM local time
}

// Utility: Generate facility-tethered non-colliding tote code (e.g. CV-SEA-49AK, CV-PDX-8B2X)
function generateToteCode(facilityId = 'facility_seattle_north') {
    const prefix = (facilityId.includes('portland') || facilityId.includes('pdx')) ? 'PDX' : 'SEA';
    const charset = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
    let code = '';
    for (let i = 0; i < 4; i++) {
        code += charset.charAt(Math.floor(Math.random() * charset.length));
    }
    return `CV-${prefix}-${code}`;
}

// Shared Pricing Engine
function getTierRate(toteCount) {
    if (toteCount >= 50) return { rate: 1.00, tier: 4, label: 'Tier 4 — $1.00/tote' };
    if (toteCount >= 25) return { rate: 2.00, tier: 3, label: 'Tier 3 — $2.00/tote' };
    if (toteCount >= 10) return { rate: 3.50, tier: 2, label: 'Tier 2 — $3.50/tote' };
    return { rate: 5.00, tier: 1, label: 'Tier 1 — $5.00/tote' };
}

function getValetFee(toteCount) {
    return 15.00 + (toteCount * 1.00);
}