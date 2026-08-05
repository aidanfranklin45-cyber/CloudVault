
        !function(t,e){var o,n,p,r;e.__SV||(window.posthog=e,e._i=[],e.init=function(i,s,a){function g(t,e){var o=e.split(".");2==o.length&&(t=t[o[0]],e=o[1]),t[e]=function(){t.push([e].concat(Array.prototype.slice.call(arguments,0)))}}var c=e;for(void 0!==a?c=e[a]=[]:a="posthog",c.people=c.people||[],c.toString=function(t){var e="posthog";return"posthog"!==a&&(e+="."+a),t||(e+=" (stub)"),e},c.people.toString=function(){return c.toString(1)+".people (stub)"},p="capture identify alias people.set people.set_once set_config register register_once unregister opt_out_capturing has_opted_out_capturing opt_in_capturing reset isFeatureEnabled onFeatureFlags getFeatureFlag getFeatureFlagPayload reloadFeatureFlags group updateEarlyAccessFeatureEnrollment getEarlyAccessFeatures onSessionId".split(" "),r=0;r<p.length;r++)g(c,p[r]);e._i.push([i,s,a])},e.__SV=1.0,o=t.createElement("script"),o.type="text/javascript",o.async=!0,o.src="https://us-assets.i.posthog.com/static/array.js",n=t.getElementsByTagName("script")[0],n.parentNode.insertBefore(o,n))}(document,window.posthog||[]);
        posthog.init('phc_njX2MWz7DdzYxHY87sdEtymMMmA2kHK9oxyG8T4XwWzb', {api_host: 'https://us.posthog.com', person_profiles: 'identified_only'});
    </script>
    <script src="https://cdn.tailwindcss.com"></script>
    <link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;600;700&display=swap" rel="stylesheet">
    <style>
        body { font-family: 'Inter', sans-serif; background-color: #f8fafc; color: #0f172a; }
        .tote-card { transition: all 0.2s ease; }
        .tote-card:hover { border-color: #93c5fd; box-shadow: 0 4px 6px -1px rgba(59, 130, 246, 0.1); }
        .tote-card.selected { border-color: #2563eb; background-color: #eff6ff; }
        input.label-input { transition: all 0.2s; border-bottom: 2px solid transparent; }
        input.label-input:focus { outline: none; border-bottom-color: #2563eb; background-color: #fff; }
        .bar-hidden { transform: translateY(100%); }
        .bar-visible { transform: translateY(0); }
        .fade-in { animation: fadeIn 0.4s ease-in-out; }
        @keyframes fadeIn { from { opacity: 0; transform: translateY(10px); } to { opacity: 1; transform: translateY(0); } }
        .saving-indicator { transition: opacity 0.3s; }
    </style>
</head>
<body class="antialiased min-h-screen flex flex-col pb-24">

    <!-- Header -->
    <header class="bg-white shadow-sm sticky top-0 z-50">
        <div class="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-4 flex justify-between items-center">
            <a href="index.html" class="flex items-center space-x-2 text-2xl font-bold tracking-tighter text-blue-600">
                <img src="logo.png" alt="CloudVault Logo" class="h-8 w-8 rounded">
                <span>CloudVault</span>
            </a>
            <div class="relative inline-block text-left">
                <div id="user-avatar" onclick="toggleDropdown()" class="w-10 h-10 bg-blue-100 text-blue-600 rounded-full flex items-center justify-center font-bold text-sm cursor-pointer select-none border-2 border-transparent hover:border-blue-300 transition">
                    --
                </div>
                <!-- Dropdown Menu -->
                <div id="user-dropdown" class="origin-top-right absolute right-0 mt-2 w-48 rounded-xl shadow-lg bg-white ring-1 ring-black ring-opacity-5 hidden z-50 overflow-hidden">
                    <div class="py-1 flex flex-col" role="menu" aria-orientation="vertical">
                        <button onclick="openSettingsModal()" class="w-full text-left px-4 py-3 text-sm font-semibold text-gray-700 hover:bg-gray-50" role="menuitem">Profile Color</button>
                        <button onclick="openBillingModal()" class="w-full text-left px-4 py-3 text-sm font-semibold text-gray-700 hover:bg-gray-50" role="menuitem">Billing & Plan</button>
                        <div class="border-t border-gray-100 my-1"></div>
                        <button onclick="triggerCancelFlowUser()" class="w-full text-left px-4 py-3 text-sm font-semibold text-red-600 hover:bg-red-50" role="menuitem">Cancel Subscription</button>
                        <button onclick="handleSignOut()" class="w-full text-left px-4 py-3 text-sm font-bold text-gray-900 hover:bg-gray-50" role="menuitem">Sign Out</button>
                    </div>
                </div>
            </div>
        </div>
    </header>

    <!-- Loading State -->
    <div id="loading-state" class="flex-grow flex items-center justify-center">
        <div class="text-center space-y-4">
            <div class="animate-spin w-10 h-10 border-4 border-blue-200 border-t-blue-600 rounded-full mx-auto"></div>
            <p class="text-gray-500 font-medium">Loading your vault...</p>
        </div>
    </div>

    <!-- Main Content (hidden until auth confirmed) -->
    <main id="main-content" class="hidden flex-grow max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-10 w-full fade-in">
        
        <!-- Developer Test Console HUD -->
        <div class="mb-8 bg-amber-50 border border-amber-300 rounded-3xl p-6 shadow-sm">
            <div class="flex justify-between items-center cursor-pointer select-none" onclick="toggleDevConsole()">
                <div class="flex items-center space-x-3">
                    <div class="w-2.5 h-2.5 rounded-full bg-amber-500 animate-pulse"></div>
                    <h2 class="text-sm font-extrabold text-amber-900 uppercase tracking-wider">Developer Test Console</h2>
                </div>
                <span id="dev-console-arrow" class="text-amber-700 font-bold transition-transform duration-200">â–¼</span>
            </div>
            
            <div id="dev-console-content" class="mt-5 pt-5 border-t border-amber-200 grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6 text-xs text-amber-900 hidden">
                <!-- Onboarding Simulation -->
                <div class="bg-white/60 p-4 rounded-xl border border-amber-200/50 flex flex-col justify-between">
                    <div>
                        <p class="font-bold mb-1">1. Simulate Onboarding</p>
                        <p class="text-[10px] text-amber-700/80 mb-3">Transitions user to active, populates empty inventory, and sets physical totes held count.</p>
                    </div>
                    <button onclick="runSimulateOnboarding(this)" class="w-full bg-amber-600 text-white font-bold py-2 px-3 rounded-lg hover:bg-amber-700 transition">
                        Onboard &amp; Load Totes
                    </button>
                </div>
                
                <!-- Tote Returns Simulation -->
                <div class="bg-white/60 p-4 rounded-xl border border-amber-200/50 flex flex-col justify-between">
                    <div>
                        <p class="font-bold mb-1">2. Simulate Tote Return</p>
                        <p class="text-[10px] text-amber-700/80 mb-2">Simulate physically returning totes to the staging warehouse to protect your card.</p>
                        <div class="flex items-center space-x-2 my-2 justify-center">
                            <span class="font-bold">Active Totes Held:</span>
                            <span id="dev-totes-held" class="font-extrabold text-sm text-gray-900 bg-white px-2 py-0.5 rounded border">0</span>
                        </div>
                    </div>
                    <div class="flex space-x-2">
                        <button onclick="updateTotesHeldSim(-1)" class="flex-1 bg-amber-600 text-white font-bold py-2 rounded-lg hover:bg-amber-700 transition">-1</button>
                        <button onclick="updateTotesHeldSim(1)" class="flex-1 bg-amber-600 text-white font-bold py-2 rounded-lg hover:bg-amber-700 transition">+1</button>
                        <button onclick="returnAllTotesSim()" class="flex-1 bg-green-600 text-white font-bold py-2 rounded-lg hover:bg-green-700 transition">All</button>
                    </div>
                </div>
                
                <!-- Account Cancellation -->
                <div class="bg-white/60 p-4 rounded-xl border border-amber-200/50 flex flex-col justify-between">
                    <div>
                        <p class="font-bold mb-1">3. Cancel Account</p>
                        <p class="text-[10px] text-amber-700/80 mb-2">Cancels active subscription and starts the 14-day return countdown.</p>
                        <div class="flex items-center space-x-2 my-2 cursor-pointer select-none">
                            <input type="checkbox" id="dev-simulate-expiry" class="rounded border-amber-300 text-amber-600 focus:ring-amber-500">
                            <label for="dev-simulate-expiry" class="text-[10px] font-bold text-amber-800">Set deadline in past (simulate instant 14 days)</label>
                        </div>
                    </div>
                    <button onclick="runCancelSubscription(this)" class="w-full bg-red-600 text-white font-bold py-2 px-3 rounded-lg hover:bg-red-700 transition">
                        Cancel Subscription
                    </button>
                </div>
                
                <!-- Audit Run -->
                <div class="bg-white/60 p-4 rounded-xl border border-amber-200/50 flex flex-col justify-between">
                    <div>
                        <p class="font-bold mb-1">4. Run Billing Audit</p>
                        <p class="text-[10px] text-amber-700/80 mb-3">Triggers billing audit. Assesses a $15/tote fee on cards-on-file for unreturned assets.</p>
                    </div>
                    <button onclick="runBillingAuditTrigger(this)" class="w-full bg-gray-900 text-white font-bold py-2 px-3 rounded-lg hover:bg-black transition">
                        Run Audit Job Now
                    </button>
                </div>
            </div>
        </div>        <!-- ============================================================ -->
        <!-- FLOW 1: NEW / LAPSED ONBOARDING WIZARD -->
        <!-- ============================================================ -->
        <div id="flow-onboarding-wizard" class="hidden max-w-2xl mx-auto bg-white border border-gray-200 rounded-3xl p-8 sm:p-10 shadow-lg space-y-8 fade-in">
            <div class="text-center">
                <h1 class="text-3xl font-extrabold text-gray-900 tracking-tight">Set Up Your CloudVault</h1>
                <p class="text-gray-500 mt-2 text-sm" id="wizard-onboarding-desc">Verify your ZIP code to check if we service your area.</p>
            </div>

            <!-- Wizard Section: ZIP Verification -->
            <div id="wizard-zip-check-container" class="space-y-4">
                <div>
                    <label class="block text-sm font-bold text-gray-700 mb-2">ZIP Code</label>
                    <input type="text" id="wizard-zip-input" placeholder="e.g. 90210" class="w-full px-4 py-4 border border-gray-300 rounded-xl text-lg font-medium" maxlength="5">
                    <p id="wizard-zip-error" class="text-red-500 text-sm mt-2 hidden font-medium"></p>
                </div>
                <button id="btn-wizard-zip-check" onclick="checkWizardZip()" class="w-full bg-blue-600 text-white px-4 py-4 rounded-xl font-bold text-lg hover:bg-blue-700 transition mt-6 shadow-md">Check Availability</button>
            </div>

            <!-- Wizard Section: Subscription Config (Hidden by default) -->
            <div id="wizard-subscription-container" class="hidden space-y-8">
                <!-- Wizard Step 1: Select Plan Tier -->
                <div class="space-y-4">
                    <label class="block font-extrabold text-gray-900 text-sm uppercase tracking-wider">1. Select Your Storage Plan</label>
                    <div class="grid grid-cols-2 gap-4">
                        <div id="wizard-tier-1" class="border-2 border-blue-600 bg-blue-50/50 rounded-2xl p-4 text-center cursor-pointer transition transform hover:scale-[1.02]" onclick="selectWizardTotes(5)">
                            <span class="block font-bold text-gray-800 text-sm">5 Totes</span>
                            <span class="block font-extrabold text-blue-600 text-lg mt-1">$5.00<span class="text-xs font-normal text-gray-500">/tote</span></span>
                            <span class="block text-[10px] text-gray-400 mt-1">Tier 1 Plan</span>
                        </div>
                        <div id="wizard-tier-2" class="border border-gray-200 bg-white rounded-2xl p-4 text-center cursor-pointer transition transform hover:scale-[1.02]" onclick="selectWizardTotes(10)">
                            <span class="block font-bold text-gray-800 text-sm">10 Totes</span>
                            <span class="block font-extrabold text-gray-900 text-lg mt-1">$3.50<span class="text-xs font-normal text-gray-500">/tote</span></span>
                            <span class="block text-[10px] text-gray-400 mt-1">Tier 2 Plan</span>
                        </div>
                        <div id="wizard-tier-3" class="border border-gray-200 bg-white rounded-2xl p-4 text-center cursor-pointer transition transform hover:scale-[1.02]" onclick="selectWizardTotes(25)">
                            <span class="block font-bold text-gray-800 text-sm">25 Totes</span>
                            <span class="block font-extrabold text-gray-900 text-lg mt-1">$2.00<span class="text-xs font-normal text-gray-500">/tote</span></span>
                            <span class="block text-[10px] text-gray-400 mt-1">Tier 3 Plan</span>
                        </div>
                        <div id="wizard-tier-4" class="border border-gray-200 bg-white rounded-2xl p-4 text-center cursor-pointer transition transform hover:scale-[1.02]" onclick="selectWizardTotes(50)">
                            <span class="block font-bold text-gray-800 text-sm">50 Totes</span>
                            <span class="block font-extrabold text-gray-900 text-lg mt-1">$1.00<span class="text-xs font-normal text-gray-500">/tote</span></span>
                            <span class="block text-[10px] text-gray-400 mt-1">Tier 4 Plan</span>
                        </div>
                    </div>

                    <!-- Custom input inside wizard -->
                    <div class="bg-gray-50 border border-gray-150 rounded-2xl p-4 flex items-center justify-between">
                        <span class="text-sm font-semibold text-gray-700">Or type custom quantity:</span>
                        <div class="flex items-center space-x-2">
                            <input type="number" id="wizard-custom-totes" value="5" min="1" max="500" class="w-24 text-center font-bold text-lg py-1.5 border border-gray-300 rounded-xl" oninput="handleWizardCustomInput()">
                            <span class="text-sm text-gray-500 font-medium">totes</span>
                        </div>
                    </div>
                </div>

                <!-- Wizard Step 2: Pickup Logistics -->
                <div class="space-y-4">
                    <label class="block font-extrabold text-gray-900 text-sm uppercase tracking-wider">2. Choose Delivery Logistics</label>
                    <div class="space-y-3">
                        <div id="wizard-opt-self" class="flex items-center p-4 rounded-2xl border-2 border-blue-600 bg-blue-50 cursor-pointer" onclick="selectWizardLogistics('self_service')">
                            <div class="w-4 h-4 rounded-full border-4 border-blue-600 bg-white mr-4 flex-shrink-0" id="wizard-dot-self"></div>
                            <div>
                                <div class="font-bold text-sm text-gray-900">Self-Serve Drop-off <span class="text-green-600 ml-1">Free</span></div>
                                <div class="text-xs text-gray-500 mt-0.5">Collect and drop off your empty/packed totes at our local staging warehouse.</div>
                            </div>
                        </div>
                        <div id="wizard-opt-valet" class="flex items-center p-4 rounded-2xl border border-gray-200 bg-white cursor-pointer" onclick="selectWizardLogistics('valet_pickup')">
                            <div class="w-4 h-4 rounded-full border border-gray-300 bg-white mr-4 flex-shrink-0" id="wizard-dot-valet"></div>
                            <div>
                                <div class="font-bold text-sm text-gray-900">Valet Delivery <span class="text-gray-500 ml-1" id="wizard-valet-label">$20.00</span></div>
                                <div class="text-xs text-gray-500 mt-0.5">We deliver empty totes to your door and pick them up when packed ($15 base + $1/tote).</div>
                            </div>
                        </div>
                    </div>
                </div>

                <!-- Wizard Step 3: Card on File Authorization Terms -->
                <div class="space-y-4 bg-amber-50/50 border border-amber-200/50 rounded-2xl p-5">
                    <label class="block font-extrabold text-amber-900 text-sm uppercase tracking-wider">3. Terms &amp; Asset Protection</label>
                    <div class="flex items-start space-x-3 cursor-pointer">
                        <input type="checkbox" id="wizard-tos-checkbox" class="w-5 h-5 rounded text-blue-600 border-gray-300 mt-1 cursor-pointer">
                        <label for="wizard-tos-checkbox" class="text-xs text-gray-600 leading-relaxed select-none">
                            I authorize CloudVault to securely tokenize and save my card on file. I agree to the active monthly subscription fees and acknowledge a **$15.00 per tote replacement fee** if physical totes are not returned within **14 days of account cancellation**.
                        </label>
                    </div>
                </div>

                <!-- Cost Summary Ledger Card -->
                <div class="bg-gray-900 text-white rounded-3xl p-6 shadow-inner space-y-3">
                    <div class="flex justify-between text-sm text-gray-400">
                        <span>Monthly Storage Plan</span>
                        <span class="font-bold text-white">$<span id="ledger-monthly">25.00</span>/mo</span>
                    </div>
                    <div class="flex justify-between text-sm text-gray-400">
                        <span>Setup &amp; Logistics Fee</span>
                        <span class="font-bold text-white" id="ledger-logistics">Free</span>
                    </div>
                    <div class="h-px bg-gray-800 my-2"></div>
                    <div class="flex justify-between items-center">
                        <div>
                            <span class="block text-sm font-bold">First Month Total</span>
                            <span class="text-[10px] text-gray-400">Billed immediately on activation</span>
                        </div>
                        <span class="text-2xl font-extrabold text-blue-400">$<span id="ledger-total">25.00</span></span>
                    </div>
                </div>

                <p id="wizard-error-msg" class="text-red-500 text-sm hidden font-semibold text-center"></p>

                <button id="wizard-activate-btn" onclick="activateOnboardingSubscription()" class="w-full bg-blue-600 text-white font-bold py-4 rounded-2xl text-lg hover:bg-blue-700 transition shadow-md">
                    Start My Storage Subscription
                </button>
            </div>

            <!-- Wizard Section: Waitlist (Hidden by default) -->
            <div id="wizard-waitlist-container" class="hidden space-y-6">
                <div class="bg-blue-50 rounded-2xl p-6 text-center border border-blue-100 mb-4">
                    <div class="w-16 h-16 bg-blue-100 rounded-full flex items-center justify-center mx-auto mb-4">
                        <svg class="w-8 h-8 text-blue-600" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M17.657 16.657L13.414 20.9a1.998 1.998 0 01-2.827 0l-4.242-4.243a8 8 0 1111.314 0z"></path><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 11a3 3 0 11-6 0 3 3 0 016 0z"></path></svg>
                    </div>
                    <h3 class="text-xl font-bold text-gray-900 mb-2">We're not in your area yet!</h3>
                    <p class="text-gray-600">CloudVault is expanding fast. Join the waitlist and we'll notify you the moment we arrive.</p>
                </div>
                <button id="btn-wizard-waitlist-submit" onclick="submitWizardWaitlist()" class="w-full bg-gray-900 text-white font-bold py-4 rounded-2xl text-lg hover:bg-gray-800 transition mt-4 shadow-md">Join Waitlist</button>
                <div id="wizard-waitlist-success" class="hidden bg-green-50 text-green-800 px-4 py-4 rounded-xl text-center font-bold border border-green-200 mt-4">
                    You're on the list! We'll be in touch soon.
                </div>
            </div>
        </div>

        <!-- ============================================================ -->
        <!-- FLOW 2: ACTIVE CUSTOMER VAULT DASHBOARD -->
        <!-- ============================================================ -->
        <div id="flow-active-dashboard" class="hidden space-y-8 fade-in">
            
            <!-- Vault Subscription Plan Header Summary Card -->
            <div class="bg-white border border-gray-200 rounded-3xl p-6 shadow-sm flex flex-col md:flex-row justify-between items-start md:items-center gap-6">
                <div class="flex items-center space-x-5">
                    <div class="p-4 bg-blue-50 text-blue-600 rounded-2xl">
                        <svg class="w-8 h-8" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 11V9a2 2 0 012-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10"></path></svg>
                    </div>
                    <div>
                        <p class="text-xs text-gray-500 uppercase tracking-wide font-bold">Active Space Plan</p>
                        <h2 class="text-2xl font-extrabold text-gray-900 mt-0.5" id="active-plan-header">Loading plan...</h2>
                    </div>
                </div>
                <div class="flex flex-wrap gap-3">
                    <button onclick="openAddTotesPanel()" class="bg-blue-600 text-white px-5 py-3 rounded-xl font-bold text-sm hover:bg-blue-700 transition shadow-sm flex items-center">
                        <svg class="w-4 h-4 mr-2" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2.5" d="M12 4v16m8-8H4"></path></svg>
                        Rent More Totes
                </div>
            </div>

            <!-- Setup Progress Timeline Stepper -->
            <div id="onboarding-tracker" class="bg-white p-8 sm:p-10 rounded-3xl border border-gray-150 shadow-sm max-w-4xl mx-auto">
                <h3 class="text-lg font-extrabold text-gray-950 mb-6 text-center">Your CloudVault Setup Progress</h3>
                
                <div class="relative flex flex-col md:flex-row justify-between items-center md:items-start gap-8 md:gap-4">
                    <!-- Progress Connection line -->
                    <div class="hidden md:block absolute top-6 left-[16%] right-[16%] h-0.5 bg-gray-200 -z-10" id="tracker-line"></div>
                    
                    <!-- Step 1 -->
                    <div class="flex flex-col items-center text-center w-full md:w-1/3">
                        <div id="step1-badge" class="w-12 h-12 rounded-full bg-green-100 text-green-600 flex items-center justify-center font-bold text-lg mb-3">âœ“</div>
                        <h4 class="font-bold text-gray-900 text-sm">1. Reservation Received</h4>
                        <p class="text-xs text-gray-500 mt-1 px-4">Payment verified &amp; space secured.</p>
                    </div>
                    
                    <!-- Step 2 -->
                    <div class="flex flex-col items-center text-center w-full md:w-1/3">
                        <div id="step2-badge" class="w-12 h-12 rounded-full bg-gray-100 text-gray-400 flex items-center justify-center font-bold text-lg mb-3">2</div>
                        <h4 class="font-bold text-gray-900 text-sm">2. Totes Preparing</h4>
                        <p class="text-xs text-gray-500 mt-1 px-4" id="step2-desc">Staging your empty barcodes.</p>
                    </div>
                    
                    <!-- Step 3 -->
                    <div class="flex flex-col items-center text-center w-full md:w-1/3">
                        <div id="step3-badge" class="w-12 h-12 rounded-full bg-gray-100 text-gray-400 flex items-center justify-center font-bold text-lg mb-3">3</div>
                        <h4 class="font-bold text-gray-900 text-sm">3. Ready for Pickup</h4>
                        <p class="text-xs text-gray-500 mt-1 px-4" id="step3-desc">We'll notify you when ready.</p>
                    </div>
                </div>
                
                <!-- Large PIN Code Card -->
                <div id="pickup-pin-container" class="hidden mt-8 pt-8 border-t border-gray-100 text-center space-y-4">
                    <div class="max-w-md mx-auto bg-gray-900 text-white rounded-3xl p-6 shadow-inner space-y-3">
                        <p class="text-xs font-bold text-gray-400 uppercase tracking-widest">Staging Room Access PIN</p>
                        <div class="text-4xl font-mono font-bold tracking-[0.2em] text-blue-400" id="pickup-pin">----</div>
                        <button onclick="copyStagingPin()" class="text-xs font-bold text-gray-300 hover:text-white bg-gray-800 hover:bg-gray-700 px-3 py-1.5 rounded-lg transition inline-flex items-center">
                            Copy PIN Code
                        </button>
                    </div>
                    <p class="text-xs text-gray-500 leading-relaxed max-w-md mx-auto">
                        Drive to our staging facility, type this PIN at the door keypad, and retrieve your empty totes. Pack them at your leisure, and return them whenever ready!
                    </p>
                </div>
            </div>

            <!-- Cutoff Banner -->
            <div id="cutoff-banner" class="hidden bg-amber-50 border border-amber-200 text-amber-800 px-4 py-3 rounded-2xl text-xs font-semibold flex items-center max-w-2xl mx-auto">
                <svg class="w-4 h-4 mr-2.5 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-2.5L13.732 4c-.77-.833-1.964-.833-2.732 0L4.082 16.5c-.77.833.192 2.5 1.732 2.5z"></path></svg>
                <span>Today's 6:00 PM cutoff has passed. Retrieval staging requests will be processed tomorrow.</span>
            </div>

            <!-- Empty Inventory State -->
            <div id="empty-state" class="hidden text-center py-16 bg-white border border-gray-150 rounded-3xl">
                <div class="w-16 h-16 bg-gray-50 rounded-full flex items-center justify-center mx-auto mb-4">
                    <svg class="w-8 h-8 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M20 7l-8-4-8 4m16 0l-8 4m8-4v10l-8 4m0-10L4 7m8 4v10M4 7v10l8 4"></path></svg>
                </div>
                <h4 class="text-lg font-bold text-gray-900">No active totes in your vault</h4>
                <p class="text-gray-500 text-xs mt-1">Your registered totes will populate here once you drop them off at the staging room.</p>
            </div>

            <!-- Search & Filter Bar -->
            <div class="flex flex-col sm:flex-row justify-between items-center bg-white rounded-2xl shadow-sm border border-gray-150 p-4 mb-6 gap-4">
                <div class="relative w-full sm:w-1/2">
                    <div class="absolute inset-y-0 left-0 pl-4 flex items-center pointer-events-none">
                        <svg class="h-5 w-5 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"></path></svg>
                    </div>
                    <input type="text" id="search-input" placeholder="Search by label or ID (e.g. CV-1004)..." class="block w-full pl-11 pr-3 py-3 border border-gray-200 rounded-xl leading-5 bg-gray-50 placeholder-gray-400 focus:outline-none focus:bg-white focus:border-blue-500 focus:ring-1 focus:ring-blue-500 transition-colors sm:text-sm" oninput="handleSearchFilter()">
                </div>
                <div class="w-full sm:w-auto">
                    <select id="status-filter" class="block w-full pl-4 pr-10 py-3 text-base border border-gray-200 focus:outline-none focus:ring-blue-500 focus:border-blue-500 sm:text-sm rounded-xl bg-gray-50 text-gray-700 font-semibold cursor-pointer" onchange="handleSearchFilter()">
                        <option value="all">All Totes</option>
                        <option value="stored">In Storage</option>
                        <option value="staged">Ready for Pickup</option>
                        <option value="pending-stage">Retrieval Pending</option>
                    </select>
                </div>
            </div>

            <!-- Tote Grid (populated by Supabase Realtime) -->
            <div id="tote-grid" class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-6"></div>
        </div>

        <!-- Add Totes Panel Overlay -->
        <div id="add-totes-overlay" class="fixed inset-0 bg-gray-900 bg-opacity-40 z-40 hidden" onclick="closeAddTotesPanel()"></div>

        <!-- Add Totes Slide-In Panel -->
        <div id="add-totes-panel" class="fixed top-0 right-0 h-full w-full max-w-md bg-white shadow-2xl z-50 transform translate-x-full transition-transform duration-300 ease-in-out overflow-y-auto">
            <div class="p-8">
                <div class="flex justify-between items-center mb-8">
                    <h2 class="text-2xl font-bold text-gray-900">Rent More Totes</h2>
                    <button onclick="closeAddTotesPanel()" class="text-gray-400 hover:text-gray-600">
                        <svg class="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"></path></svg>
                    </button>
                </div>

                <!-- Live Totes count picker -->
                <div class="mb-6 space-y-3">
                    <label class="block font-extrabold text-gray-900 text-sm uppercase tracking-wider">How many additional totes?</label>
                    
                    <!-- Preset Quick Select Buttons -->
                    <div class="grid grid-cols-4 gap-2">
                        <button onclick="setAddTotesVal(1)" class="py-2 border border-gray-200 rounded-xl text-xs font-bold bg-white text-gray-700 hover:border-blue-500 transition focus:outline-none focus:ring-1 focus:ring-blue-500">+1</button>
                        <button onclick="setAddTotesVal(5)" class="py-2 border border-gray-200 rounded-xl text-xs font-bold bg-white text-gray-700 hover:border-blue-500 transition focus:outline-none focus:ring-1 focus:ring-blue-500">+5</button>
                        <button onclick="setAddTotesVal(10)" class="py-2 border border-gray-200 rounded-xl text-xs font-bold bg-white text-gray-700 hover:border-blue-500 transition focus:outline-none focus:ring-1 focus:ring-blue-500">+10</button>
                        <button onclick="setAddTotesVal(25)" class="py-2 border border-gray-200 rounded-xl text-xs font-bold bg-white text-gray-700 hover:border-blue-500 transition focus:outline-none focus:ring-1 focus:ring-blue-500">+25</button>
                    </div>

                    <div class="flex items-center space-x-4">
                        <div class="w-10 h-10 bg-gray-100 hover:bg-gray-250 cursor-pointer rounded-xl flex items-center justify-center font-bold text-xl select-none" onclick="updateAddTotes(-1)">-</div>
                        <input type="number" id="add-totes-count" value="1" min="1" max="100" class="w-20 text-center font-extrabold text-lg py-2 border border-gray-300 rounded-xl" oninput="handleAddTotesInput()">
                        <div class="w-10 h-10 bg-gray-100 hover:bg-gray-250 cursor-pointer rounded-xl flex items-center justify-center font-bold text-xl select-none" onclick="updateAddTotes(1)">+</div>
                    </div>
                </div>

                <!-- Transparent Comparison Ledger -->
                <div class="bg-gray-50 rounded-2xl p-5 border border-gray-200 mb-6 space-y-3">
                    <p class="text-[10px] font-extrabold text-gray-400 uppercase tracking-widest mb-1">Detailed Ledger Comparison</p>
                    
                    <!-- Current Plan row -->
                    <div class="flex justify-between text-xs text-gray-600">
                        <span>Current Plan</span>
                        <span id="preview-current-summary" class="font-medium text-gray-900">-</span>
                    </div>
                    <!-- Renting row -->
                    <div class="flex justify-between text-xs text-gray-600">
                        <span>New Rent Totes</span>
                        <span id="preview-added-count" class="font-medium text-blue-600">+1 tote</span>
                    </div>
                    <div class="h-px bg-gray-200"></div>
                    <!-- New total rate -->
                    <div class="flex justify-between text-xs text-gray-600">
                        <span>New Storage Rate</span>
                        <span id="preview-new-rate" class="font-bold text-gray-900">-</span>
                    </div>
                    <!-- New monthly billing total -->
                    <div class="flex justify-between text-xs text-gray-600">
                        <span>New Monthly storage bill</span>
                        <span id="preview-new-monthly" class="font-bold text-gray-900">-</span>
                    </div>
                    
                    <div class="h-px bg-gray-200"></div>

                    <!-- Visual Incremental Monthly Change -->
                    <div class="flex justify-between items-center bg-blue-50 p-3.5 rounded-xl border border-blue-100">
                        <div>
                            <span class="block text-xs font-bold text-blue-900">Additional Monthly Cost</span>
                            <span class="text-[9px] text-blue-500">Subscribed billing delta</span>
                        </div>
                        <span id="preview-incremental-cost" class="text-xl font-extrabold text-blue-600">+$5.00/mo</span>
                    </div>
                </div>

                <!-- Tier Crossing Alert -->
                <div id="tier-change-banner" class="hidden bg-emerald-50 border border-emerald-200 text-emerald-800 text-xs font-semibold px-4 py-3.5 rounded-xl mb-6">
                    ðŸŽ‰ Crossing tiers! Your monthly rate drops across ALL totes in your vault.
                </div>

                <!-- Logistics Option -->
                <div class="mb-6 space-y-3">
                    <label class="block font-extrabold text-gray-900 text-sm uppercase tracking-wider">Delivery for new totes</label>
                    <div class="space-y-2">
                        <div id="add-opt-self" class="flex items-center p-3 rounded-xl border-2 border-blue-600 bg-blue-50 cursor-pointer" onclick="selectAddLogistics('self_service')">
                            <div class="w-4 h-4 rounded-full border-4 border-blue-600 bg-white mr-3 flex-shrink-0" id="add-dot-self"></div>
                            <div><div class="font-bold text-sm">Self-Serve Drop-off <span class="text-green-600 ml-1">Free</span></div></div>
                        </div>
                        <div id="add-opt-valet" class="flex items-center p-3 rounded-xl border-2 border-gray-200 bg-white cursor-pointer" onclick="selectAddLogistics('valet_pickup')">
                            <div class="w-4 h-4 rounded-full border-2 border-gray-300 bg-white mr-3 flex-shrink-0" id="add-dot-valet"></div>
                            <div>
                                <div class="font-bold text-sm">Valet Delivery <span class="text-gray-600 ml-1" id="add-valet-fee-label">$16+</span></div>
                                <div class="text-xs text-gray-500 mt-0.5">$15 base + $1/new tote delivered</div>
                            </div>
                        </div>
                    </div>
                </div>

                <!-- Terms disclaimer -->
                <div class="text-[10px] text-gray-500 leading-relaxed mb-6 bg-gray-50 p-3 rounded-xl border border-gray-150">
                    * By confirming, you authorize CloudVault to update your subscription billing and agree to the <strong>$15.00/tote</strong> replacement fee for the additional physical assets.
                </div>

                <p id="add-totes-error" class="text-red-500 text-sm mb-4 hidden font-semibold"></p>
                <button id="add-totes-confirm-btn" onclick="confirmAddTotes()" class="w-full bg-blue-600 text-white px-4 py-4 rounded-xl font-bold text-lg hover:bg-blue-700 transition">
                    Confirm &amp; Add Totes
                </button>
            </div>
        </div>

        <!-- Toast Notification -->
        <div id="toast" class="fixed bottom-6 right-6 bg-gray-900 text-white px-6 py-4 rounded-xl shadow-2xl font-semibold text-sm z-50 transform translate-y-20 opacity-0 transition-all duration-300">
            <span id="toast-msg"></span>
        </div>     </div>

    </main>

    <!-- Action Bar (Sticky Bottom) -->
    <div id="action-bar" class="fixed bottom-0 left-0 right-0 bg-white border-t border-gray-200 shadow-[0_-4px_6px_-1px_rgba(0,0,0,0.05)] p-4 transition-transform duration-300 bar-hidden z-40">
        <div class="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 flex justify-between items-center">
            <div class="text-lg font-bold text-gray-900">
                <span id="selected-count" class="text-blue-600">0</span> Items Selected
            </div>
            <button id="request-btn" onclick="requestRetrieval()" class="bg-blue-600 text-white px-6 py-3 rounded-lg font-bold hover:bg-blue-700 transition shadow-md flex items-center">
                Request Retrieval
                <svg class="w-5 h-5 ml-2" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M14 5l7 7m0 0l-7 7m7-7H3"></path></svg>
            </button>
        </div>
    </div>

    <!-- PIN Confirmation Modal -->
    <div id="pin-modal" class="fixed inset-0 bg-gray-900 bg-opacity-50 z-50 hidden flex items-center justify-center p-4">
        <div class="bg-white rounded-2xl shadow-2xl p-8 max-w-md w-full text-center">
            <div class="w-16 h-16 bg-green-100 text-green-500 rounded-full flex items-center justify-center mx-auto mb-6">
                <svg class="w-8 h-8" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="3" d="M5 13l4 4L19 7"></path></svg>
            </div>
            <h2 class="text-2xl font-bold text-gray-900 mb-2">Staging Requested</h2>
            <p class="text-gray-600 mb-6">Your items will be ready in the staging room. Use this PIN at the door:</p>
            <div class="bg-gray-900 text-white text-5xl font-mono font-bold py-6 px-8 rounded-xl tracking-[0.3em] mb-4" id="pin-display">
                ----
            </div>
            <p class="text-sm text-gray-500 mb-6">This PIN expires in <strong>24 hours</strong>.</p>
            <button onclick="closeModal()" class="w-full bg-gray-100 text-gray-800 font-bold py-3 rounded-xl hover:bg-gray-200 transition">Return to Vault</button>
        </div>
    </div>

    <!-- Retrieval Options Modal -->
    <div id="retrieval-modal" class="fixed inset-0 bg-gray-900 bg-opacity-50 z-50 hidden flex items-center justify-center p-4">
        <div class="bg-white rounded-3xl shadow-2xl w-full max-w-md overflow-hidden flex flex-col max-h-[90vh]">
            <!-- Header -->
            <div class="bg-blue-600 px-6 py-5 text-white flex justify-between items-center">
                <h2 class="text-xl font-bold">Retrieval Options</h2>
                <button onclick="closeRetrievalModal()" class="text-blue-100 hover:text-white transition">
                    <svg class="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"></path></svg>
                </button>
            </div>

            <!-- Body -->
            <div class="p-6 overflow-y-auto">
                <p class="text-gray-600 mb-6 font-medium">How would you like to receive your <span id="retrieval-tote-count" class="font-bold text-gray-900">0</span> items?</p>
                
                <div class="space-y-4">
                    <!-- Option 1: Self-Service -->
                    <div id="retrieval-opt-staging" class="flex items-center p-4 rounded-xl border-2 border-blue-500 bg-blue-50 cursor-pointer transition-all" onclick="selectRetrievalLogistics('staging')">
                        <div class="w-5 h-5 rounded-full border-[5px] border-blue-600 bg-white mr-4 flex-shrink-0" id="retrieval-dot-staging"></div>
                        <div>
                            <div class="font-bold text-gray-900 text-lg">Self-Service Pickup <span class="text-green-600 ml-2 text-sm">Included</span></div>
                            <div class="text-sm text-gray-500 mt-1">We'll stage it at your local facility.</div>
                        </div>
                    </div>
                    
                    <!-- Option 2: Valet Delivery -->
                    <div id="retrieval-opt-valet" class="flex items-center p-4 rounded-xl border-2 border-gray-200 bg-white cursor-pointer transition-all" onclick="selectRetrievalLogistics('valet_delivery')">
                        <div class="w-5 h-5 rounded-full border-2 border-gray-300 bg-white mr-4 flex-shrink-0" id="retrieval-dot-valet"></div>
                        <div>
                            <div class="font-bold text-gray-900 text-lg">Valet Delivery <span class="text-gray-600 ml-2 text-sm" id="retrieval-valet-fee-label">...</span></div>
                            <div class="text-sm text-gray-500 mt-1">We'll deliver it to your door.</div>
                        </div>
                    </div>
                </div>
                
                <!-- Terms disclaimer -->
                <div class="text-[10px] text-gray-500 leading-relaxed mt-6 bg-gray-50 p-3 rounded-xl border border-gray-150 hidden" id="retrieval-valet-terms">
                    * By confirming, you authorize CloudVault to charge the valet delivery fee to your card on file for this service.
                </div>
            </div>

            <!-- Footer -->
            <div class="px-6 py-5 bg-gray-50 border-t border-gray-100">
                <button id="confirm-retrieval-btn" onclick="confirmRetrieval()" class="w-full bg-blue-600 text-white px-4 py-4 rounded-xl font-bold text-lg hover:bg-blue-700 transition shadow-lg">
                    Confirm Request
                </button>
            </div>
        </div>
    </div>

    <!-- Cancellation Confirmation Modal -->
    <div id="cancel-modal" class="fixed inset-0 bg-gray-900 bg-opacity-40 z-50 flex items-center justify-center hidden">
        <div class="bg-white rounded-3xl p-8 max-w-md w-full mx-4 shadow-2xl space-y-6">
            <h2 class="text-2xl font-bold text-gray-900">Cancel Subscription?</h2>
            <p class="text-sm text-gray-600 leading-relaxed">
                You are canceling your monthly subscription. You currently physically hold <span id="cancel-totes-count-modal" class="font-bold text-gray-900">0</span> totes.
            </p>
            <div class="bg-red-50 border border-red-200 rounded-xl p-4 text-xs text-red-800 leading-relaxed">
                <strong>âš ï¸ Asset Return Requirement:</strong> You must return all physical totes to our staging room within <strong>14 days</strong> of cancellation. After 14 days, your card-on-file will be automatically billed <strong>$15.00 per unreturned tote</strong>.
            </div>
            <div class="flex items-center space-x-2 cursor-pointer select-none">
                <input type="checkbox" id="user-cancel-simulate-expiry" class="rounded text-blue-600 border-gray-300">
                <label for="user-cancel-simulate-expiry" class="text-xs text-gray-600 font-semibold">Simulate immediate deadline expiry (sets deadline in past)</label>
            </div>
            <div class="flex space-x-4">
                <button onclick="closeCancelModal()" class="flex-1 bg-gray-100 text-gray-600 font-bold py-3 rounded-xl hover:bg-gray-200 transition">Keep Subscription</button>
                <button onclick="confirmCancelSubscriptionFlow()" id="confirm-cancel-btn" class="flex-1 bg-red-600 text-white font-bold py-3 rounded-xl hover:bg-red-700 transition">Confirm Cancel</button>
            </div>
        </div>
    </div>

    <!-- Settings Modal -->
    <div id="settings-modal" class="fixed inset-0 bg-gray-900 bg-opacity-40 z-50 flex items-center justify-center hidden">
        <div class="bg-white rounded-3xl p-8 max-w-md w-full mx-4 shadow-2xl space-y-6">
            <h2 class="text-2xl font-bold text-gray-900">Profile Settings</h2>
            <div class="space-y-3">
                <label class="block text-sm font-semibold text-gray-700">Avatar Color</label>
                <div class="flex space-x-4">
                    <button onclick="selectColor('blue')" id="color-blue" class="w-10 h-10 rounded-full bg-blue-100 text-blue-600 border-2 border-transparent hover:border-blue-300 flex items-center justify-center font-bold transition"></button>
                    <button onclick="selectColor('green')" id="color-green" class="w-10 h-10 rounded-full bg-green-100 text-green-600 border-2 border-transparent hover:border-green-300 flex items-center justify-center font-bold transition"></button>
                    <button onclick="selectColor('purple')" id="color-purple" class="w-10 h-10 rounded-full bg-purple-100 text-purple-600 border-2 border-transparent hover:border-purple-300 flex items-center justify-center font-bold transition"></button>
                    <button onclick="selectColor('rose')" id="color-rose" class="w-10 h-10 rounded-full bg-rose-100 text-rose-600 border-2 border-transparent hover:border-rose-300 flex items-center justify-center font-bold transition"></button>
                    <button onclick="selectColor('orange')" id="color-orange" class="w-10 h-10 rounded-full bg-orange-100 text-orange-600 border-2 border-transparent hover:border-orange-300 flex items-center justify-center font-bold transition"></button>
                </div>
            </div>
            <div class="flex space-x-4 pt-4">
                <button onclick="closeSettingsModal()" class="flex-1 bg-gray-100 text-gray-600 font-bold py-3 rounded-xl hover:bg-gray-200 transition">Cancel</button>
                <button onclick="saveProfileColor()" id="save-color-btn" class="flex-1 bg-blue-600 text-white font-bold py-3 rounded-xl hover:bg-blue-700 transition">Save Changes</button>
            </div>
        </div>
    </div>

    <!-- Billing Modal -->
    <div id="billing-modal" class="fixed inset-0 bg-gray-900 bg-opacity-40 z-50 flex items-center justify-center hidden">
        <div class="bg-white rounded-3xl p-8 max-w-md w-full mx-4 shadow-2xl space-y-6">
            <h2 class="text-2xl font-bold text-gray-900">Billing & Plan</h2>
            <div class="space-y-4">
                <div class="bg-gray-50 rounded-xl p-4 border border-gray-100">
                    <p class="text-xs text-gray-500 font-semibold uppercase tracking-wider mb-1">Next Payment Date</p>
                    <p id="billing-next-date" class="text-lg font-bold text-gray-900">Loading...</p>
                </div>
                <div class="bg-gray-50 rounded-xl p-4 border border-gray-100">
                    <p class="text-xs text-gray-500 font-semibold uppercase tracking-wider mb-1">Payment Method</p>
                    <div class="flex items-center justify-between">
                        <p class="text-sm font-bold text-gray-900 flex items-center">
                            <svg class="w-5 h-5 mr-2 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M3 10h18M7 15h1m4 0h1m-7 4h12a3 3 0 003-3V8a3 3 0 00-3-3H6a3 3 0 00-3 3v8a3 3 0 003 3z"></path></svg>
                            â€¢â€¢â€¢â€¢ 4242
                        </p>
                        <button class="text-blue-600 text-sm font-bold hover:underline">Update</button>
                    </div>
                </div>
            </div>
            <div class="pt-4">
                <button onclick="closeBillingModal()" class="w-full bg-gray-100 text-gray-800 font-bold py-3 rounded-xl hover:bg-gray-200 transition">Close</button>
            </div>
        </div>
    </div>

    <!-- Supabase JS SDK -->
    <script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2"></script>
    <script src="supabase-config.js"></script>

    <script>
        // ============================================================
        // Utilities
        // ============================================================
        function debounce(func, wait) {
            let timeout;
            return function(...args) {
                clearTimeout(timeout);
                timeout = setTimeout(() => func.apply(this, args), wait);
            };
        }

        // ============================================================
        // State
        // ============================================================
        let currentUser = null;
        let currentUserColor = 'blue';
        let selectedItems = new Set();
        let currentInventory = [];
        let systemPricing = { valet_base: 15.00, valet_tote_adder: 1.00 };
        let retrievalLogisticsType = 'staging';
        let unsubscribeInventory = null;
        let unsubscribeUsers = null;
        let unsubscribeSubs = null;

        // Wizard & Totes State
        let wizardTotes = 5;
        let wizardLogistics = 'self_service';
        let wizardZip = '';
        let additionalToteCount = 1;
        let addTotesLogistics = 'self_service';
        let currentSubscription = null;

        // ============================================================
        // Pricing & Wizard Functions
        // ============================================================
        function getAddTierRate(count) {
            if (count >= 50) return { rate: 1.00, tier: 4, label: 'Tier 4 â€” $1.00/tote' };
            if (count >= 25) return { rate: 2.00, tier: 3, label: 'Tier 3 â€” $2.00/tote' };
            if (count >= 10) return { rate: 3.50, tier: 2, label: 'Tier 2 â€” $3.50/tote' };
            return { rate: 5.00, tier: 1, label: 'Tier 1 â€” $5.00/tote' };
        }

        function updateAddTotesPreview() {
            if (!currentSubscription) return;
            const currentTotes = currentSubscription.total_totes || 0;
            const currentRate = Number(currentSubscription.tote_rate) || 5.00;
            const currentMonthly = Number(currentSubscription.recurring_storage) || 0.00;

            const newTotal = currentTotes + additionalToteCount;
            const { rate: newRate, label: rateLabel } = getAddTierRate(newTotal);
            const newMonthly = Math.round(newTotal * newRate * 100) / 100;
            const delta = Math.round((newMonthly - currentMonthly) * 100) / 100;

            document.getElementById('preview-current-summary').textContent = `${currentTotes} Tote${currentTotes > 1 ? 's' : ''} @ $${currentRate.toFixed(2)} = $${currentMonthly.toFixed(2)}/mo`;
            document.getElementById('preview-added-count').textContent = `+${additionalToteCount} Tote${additionalToteCount > 1 ? 's' : ''}`;
            document.getElementById('preview-new-rate').textContent = rateLabel;
            document.getElementById('preview-new-monthly').textContent = `$${newMonthly.toFixed(2)}/mo`;
            
            const incrementalCostEl = document.getElementById('preview-incremental-cost');
            incrementalCostEl.textContent = delta >= 0 ? `+$${delta.toFixed(2)}/mo` : `-$${Math.abs(delta).toFixed(2)}/mo`;
            incrementalCostEl.className = delta < 0 ? 'text-lg font-extrabold text-green-600' : 'text-lg font-extrabold text-blue-600';

            const tierBanner = document.getElementById('tier-change-banner');
            if (newRate < currentRate) {
                tierBanner.classList.remove('hidden');
            } else {
                tierBanner.classList.add('hidden');
            }

            document.getElementById('add-valet-fee-label').textContent = `$${(15.00 + additionalToteCount * 1.00).toFixed(2)}`;
        }

        function selectAddLogistics(type) {
            addTotesLogistics = type;
            const selfEl = document.getElementById('add-opt-self');
            const valetEl = document.getElementById('add-opt-valet');
            const dotSelf = document.getElementById('add-dot-self');
            const dotValet = document.getElementById('add-dot-valet');
            if (type === 'self_service') {
                selfEl.className = 'flex items-center p-3 rounded-xl border-2 border-blue-600 bg-blue-50 cursor-pointer';
                valetEl.className = 'flex items-center p-3 rounded-xl border-2 border-gray-200 bg-white cursor-pointer';
                dotSelf.className = 'w-4 h-4 rounded-full border-4 border-blue-600 bg-white mr-3 flex-shrink-0';
                dotValet.className = 'w-4 h-4 rounded-full border-2 border-gray-300 bg-white mr-3 flex-shrink-0';
            } else {
                valetEl.className = 'flex items-center p-3 rounded-xl border-2 border-blue-600 bg-blue-50 cursor-pointer';
                selfEl.className = 'flex items-center p-3 rounded-xl border-2 border-gray-200 bg-white cursor-pointer';
                dotValet.className = 'w-4 h-4 rounded-full border-4 border-blue-600 bg-white mr-3 flex-shrink-0';
                dotSelf.className = 'w-4 h-4 rounded-full border-2 border-gray-300 bg-white mr-3 flex-shrink-0';
            }
            updateAddTotesPreview();
        }

        async function confirmAddTotes() {
            const btn = document.getElementById('add-totes-confirm-btn');
            const errEl = document.getElementById('add-totes-error');
            btn.disabled = true;
            btn.textContent = 'Processing...';
            errEl.classList.add('hidden');

            try {
                const { data, error } = await supabase.rpc('add_totes', {
                    p_additional_totes: additionalToteCount,
                    p_logistics_type: addTotesLogistics
                });
                if (error) throw error;
                closeAddTotesPanel();
                showToast(`${additionalToteCount} tote${additionalToteCount > 1 ? 's' : ''} added! New monthly: $${data.newMonthly.toFixed(2)}/mo`);
            } catch (err) {
                console.error('Add totes failed:', err);
                errEl.textContent = err.message || 'Something went wrong. Please try again.';
                errEl.classList.remove('hidden');
                btn.textContent = 'Confirm & Add Totes';
                btn.disabled = false;
            }
        }

        function initWizardState() {
            selectWizardTotes(wizardTotes);
            selectWizardLogistics(wizardLogistics);
            document.getElementById('wizard-zip-check-container').classList.remove('hidden');
            document.getElementById('wizard-subscription-container').classList.add('hidden');
            document.getElementById('wizard-waitlist-container').classList.add('hidden');
            document.getElementById('wizard-onboarding-desc').textContent = 'Verify your ZIP code to check if we service your area.';
            document.getElementById('wizard-zip-input').value = '';
            document.getElementById('wizard-zip-error').classList.add('hidden');
            wizardZip = '';
        }

        async function checkWizardZip() {
            const zipInput = document.getElementById('wizard-zip-input');
            const zipError = document.getElementById('wizard-zip-error');
            const zip = zipInput.value.trim();
            const zipRegex = /^\d{5}$/;

            zipError.classList.add('hidden');

            if (!zipRegex.test(zip)) {
                zipError.textContent = 'Please enter a valid 5-digit ZIP code.';
                zipError.classList.remove('hidden');
                return;
            }

            const btn = document.getElementById('btn-wizard-zip-check');
            const originalText = btn.textContent;
            btn.textContent = 'Checking...';
            btn.disabled = true;

            try {
                const { data: area, error } = await supabase
                    .from('service_areas')
                    .select('*')
                    .eq('zip_code', zip)
                    .eq('active', true)
                    .maybeSingle();

                btn.textContent = originalText;
                btn.disabled = false;

                if (!area) {
                    // ZIP not active -> show waitlist
                    wizardZip = zip;
                    document.getElementById('wizard-zip-check-container').classList.add('hidden');
                    document.getElementById('wizard-waitlist-container').classList.remove('hidden');
                    document.getElementById('wizard-onboarding-desc').textContent = 'We\'re not in your area yet.';
                    return;
                }

                // ZIP is active -> proceed to subscription wizard
                wizardZip = zip;
                document.getElementById('wizard-zip-check-container').classList.add('hidden');
                document.getElementById('wizard-subscription-container').classList.remove('hidden');
                document.getElementById('wizard-onboarding-desc').textContent = `Plan Configuration â€” Servicing ${area.city || zip}`;
            } catch (err) {
                console.error("Error checking zip:", err);
                btn.textContent = originalText;
                btn.disabled = false;
                zipError.textContent = 'Unable to check ZIP code. Please try again.';
                zipError.classList.remove('hidden');
            }
        }

        async function submitWizardWaitlist() {
            const btn = document.getElementById('btn-wizard-waitlist-submit');
            btn.textContent = 'Joining...';
            btn.disabled = true;

            try {
                await supabase.from('waitlist').insert({ email: currentUser.email, zip_code: wizardZip });
                document.getElementById('wizard-waitlist-success').classList.remove('hidden');
                btn.classList.add('hidden');
            } catch (err) {
                console.error("Error joining waitlist:", err);
                alert("Something went wrong joining the waitlist. Please try again.");
                btn.textContent = 'Join Waitlist';
                btn.disabled = false;
            }
        }

        function getWizardTierRate(count) {
            if (count >= 50) return { rate: 1.00, tier: 4, label: 'Tier 4 â€” $1.00/tote' };
            if (count >= 25) return { rate: 2.00, tier: 3, label: 'Tier 3 â€” $2.00/tote' };
            if (count >= 10) return { rate: 3.50, tier: 2, label: 'Tier 2 â€” $3.50/tote' };
            return { rate: 5.00, tier: 1, label: 'Tier 1 â€” $5.00/tote' };
        }

        function selectWizardTotes(count) {
            wizardTotes = count;
            document.getElementById('wizard-custom-totes').value = count;
            updateWizardLedger();
        }

        function handleWizardCustomInput() {
            const input = document.getElementById('wizard-custom-totes');
            let val = parseInt(input.value) || 1;
            if (val < 1) val = 1;
            if (val > 500) val = 500;
            wizardTotes = val;
            updateWizardLedger();
        }

        function selectWizardLogistics(type) {
            wizardLogistics = type;
            const selfEl = document.getElementById('wizard-opt-self');
            const valetEl = document.getElementById('wizard-opt-valet');
            const dotSelf = document.getElementById('wizard-dot-self');
            const dotValet = document.getElementById('wizard-dot-valet');
            if (type === 'self_service') {
                selfEl.className = 'flex items-center p-4 rounded-2xl border-2 border-blue-600 bg-blue-50 cursor-pointer';
                valetEl.className = 'flex items-center p-4 rounded-2xl border border-gray-200 bg-white cursor-pointer';
                dotSelf.className = 'w-4 h-4 rounded-full border-4 border-blue-600 bg-white mr-4 flex-shrink-0';
                dotValet.className = 'w-4 h-4 rounded-full border border-gray-300 bg-white mr-4 flex-shrink-0';
            } else {
                valetEl.className = 'flex items-center p-4 rounded-2xl border-2 border-blue-600 bg-blue-50 cursor-pointer';
                selfEl.className = 'flex items-center p-4 rounded-2xl border border-gray-200 bg-white cursor-pointer';
                dotValet.className = 'w-4 h-4 rounded-full border-4 border-blue-600 bg-white mr-4 flex-shrink-0';
                dotSelf.className = 'w-4 h-4 rounded-full border border-gray-300 bg-white mr-4 flex-shrink-0';
            }
            updateWizardLedger();
        }

        function updateWizardLedger() {
            const { rate, tier } = getWizardTierRate(wizardTotes);
            
            for (let i = 1; i <= 4; i++) {
                const card = document.getElementById(`wizard-tier-${i}`);
                if (card) {
                    const presetCount = i === 1 ? 5 : i === 2 ? 10 : i === 3 ? 25 : 50;
                    if (wizardTotes === presetCount) {
                        card.className = 'border-2 border-blue-600 bg-blue-50/50 rounded-2xl p-4 text-center cursor-pointer transition transform hover:scale-[1.02] shadow-sm';
                        const badge = card.querySelector('.text-lg');
                        if (badge) badge.className = 'block font-extrabold text-blue-600 text-lg mt-1';
                    } else {
                        card.className = 'border border-gray-200 bg-white rounded-2xl p-4 text-center cursor-pointer transition transform hover:scale-[1.02] opacity-70';
                        const badge = card.querySelector('.text-lg');
                        if (badge) badge.className = 'block font-extrabold text-gray-900 text-lg mt-1';
                    }
                }
            }

            const monthly = wizardTotes * rate;
            const logisticsFee = wizardLogistics === 'valet_pickup' ? 15.00 + (wizardTotes * 1.00) : 0;
            const total = monthly + logisticsFee;

            document.getElementById('ledger-monthly').textContent = monthly.toFixed(2);
            document.getElementById('ledger-logistics').textContent = logisticsFee === 0 ? 'Free' : `$${logisticsFee.toFixed(2)}`;
            document.getElementById('ledger-total').textContent = total.toFixed(2);

            document.getElementById('wizard-valet-label').textContent = `$${(15.00 + wizardTotes * 1.00).toFixed(2)}`;
        }

        async function activateOnboardingSubscription() {
            const tosCheckbox = document.getElementById('wizard-tos-checkbox');
            const errorMsg = document.getElementById('wizard-error-msg');
            const btn = document.getElementById('wizard-activate-btn');

            errorMsg.classList.add('hidden');
            if (!tosCheckbox.checked) {
                errorMsg.textContent = 'You must authorize card-on-file billing and agree to the terms to activate your space.';
                errorMsg.classList.remove('hidden');
                return;
            }

            btn.disabled = true;
            btn.textContent = 'Processing...';

            try {
                let zipCode = wizardZip || '98101';

                const { data, error } = await supabase.rpc('create_customer_profile', {
                    p_name: currentUser.user_metadata?.name || currentUser.email.split('@')[0],
                    p_phone: currentUser.user_metadata?.phone || '(555) 555-5555',
                    p_zip: zipCode,
                    p_tote_count: wizardTotes,
                    p_logistics_type: wizardLogistics
                });
                if (error) throw error;

                showToast('Subscription activated successfully!');
            } catch (err) {
                console.error('Failed to activate subscription:', err);
                errorMsg.textContent = err.message || 'Activation failed. Please try again.';
                errorMsg.classList.remove('hidden');
                btn.disabled = false;
                btn.textContent = 'Start My Storage Subscription';
            }
        }

        function copyStagingPin() {
            const pinEl = document.getElementById('pickup-pin');
            if (!pinEl) return;
            const text = pinEl.textContent;
            navigator.clipboard.writeText(text).then(() => {
                showToast("PIN code copied to clipboard!");
            }).catch(err => {
                console.error("Failed to copy PIN:", err);
            });
        }

        const STAFF_ROLES = ['executive', 'warehouse_manager', 'warehouse_worker'];

        supabase.auth.onAuthStateChange(async (event, session) => {
            if (!session) {
                window.location.href = 'login.html';
                return;
            }
            currentUser = session.user;

            try {
                const profile = await getCachedUserProfile(currentUser.id);
                if (profile && STAFF_ROLES.includes(profile.role)) {
                    window.location.href = 'admin.html';
                    return;
                }
            } catch (e) {
                console.warn('Role check failed, continuing as customer:', e);
            }

            const initials = (currentUser.user_metadata?.name || currentUser.email || '--')
                .split(' ').map(s => s[0]).join('').toUpperCase().slice(0, 2);
            document.getElementById('user-avatar').textContent = initials;

            try {
                const { data: pricing } = await supabase.from('settings').select('valet_base, valet_tote_adder').eq('id', 'pricing').single();
                if (pricing) {
                    systemPricing.valet_base = Number(pricing.valet_base);
                    systemPricing.valet_tote_adder = Number(pricing.valet_tote_adder);
                }
            } catch (err) {
                console.warn('Could not fetch pricing, using defaults.', err);
            }

            if (isPastCutoff()) {
                document.getElementById('cutoff-banner').classList.remove('hidden');
            }

            // Real-time listener on user profile
            if (unsubscribeUsers) supabase.removeChannel(unsubscribeUsers);
            
            const handleProfileUpdate = (profileData) => {
                document.getElementById('loading-state').classList.add('hidden');
                document.getElementById('main-content').classList.remove('hidden');
                
                if (profileData) {
                    sessionStorage.setItem(`cv_user_${currentUser.id}`, JSON.stringify(profileData));
                    if (profileData.name) {
                        const pi = profileData.name.split(' ').map(s => s[0]).join('').toUpperCase().slice(0, 2);
                        document.getElementById('user-avatar').textContent = pi;
                    }
                    if (profileData.avatar_color) {
                        currentUserColor = profileData.avatar_color;
                        applyAvatarColor(currentUserColor);
                    }
                    const devHeld = document.getElementById('dev-totes-held');
                    if (devHeld) {
                        devHeld.textContent = profileData.active_totes_held || 0;
                    }
                    renderOnboardingTracker(profileData);
                } else {
                    attachInventoryListener(currentUser.id);
                }
            };

            // Get initial user profile
            const { data: initialUser } = await supabase.from('users').select('*').eq('id', currentUser.id).maybeSingle();
            handleProfileUpdate(initialUser);

            if (unsubscribeUsers) supabase.removeChannel(unsubscribeUsers);
            unsubscribeUsers = supabase.channel(`users_changes_${currentUser.id}_${Date.now()}`)
                .on('postgres_changes', { event: '*', schema: 'public', table: 'users', filter: `id=eq.${currentUser.id}` }, payload => {
                    handleProfileUpdate(payload.new);
                })
                .subscribe();

            // Real-time listener on subscription
            if (unsubscribeSubs) supabase.removeChannel(unsubscribeSubs);

            const handleSubsUpdate = (sub) => {
                const onboardingWizard = document.getElementById('flow-onboarding-wizard');
                const activeDashboard = document.getElementById('flow-active-dashboard');
                
                if (!sub || sub.status !== 'active') {
                    onboardingWizard.classList.remove('hidden');
                    activeDashboard.classList.add('hidden');
                    currentSubscription = null;
                    initWizardState();
                } else {
                    currentSubscription = sub;
                    onboardingWizard.classList.add('hidden');
                    activeDashboard.classList.remove('hidden');
                    
                    const headerPlan = document.getElementById('active-plan-header');
                    if (headerPlan) {
                        headerPlan.textContent = `${sub.total_totes} Totes Plan ($${Number(sub.tote_rate).toFixed(2)}/tote â€” $${Number(sub.recurring_storage).toFixed(2)}/mo)`;
                    }
                    updateAddTotesPreview();
                }
            };

            const { data: initialSubs } = await supabase.from('subscriptions').select('*').eq('uid', currentUser.id).limit(1);
            if (initialSubs && initialSubs.length > 0) {
                handleSubsUpdate(initialSubs[0]);
            } else {
                handleSubsUpdate(null);
            }

            unsubscribeSubs = supabase.channel(`subscriptions_changes_${currentUser.id}_${Date.now()}`)
                .on('postgres_changes', { event: '*', schema: 'public', table: 'subscriptions', filter: `uid=eq.${currentUser.id}` }, payload => {
                    handleSubsUpdate(payload.new);
                })
                .subscribe();
        });

        // ============================================================
        // Onboarding Progress Tracker UI Renderer
        // ============================================================
        function renderOnboardingTracker(profile) {
            const tracker = document.getElementById('onboarding-tracker');
            const grid = document.getElementById('tote-grid');
            const empty = document.getElementById('empty-state');
            const cutoffBanner = document.getElementById('cutoff-banner');
            const actionBar = document.getElementById('action-bar');
            
            const status = profile.onboarding_status || 'pending';
            
            if (status === 'active') {
                tracker.classList.add('hidden');
                grid.classList.remove('hidden');
                attachInventoryListener(currentUser.id);
            } else {
                grid.classList.add('hidden');
                empty.classList.add('hidden');
                if (cutoffBanner) cutoffBanner.classList.add('hidden');
                if (actionBar) actionBar.className = "fixed bottom-0 left-0 right-0 bg-white border-t border-gray-200 shadow-[0_-4px_6px_-1px_rgba(0,0,0,0.05)] p-4 transition-transform duration-300 bar-hidden z-40";
                
                tracker.classList.remove('hidden');
                
                const step2Badge = document.getElementById('step2-badge');
                const step3Badge = document.getElementById('step3-badge');
                const step3Desc = document.getElementById('step3-desc');
                const pinContainer = document.getElementById('pickup-pin-container');
                const pinDisplay = document.getElementById('pickup-pin');
                
                if (status === 'pending') {
                    step2Badge.className = "w-12 h-12 rounded-full bg-blue-50 text-blue-600 border-2 border-blue-600 flex items-center justify-center font-bold text-lg mb-3";
                    step2Badge.innerHTML = '<span class="animate-pulse">â—</span>';
                    
                    step3Badge.className = "w-12 h-12 rounded-full bg-gray-100 text-gray-400 flex items-center justify-center font-bold text-lg mb-3";
                    step3Badge.textContent = "3";
                    step3Desc.textContent = "We'll notify you when ready.";
                    pinContainer.classList.add('hidden');
                } else if (status === 'totes-ready') {
                    step2Badge.className = "w-12 h-12 rounded-full bg-green-100 text-green-600 flex items-center justify-center font-bold text-lg mb-3";
                    step2Badge.textContent = "âœ“";
                    
                    step3Badge.className = "w-12 h-12 rounded-full bg-blue-600 text-white flex items-center justify-center font-bold text-lg mb-3 shadow-md";
                    step3Badge.textContent = "3";
                    step3Desc.innerHTML = "<span class='text-blue-600 font-bold'>Totes staged!</span>";
                    
                    pinContainer.classList.remove('hidden');
                    pinDisplay.textContent = profile.onboarding_pin || '----';
                }
            }
        }

        // ============================================================
        // Real-time listener for Inventory
        // ============================================================
        function attachInventoryListener(uid) {
            if (unsubscribeInventory) supabase.removeChannel(unsubscribeInventory);

            const fetchInventory = async () => {
                const { data, error } = await supabase
                    .from('inventory')
                    .select('*')
                    .eq('uid', uid)
                    .order('created_at', { ascending: false });

                if (!error && data) {
                    currentInventory = data;
                } else {
                    currentInventory = [];
                }
                renderInventory();
            };

            fetchInventory();

            unsubscribeInventory = supabase.channel(`inventory_changes_${uid}_${Date.now()}`)
                .on('postgres_changes', { event: '*', schema: 'public', table: 'inventory', filter: `uid=eq.${uid}` }, () => {
                    fetchInventory();
                })
                .subscribe();
        }

        function handleSearchFilter() {
            renderInventory();
        }

        function renderInventory() {
            const grid = document.getElementById('tote-grid');
            const empty = document.getElementById('empty-state');
            const tracker = document.getElementById('onboarding-tracker');

            // Get filter values
            const searchInput = document.getElementById('search-input');
            const statusSelect = document.getElementById('status-filter');
            const query = searchInput ? searchInput.value.toLowerCase() : '';
            const statusFilter = statusSelect ? statusSelect.value : 'all';

            const filteredData = currentInventory.filter(item => {
                const matchesSearch = (item.label || '').toLowerCase().includes(query) || (item.tote_code || '').toLowerCase().includes(query);
                const matchesStatus = statusFilter === 'all' || item.status === statusFilter;
                return matchesSearch && matchesStatus;
            });

            tracker.classList.add('hidden');
            grid.classList.remove('hidden');

            if (currentInventory.length === 0) {
                grid.innerHTML = '';
                empty.classList.remove('hidden');
                // Hide search bar if they have zero inventory total
                document.getElementById('search-input').parentElement.parentElement.classList.add('hidden');
                return;
            }

            // They have inventory, show search bar
            document.getElementById('search-input').parentElement.parentElement.classList.remove('hidden');
            empty.classList.add('hidden');
            grid.innerHTML = '';

            if (filteredData.length === 0) {
                grid.innerHTML = '<div class="col-span-full text-center py-12 text-gray-500 font-semibold">No totes match your search.</div>';
                return;
            }

            filteredData.forEach((item) => {
                const id = item.id;
                const isSelected = selectedItems.has(id);
                const isStaged = item.status === 'staged' || item.status === 'pending-stage';
                const isBulky = item.item_type === 'bulky';

                const card = document.createElement('div');
                card.className = `tote-card bg-white border-2 rounded-2xl p-6 relative cursor-pointer ${isSelected ? 'selected border-blue-600' : 'border-gray-100'} ${isStaged ? 'opacity-60 pointer-events-none' : ''}`;
                card.onclick = () => { if (!isStaged) toggleTote(id); };

                card.innerHTML = `
                    <div class="flex justify-between items-start mb-4">
                        <div class="w-12 h-12 ${isBulky ? 'bg-purple-50 border-purple-100' : 'bg-gray-50 border-gray-100'} rounded-lg flex items-center justify-center border">
                            ${isBulky
                                ? '<span class="text-purple-500 font-bold text-xs uppercase tracking-wider">Bulky</span>'
                                : '<svg class="w-6 h-6 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M20 7l-8-4-8 4m16 0l-8 4m8-4v10l-8 4m0-10L4 7m8 4v10M4 7v10l8 4"></path></svg>'
                            }
                        </div>
                        ${isStaged
                            ? '<span class="text-xs font-bold text-amber-600 bg-amber-50 px-2 py-1 rounded-full border border-amber-200">Staged</span>'
                            : `<div class="w-6 h-6 rounded border-2 flex items-center justify-center ${isSelected ? 'bg-blue-600 border-blue-600 text-white' : 'border-gray-300'}">
                                ${isSelected ? '<svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="3" d="M5 13l4 4L19 7"></path></svg>' : ''}
                               </div>`
                        }
                    </div>
                    <div class="text-xs font-bold text-gray-400 tracking-wider mb-1">${item.tote_code || 'TOTE'}</div>
                    <input type="text"
                        value="${item.label || ''}"
                        class="label-input w-full bg-transparent font-bold text-gray-900 text-lg placeholder-gray-300 pb-1"
                        placeholder="Add a label..."
                        data-id="${id}"
                        data-original="${item.label || ''}"
                        onclick="event.stopPropagation()"
                    >
                    <div class="saving-indicator text-xs text-green-600 mt-1 opacity-0" id="save-${id}">âœ“ Saved</div>
                `;

                grid.appendChild(card);
            });

            attachLabelListeners();
        }

        // ============================================================
        // Save Label updates
        // ============================================================
        function attachLabelListeners() {
            document.querySelectorAll('.label-input').forEach(input => {
                const debouncedSave = debounce(async (el) => {
                    const id = el.dataset.id;
                    const newLabel = el.value.trim();
                    const original = el.dataset.original;

                    if (newLabel === original) return;

                    const { error } = await supabase.from('inventory').update({ label: newLabel }).eq('id', id);
                    if (!error) {
                        el.dataset.original = newLabel;
                        const indicator = document.getElementById(`save-${id}`);
                        if (indicator) {
                            indicator.classList.remove('opacity-0');
                            setTimeout(() => indicator.classList.add('opacity-0'), 1500);
                        }
                    } else {
                        console.error('Failed to save label:', error);
                    }
                }, 1500);

                input.addEventListener('input', (e) => debouncedSave(e.target));
            });
        }

        // ============================================================
        // Selection Logic
        // ============================================================
        function toggleTote(id) {
            if (selectedItems.has(id)) {
                selectedItems.delete(id);
            } else {
                selectedItems.add(id);
            }
            document.querySelectorAll('.tote-card').forEach(card => {
                const input = card.querySelector('.label-input');
                if (!input) return;
                const cardId = input.dataset.id;
                const isSelected = selectedItems.has(cardId);
                card.classList.toggle('selected', isSelected);
                card.classList.toggle('border-blue-600', isSelected);
                card.classList.toggle('border-gray-100', !isSelected);

                const checkbox = card.querySelector('.w-6.h-6.rounded');
                if (checkbox) {
                    checkbox.className = `w-6 h-6 rounded border-2 flex items-center justify-center ${isSelected ? 'bg-blue-600 border-blue-600 text-white' : 'border-gray-300'}`;
                    checkbox.innerHTML = isSelected ? '<svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="3" d="M5 13l4 4L19 7"></path></svg>' : '';
                }
            });
            updateActionBar();
        }

        function updateActionBar() {
            const count = selectedItems.size;
            const countEl = document.getElementById('selected-count');
            if (countEl) {
                countEl.innerText = count;
            }
            const bar = document.getElementById('action-bar');
            if (bar) {
                if (count > 0) {
                    bar.classList.remove('bar-hidden');
                    bar.classList.add('bar-visible');
                } else {
                    bar.classList.remove('bar-visible');
                    bar.classList.add('bar-hidden');
                }
            }
        }

        // ============================================================
        // STAGING REQUEST: Call Postgres RPC
        // ============================================================
        function requestRetrieval() {
            if (selectedItems.size === 0) return;
            
            // Populate modal counts and pricing
            const count = selectedItems.size;
            document.getElementById('retrieval-tote-count').textContent = count;
            
            const valetFee = systemPricing.valet_base + (count * systemPricing.valet_tote_adder);
            document.getElementById('retrieval-valet-fee-label').textContent = `$${valetFee.toFixed(2)}`;
            
            // Reset to default
            selectRetrievalLogistics('staging');
            document.getElementById('retrieval-modal').classList.remove('hidden');
        }

        function closeRetrievalModal() {
            document.getElementById('retrieval-modal').classList.add('hidden');
        }

        function selectRetrievalLogistics(type) {
            retrievalLogisticsType = type;
            
            const stagingOpt = document.getElementById('retrieval-opt-staging');
            const stagingDot = document.getElementById('retrieval-dot-staging');
            const valetOpt = document.getElementById('retrieval-opt-valet');
            const valetDot = document.getElementById('retrieval-dot-valet');
            const termsBox = document.getElementById('retrieval-valet-terms');

            if (type === 'staging') {
                stagingOpt.classList.replace('border-gray-200', 'border-blue-500');
                stagingOpt.classList.replace('bg-white', 'bg-blue-50');
                stagingDot.classList.replace('border-gray-300', 'border-blue-600');
                stagingDot.classList.add('border-[5px]');
                stagingDot.classList.remove('border-2');
                
                valetOpt.classList.replace('border-blue-500', 'border-gray-200');
                valetOpt.classList.replace('bg-blue-50', 'bg-white');
                valetDot.classList.replace('border-blue-600', 'border-gray-300');
                valetDot.classList.remove('border-[5px]');
                valetDot.classList.add('border-2');
                
                termsBox.classList.add('hidden');
            } else {
                valetOpt.classList.replace('border-gray-200', 'border-blue-500');
                valetOpt.classList.replace('bg-white', 'bg-blue-50');
                valetDot.classList.replace('border-gray-300', 'border-blue-600');
                valetDot.classList.add('border-[5px]');
                valetDot.classList.remove('border-2');
                
                stagingOpt.classList.replace('border-blue-500', 'border-gray-200');
                stagingOpt.classList.replace('bg-blue-50', 'bg-white');
                stagingDot.classList.replace('border-blue-600', 'border-gray-300');
                stagingDot.classList.remove('border-[5px]');
                stagingDot.classList.add('border-2');
                
                termsBox.classList.remove('hidden');
            }
        }

        async function confirmRetrieval() {
            const btn = document.getElementById('confirm-retrieval-btn');
            btn.disabled = true;
            btn.textContent = 'Submitting Request...';

            try {
                const { data, error } = await supabase.rpc('request_staging', {
                    p_tote_ids: Array.from(selectedItems),
                    p_fulfillment_type: retrievalLogisticsType
                });
                if (error) throw error;

                closeRetrievalModal();

                if (retrievalLogisticsType === 'valet_delivery') {
                    showToast('Valet delivery requested successfully!');
                } else {
                    // Show PIN modal for self-service
                    document.getElementById('pin-display').textContent = data.pin;
                    document.getElementById('pin-modal').classList.remove('hidden');
                }

                selectedItems.clear();
                updateActionBar();
            } catch (err) {
                console.error('Staging request failed:', err);
                alert('Request failed: ' + (err.message || 'Please try again.'));
            } finally {
                btn.disabled = false;
                btn.textContent = 'Confirm Request';
            }
        }

        function closeModal() {
            document.getElementById('pin-modal').classList.add('hidden');
        }

        function handleSignOut() {
            clearUserCache();
            supabase.auth.signOut().then(() => {
                window.location.href = 'index.html';
            });
        }

        // ============================================================
        // Add Totes Panel Logic
        // ============================================================
        function openAddTotesPanel() {
            const panel = document.getElementById('add-totes-panel');
            const overlay = document.getElementById('add-totes-overlay');
            panel.classList.remove('translate-x-full');
            overlay.classList.remove('hidden');
            additionalToteCount = 1;
            document.getElementById('add-totes-count').value = 1;
            updateAddTotesPreview();
        }

        function closeAddTotesPanel() {
            document.getElementById('add-totes-panel').classList.add('translate-x-full');
            document.getElementById('add-totes-overlay').classList.add('hidden');
        }

        function handleAddTotesInput() {
            const input = document.getElementById('add-totes-count');
            let val = parseInt(input.value) || 1;
            if (val < 1) val = 1;
            if (val > 100) val = 100;
            input.value = val;
            additionalToteCount = val;
            updateAddTotesPreview();
        }

        function setAddTotesVal(val) {
            document.getElementById('add-totes-count').value = val;
            additionalToteCount = val;
            updateAddTotesPreview();
        }

        function updateAddTotes(delta) {
            additionalToteCount = Math.max(1, Math.min(100, additionalToteCount + delta));
            document.getElementById('add-totes-count').value = additionalToteCount;
            updateAddTotesPreview();
        }

        function showToast(message) {
            const toast = document.getElementById('toast');
            const toastMsg = document.getElementById('toast-msg');
            if (toastMsg) {
                toastMsg.textContent = message;
            }
            if (toast) {
                toast.classList.remove('translate-y-20', 'opacity-0');
                setTimeout(() => {
                    toast.classList.add('translate-y-20', 'opacity-0');
                }, 3500);
            }
        }

        // ============================================================
        // Developer Test Console HUD Logic
        // ============================================================
        function toggleDevConsole() {
            const content = document.getElementById('dev-console-content');
            const arrow = document.getElementById('dev-console-arrow');
            if (content.classList.contains('hidden')) {
                content.classList.remove('hidden');
                arrow.textContent = 'â–²';
            } else {
                content.classList.add('hidden');
                arrow.textContent = 'â–¼';
            }
        }

        async function runSimulateOnboarding(btn) {
            if (btn) {
                btn.disabled = true;
                btn.textContent = 'Processing...';
            }
            showToast("Simulating onboarding setup...");
            try {
                const { data, error } = await supabase.rpc('simulate_onboarding_complete');
                if (error) throw error;
                showToast(`Setup complete! Loaded ${data.totesActivated} inventory totes.`);
            } catch (err) {
                console.error("Simulation failed:", err);
                alert("Simulation failed: " + err.message);
            } finally {
                if (btn) {
                    btn.disabled = false;
                    btn.textContent = 'Onboard & Load Totes';
                }
            }
        }

        async function updateTotesHeldSim(amount) {
            if (!currentUser) return;
            try {
                const { error } = await supabase.rpc('update_totes_held_sim', { p_amount: amount });
                if (error) throw error;
                showToast("Simulated totes held count update.");
            } catch (err) {
                console.error("Failed to update active totes held:", err);
            }
        }

        async function returnAllTotesSim() {
            if (!currentUser) return;
            try {
                const { error } = await supabase.rpc('return_all_totes_sim');
                if (error) throw error;
                showToast("Simulated return of all totes.");
            } catch (err) {
                console.error("Failed to reset totes:", err);
            }
        }

        async function runCancelSubscription(btn) {
            if (btn) {
                btn.disabled = true;
                btn.textContent = 'Processing...';
            }
            const simulateExpiry = document.getElementById('dev-simulate-expiry').checked;
            showToast("Processing cancellation...");
            try {
                const { data, error } = await supabase.rpc('cancel_subscription', { p_simulate_expiry: simulateExpiry });
                if (error) throw error;
                showToast(`Cancelled! Totes at cancellation: ${data.totesHeld}. Deadline: ${new Date(data.deadline).toLocaleTimeString()}`);
            } catch (err) {
                console.error("Cancellation failed:", err);
                alert("Cancellation failed: " + err.message);
            } finally {
                if (btn) {
                    btn.disabled = false;
                    btn.textContent = 'Cancel Subscription';
                }
            }
        }

        async function runBillingAuditTrigger(btn) {
            if (btn) {
                btn.disabled = true;
                btn.textContent = 'Processing...';
            }
            showToast("Running billing audit task...");
            try {
                const { data, error } = await supabase.rpc('trigger_tote_audit_test');
                if (error) throw error;
                const processed = data.processed || [];
                if (processed.length === 0) {
                    showToast("Audit run complete: 0 accounts expired.");
                } else {
                    const summary = processed.map(p => `User ${p.uid.substring(0, 6)}: billed $${p.charged.toFixed(2)} (${p.unreturnedTotes} unreturned)`).join('\n');
                    alert(`Audit Job Succeeded!\n\n${summary}`);
                }
            } catch (err) {
                console.error("Audit trigger failed:", err);
                alert("Audit failed: " + err.message);
            } finally {
                if (btn) {
                    btn.disabled = false;
                    btn.textContent = 'Run Audit Job Now';
                }
            }
        }

        // ============================================================
        // User Cancellation Flow Modal
        // ============================================================
        function triggerCancelFlowUser() {
            if (!currentUser) return;
            
            let totesHeld = 0;
            const cachedProfile = sessionStorage.getItem(`cv_user_${currentUser.id}`);
            if (cachedProfile) {
                const profile = JSON.parse(cachedProfile);
                totesHeld = profile.active_totes_held || 0;
            }
            
            document.getElementById('cancel-totes-count-modal').textContent = totesHeld;
            document.getElementById('cancel-modal').classList.remove('hidden');
        }

        function closeCancelModal() {
            document.getElementById('cancel-modal').classList.add('hidden');
        }

        async function confirmCancelSubscriptionFlow() {
            const btn = document.getElementById('confirm-cancel-btn');
            btn.disabled = true;
            btn.textContent = 'Processing...';
            const simulateExpiry = document.getElementById('user-cancel-simulate-expiry').checked;
            try {
                const { error } = await supabase.rpc('cancel_subscription', { p_simulate_expiry: simulateExpiry });
                if (error) throw error;
                closeCancelModal();
                showToast("Your subscription has been cancelled.");
            } catch (err) {
                console.error("Cancellation failed:", err);
                alert("Failed to cancel subscription: " + err.message);
            } finally {
                btn.disabled = false;
                btn.textContent = 'Confirm Cancel';
            }
        }
        // ============================================================
        // Dropdown & Modals
        // ============================================================
        function toggleDropdown() {
            document.getElementById('user-dropdown').classList.toggle('hidden');
        }

        window.addEventListener('click', function(e) {
            const avatar = document.getElementById('user-avatar');
            const dropdown = document.getElementById('user-dropdown');
            if (avatar && dropdown) {
                if (!avatar.contains(e.target) && !dropdown.contains(e.target)) {
                    dropdown.classList.add('hidden');
                }
            }
        });

        function openSettingsModal() {
            document.getElementById('user-dropdown').classList.add('hidden');
            document.getElementById('settings-modal').classList.remove('hidden');
            if (currentUserColor) selectColor(currentUserColor);
        }
        function closeSettingsModal() {
            document.getElementById('settings-modal').classList.add('hidden');
        }

        let tempColor = 'blue';
        function selectColor(color) {
            tempColor = color;
            const colors = ['blue', 'green', 'purple', 'rose', 'orange'];
            colors.forEach(c => {
                const btn = document.getElementById('color-' + c);
                if (c === color) {
                    btn.classList.add('border-' + c + '-600');
                    btn.classList.remove('border-transparent');
                    btn.innerHTML = 'âœ“';
                } else {
                    btn.classList.remove('border-' + c + '-600');
                    btn.classList.add('border-transparent');
                    btn.innerHTML = '';
                }
            });
        }

        async function saveProfileColor() {
            const btn = document.getElementById('save-color-btn');
            btn.disabled = true;
            btn.textContent = 'Saving...';
            try {
                const { error } = await supabase.from('users').update({ avatar_color: tempColor }).eq('id', currentUser.id);
                if (error) throw error;
                currentUserColor = tempColor;
                applyAvatarColor(currentUserColor);
                closeSettingsModal();
                showToast("Profile color updated!");
            } catch (err) {
                console.error("Failed to update color", err);
                alert("Failed to update color: " + err.message);
            } finally {
                btn.disabled = false;
                btn.textContent = 'Save Changes';
            }
        }

        function applyAvatarColor(color) {
            if (!color) color = 'blue';
            const avatar = document.getElementById('user-avatar');
            avatar.className = 'w-10 h-10 rounded-full flex items-center justify-center font-bold text-sm cursor-pointer select-none border-2 border-transparent transition ' + 
                (color === 'blue' ? 'bg-blue-100 text-blue-600 hover:border-blue-300' :
                 color === 'green' ? 'bg-green-100 text-green-600 hover:border-green-300' :
                 color === 'purple' ? 'bg-purple-100 text-purple-600 hover:border-purple-300' :
                 color === 'rose' ? 'bg-rose-100 text-rose-600 hover:border-rose-300' :
                 'bg-orange-100 text-orange-600 hover:border-orange-300');
        }

        function openBillingModal() {
            document.getElementById('user-dropdown').classList.add('hidden');
            document.getElementById('billing-modal').classList.remove('hidden');
            
            const nextDateEl = document.getElementById('billing-next-date');
            nextDateEl.textContent = 'Loading...';
            
            supabase.from('subscriptions').select('current_period_end').eq('uid', currentUser.id).eq('status', 'active').single().then(({data, error}) => {
                if (error || !data) {
                    nextDateEl.textContent = 'Unavailable';
                } else {
                    const d = new Date(data.current_period_end);
                    nextDateEl.textContent = d.toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' });
                }
            });
        }
        function closeBillingModal() {
            document.getElementById('billing-modal').classList.add('hidden');
        }
    
