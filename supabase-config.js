// supabase-config.js
// Shared Supabase initialization — imported by all pages.

const SUPABASE_URL = "https://xbxvebnrjryvksvtufqj.supabase.co";
const SUPABASE_ANON_KEY = "sb_publishable_-cW5neaZRGmicOHaHw1n3g_laY5yFZQ";

// Cloudflare Turnstile Configuration
const CLOUDFLARE_TURNSTILE_SITE_KEY = "0x4AAAAAAEjEt23VSN7b2FPK";
window.CLOUDFLARE_TURNSTILE_SITE_KEY = CLOUDFLARE_TURNSTILE_SITE_KEY;

// Safe Session Storage Engine supporting cross-tab persistence & robust token recovery
const customStorageEngine = {
    getItem: (key) => {
        try {
            return localStorage.getItem(key) || sessionStorage.getItem(key);
        } catch (e) {
            return null;
        }
    },
    setItem: (key, value) => {
        try {
            localStorage.setItem(key, value);
            sessionStorage.setItem(key, value);
        } catch (e) {
            try { sessionStorage.setItem(key, value); } catch (e2) {}
        }
    },
    removeItem: (key) => {
        try {
            localStorage.removeItem(key);
            sessionStorage.removeItem(key);
        } catch (e) {}
    }
};

// Initialize Supabase Client
const { createClient } = window.supabase;
window.createSupabaseClient = createClient;
window.supabaseSDK = { createClient };

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

// Utility: Generate facility-tethered non-colliding tote code with guaranteed alphanumeric mixture (e.g. CV-SEA-49AK, CV-YAK-8K3M)
function generateToteCode(facilityId = 'facility_seattle_north') {
    let prefix = 'SEA';
    const fid = String(facilityId).toLowerCase();
    if (fid.includes('yakima') || fid.includes('yak')) prefix = 'YAK';
    else if (fid.includes('portland') || fid.includes('pdx') || fid.includes('por')) prefix = 'PDX';
    else if (fid.includes('denver') || fid.includes('den')) prefix = 'DEN';
    else if (fid.includes('spokane') || fid.includes('spo')) prefix = 'SPO';
    else if (fid.includes('austin') || fid.includes('atx')) prefix = 'ATX';
    else prefix = 'SEA';

    // Disambiguated digit & letter sets (excludes 0, O, 1, I to prevent scanning confusion)
    const digits = '23456789';
    const letters = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
    const allChars = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';

    // Guarantee a mixture of both letters and numbers in the last 4 characters
    const chars = [
        digits.charAt(Math.floor(Math.random() * digits.length)),
        letters.charAt(Math.floor(Math.random() * letters.length)),
        allChars.charAt(Math.floor(Math.random() * allChars.length)),
        allChars.charAt(Math.floor(Math.random() * allChars.length))
    ];
    // Fisher-Yates shuffle
    for (let i = chars.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [chars[i], chars[j]] = [chars[j], chars[i]];
    }
    return `CV-${prefix}-${chars.join('')}`;
}

// Dynamic Pricing Engine Helper (Delegates to window.CloudVaultBilling or active facility context)
function getTierRate(toteCount, customRates = null) {
    if (typeof window !== 'undefined' && window.CloudVaultBilling && typeof window.CloudVaultBilling.getTierRate === 'function') {
        return window.CloudVaultBilling.getTierRate(toteCount, customRates);
    }
    const rates = customRates || (typeof activeFacilityPricing !== 'undefined' ? activeFacilityPricing : (typeof window !== 'undefined' ? (window.activeFacilityPricing || window.regionalRates) : null));
    if (!rates) {
        throw new Error("Dynamic pricing context is missing. Cannot calculate tier rate without active facility configuration.");
    }
    const count = Math.max(1, Number(toteCount) || 1);
    const t1 = Number(rates.tier1_rate != null ? rates.tier1_rate : rates.tier1);
    const t2 = Number(rates.tier2_rate != null ? rates.tier2_rate : (rates.tier2 != null ? rates.tier2 : t1));
    const t3 = Number(rates.tier3_rate != null ? rates.tier3_rate : (rates.tier3 != null ? rates.tier3 : t2));
    const t4 = Number(rates.tier4_rate != null ? rates.tier4_rate : (rates.tier4 != null ? rates.tier4 : t3));

    if (count >= 50) return { rate: t4, tier: 4, label: `Tier 4 — $${t4.toFixed(2)}/tote` };
    if (count >= 25) return { rate: t3, tier: 3, label: `Tier 3 — $${t3.toFixed(2)}/tote` };
    if (count >= 10) return { rate: t2, tier: 2, label: `Tier 2 — $${t2.toFixed(2)}/tote` };
    return { rate: t1, tier: 1, label: `Tier 1 — $${t1.toFixed(2)}/tote` };
}
if (typeof window !== 'undefined') {
    window.getTierRate = getTierRate;
}

function getValetFee(toteCount, customValet = null) {
    if (typeof window !== 'undefined' && window.CloudVaultBilling && typeof window.CloudVaultBilling.getValetFee === 'function') {
        return window.CloudVaultBilling.getValetFee(toteCount, customValet);
    }
    const valet = customValet || (typeof activeFacilityPricing !== 'undefined' ? activeFacilityPricing : (typeof window !== 'undefined' ? (window.activeFacilityPricing || window.regionalRates) : null));
    if (!valet) {
        throw new Error("Dynamic valet pricing context is missing. Cannot calculate valet fee without active facility configuration.");
    }
    const count = Math.max(0, Number(toteCount) || 0);
    const base = Number(valet.valet_base != null ? valet.valet_base : 0);
    const adder = Number(valet.valet_tote_adder != null ? valet.valet_tote_adder : 0);
    return base + (count * adder);
}
if (typeof window !== 'undefined') {
    window.getValetFee = getValetFee;
}

// =========================================================================
// 2D Barcode Badge Authentication & Global Scanner Engine
// =========================================================================

// Compute SHA-256 hash of a badge token string (lowercase hex format)
async function hashBadgeToken(token) {
    if (!token || typeof token !== 'string') return '';
    const cleanToken = token.trim();
    const encoder = new TextEncoder();
    const data = encoder.encode(cleanToken);
    const hashBuffer = await crypto.subtle.digest('SHA-256', data);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
}

// Generate high-entropy 2D QR/Barcode badge token optimized for both 2D QR and 1D Code-128 laser scanning
function generateBadgeToken() {
    const randomBytes = new Uint8Array(5);
    crypto.getRandomValues(randomBytes);
    const hex = Array.from(randomBytes).map(b => b.toString(16).padStart(2, '0')).join('').toUpperCase();
    return `CV-AUTH-${hex}`;
}

// Authenticate an employee badge token against Supabase RPC
async function authenticateEmployeeBadge(token) {
    try {
        if (!token || !token.trim().startsWith('CV-AUTH-')) {
            throw new Error('Invalid badge format. Expected CV-AUTH- prefix.');
        }
        const tokenHash = await hashBadgeToken(token.trim());
        const { data, error } = await window.supabase.rpc('verify_employee_badge_login', {
            p_token_hash: tokenHash
        });

        if (error) throw error;
        if (!data || !data.success || !data.user) {
            throw new Error('Badge verification failed.');
        }

        // Store the verified employee profile in sessionStorage for the active shift
        const user = data.user;
        sessionStorage.setItem('cv_active_badge_user', JSON.stringify(user));
        localStorage.removeItem('cv_active_badge_user'); // Clean up any stale persistent badge credentials
        if (user.assigned_facility_id) {
            localStorage.setItem('cloudvault_selected_facility', user.assigned_facility_id);
        }

        return { success: true, user: user, badgeId: data.badge_id };
    } catch (err) {
        console.error('Badge authentication error:', err);
        return { success: false, error: err.message || 'Authentication failed' };
    }
}

// Global Hardware 2D Barcode HID Scanner Listener
// Passively listens for rapid burst keystrokes (<60ms per key) and handles CV-AUTH- badges & warehouse barcodes
function initGlobalBadgeScanner(options = {}) {
    let keyBuffer = [];
    let activeInputPreValue = null;
    const BURST_THRESHOLD_MS = 60; // Hardware scanners emit keystrokes well under 50ms

    window.addEventListener('keydown', async (e) => {
        const now = Date.now();
        const activeEl = document.activeElement;
        const isInputElement = activeEl && (activeEl.tagName === 'INPUT' || activeEl.tagName === 'TEXTAREA' || activeEl.tagName === 'SELECT' || activeEl.isContentEditable);

        if (keyBuffer.length === 0 && isInputElement && activeEl.value !== undefined) {
            activeInputPreValue = activeEl.value;
        }

        if (e.key === 'Enter') {
            if (keyBuffer.length >= 4) {
                // Calculate average inter-keystroke interval
                let intervals = [];
                for (let i = 1; i < keyBuffer.length; i++) {
                    intervals.push(keyBuffer[i].time - keyBuffer[i - 1].time);
                }
                const avgInterval = intervals.length ? intervals.reduce((a, b) => a + b, 0) / intervals.length : 0;
                const scannedString = keyBuffer.map(k => k.char).join('').trim();

                const isAuthScan = scannedString.startsWith('CV-AUTH-');
                const isHardwareBurst = avgInterval < BURST_THRESHOLD_MS;
                const isTargetPrefix = scannedString.startsWith('CV-') || scannedString.startsWith('V-') || scannedString.startsWith('ROOM-') || scannedString.startsWith('BAY-') || scannedString.startsWith('SHELF-') || scannedString.startsWith('STAGE-');

                // If user is typing in an input field and it's NOT a hardware burst or CV-AUTH- badge, let the input handle Enter normally
                if (isInputElement && !isAuthScan && !isHardwareBurst) {
                    keyBuffer = [];
                    activeInputPreValue = null;
                    return; // Allow native input Enter event (e.g. searching in Telemetry Console)
                }

                // If it is an authentic hardware scan or an employee badge:
                if (isAuthScan || isHardwareBurst || (!isInputElement && isTargetPrefix)) {
                    e.preventDefault();
                    e.stopPropagation();

                    // If it's the Master Search Bar in Telemetry Console
                    if (isInputElement && activeEl && activeEl.id === 'master-tote-search-input') {
                        activeEl.value = scannedString;
                        activeEl.dispatchEvent(new Event('input', { bubbles: true }));
                        if (typeof executeMasterToteSearch === 'function') {
                            executeMasterToteSearch(scannedString);
                        }
                        keyBuffer = [];
                        activeInputPreValue = null;
                        return;
                    }

                    // Sanitize input if badge was scanned while cursor was in an unrelated text box
                    if (isInputElement && activeEl && activeEl.id !== 'scan-barcode') {
                        if (activeInputPreValue !== null) {
                            activeEl.value = activeInputPreValue;
                        } else {
                            activeEl.value = activeEl.value.replace(scannedString, '').trim();
                        }
                    }

                    keyBuffer = [];
                    activeInputPreValue = null;

                    // Handle Employee Auth Badge Scan
                    if (isAuthScan) {
                        if (typeof options.onBadgeScanStart === 'function') {
                            options.onBadgeScanStart(scannedString);
                        }

                        const authResult = await authenticateEmployeeBadge(scannedString);
                        if (authResult.success) {
                            if (typeof options.onBadgeSuccess === 'function') {
                                options.onBadgeSuccess(authResult.user, authResult);
                            } else {
                                showBadgeScanToast(`Welcome, ${authResult.user.name}! Verified badge.`, 'success');
                                setTimeout(() => {
                                    window.location.href = 'admin.html';
                                }, 600);
                            }
                        } else {
                            if (typeof options.onBadgeError === 'function') {
                                options.onBadgeError(authResult.error);
                            } else {
                                showBadgeScanToast(authResult.error || 'Invalid or revoked employee badge.', 'error');
                            }
                        }
                        return;
                    }

                    // Handle Tote Barcode Scan if callback provided (e.g. on admin warehouse view)
                    if (typeof options.onToteScan === 'function') {
                        options.onToteScan(scannedString);
                    }
                    return;
                }
            }
            keyBuffer = [];
            activeInputPreValue = null;
        } else if (e.key && e.key.length === 1 && !e.ctrlKey && !e.altKey && !e.metaKey) {
            // If pause between keystrokes is too long for a scanner burst, reset buffer
            if (keyBuffer.length > 0) {
                const lastTime = keyBuffer[keyBuffer.length - 1].time;
                if (now - lastTime > BURST_THRESHOLD_MS * 2.5) {
                    keyBuffer = [];
                    if (isInputElement && activeEl.value !== undefined) activeInputPreValue = activeEl.value;
                }
            }
            keyBuffer.push({ char: e.key, time: now });
        }
    }, true);
}

// Unobtrusive Toast for Badge Scan Feedback
function showBadgeScanToast(message, type = 'info') {
    let toast = document.getElementById('cv-badge-scan-toast');
    if (!toast) {
        toast = document.createElement('div');
        toast.id = 'cv-badge-scan-toast';
        toast.className = 'fixed bottom-6 right-6 z-50 px-5 py-3.5 rounded-2xl shadow-2xl flex items-center gap-3 font-sans text-sm font-semibold transition-all duration-300 transform translate-y-12 opacity-0 pointer-events-none';
        document.body.appendChild(toast);
    }

    if (type === 'success') {
        toast.className = 'fixed bottom-6 right-6 z-50 px-5 py-3.5 rounded-2xl shadow-2xl flex items-center gap-3 font-sans text-sm font-bold bg-emerald-950/90 text-emerald-300 border border-emerald-500/40 backdrop-blur-md transition-all duration-300 transform translate-y-0 opacity-100';
        toast.innerHTML = `<span class="w-3 h-3 rounded-full bg-emerald-400 animate-ping"></span> <span>${message}</span>`;
    } else if (type === 'error') {
        toast.className = 'fixed bottom-6 right-6 z-50 px-5 py-3.5 rounded-2xl shadow-2xl flex items-center gap-3 font-sans text-sm font-bold bg-red-950/90 text-red-300 border border-red-500/40 backdrop-blur-md transition-all duration-300 transform translate-y-0 opacity-100';
        toast.innerHTML = `<span class="w-2.5 h-2.5 rounded-full bg-red-400"></span> <span>${message}</span>`;
    } else {
        toast.className = 'fixed bottom-6 right-6 z-50 px-5 py-3.5 rounded-2xl shadow-2xl flex items-center gap-3 font-sans text-sm font-bold bg-gray-900/90 text-cyan-300 border border-cyan-500/40 backdrop-blur-md transition-all duration-300 transform translate-y-0 opacity-100';
        toast.innerHTML = `<span class="w-2.5 h-2.5 rounded-full bg-cyan-400 animate-pulse"></span> <span>${message}</span>`;
    }

    clearTimeout(window.badgeToastTimer);
    window.badgeToastTimer = setTimeout(() => {
        if (toast) {
            toast.classList.add('translate-y-12', 'opacity-0');
        }
    }, 4000);
}