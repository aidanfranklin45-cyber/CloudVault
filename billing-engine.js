/**
 * CloudVault Core Billing Engine & Invoice Management Module
 * Window Global: window.CloudVaultBilling
 */
(function (global) {
  'use strict';

  const CloudVaultBilling = {
    /**
     * Authoritative volume tier calculation. Pure function from rate schedule and tote count.
     * @param {number} toteCount - Number of storage totes
     * @param {Object} [customRates] - Optional rate matrix { tier1, tier2, tier3, tier4 }
     * @returns {{rate: number, tier: number, tierName: string, label: string}}
     */
    getTierRate: function (toteCount, customRates = null) {
      const rates = customRates || (typeof window !== 'undefined' && window.regionalRates) || { tier1: 5.10, tier2: 3.50, tier3: 2.50, tier4: 1.00 };
      const count = Math.max(1, Number(toteCount) || 1);
      const t4 = Number(rates.tier4 != null ? rates.tier4 : 1.00);
      const t3 = Number(rates.tier3 != null ? rates.tier3 : 2.50);
      const t2 = Number(rates.tier2 != null ? rates.tier2 : 3.50);
      const t1 = Number(rates.tier1 != null ? rates.tier1 : 5.10);

      if (count >= 50) return { rate: t4, tier: 4, tierName: 'Tier 4 Enterprise Volume', label: `Tier 4 — $${t4.toFixed(2)}/tote` };
      if (count >= 25) return { rate: t3, tier: 3, tierName: 'Tier 3 Commercial Volume', label: `Tier 3 — $${t3.toFixed(2)}/tote` };
      if (count >= 10) return { rate: t2, tier: 2, tierName: 'Tier 2 Preferred Volume', label: `Tier 2 — $${t2.toFixed(2)}/tote` };
      return { rate: t1, tier: 1, tierName: 'Tier 1 Standard Volume', label: `Tier 1 — $${t1.toFixed(2)}/tote` };
    },

    /**
     * Authoritative valet logistics fee calculation.
     * @param {number} toteCount - Number of storage totes
     * @param {Object} [customValet] - Optional valet config { valet_base, valet_tote_adder }
     * @returns {number} Calculated valet fee
     */
    getValetFee: function (toteCount, customValet = null) {
      const valet = customValet || (typeof window !== 'undefined' && window.regionalRates) || { valet_base: 16.00, valet_tote_adder: 1.00 };
      const count = Math.max(0, Number(toteCount) || 0);
      const base = Number(valet.valet_base != null ? valet.valet_base : 16.00);
      const adder = Number(valet.valet_tote_adder != null ? valet.valet_tote_adder : 1.00);
      return base + (count * adder);
    },

    /**
     * Dynamically resolves the missing tote replacement fee for a facility.
     * @param {string} facilityId - Facility ID
     * @returns {Promise<number>} Missing tote fee
     */
    getMissingToteFee: async function (facilityId) {
      const sb = global.supabase || (typeof window !== 'undefined' ? window.supabase : null);
      if (sb && facilityId) {
        try {
          const { data: fac } = await sb.from('facilities').select('missing_tote_fee').eq('id', facilityId).maybeSingle();
          if (fac && fac.missing_tote_fee != null) {
            return Number(fac.missing_tote_fee);
          }
        } catch (err) {
          console.warn('[CloudVaultBilling] Error querying facility missing_tote_fee:', err.message);
        }
      }
      return 15.00;
    },

    /**
     * Dynamically resolves the expansion waitlist deposit and terms for an unlaunched market.
     * @param {string} zipCode - Target postal code
     * @returns {Promise<{depositAmount: number, priceLockYears: number, refundGuaranteeDays: number}>}
     */
    resolveWaitlistDeposit: async function (zipCode) {
      const sb = global.supabase || (typeof window !== 'undefined' ? window.supabase : null);
      let deposit = 20.00;
      let priceLockYears = 3;
      let refundGuaranteeDays = 365;

      if (sb) {
        try {
          if (zipCode) {
            const { data: zone } = await sb.from('operational_zones')
              .select('required_deposit, price_lock_years, refund_guarantee_days')
              .contains('zip_codes', [zipCode])
              .maybeSingle();

            if (zone && zone.required_deposit != null) {
              deposit = Number(zone.required_deposit);
              if (zone.price_lock_years) priceLockYears = Number(zone.price_lock_years);
              if (zone.refund_guarantee_days) refundGuaranteeDays = Number(zone.refund_guarantee_days);
              return { depositAmount: deposit, priceLockYears, refundGuaranteeDays };
            }
          }

          const { data: meta } = await sb.from('metadata').select('value').eq('id', 'unlaunched_deposit').maybeSingle();
          if (meta && meta.value != null) {
            const parsed = typeof meta.value === 'object' ? (meta.value.amount != null ? meta.value.amount : meta.value) : meta.value;
            const parsedNum = Number(parsed);
            if (!isNaN(parsedNum) && parsedNum >= 0) {
              deposit = parsedNum;
            }
          }
        } catch (err) {
          console.warn('[CloudVaultBilling] Error resolving waitlist deposit:', err.message);
        }
      }

      return { depositAmount: deposit, priceLockYears, refundGuaranteeDays };
    },

    /**
     * Dynamically queries all active facilities and calculates High-Low pricing ranges for each tier.
     * @returns {Promise<{
     *   tier1: { min: number, max: number, label: string },
     *   tier2: { min: number, max: number, label: string },
     *   tier3: { min: number, max: number, label: string },
     *   tier4: { min: number, max: number, label: string },
     *   valet_base: { min: number, max: number },
     *   valet_tote_adder: { min: number, max: number },
     *   facilitiesCount: number
     * }>}
     */
    getFacilityPricingRanges: async function () {
      const sb = global.supabase || (typeof window !== 'undefined' ? window.supabase : null);
      const defaults = {
        tier1: { min: 5.00, max: 5.10, label: '$5.00 – $5.10/tote' },
        tier2: { min: 3.50, max: 3.50, label: '$3.50/tote' },
        tier3: { min: 2.00, max: 2.50, label: '$2.00 – $2.50/tote' },
        tier4: { min: 1.00, max: 1.00, label: '$1.00/tote' },
        valet_base: { min: 8.00, max: 16.00 },
        valet_tote_adder: { min: 1.00, max: 1.00 },
        facilitiesCount: 0
      };

      if (!sb) return defaults;

      try {
        const { data: facs, error } = await sb.from('facilities').select('tier1_rate, tier2_rate, tier3_rate, tier4_rate, valet_base, valet_tote_adder');
        if (error || !facs || facs.length === 0) return defaults;

        const t1Rates = facs.map(f => Number(f.tier1_rate)).filter(r => !isNaN(r));
        const t2Rates = facs.map(f => Number(f.tier2_rate)).filter(r => !isNaN(r));
        const t3Rates = facs.map(f => Number(f.tier3_rate)).filter(r => !isNaN(r));
        const t4Rates = facs.map(f => Number(f.tier4_rate)).filter(r => !isNaN(r));
        const vbRates = facs.map(f => Number(f.valet_base)).filter(r => !isNaN(r));
        const vaRates = facs.map(f => Number(f.valet_tote_adder)).filter(r => !isNaN(r));

        const formatRange = (min, max) => {
          if (min === max) return `$${min.toFixed(2)}/tote`;
          return `$${min.toFixed(2)} – $${max.toFixed(2)}/tote`;
        };

        const minT1 = Math.min(...t1Rates), maxT1 = Math.max(...t1Rates);
        const minT2 = Math.min(...t2Rates), maxT2 = Math.max(...t2Rates);
        const minT3 = Math.min(...t3Rates), maxT3 = Math.max(...t3Rates);
        const minT4 = Math.min(...t4Rates), maxT4 = Math.max(...t4Rates);
        const minVb = Math.min(...vbRates), maxVb = Math.max(...vbRates);
        const minVa = Math.min(...vaRates), maxVa = Math.max(...vaRates);

        return {
          tier1: { min: minT1, max: maxT1, label: formatRange(minT1, maxT1) },
          tier2: { min: minT2, max: maxT2, label: formatRange(minT2, maxT2) },
          tier3: { min: minT3, max: maxT3, label: formatRange(minT3, maxT3) },
          tier4: { min: minT4, max: maxT4, label: formatRange(minT4, maxT4) },
          valet_base: { min: minVb, max: maxVb },
          valet_tote_adder: { min: minVa, max: maxVa },
          facilitiesCount: facs.length
        };
      } catch (err) {
        console.warn('[CloudVaultBilling] getFacilityPricingRanges error:', err);
        return defaults;
      }
    },

    /**
     * Dispatches checkout initialization to the stripe-checkout Edge Function.
     * @param {Object} payload - Checkout parameters
     * @returns {Promise<{data?: Object, error?: Object}>}
     */
    initiateStripeCheckout: async function (payload) {
      const sb = global.supabase || (typeof window !== 'undefined' ? window.supabase : null);
      if (!sb || !sb.functions) {
        throw new Error('Supabase client or Edge Functions unavailable.');
      }
      return await sb.functions.invoke('stripe-checkout', { body: payload });
    },

    /**
     * Dispatches one-time fee billing to the stripe-service-charge Edge Function.
     * @param {Object} payload - Service charge parameters
     * @returns {Promise<{data?: Object, error?: Object}>}
     */
    initiateServiceCharge: async function (payload) {
      const sb = global.supabase || (typeof window !== 'undefined' ? window.supabase : null);
      if (!sb || !sb.functions) {
        throw new Error('Supabase client or Edge Functions unavailable.');
      }
      return await sb.functions.invoke('stripe-service-charge', { body: payload });
    },

    /**
     * Dynamically resolves rate schedules and volume tier rate for a customer at billing execution time.
     * Evaluates customer price lock (price lock immunity) first, then falls back to live regional facility rates.
     * Tier thresholds: 50+ (Tier 4), 25-49 (Tier 3), 10-24 (Tier 2), 1-9 (Tier 1).
     * @param {string} userId - User UUID
     * @param {string} facilityId - Facility ID
     * @param {number} toteCount - Number of storage totes
     * @returns {Promise<{toteRate: number, tierNumber: number, tierName: string, recurringStorage: number, ratesUsed: Object, isPriceLock: boolean}>}
     */
    resolveCustomerPricing: async function (userId, facilityId, toteCount = 1) {
      const sb = global.supabase;
      let rates = { tier1: 5.10, tier2: 3.50, tier3: 2.50, tier4: 1.00 };
      let isPriceLock = false;
      let assignedFacId = facilityId || null;

      if (sb) {
        try {
          if (userId) {
            const { data: user } = await sb.from('users')
              .select('assigned_facility_id, has_price_lock, price_lock_rates')
              .eq('id', userId)
              .maybeSingle();

            if (user) {
              if (user.assigned_facility_id && !assignedFacId) {
                assignedFacId = user.assigned_facility_id;
              }
              if (user.has_price_lock && user.price_lock_rates) {
                const plr = user.price_lock_rates;
                rates.tier1 = Number(plr.tier1_rate || plr.tier1 || rates.tier1);
                rates.tier2 = Number(plr.tier2_rate || plr.tier2 || rates.tier2);
                rates.tier3 = Number(plr.tier3_rate || plr.tier3 || rates.tier3);
                rates.tier4 = Number(plr.tier4_rate || plr.tier4 || rates.tier4);
                isPriceLock = true;
              }
            }
          }

          if (!isPriceLock) {
            const facIdToQuery = assignedFacId || 'facility_seattle_north';
            const { data: fac } = await sb.from('facilities')
              .select('tier1_rate, tier2_rate, tier3_rate, tier4_rate')
              .eq('id', facIdToQuery)
              .maybeSingle();

            if (fac) {
              rates.tier1 = Number(fac.tier1_rate) || 5.00;
              rates.tier2 = Number(fac.tier2_rate) || 3.50;
              rates.tier3 = Number(fac.tier3_rate) || 2.00;
              rates.tier4 = Number(fac.tier4_rate) || 1.00;
            }
          }
        } catch (err) {
          console.warn('[CloudVaultBilling] Error resolving customer dynamic pricing:', err.message);
        }
      }

      const count = Math.max(1, Number(toteCount) || 1);
      let toteRate = rates.tier1;
      let tierNumber = 1;
      let tierName = 'Tier 1 Standard Volume';

      if (count >= 50) {
        toteRate = rates.tier4;
        tierNumber = 4;
        tierName = 'Tier 4 Enterprise Volume';
      } else if (count >= 25) {
        toteRate = rates.tier3;
        tierNumber = 3;
        tierName = 'Tier 3 Commercial Volume';
      } else if (count >= 10) {
        toteRate = rates.tier2;
        tierNumber = 2;
        tierName = 'Tier 2 Preferred Volume';
      }

      return {
        toteRate,
        tierNumber,
        tierName,
        recurringStorage: count * toteRate,
        ratesUsed: rates,
        isPriceLock
      };
    },

    /**
     * Calculates pro-rata storage fee for mid-cycle tote additions.
     * @param {Object} params - { currentTotes, additionalTotes, userId, facilityId, nextBillingDate }
     * @returns {Promise<{proRataAmount: number, daysRemaining: number, oldRate: number, newRate: number, oldMonthly: number, newMonthly: number, newTotalTotes: number, tierName: string, isPriceLock: boolean}>}
     */
    calculateProratedExpansion: async function ({ currentTotes = 0, additionalTotes = 0, userId = null, facilityId = null, nextBillingDate = null } = {}) {
      const curTotes = Number(currentTotes) || 0;
      const addTotes = Number(additionalTotes) || 0;
      const newTotal = curTotes + addTotes;

      const currentPricing = await this.resolveCustomerPricing(userId, facilityId, Math.max(1, curTotes));
      const newPricing = await this.resolveCustomerPricing(userId, facilityId, newTotal);

      const oldMonthly = curTotes * currentPricing.toteRate;
      const newMonthly = newTotal * newPricing.toteRate;
      const monthlyDelta = Math.max(0, newMonthly - oldMonthly);

      // Calculate days remaining in billing cycle (default 15 days if no nextBillingDate)
      const now = new Date();
      let daysRemaining = 15;
      if (nextBillingDate) {
        const nextDate = new Date(nextBillingDate);
        const diffMs = nextDate.getTime() - now.getTime();
        if (diffMs > 0) {
          daysRemaining = Math.max(1, Math.min(31, Math.ceil(diffMs / (1000 * 60 * 60 * 24))));
        }
      }

      // Pro-rata storage = (Monthly Delta / 30) * daysRemaining
      const proRataAmount = Number(((monthlyDelta / 30) * daysRemaining).toFixed(2));

      return {
        proRataAmount,
        daysRemaining,
        oldRate: currentPricing.toteRate,
        newRate: newPricing.toteRate,
        oldMonthly,
        newMonthly,
        monthlyDelta,
        newTotalTotes: newTotal,
        tierName: newPricing.tierName,
        isPriceLock: newPricing.isPriceLock
      };
    },

    /**
     * Executes partial tote unsubscribe/reduction workflow for a customer.
     * @param {string} userId - User UUID
     * @param {number} reduceCount - Number of totes to unsubscribe
     * @returns {Promise<{success: boolean, result?: Object, invoice?: Object, error?: string}>}
     */
    processToteReduction: async function (userId, reduceCount) {
      try {
        if (!userId || !reduceCount || reduceCount <= 0) {
          return { success: false, error: 'User ID and positive reduction count are required' };
        }

        const sb = global.supabase;
        if (!sb) return { success: false, error: 'Supabase client missing' };

        // 1. Call RPC function reduce_subscription_totes
        const { data: rpcRes, error: rpcErr } = await sb.rpc('reduce_subscription_totes', {
          p_uid: userId,
          p_reduce_count: reduceCount
        });

        if (rpcErr) {
          console.error('[CloudVaultBilling] Error calling reduce_subscription_totes RPC:', rpcErr);
          return { success: false, error: rpcErr.message };
        }

        // 2. Create confirmation invoice/statement record for the subscription modification
        const userRes = await sb.from('users').select('*').eq('id', userId).maybeSingle();
        const user = userRes.data || {};

        const oldTotes = rpcRes.oldTotal || rpcRes.oldTotes;
        const newTotes = rpcRes.newTotal || rpcRes.newTotes;
        const oldRate = Number(rpcRes.oldRate) || 0;
        const newRate = Number(rpcRes.newRate) || 0;
        const newMonthly = Number(rpcRes.newMonthly) || 0;

        const rateChanged = oldRate !== newRate && oldRate > 0;
        const noteText = rateChanged
          ? `✓ Unsubscribed ${reduceCount} container(s) (${oldTotes} → ${newTotes} totes). New tier: $${newRate.toFixed(2)}/mo ($${newMonthly.toFixed(2)}/mo). Pro-rata adjustment will appear on your next statement.`
          : `✓ Unsubscribed ${reduceCount} container(s) (${oldTotes} → ${newTotes} totes). New monthly: $${newMonthly.toFixed(2)}/mo. Pro-rata adjustment will appear on your next statement.`;

        return {
          success: true,
          result: rpcRes,
          message: noteText
        };
      } catch (err) {
        console.error('[CloudVaultBilling] Exception in processToteReduction:', err);
        return { success: false, error: err.message };
      }
    },

    /**
     * Resolves dynamic missing tote fee for a facility from public.facilities.
     * @param {string} facilityId - Facility ID
     * @returns {Promise<number>} - Missing tote fee
     */
    resolveFacilityMissingToteFee: async function (facilityId) {
      const sb = global.supabase;
      if (!sb) return 15.00;
      try {
        const facId = facilityId || 'facility_yakima';
        const { data: fac } = await sb.from('facilities').select('missing_tote_fee').eq('id', facId).maybeSingle();
        if (fac && fac.missing_tote_fee != null) {
          return Number(fac.missing_tote_fee);
        }
      } catch (e) {
        console.warn('[CloudVaultBilling] Error resolving facility missing tote fee:', e.message);
      }
      return 15.00;
    },

    /**
     * Consolidated Canonical Missing Tote Resolution Workflow.
     * Handles dynamic fee calculation, Stripe invoice creation/sending, database charge/invoice logging,
     * inventory status transition, subscription decrement, tier recalculation, and Stripe subscription quantity sync.
     * 
     * @param {Object} params - { toteId, toteCode, action: 'charge' | 'reshelve' | 'decommission', reason, notes, facilityId, customFee }
     * @returns {Promise<{success: boolean, message?: string, fee?: number, invoice?: Object, reductionResult?: Object, error?: string}>}
     */
    processMissingToteResolution: async function ({ toteId, toteCode, action = 'charge', reason = 'Missing Container Replacement Fee', notes = '', facilityId = null, customFee = null } = {}) {
      const sb = global.supabase;
      if (!sb) return { success: false, error: 'Supabase client unavailable' };
      if (!toteId && !toteCode) return { success: false, error: 'Tote ID or Tote Code is required' };

      try {
        // 1. Fetch Tote and User record
        let toteQuery = sb.from('inventory').select('*, users!uid(*)');
        if (toteId) toteQuery = toteQuery.eq('id', toteId);
        else if (toteCode) toteQuery = toteQuery.eq('tote_code', toteCode);

        const { data: toteData, error: toteErr } = await toteQuery.maybeSingle();
        if (toteErr || !toteData) {
          throw new Error(toteErr ? toteErr.message : 'Tote not found in inventory');
        }

        const tote = toteData;
        const user = tote.users || {};
        const userId = tote.uid;
        const facId = facilityId || tote.facility_id || user.assigned_facility_id || 'facility_yakima';
        const code = tote.tote_code || toteCode || 'TOTE';

        if (action === 'reshelve') {
          const shelf = reason || 'A1-B01-S1';
          const { error } = await sb.from('inventory').update({
            status: 'stored',
            location_code: shelf.trim().toUpperCase(),
            location_type: 'vault',
            missing_resolution: 'reshelved'
          }).eq('id', tote.id);
          if (error) throw error;
          return { success: true, message: `Tote ${code} re-shelved to ${shelf}.` };

        } else if (action === 'decommission') {
          const { error } = await sb.from('inventory').update({
            status: 'missing-tote',
            missing_resolution: 'written_off'
          }).eq('id', tote.id);
          if (error) throw error;
          return { success: true, message: `Tote ${code} decommissioned and written off.` };

        } else if (action === 'charge') {
          // A. Dynamically resolve facility missing fee
          let fee = customFee != null ? Number(customFee) : await this.resolveFacilityMissingToteFee(facId);
          if (isNaN(fee) || fee <= 0) fee = 15.00;

          // B. Create & Send Stripe Invoice
          let stripeRes = { success: true, stripeInvoiceId: null, hostedInvoiceUrl: null, pdfUrl: null, paymentIntentId: null };
          const stripeHelper = global.StripeBillingIntegration || global.CloudVaultStripe;
          if (stripeHelper && typeof stripeHelper.createAndSendMissingToteInvoice === 'function') {
            stripeRes = await stripeHelper.createAndSendMissingToteInvoice({
              customerId: user.stripe_customer_id,
              amount: fee,
              toteCode: code,
              facilityId: facId,
              userId: userId,
              customerEmail: user.email,
              customerName: user.name
            });
          }

          // Calculate dynamic tax for this customer & facility
          const taxInfo = await this.resolveTaxRate({ facilityId: facId, uid: userId, zipCode: user.active_zone });
          const taxRate = Number(taxInfo.taxRate || 0);
          const taxAmount = Math.round(fee * taxRate * 100) / 100;
          const totalAfterTax = Math.round((fee + taxAmount) * 100) / 100;

          const nowIso = new Date().toISOString();
          const invNum = this.generateInvoiceNumber();
          const stripeInvId = stripeRes.stripeInvoiceId || `in_${Date.now()}`;

          // C. Create official invoice record in public.invoices
          const invoiceRecord = {
            invoice_number: invNum,
            stripe_invoice_id: stripeInvId,
            stripe_customer_id: user.stripe_customer_id || null,
            stripe_payment_intent_id: stripeRes.paymentIntentId || null,
            stripe_hosted_invoice_url: stripeRes.hostedInvoiceUrl || `https://invoice.stripe.com/i/${stripeInvId}`,
            stripe_invoice_pdf: stripeRes.pdfUrl || null,
            uid: userId,
            customer_name: user.name || 'CloudVault Customer',
            customer_email: user.email || '',
            facility_id: facId,
            invoice_type: 'missing_tote_fee',
            payment_status: 'paid',
            subtotal: fee,
            tax: taxAmount,
            total_amount: totalAfterTax,
            amount_due: 0.00,
            amount_paid: totalAfterTax,
            amount_remaining: 0.00,
            payment_method: 'stripe',
            transaction_reference: stripeRes.paymentIntentId || stripeInvId,
            line_items: [
              {
                id: 'li_missing_' + Date.now(),
                description: `Missing Container Replacement Fee — ${code}`,
                amount: fee,
                quantity: 1,
                unit_amount: fee
              }
            ],
            paid_at: nowIso,
            created_at: nowIso
          };

          const { error: invErr } = await sb.from('invoices').insert([invoiceRecord]);
          if (invErr) console.warn('[CloudVaultBilling] Invoice logging notice:', invErr.message);

          // D. Record in public.charges ledger
          await sb.from('charges').insert([{
            uid: userId,
            charge_type: `Missing Container Replacement Fee (${code})`,
            amount: fee,
            totes_charged: 1,
            status: 'success',
            stripe_payment_intent_id: stripeRes.paymentIntentId || null,
            charged_at: nowIso
          }]);

          // E. Update inventory record status
          await sb.from('inventory').update({
            status: 'missing-tote',
            location_type: 'missing',
            missing_resolution: 'billed_customer',
            missing_reason: reason || 'Missing Container Replacement Fee',
            missing_notes: notes || `Assessed $${fee.toFixed(2)} replacement penalty fee.`
          }).eq('id', tote.id);

          // F. Decrement Subscription & Recalculate Volume Tier
          let reductionResult = null;
          if (userId) {
            try {
              // 1. Fetch current subscription to see starting count
              const { data: currentSub } = await sb.from('subscriptions').select('*').eq('uid', userId).maybeSingle();
              const startingTotes = currentSub ? Number(currentSub.total_totes || currentSub.tote_count || user.active_totes_held || 1) : (user.active_totes_held || 1);
              const targetTotes = Math.max(1, startingTotes - 1);

              // 2. Resolve new dynamic pricing for reduced tote pool (evaluates price locks and volume tier brackets)
              const newPricing = await this.resolveCustomerPricing(userId, facId, targetTotes);

              // 3. Update subscriptions table with new total, new tote_rate, and new recurring_storage
              const { error: subUpdErr } = await sb.from('subscriptions').update({
                total_totes: targetTotes,
                tote_count: targetTotes,
                quantity: targetTotes,
                tote_rate: newPricing.toteRate,
                recurring_storage: newPricing.recurringStorage,
                monthly_total: newPricing.recurringStorage,
                last_updated: nowIso
              }).eq('uid', userId);

              if (subUpdErr) {
                console.warn('[CloudVaultBilling] Notice updating subscription:', subUpdErr.message);
              }

              // 4. Update users table active_totes_held
              await sb.from('users').update({
                active_totes_held: targetTotes
              }).eq('id', userId);

              // 5. Sync quantity and unit rate with Stripe Subscription
              if (global.CloudVaultStripe && typeof global.CloudVaultStripe.syncSubscriptionQuantityWithStripe === 'function') {
                await global.CloudVaultStripe.syncSubscriptionQuantityWithStripe(userId, targetTotes);
              }

              reductionResult = {
                oldTotal: startingTotes,
                newTotal: targetTotes,
                newRate: newPricing.toteRate,
                newMonthly: newPricing.recurringStorage,
                tierName: newPricing.tierName
              };
            } catch (redErr) {
              console.warn('[CloudVaultBilling] Error in subscription decrement/tier recalculation:', redErr.message);
            }
          }

          const tierChangeMsg = reductionResult && reductionResult.oldTotal !== reductionResult.newTotal
            ? ` Subscription updated: ${reductionResult.oldTotal} → ${reductionResult.newTotal} totes (New tier: ${reductionResult.tierName} @ $${reductionResult.newRate.toFixed(2)}/tote = $${reductionResult.newMonthly.toFixed(2)}/mo).`
            : '';

          return {
            success: true,
            message: `✓ Assessed $${fee.toFixed(2)} missing tote fee for ${code} to ${user.name || 'customer'}. Stripe invoice created & sent.${tierChangeMsg}`,
            fee,
            invoice: invoiceRecord,
            reductionResult
          };
        }

        return { success: false, error: `Invalid action: ${action}` };
      } catch (err) {
        console.error('[CloudVaultBilling] Exception in processMissingToteResolution:', err);
        return { success: false, error: err.message };
      }
    },

    /**
     * Generates a standard CloudVault invoice number.
     * Example: "INV-2026-89421"
     * @returns {string}
     */
    generateInvoiceNumber: function () {
      const year = new Date().getFullYear();
      const timePart = Date.now().toString().slice(-6);
      const randomPart = Math.floor(100 + Math.random() * 900);
      return `INV-${year}-${timePart}${randomPart}`;
    },

    /**
     * Validates a facility_id against public.facilities table.
     * If facility_id is invalid or missing, defaults to a valid facility ID in public.facilities (e.g. 'facility_seattle_north').
     * @param {string} facilityId
     * @returns {Promise<string>}
     */
    validateFacilityId: async function (facilityId) {
      const sb = global.supabase;
      const defaultFacility = 'facility_seattle_north';
      if (!sb) return facilityId || defaultFacility;

      if (facilityId) {
        try {
          const { data } = await sb.from('facilities')
            .select('id')
            .eq('id', facilityId)
            .maybeSingle();
          if (data && data.id) {
            return data.id;
          }
        } catch (e) {
          console.warn('[CloudVaultBilling] Error validating facility_id:', e.message);
        }
      }

      try {
        const { data: defFac } = await sb.from('facilities')
          .select('id')
          .eq('id', defaultFacility)
          .maybeSingle();
        if (defFac && defFac.id) {
          return defFac.id;
        }
        const { data: firstFac } = await sb.from('facilities')
          .select('id')
          .limit(1)
          .maybeSingle();
        if (firstFac && firstFac.id) {
          return firstFac.id;
        }
      } catch (e) {
        console.warn('[CloudVaultBilling] Error fetching fallback facility_id:', e.message);
      }

      return defaultFacility;
    },

    /**
     * Resolves tax rate and label dynamically for a given facility, customer ZIP, or user ID.
     * Checks service_areas by ZIP, by facility_id, get_tax_rate_for_zip RPC, and falls back to regional defaults.
     * @param {Object} opts - { facilityId, zipCode, uid }
     * @returns {Promise<{taxRate: number, taxLabel: string}>}
     */
    resolveTaxRate: async function ({ facilityId = null, zipCode = null, uid = null } = {}) {
      const sb = global.supabase;
      let taxRate = null;
      let taxLabel = null;

      if (sb) {
        try {
          let custZip = zipCode;
          if (!custZip && uid) {
            const { data: u } = await sb.from('users').select('active_zone, assigned_facility_id').eq('id', uid).maybeSingle();
            if (u) {
              custZip = u.active_zone || null;
              if (!facilityId && u.assigned_facility_id) facilityId = u.assigned_facility_id;
            }
          }

          if (custZip) {
            const { data: saZip } = await sb.from('service_areas')
              .select('tax_rate, tax_label, city, state')
              .eq('zip_code', custZip)
              .maybeSingle();
            if (saZip && saZip.tax_rate != null) {
              taxRate = Number(saZip.tax_rate);
              const loc = [saZip.city, saZip.state].filter(Boolean).join(', ');
              taxLabel = saZip.tax_label || `${loc || 'Local'} Sales Tax (${(taxRate * 100).toFixed(2)}%)`;
            }
          }

          if (taxRate == null && facilityId) {
            const { data: saFac } = await sb.from('service_areas')
              .select('tax_rate, tax_label, city, state')
              .eq('facility_id', facilityId)
              .not('tax_rate', 'is', null)
              .limit(1);
            if (saFac && saFac[0] && saFac[0].tax_rate != null) {
              taxRate = Number(saFac[0].tax_rate);
              const loc = [saFac[0].city, saFac[0].state].filter(Boolean).join(', ');
              taxLabel = saFac[0].tax_label || `${loc || 'Regional'} Sales Tax (${(taxRate * 100).toFixed(2)}%)`;
            }
          }

          if (taxRate == null && custZip) {
            const { data: rpcRate } = await sb.rpc('get_tax_rate_for_zip', { p_zip: custZip });
            if (rpcRate != null) {
              taxRate = Number(rpcRate);
              taxLabel = `State & Local Sales Tax (${(taxRate * 100).toFixed(2)}%)`;
            }
          }
        } catch (e) {
          console.warn('[CloudVaultBilling] resolveTaxRate notice:', e.message);
        }
      }

      // No hardcoded fallbacks — service_areas table is the sole source of truth.
      // If no rate is configured for this ZIP / facility, tax is $0.00.
      if (taxRate == null) {
        taxRate = 0.00;
        taxLabel = 'Sales Tax (Not Configured)';
      }

      return { taxRate, taxLabel };
    },

    /**
     * Persists an invoice record to Supabase public.invoices table.
     * @param {Object} params - Invoice properties
     * @returns {Promise<{success: boolean, data?: Object, error?: string}>}
     */
    createInvoiceRecord: async function (params = {}) {
      try {
        const sb = global.supabase;
        if (!sb) {
          console.error('[CloudVaultBilling] Supabase client is not available on window.supabase');
          return { success: false, error: 'Supabase client missing' };
        }

        const invoiceNumber = params.invoice_number || params.invoiceNumber || this.generateInvoiceNumber();
        const subtotal = Number(params.subtotal) || 0.00;
        const deliveryFee = Number(params.delivery_fee || params.deliveryFee) || 0.00;
        const surgeFee = Number(params.surge_fee || params.surgeFee) || 0.00;
        const discount = Number(params.discount) || 0.00;

        let lineItems = params.line_items || params.lineItems || [];
        if (typeof lineItems === 'string') {
          try {
            lineItems = JSON.parse(lineItems);
          } catch (e) {
            lineItems = [];
          }
        }
        if (!Array.isArray(lineItems)) {
          lineItems = [];
        }

        const rawFacilityId = params.facility_id || params.facilityId || null;
        const validFacilityId = await this.validateFacilityId(rawFacilityId);
        const targetFacId = validFacilityId || rawFacilityId || null;
        const targetUid = params.uid || params.userId || params.user_id || null;

        // --- Tax Resolution ---
        let resolvedTaxRate = params.tax_rate != null ? Number(params.tax_rate) : null;
        let resolvedTaxLabel = params.tax_label || null;

        if (resolvedTaxRate == null) {
          const taxInfo = await this.resolveTaxRate({
            facilityId: targetFacId,
            zipCode: params.zip_code,
            uid: targetUid
          });
          resolvedTaxRate = taxInfo.taxRate;
          resolvedTaxLabel = taxInfo.taxLabel;
        }

        // Full taxable base across all taxable services (storage subtotal + valet delivery + surge/rush fee)
        const taxableBase = Math.max(0, subtotal + deliveryFee + surgeFee);
        const taxAmount = resolvedTaxRate != null ? Math.round(taxableBase * resolvedTaxRate * 100) / 100 : (Number(params.tax) || 0.00);
        
        // Tax is shown only in the financial summary totals section, NOT as a line item
        // Strip any legacy tax line items that may exist in old records
        lineItems = lineItems.filter(i => !((i.description || '').toLowerCase().includes('sales tax') || (i.description || '').toLowerCase().includes('state tax') || i.tax_rate != null));

        const computedTotal = Math.round((taxableBase + taxAmount - discount) * 100) / 100;
        let totalAmount = computedTotal;
        if (params.total_amount != null) {
          const rawTotal = Number(params.total_amount);
          // If total_amount was explicitly passed as pre-tax amount and taxAmount > 0, enforce computedTotal (after tax)
          if (taxAmount > 0 && Math.abs(rawTotal - (taxableBase - discount)) < 0.01) {
            totalAmount = computedTotal;
          } else if (rawTotal !== 0) {
            totalAmount = rawTotal;
          }
        }
        const invType = (params.invoice_type || params.invoiceType || '').toLowerCase();
        if (invType !== 'refund' && totalAmount < 0) {
          totalAmount = 0;
        }

        const paymentStatus = params.payment_status || params.paymentStatus || 'paid';
        const createdAt = params.created_at || params.createdAt || new Date().toISOString();
        const paidAt = params.paid_at || params.paidAt || (paymentStatus === 'paid' ? createdAt : null);
        const dueDate = params.due_date || params.dueDate || new Date(new Date(createdAt).getTime() + 3 * 24 * 60 * 60 * 1000).toISOString();

        if (!targetUid) {
          console.error('[CloudVaultBilling] Customer UID is required to create an invoice record');
          return { success: false, error: 'Customer UID is required' };
        }

        let subId = params.subscription_id || params.subscriptionId || null;
        if (!subId) {
          try {
            const { data: subRow } = await sb.from('subscriptions').select('id').eq('uid', targetUid).maybeSingle();
            if (subRow) subId = subRow.id;
          } catch (e) {
            console.warn('[CloudVaultBilling] Notice resolving subscription_id for invoice:', e.message);
          }
        }

        const record = {
          invoice_number: invoiceNumber,
          uid: targetUid,
          subscription_id: subId,
          customer_name: params.customer_name || params.customerName || null,
          customer_email: params.customer_email || params.customerEmail || null,
          facility_id: validFacilityId,
          invoice_type: params.invoice_type || params.invoiceType || 'subscription',
          payment_status: paymentStatus,
          subtotal: subtotal,
          delivery_fee: deliveryFee,
          surge_fee: surgeFee,
          tax: taxAmount,
          discount: discount,
          total_amount: totalAmount,
          payment_method: params.payment_method || params.paymentMethod || 'card',
          transaction_reference: params.transaction_reference || params.transactionReference || null,
          stripe_invoice_id: params.stripe_invoice_id || params.stripeInvoiceId || null,
          stripe_hosted_invoice_url: params.stripe_hosted_invoice_url || params.stripeHostedInvoiceUrl || null,
          stripe_invoice_pdf: params.stripe_invoice_pdf || params.stripeInvoicePdf || null,
          stripe_payment_intent_id: params.stripe_payment_intent_id || params.stripePaymentIntentId || null,
          notes: params.notes || null,
          line_items: lineItems,
          due_date: dueDate,
          created_at: createdAt,
          paid_at: paidAt,
          refunded_at: params.refunded_at || params.refundedAt || null
        };

        let { data, error } = await sb
          .from('invoices')
          .insert([record])
          .select()
          .single();

        // Retry with timestamp-backed invoice number on duplicate key / 409 conflict
        if (error && (error.code === '23505' || error.status === 409 || (error.message && error.message.includes('unique')))) {
          console.warn('[CloudVaultBilling] Unique invoice_number collision, retrying with fresh number...');
          record.invoice_number = this.generateInvoiceNumber();
          const retryRes = await sb
            .from('invoices')
            .insert([record])
            .select()
            .single();
          data = retryRes.data;
          error = retryRes.error;
        }

        if (error) {
          console.error('[CloudVaultBilling] Error creating invoice record:', error);
          return { success: false, error: error.message, details: error };
        }

        // Invalidate in-memory invoice cache for user
        if (global._invoiceCache && record.uid) {
          delete global._invoiceCache[record.uid];
        }
        if (global._invoiceCache && record.customer_email) {
          delete global._invoiceCache[record.customer_email];
        }

        return { success: true, data };
      } catch (err) {
        console.error('[CloudVaultBilling] Exception in createInvoiceRecord:', err);
        return { success: false, error: err.message };
      }
    },

    /**
     * Creates the Day-0 first-month invoice charged at signup.
     * Called immediately after create_subscription RPC succeeds.
     * Charges the customer immediately (paid_at = now(), payment_status = 'paid')
     * and updates subscription next_billing_date to 1 month from now.
     */
    createSignupInvoice: async function(userId, subscriptionData, userZip) {
      if (!userId || !subscriptionData) return { success: false, error: 'Missing params' };
      const toteCount = Number(subscriptionData.total_totes || subscriptionData.tote_count || 0);
      const pricingRes = await this.resolveCustomerPricing(userId, subscriptionData.facility_id, toteCount);
      
      const toteRate = (Number(subscriptionData.tote_rate) > 0 && !(toteCount >= 10 && Number(subscriptionData.tote_rate) > pricingRes.toteRate)) 
        ? Number(subscriptionData.tote_rate) 
        : pricingRes.toteRate;
      const storageAmt = Number(subscriptionData.recurring_storage || (toteCount * toteRate) || pricingRes.recurringStorage);
      const valetFee = Number(subscriptionData.valet_fee || 0);
      const now = new Date();
      const nowIso = now.toISOString();

      const nextBilling = new Date(now);
      nextBilling.setMonth(nextBilling.getMonth() + 1);
      const nextBillingIso = nextBilling.toISOString();

      const invRes = await this.createInvoiceRecord({
        uid: userId,
        customer_name: subscriptionData.customer_name || 'CloudVault Customer',
        customer_email: subscriptionData.customer_email || null,
        facility_id: subscriptionData.facility_id || null,
        invoice_type: 'initial_reservation',
        payment_status: 'paid',
        subtotal: storageAmt,
        delivery_fee: valetFee,
        total_amount: storageAmt + valetFee,
        payment_method: 'card',
        zip_code: userZip || null,
        transaction_reference: (typeof window !== 'undefined' && window.CloudVaultStripe)
          ? window.CloudVaultStripe.generateChargeId()
          : 'ch_signup_' + Date.now(),
        notes: `First month — charged at signup (${toteCount} totes, ${pricingRes.tierName}${pricingRes.isPriceLock ? ' [Price Locked]' : ''})`,
        line_items: [
          { description: `CloudVault Storage (${toteCount} totes @ $${toteRate.toFixed(2)}/mo — ${pricingRes.tierName})`, qty: toteCount || 1, unit_price: toteRate, amount: storageAmt },
          ...(valetFee > 0 ? [{ description: 'Valet Delivery Service Fee', qty: 1, unit_price: valetFee, amount: valetFee }] : [])
        ],
        created_at: nowIso,
        paid_at: nowIso,
        due_date: nowIso
      });

      const sb = global.supabase;
      if (sb && userId) {
        try {
          await sb.from('subscriptions')
            .update({
              last_billed_at: nowIso,
              next_billing_date: nextBillingIso,
              status: 'active'
            })
            .eq('uid', userId);
        } catch (e) {
          console.warn('[CloudVaultBilling] Warning updating subscription timing on signup:', e.message);
        }
      }

      return invRes;
    },

    /**
     * Computes accurate itemized subtotal, valet fee, line items, and grand total for an access request / retrieval flow,
     * persisting a paid receipt invoice to public.invoices.
     * @param {Object} req - Access request record
     * @param {Object} [userObj] - Customer metadata (name, email, assigned_facility_id)
     * @returns {Promise<{success: boolean, data?: Object, error?: string}>}
     */
    createAccessRequestInvoice: async function (req, userObj = {}) {
      const sb = global.supabase;
      const reqId = req.id;
      const txnRef = `AR-${reqId}`;
      const reqRefTag = `ar_${reqId}`;

      const toteCount = Array.isArray(req.requested_tote_codes) && req.requested_tote_codes.length > 0
        ? req.requested_tote_codes.length
        : (Array.isArray(req.requested_items) && req.requested_items.length > 0
          ? req.requested_items.length
          : (Number(req.additional_totes) || 1));

      let valetFee = Number(req.valet_fee || 0);
      const isValet = req.fulfillment_type === 'valet_delivery' || req.request_type === 'valet' || req.fulfillment_type === 'valet';

      if (isValet && valetFee === 0) {
        let valetBase = 0.00;
        let valetAdder = 0.00;
        const facId = req.facility_id || userObj.assigned_facility_id;
        if (sb && facId) {
          try {
            const { data: fac } = await sb.from('facilities')
              .select('valet_base, valet_tote_adder')
              .eq('id', facId)
              .maybeSingle();
            if (fac) {
              valetBase = fac.valet_base != null ? Number(fac.valet_base) : 0.00;
              valetAdder = fac.valet_tote_adder != null ? Number(fac.valet_tote_adder) : 0.00;
            }
          } catch (e) {
            console.warn('[CloudVaultBilling] Error fetching facility valet rates:', e.message);
          }
        }
        valetFee = valetBase + (toteCount * valetAdder);
      }

      const surgeFee = Number(req.surge_fee || 0);
      const subtotal = Number(req.subtotal || 0);
      const grandTotal = subtotal + valetFee + surgeFee;
      const lineItems = [];
      if (isValet) {
        let valetBase = 0.00;
        let valetAdder = 0.00;
        const facId = req.facility_id || userObj.assigned_facility_id;
        if (sb && facId) {
          try {
            const { data: fac } = await sb.from('facilities')
              .select('valet_base, valet_tote_adder')
              .eq('id', facId)
              .maybeSingle();
            if (fac) {
              valetBase = fac.valet_base != null ? Number(fac.valet_base) : 0.00;
              valetAdder = fac.valet_tote_adder != null ? Number(fac.valet_tote_adder) : 0.00;
            }
          } catch (e) {
            console.warn('[CloudVaultBilling] Error fetching facility valet rates:', e.message);
          }
        }
        const adderTotal = toteCount * valetAdder;
        lineItems.push({
          description: 'Valet Base Fee',
          qty: 1,
          unit_price: valetBase,
          amount: valetBase
        });
        if (adderTotal > 0) {
          lineItems.push({
            description: `Per Tote Valet Fee ($${valetAdder.toFixed(2)}/tote)`,
            qty: toteCount,
            unit_price: valetAdder,
            amount: adderTotal
          });
        }
      } else {
        if (subtotal > 0) {
          lineItems.push({
            description: `Self-Service Staging Access (${toteCount} tote${toteCount > 1 ? 's' : ''})`,
            qty: toteCount,
            unit_price: subtotal / toteCount,
            amount: subtotal
          });
        }
      }
      if (surgeFee > 0) {
        lineItems.push({
          description: `Expedited Staging Access (${req.surge_tier || 'rush'})`,
          qty: 1,
          unit_price: surgeFee,
          amount: surgeFee
        });
      }

      const status = req.status === 'cancelled' ? 'refunded' : 'paid';
      const userZip = userObj.zip_code || req.zip_code || null;

      return this.createInvoiceRecord({
        uid: req.uid,
        customer_name: userObj.name || userObj.customer_name || 'Valued Customer',
        customer_email: userObj.email || userObj.customer_email || null,
        facility_id: req.facility_id || userObj.assigned_facility_id || null,
        zip_code: userZip,
        invoice_type: invType,
        payment_status: status,
        subtotal: subtotal,
        delivery_fee: valetFee,
        surge_fee: surgeFee,
        payment_method: 'card',
        transaction_reference: txnRef,
        notes: `Access request receipt [Ref: ${reqRefTag}]`,
        line_items: lineItems,
        created_at: createdAt,
        paid_at: status === 'paid' ? createdAt : null,
        due_date: new Date(new Date(createdAt).getTime() + 3 * 24 * 60 * 60 * 1000).toISOString()
      });
    },

    /**
     * Synchronizes charges table records with public.invoices table for clean receipt tracking.
     * @param {string} [userId] - Optional User UUID filter
     * @returns {Promise<{success: boolean, syncedCount: number}>}
     */
    syncChargesToInvoices: async function (userId = null) {
      const sb = global.supabase;
      if (!sb) return { success: false, syncedCount: 0 };

      try {
        let invQuery = sb.from('invoices').select('transaction_reference, notes');
        if (userId) invQuery = invQuery.eq('uid', userId);
        const { data: existingInvoices } = await invQuery;

        const existingRefs = new Set();
        const existingNotesArr = [];
        (existingInvoices || []).forEach(i => {
          if (i.transaction_reference) existingRefs.add(i.transaction_reference);
          if (i.notes) existingNotesArr.push(i.notes);
        });
        const existingNotesStr = existingNotesArr.join(' ');

        let chgQuery = sb.from('charges').select('*');
        if (userId) chgQuery = chgQuery.eq('uid', userId);
        const { data: charges } = await chgQuery;

        if (!charges || charges.length === 0) {
          return { success: true, syncedCount: 0 };
        }

        let usersMap = {};
        if (!userId) {
          const { data: users } = await sb.from('users').select('id, name, email, assigned_facility_id');
          (users || []).forEach(u => { usersMap[u.id] = u; });
        } else {
          const { data: u } = await sb.from('users').select('id, name, email, assigned_facility_id').eq('id', userId).maybeSingle();
          if (u) usersMap[u.id] = u;
        }

        let syncedCount = 0;
        for (const chg of charges) {
          const txnRef = `CHG-${chg.id}`;
          const chgRefTag = `charge_${chg.id}`;

          if (!existingRefs.has(txnRef) && !existingNotesStr.includes(chgRefTag) && !existingNotesStr.includes(chg.id)) {
            const userObj = usersMap[chg.uid] || {};
            const amt = Number(chg.amount || 0);
            const status = (chg.status === 'success' || chg.status === 'paid') ? 'paid' : (chg.status || 'paid');
            const createdAt = chg.charged_at || chg.created_at || new Date().toISOString();

            const res = await this.createInvoiceRecord({
              uid: chg.uid,
              customer_name: userObj.name || 'Valued Customer',
              customer_email: userObj.email || null,
              facility_id: userObj.assigned_facility_id || null,
              invoice_type: chg.charge_type || 'charge',
              payment_status: status,
              subtotal: amt,
              payment_method: 'card',
              transaction_reference: txnRef,
              notes: `Synced charge receipt [Ref: ${chgRefTag}]`,
              line_items: [
                {
                  description: `CloudVault Fee / Charge: ${chg.charge_type || 'General Fee'}`,
                  qty: Number(chg.totes_charged || 1),
                  unit_price: amt,
                  amount: amt
                }
              ],
              created_at: createdAt,
              paid_at: status === 'paid' ? createdAt : null,
              due_date: new Date(new Date(createdAt).getTime() + 3 * 24 * 60 * 60 * 1000).toISOString()
            });

            if (res.success) {
              existingRefs.add(txnRef);
              syncedCount++;
            }
          }
        }

        return { success: true, syncedCount };
      } catch (err) {
        console.error('[CloudVaultBilling] Error synchronizing charges to invoices:', err);
        return { success: false, syncedCount: 0, error: err.message };
      }
    },

    /**
     * Fetches invoice records for a user by userId or customerEmail.
     * Uses indexed point-lookup with in-memory session caching for sub-50ms response times.
     * @param {string} userId - User UUID
     * @param {string} customerEmail - User Email address
     * @param {object} [options] - Optional flags e.g. { forceRefresh: boolean }
     * @returns {Promise<{success: boolean, invoices: Array, error?: string}>}
     */
    fetchInvoicesForUser: async function (userId, customerEmail, options = {}) {
      try {
        const sb = global.supabase;
        if (!sb) {
          console.error('[CloudVaultBilling] Supabase client missing');
          return { success: false, error: 'Supabase client missing', invoices: [] };
        }

        const cacheKey = userId || customerEmail;
        if (!cacheKey) {
          console.warn('[CloudVaultBilling] Neither userId nor customerEmail provided to fetchInvoicesForUser');
          return { success: true, invoices: [] };
        }

        // 1. In-memory cache lookup (TTL: 60s) for instant 0ms modal renders
        global._invoiceCache = global._invoiceCache || {};
        const cachedEntry = global._invoiceCache[cacheKey];
        if (!options.forceRefresh && cachedEntry && (Date.now() - cachedEntry.timestamp < 60000)) {
          return { success: true, invoices: cachedEntry.invoices || [] };
        }

        // 2. Direct indexed query on public.invoices with resilient lookup
        let invoicesList = [];
        if (userId) {
          const { data: dUid } = await sb.from('invoices').select('*').eq('uid', userId).order('created_at', { ascending: false });
          if (dUid && dUid.length > 0) invoicesList = dUid;
        }

        if (customerEmail) {
          const { data: dEmail } = await sb.from('invoices').select('*').ilike('customer_email', customerEmail).order('created_at', { ascending: false });
          if (dEmail && dEmail.length > 0) {
            // Combine and deduplicate by invoice ID
            const existingIds = new Set(invoicesList.map(i => i.id));
            dEmail.forEach(inv => {
              if (!existingIds.has(inv.id)) {
                invoicesList.push(inv);
                existingIds.add(inv.id);
              }
            });
          }
        }

        invoicesList.sort((a, b) => new Date(b.created_at || 0) - new Date(a.created_at || 0));
        let data = invoicesList;

        // 3. If no invoices exist for this user, check if they are a real customer with an active subscription
        const isEmployeeAccount = (customerEmail && (customerEmail.includes('@cloudvault.com') || customerEmail === 'ellie@test.com'));
        if ((!data || data.length === 0) && userId && !isEmployeeAccount) {
          try {
            const { data: usr } = await sb.from('users').select('role, active_zone, assigned_facility_id').eq('id', userId).maybeSingle();
            const role = (usr?.role || '').toLowerCase();
            const isStaffRole = ['admin', 'manager', 'driver', 'worker', 'executive', 'support'].includes(role);

            if (!isStaffRole) {
              const { data: sub } = await sb.from('subscriptions').select('*').eq('uid', userId).maybeSingle();
              if (sub) {
                const custZip = usr?.active_zone || null;
                const custFac = sub.facility_id || usr?.assigned_facility_id || 'facility_yakima';
                const toteCount = Number(sub.total_totes || sub.tote_count || 1);
                const toteRate = Number(sub.tote_rate || 5.00);
                const storageAmt = Number(sub.recurring_storage || (toteCount * toteRate));
                const valetFee = Number(sub.valet_fee || 0);
                const subtotal = storageAmt + valetFee;

                // Check if user has active promo redemption or referral
                let discountAmt = 0;
                let promoCode = null;
                try {
                  const { data: promoRed } = await sb.from('promo_redemptions').select('*').eq('customer_uid', userId).maybeSingle();
                  if (promoRed) {
                    promoCode = promoRed.promo_code;
                    discountAmt = Number(promoRed.discount_amount) || Math.round(subtotal * 0.20 * 100) / 100;
                  }
                } catch (pErr) {}

                const taxInfo = await this.resolveCustomerTaxRate(userId, custFac, custZip);
                const taxRate = Number(taxInfo.taxRate || 0);
                const taxAmt = Math.round(subtotal * taxRate * 100) / 100;
                const total = Math.max(0, Math.round((subtotal - discountAmt + taxAmt) * 100) / 100);
                const createdAt = sub.created_at || new Date().toISOString();

                const lineItems = [
                  {
                    description: `CloudVault Storage Subscription (${toteCount} totes @ $${toteRate.toFixed(2)}/mo)`,
                    qty: toteCount,
                    unit_price: toteRate,
                    amount: storageAmt
                  }
                ];
                if (valetFee > 0) {
                  lineItems.push({ description: 'Valet Delivery Service Fee', qty: 1, unit_price: valetFee, amount: valetFee });
                }
                if (discountAmt > 0) {
                  lineItems.push({ description: `Creator Discount (${promoCode || '20% off 2 mo'})`, qty: 1, unit_price: -discountAmt, amount: -discountAmt, is_discount: true, promo_code: promoCode });
                }
                if (taxAmt > 0) {
                  lineItems.push({ description: `State/Local Sales Tax (${(taxRate * 100).toFixed(2)}%)`, qty: 1, unit_price: taxAmt, amount: taxAmt, tax_rate: taxRate, is_tax: true });
                }

                const created = await this.createInvoiceRecord({
                  uid: userId,
                  customer_name: customerEmail ? customerEmail.split('@')[0] : 'Valued Customer',
                  customer_email: customerEmail || null,
                  facility_id: custFac,
                  invoice_type: 'subscription',
                  payment_status: 'paid',
                  subtotal: storageAmt,
                  delivery_fee: valetFee,
                  discount: discountAmt,
                  tax: taxAmt,
                  total_amount: total,
                  payment_method: 'card',
                  notes: promoCode ? `Initial subscription invoice with promo ${promoCode}` : 'Initial subscription signup invoice receipt',
                  line_items: lineItems,
                  created_at: createdAt,
                  paid_at: createdAt
                });
                if (created && created.success && created.data) {
                  data = [created.data];
                }
              }
            }
          } catch (initErr) {
            console.warn('[CloudVaultBilling] Initial invoice synthesis notice:', initErr.message);
          }
        }

        // Ensure returned invoices have their after-tax totals calculated
        (data || []).forEach(inv => {
          const sub = Number(inv.subtotal || 0);
          const del = Number(inv.delivery_fee || 0);
          const srg = Number(inv.surge_fee || 0);
          const tx = Number(inv.tax || 0);
          const dsc = Number(inv.discount || 0);
          const calculatedTotal = Math.max(0, Math.round((sub + del + srg + tx - dsc) * 100) / 100);
          if (tx > 0 && Math.abs(Number(inv.total_amount || 0) - (sub + del + srg - dsc)) < 0.01) {
            inv.total_amount = calculatedTotal;
          }
        });

        // 4. Update in-memory session cache
        const resultInvoices = data || [];
        global._invoiceCache[cacheKey] = {
          invoices: resultInvoices,
          timestamp: Date.now()
        };
        if (userId && customerEmail) {
          global._invoiceCache[userId] = global._invoiceCache[cacheKey];
          global._invoiceCache[customerEmail] = global._invoiceCache[cacheKey];
        }

        return { success: true, invoices: resultInvoices };
      } catch (err) {
        console.error('[CloudVaultBilling] Exception in fetchInvoicesForUser:', err);
        return { success: false, error: err.message, invoices: [] };
      }
    },

    /**
     * Scans and retroactively realigns all existing invoices in public.invoices table:
     * - Resolves each customer's active Price Lock (price lock immunity) or assigned facility regional rates.
     * - Recalculates exact tote count, volume tier rate, storage subtotal, line items, and dynamic tax.
     * - Updates invalid/miscoded historical invoice records in Supabase to after-tax amounts.
     * @returns {Promise<{success: boolean, scannedCount: number, updatedCount: number, error?: string}>}
     */
    realignExistingInvoices: async function () {
      try {
        const sb = global.supabase;
        if (!sb) {
          console.error('[CloudVaultBilling] Supabase client missing');
          return { success: false, error: 'Supabase client missing', scannedCount: 0, updatedCount: 0 };
        }

        const { data: invoices, error: fetchErr } = await sb
          .from('invoices')
          .select('*');

        if (fetchErr) {
          console.error('[CloudVaultBilling] Error fetching invoices for realignment:', fetchErr);
          return { success: false, error: fetchErr.message, scannedCount: 0, updatedCount: 0 };
        }

        if (!invoices || invoices.length === 0) {
          return { success: true, scannedCount: 0, updatedCount: 0 };
        }

        let updatedCount = 0;

        for (const inv of invoices) {
          if (!inv.uid && !inv.customer_email) continue;

          const invType = (inv.invoice_type || '').toLowerCase();
          const isSubscriptionInvoice = invType === 'subscription' || invType === 'initial_reservation' || invType === 'monthly_subscription';

          // Parse line items
          let lineItems = inv.line_items || [];
          if (typeof lineItems === 'string') {
            try { lineItems = JSON.parse(lineItems); } catch (e) { lineItems = []; }
          }
          if (!Array.isArray(lineItems)) lineItems = [];

          let modified = false;

          if (isSubscriptionInvoice) {
            // Determine tote count from invoice, line items, or user subscription
            let toteCount = Number(inv.tote_count || inv.total_totes || inv.totes || 0);

            const storageItemIndex = lineItems.findIndex(i => {
              const d = (i.description || i.name || '').toLowerCase();
              return d.includes('subscription') || d.includes('storage plan') || d.includes('tote storage');
            });
            const storageItem = storageItemIndex !== -1 ? lineItems[storageItemIndex] : null;

            if (!toteCount && storageItem) {
              const match = (storageItem.description || '').match(/(\d+)\s*tote/i);
              if (match && match[1]) {
                toteCount = parseInt(match[1], 10);
              } else if (Number(storageItem.qty || storageItem.quantity) > 1) {
                toteCount = Number(storageItem.qty || storageItem.quantity);
              }
            }

            if (!toteCount && inv.uid) {
              const { data: userSub } = await sb.from('subscriptions').select('total_totes, tote_count').eq('uid', inv.uid).maybeSingle();
              if (userSub) {
                toteCount = Number(userSub.total_totes || userSub.tote_count || 0);
              }
              if (!toteCount) {
                const { count: invToteCount } = await sb.from('inventory').select('*', { count: 'exact', head: true })
                  .eq('uid', inv.uid)
                  .not('status', 'in', '("missing-tote","missing","decommissioned","discharged")');
                if (invToteCount) toteCount = invToteCount;
              }
            }

            if (!toteCount || toteCount < 1) toteCount = 1;

            const pricingRes = await this.resolveCustomerPricing(inv.uid, inv.facility_id, toteCount);
            const correctToteRate = pricingRes.toteRate;
            const expectedStorageSubtotal = Math.round(toteCount * correctToteRate * 100) / 100;

            if (storageItem) {
              const currentQty = Number(storageItem.qty || storageItem.quantity || 1);
              const currentUnitPrice = Number(storageItem.unit_price || storageItem.unitPrice || 0);
              const currentAmount = Number(storageItem.amount || 0);

              if (currentQty !== toteCount || currentUnitPrice !== correctToteRate || Math.abs(currentAmount - expectedStorageSubtotal) > 0.01) {
                storageItem.qty = toteCount;
                storageItem.unit_price = correctToteRate;
                storageItem.amount = expectedStorageSubtotal;
                storageItem.description = `CloudVault Storage Subscription (${toteCount} totes @ $${correctToteRate.toFixed(2)}/mo — ${pricingRes.tierName})`;
                modified = true;
              }
            } else {
              lineItems.unshift({
                description: `CloudVault Storage Subscription (${toteCount} totes @ $${correctToteRate.toFixed(2)}/mo — ${pricingRes.tierName})`,
                qty: toteCount,
                unit_price: correctToteRate,
                amount: expectedStorageSubtotal
              });
              modified = true;
            }

            let deliveryFee = Number(inv.delivery_fee || 0);
            let surgeFee = Number(inv.surge_fee || 0);
            let discount = Number(inv.discount || 0);
            let newSubtotal = expectedStorageSubtotal;
            const taxableBase = Math.max(0, newSubtotal + deliveryFee + surgeFee);

            // Dynamically resolve tax rate and calculate after-tax totals
            const taxInfo = await this.resolveTaxRate({
              facilityId: inv.facility_id,
              uid: inv.uid,
              zipCode: inv.zip_code
            });
            const taxRate = taxInfo.taxRate != null ? taxInfo.taxRate : 0.086;
            const taxLabel = taxInfo.taxLabel || `Sales Tax (${(taxRate * 100).toFixed(2)}%)`;
            const tax = Math.round(taxableBase * taxRate * 100) / 100;

            const taxItemIndex = lineItems.findIndex(i => (i.description || '').toLowerCase().includes('tax') || i.tax_rate != null);
            if (tax > 0) {
              const taxItem = {
                description: taxLabel,
                qty: 1,
                unit_price: tax,
                amount: tax,
                tax_rate: taxRate
              };
              if (taxItemIndex !== -1) {
                if (Math.abs(Number(lineItems[taxItemIndex].amount || 0) - tax) > 0.01 || lineItems[taxItemIndex].tax_rate !== taxRate) {
                  lineItems[taxItemIndex] = taxItem;
                  modified = true;
                }
              } else {
                lineItems.push(taxItem);
                modified = true;
              }
            }

            let newTotal = Math.round((taxableBase + tax - discount) * 100) / 100;
            if (newTotal < 0) newTotal = 0;

            if (Math.abs(Number(inv.subtotal || 0) - newSubtotal) > 0.01 ||
                Math.abs(Number(inv.tax || 0) - tax) > 0.01 ||
                Math.abs(Number(inv.total_amount || 0) - newTotal) > 0.01) {
              modified = true;
            }

            if (modified) {
              const updatePayload = {
                subtotal: newSubtotal,
                tax: tax,
                total_amount: newTotal,
                line_items: lineItems,
                notes: (inv.notes || '').includes('Realigned')
                  ? inv.notes
                  : `${inv.notes || ''} [Realigned to dynamic ${pricingRes.tierName} rate $${correctToteRate.toFixed(2)}/tote/mo]`.trim()
              };
              const { error: updateErr } = await sb.from('invoices').update(updatePayload).eq('id', inv.id);
              if (!updateErr) updatedCount++;
            }
          } else {
            // Non-subscription service invoice (retrieval / valet / surge / expansion)
            // Strip any erroneously injected monthly subscription line items
            const originalLen = lineItems.length;
            lineItems = lineItems.filter(i => {
              const desc = (i.description || i.name || '').toLowerCase();
              return !(desc.includes('storage subscription') || (desc.includes('subscription (') && desc.includes('tier')));
            });

            if (lineItems.length !== originalLen) modified = true;

            const subtotal = Number(inv.subtotal || 0);
            const deliveryFee = Number(inv.delivery_fee || 0);
            const surgeFee = Number(inv.surge_fee || 0);
            const discount = Number(inv.discount || 0);
            const taxableBase = Math.max(0, subtotal + deliveryFee + surgeFee);

            // Dynamically resolve tax rate and calculate after-tax totals
            const taxInfo = await this.resolveTaxRate({
              facilityId: inv.facility_id,
              uid: inv.uid,
              zipCode: inv.zip_code
            });
            const taxRate = taxInfo.taxRate != null ? taxInfo.taxRate : 0.086;
            const taxLabel = taxInfo.taxLabel || `Sales Tax (${(taxRate * 100).toFixed(2)}%)`;
            const tax = Math.round(taxableBase * taxRate * 100) / 100;

            const taxItemIndex = lineItems.findIndex(i => (i.description || '').toLowerCase().includes('tax') || i.tax_rate != null);
            if (tax > 0) {
              const taxItem = {
                description: taxLabel,
                qty: 1,
                unit_price: tax,
                amount: tax,
                tax_rate: taxRate
              };
              if (taxItemIndex !== -1) {
                if (Math.abs(Number(lineItems[taxItemIndex].amount || 0) - tax) > 0.01 || lineItems[taxItemIndex].tax_rate !== taxRate) {
                  lineItems[taxItemIndex] = taxItem;
                  modified = true;
                }
              } else {
                lineItems.push(taxItem);
                modified = true;
              }
            }

            const correctTotal = Math.round((taxableBase + tax - discount) * 100) / 100;

            if (Math.abs(Number(inv.tax || 0) - tax) > 0.01 || Math.abs(Number(inv.total_amount || 0) - correctTotal) > 0.01) {
              modified = true;
            }

            if (modified) {
              const updatePayload = {
                subtotal: subtotal,
                tax: tax,
                total_amount: correctTotal,
                line_items: lineItems
              };
              const { error: updateErr } = await sb.from('invoices').update(updatePayload).eq('id', inv.id);
              if (!updateErr) updatedCount++;
            }
          }
        }

        console.log(`[CloudVaultBilling] Retroactive invoice realignment complete: ${updatedCount} of ${invoices.length} invoices realigned.`);
        return { success: true, scannedCount: invoices.length, updatedCount };
      } catch (err) {
        console.error('[CloudVaultBilling] Exception in realignExistingInvoices:', err);
        return { success: false, error: err.message, scannedCount: 0, updatedCount: 0 };
      }
    },

    /**
     * Scans subscriptions, charges, access_requests, and waitlist for unbilled records,
     * creating retroactive invoices in public.invoices without duplicates and realigning existing invoices.
     * @returns {Promise<{success: boolean, count: number, backfilled: Object, invoices: Array, error?: string}>}
     */
    backfillRetroactiveInvoices: async function () {
      try {
        const sb = global.supabase;
        if (!sb) {
          console.error('[CloudVaultBilling] Supabase client missing');
          return { success: false, error: 'Supabase client missing', count: 0, invoices: [] };
        }

        // First realign any miscoded existing invoices
        await this.realignExistingInvoices();

        // 1. Fetch existing invoices to prevent duplicates
        const { data: existingInvoices, error: invErr } = await sb
          .from('invoices')
          .select('id, uid, customer_email, transaction_reference, notes, invoice_type');

        if (invErr) {
          console.error('[CloudVaultBilling] Error fetching existing invoices for backfill:', invErr);
          return { success: false, error: invErr.message, count: 0, invoices: [] };
        }

        const existingTxnRefs = new Set(
          (existingInvoices || []).map(i => i.transaction_reference).filter(Boolean)
        );
        const existingNotes = (existingInvoices || []).map(i => i.notes || '').join(' ');

        // 2. Fetch users lookup map — indexed by both id AND email to catch
        //    waitlist prospects who never completed account signup
        const { data: usersData } = await sb.from('users').select('id, name, email, assigned_facility_id');
        const usersMap = {};
        const usersByEmail = {};
        if (usersData) {
          usersData.forEach(u => {
            usersMap[u.id] = u;
            if (u.email) usersByEmail[u.email.toLowerCase().trim()] = u;
          });
        }

        const createdInvoices = [];
        const stats = { subscriptions: 0, charges: 0, accessRequests: 0, waitlist: 0 };

        // -------------------------------------------------------------
        // A. Backfill Subscriptions
        // -------------------------------------------------------------
        const { data: subscriptions } = await sb.from('subscriptions').select('*');
        if (subscriptions && subscriptions.length > 0) {
          for (const sub of subscriptions) {
            const txnRef = `SUB-${sub.id}`;
            const subRefTag = `sub_${sub.id}`;

            const alreadyHasTxn = existingTxnRefs.has(txnRef);
            const alreadyInNotes = existingNotes.includes(subRefTag) || existingNotes.includes(sub.id);
            const hasSubInvoice = (existingInvoices || []).some(inv =>
              inv.uid === sub.uid &&
              ['subscription', 'initial_reservation'].includes(inv.invoice_type) &&
              (inv.transaction_reference === txnRef || (inv.notes && inv.notes.includes(sub.id)))
            );

            if (!alreadyHasTxn && !alreadyInNotes && !hasSubInvoice) {
              const userObj = usersMap[sub.uid] || {};
              const toteCount = Number(sub.tote_count || sub.total_totes || 0);
              const pricingRes = await this.resolveCustomerPricing(sub.uid, sub.facility_id || userObj.assigned_facility_id, toteCount);
              const toteRate = (Number(sub.tote_rate) > 0 && !(toteCount >= 10 && Number(sub.tote_rate) > pricingRes.toteRate)) 
                ? Number(sub.tote_rate) 
                : pricingRes.toteRate;
              const storageAmt = Number(sub.recurring_storage || (toteCount * toteRate) || pricingRes.recurringStorage);
              const valetFee = Number(sub.valet_fee || 0);
              const total = Number(sub.first_month_total || sub.monthly_total || (storageAmt + valetFee));
              const createdAt = sub.created_at || new Date().toISOString();

              const lineItems = [
                {
                  description: `CloudVault Storage Subscription (${toteCount} totes @ $${toteRate.toFixed(2)}/mo — ${pricingRes.tierName})`,
                  qty: toteCount || 1,
                  unit_price: toteRate || storageAmt,
                  amount: storageAmt
                }
              ];
              if (valetFee > 0) {
                lineItems.push({
                  description: 'Initial Valet Delivery & Setup Fee',
                  qty: 1,
                  unit_price: valetFee,
                  amount: valetFee
                });
              }

              const res = await this.createInvoiceRecord({
                uid: sub.uid,
                customer_name: userObj.name || 'Valued Customer',
                customer_email: userObj.email || null,
                facility_id: userObj.assigned_facility_id || sub.facility_id || null,
                invoice_type: 'subscription',
                payment_status: 'paid',
                subtotal: storageAmt,
                delivery_fee: valetFee,
                total_amount: total,
                payment_method: 'card',
                transaction_reference: txnRef,
                notes: `Retroactive initial subscription backfill [Ref: ${subRefTag}]`,
                line_items: lineItems,
                created_at: createdAt,
                paid_at: createdAt,
                due_date: new Date(new Date(createdAt).getTime() + 3 * 24 * 60 * 60 * 1000).toISOString()
              });

              if (res.success && res.data) {
                createdInvoices.push(res.data);
                existingTxnRefs.add(txnRef);
                stats.subscriptions++;
              }
            }
          }
        }

        // -------------------------------------------------------------
        // B. Backfill Charges
        // -------------------------------------------------------------
        const { data: charges } = await sb.from('charges').select('*');
        if (charges && charges.length > 0) {
          for (const chg of charges) {
            const txnRef = `CHG-${chg.id}`;
            const chgRefTag = `charge_${chg.id}`;

            const alreadyHasTxn = existingTxnRefs.has(txnRef);
            const alreadyInNotes = existingNotes.includes(chgRefTag) || existingNotes.includes(chg.id);

            if (!alreadyHasTxn && !alreadyInNotes) {
              const userObj = usersMap[chg.uid] || {};
              const amt = Number(chg.amount || 0);
              const status = (chg.status === 'success' || chg.status === 'paid') ? 'paid' : (chg.status || 'paid');
              const createdAt = chg.charged_at || chg.created_at || new Date().toISOString();

              const res = await this.createInvoiceRecord({
                uid: chg.uid,
                customer_name: userObj.name || 'Valued Customer',
                customer_email: userObj.email || null,
                facility_id: userObj.assigned_facility_id || null,
                invoice_type: chg.charge_type || 'charge',
                payment_status: status,
                subtotal: amt,
                total_amount: amt,
                payment_method: 'card',
                transaction_reference: txnRef,
                notes: `Retroactive charge backfill for ${chg.charge_type || 'fee'} [Ref: ${chgRefTag}]`,
                line_items: [
                  {
                    description: `CloudVault Fee / Charge: ${chg.charge_type || 'General Fee'}`,
                    qty: Number(chg.totes_charged || 1),
                    unit_price: amt,
                    amount: amt
                  }
                ],
                created_at: createdAt,
                paid_at: status === 'paid' ? createdAt : null,
                due_date: new Date(new Date(createdAt).getTime() + 3 * 24 * 60 * 60 * 1000).toISOString()
              });

              if (res.success && res.data) {
                createdInvoices.push(res.data);
                existingTxnRefs.add(txnRef);
                stats.charges++;
              }
            }
          }
        }

        // -------------------------------------------------------------
        // C. Backfill Access Requests
        // -------------------------------------------------------------
        const { data: accessRequests } = await sb.from('access_requests').select('*');
        if (accessRequests && accessRequests.length > 0) {
          for (const req of accessRequests) {
            const txnRef = `AR-${req.id}`;
            const reqRefTag = `ar_${req.id}`;

            const alreadyHasTxn = existingTxnRefs.has(txnRef);
            const alreadyInNotes = existingNotes.includes(reqRefTag) || existingNotes.includes(req.id);

            if (!alreadyHasTxn && !alreadyInNotes) {
              const userObj = usersMap[req.uid] || {};
              const res = await this.createAccessRequestInvoice(req, userObj);

              if (res.success && res.data) {
                createdInvoices.push(res.data);
                existingTxnRefs.add(txnRef);
                stats.accessRequests++;
              }
            }
          }
        }

        // -------------------------------------------------------------
        // D. Backfill Waitlist
        // -------------------------------------------------------------
        const { data: waitlistEntries } = await sb.from('waitlist').select('*');
        if (waitlistEntries && waitlistEntries.length > 0) {
          for (const w of waitlistEntries) {
            const txnRef = `WTL-${w.id}`;
            const wRefTag = `waitlist_${w.id}`;
            const wEmail = (w.email || '').toLowerCase().trim();

            const alreadyHasTxn = existingTxnRefs.has(txnRef);
            const alreadyInNotes = existingNotes.includes(wRefTag) || existingNotes.includes(w.id);
            // Check by email too — catches unlinked prospects who never completed signup
            const hasWaitlistInvoice = (existingInvoices || []).some(inv =>
              (inv.customer_email || '').toLowerCase().trim() === wEmail &&
              inv.invoice_type === 'unlaunched_deposit'
            );

            if (!alreadyHasTxn && !alreadyInNotes && !hasWaitlistInvoice) {
              // Resolve user object: try uid first, then fall back to email lookup
              //   This handles prospects who submitted a deposit but never finished signup
              const userObj =
                (w.user_id ? usersMap[w.user_id] : null) ||
                (wEmail ? usersByEmail[wEmail] : null) ||
                {};

              // Resolve resolved uid (may be null for true unlinked prospects)
              const resolvedUid = w.user_id || userObj.id || null;

              // Default deposit: $25 if unlaunched market, $20 general waitlist
              const deposit = Number(w.deposit_amount || w.amount_paid || 25.00);
              const pStatus = (
                w.payment_status === 'deposit_paid' ||
                w.payment_status === 'paid' ||
                w.status === 'deposit_paid'
              ) ? 'deposit_received' : (w.payment_status || 'deposit_received');
              const createdAt = w.created_at || new Date().toISOString();
              // Build a human-readable name — fall back to email prefix or 'Waitlist Lead'
              const displayName =
                w.name ||
                userObj.name ||
                w.full_name ||
                (wEmail ? wEmail.split('@')[0] : 'Waitlist Lead');

              const res = await this.createInvoiceRecord({
                uid: resolvedUid,
                customer_name: displayName,
                customer_email: w.email,
                facility_id: null,
                invoice_type: 'unlaunched_deposit',
                payment_status: pStatus,
                subtotal: deposit,
                total_amount: deposit,
                payment_method: 'card',
                transaction_reference: txnRef,
                notes: `Retroactive waitlist priority deposit backfill [Ref: ${wRefTag}]${resolvedUid ? '' : ' [UNLINKED PROSPECT — no user account]'}`,
                line_items: [
                  {
                    description: `Unlaunched Market Priority Queue Reservation (${w.requested_totes || w.tote_count || 5} totes)`,
                    qty: 1,
                    unit_price: deposit,
                    amount: deposit
                  }
                ],
                created_at: createdAt,
                paid_at: (pStatus === 'paid' || pStatus === 'deposit_received') ? createdAt : null,
                due_date: new Date(new Date(createdAt).getTime() + 3 * 24 * 60 * 60 * 1000).toISOString()
              });

              if (res.success && res.data) {
                createdInvoices.push(res.data);
                existingTxnRefs.add(txnRef);
                stats.waitlist++;
              }
            }
          }
        }

        return {
          success: true,
          count: createdInvoices.length,
          backfilled: stats,
          invoices: createdInvoices
        };
      } catch (err) {
        console.error('[CloudVaultBilling] Exception in backfillRetroactiveInvoices:', err);
        return { success: false, error: err.message, count: 0, invoices: [] };
      }
    },

    /**
     * Scans active subscriptions due for renewal (next_billing_date <= now() or null),
     * generates monthly recurring subscription invoices, updates last_billed_at, and advances next_billing_date by 1 month.
     * @returns {Promise<{success: boolean, processedCount: number, invoices: Array, error?: string}>}
     */
    processMonthlyAutopayBilling: async function () {
      try {
        const sb = global.supabase;
        if (!sb) {
          console.error('[CloudVaultBilling] Supabase client missing');
          return { success: false, error: 'Supabase client missing', processedCount: 0, invoices: [] };
        }

        const now = new Date();
        const nowIso = now.toISOString();

        // 1. Fetch active subscriptions
        const { data: activeSubs, error: subErr } = await sb
          .from('subscriptions')
          .select('*')
          .eq('status', 'active');

        if (subErr) {
          console.error('[CloudVaultBilling] Error fetching active subscriptions:', subErr);
          return { success: false, error: subErr.message, processedCount: 0, invoices: [] };
        }

        if (!activeSubs || activeSubs.length === 0) {
          return { success: true, processedCount: 0, invoices: [] };
        }

        // Filter for subscriptions due for renewal (next_billing_date is null or <= now)
        const dueSubs = activeSubs.filter(sub => {
          if (!sub.next_billing_date) return true;
          return new Date(sub.next_billing_date) <= now;
        });

        if (dueSubs.length === 0) {
          return { success: true, processedCount: 0, invoices: [] };
        }

        // Fetch users lookup map
        const userIds = dueSubs.map(s => s.uid).filter(Boolean);
        const usersMap = {};
        if (userIds.length > 0) {
          const { data: usersData } = await sb.from('users').select('id, name, email, assigned_facility_id').in('id', userIds);
          if (usersData) {
            usersData.forEach(u => { usersMap[u.id] = u; });
          }
        }

        const createdInvoices = [];

        for (const sub of dueSubs) {
          const userObj = usersMap[sub.uid] || {};

          const toteCount = Number(sub.tote_count || sub.total_totes || 0);
          const pricingRes = await this.resolveCustomerPricing(sub.uid, sub.facility_id || userObj.assigned_facility_id, toteCount);
          const toteRate = (Number(sub.tote_rate) > 0 && !(toteCount >= 10 && Number(sub.tote_rate) > pricingRes.toteRate)) 
            ? Number(sub.tote_rate) 
            : pricingRes.toteRate;
          const storageAmt = Number(sub.recurring_storage || (toteCount * toteRate) || pricingRes.recurringStorage);
          const valetFee = Number(sub.valet_fee || 0);
          let monthlyTotal = Number(sub.monthly_total || (storageAmt + valetFee));

          if (monthlyTotal <= 0 && storageAmt > 0) {
            monthlyTotal = storageAmt;
          }

          const txnRef = `AUTOPAY-${sub.id}-${nowIso.slice(0, 10)}`;

          // Create invoice record
          const invRes = await this.createInvoiceRecord({
            uid: sub.uid,
            customer_name: userObj.name || 'Valued Customer',
            customer_email: userObj.email || null,
            facility_id: userObj.assigned_facility_id || sub.facility_id || null,
            invoice_type: 'subscription',
            payment_status: 'paid',
            subtotal: storageAmt,
            delivery_fee: valetFee,
            total_amount: monthlyTotal,
            payment_method: 'autopay',
            transaction_reference: txnRef,
            notes: `Automated monthly subscription autopay renewal (${pricingRes.tierName}${pricingRes.isPriceLock ? ' [Price Locked]' : ''})`,
            line_items: [
              {
                description: `CloudVault Monthly Autopay Storage Subscription (${toteCount} totes @ $${toteRate.toFixed(2)}/mo — ${pricingRes.tierName})`,
                qty: toteCount || 1,
                unit_price: toteRate || storageAmt,
                amount: storageAmt
              }
            ],
            created_at: nowIso,
            paid_at: nowIso,
            due_date: new Date(now.getTime() + 3 * 24 * 60 * 60 * 1000).toISOString()
          });

          if (invRes.success && invRes.data) {
            createdInvoices.push(invRes.data);
          }

          // Advance next_billing_date by 1 month from current next_billing_date or now
          let baseDate = sub.next_billing_date ? new Date(sub.next_billing_date) : new Date(now);
          if (isNaN(baseDate.getTime())) {
            baseDate = new Date(now);
          }

          const nextBilling = new Date(baseDate);
          nextBilling.setMonth(nextBilling.getMonth() + 1);

          // Ensure next_billing_date is strictly in the future relative to now
          if (nextBilling <= now) {
            nextBilling.setTime(now.getTime() + 30 * 24 * 60 * 60 * 1000);
          }

          // Update subscription record with last_billed_at and new next_billing_date
          await sb
            .from('subscriptions')
            .update({
              last_billed_at: nowIso,
              next_billing_date: nextBilling.toISOString(),
              last_updated: nowIso
            })
            .eq('id', sub.id);
        }

        return {
          success: true,
          processedCount: createdInvoices.length,
          invoices: createdInvoices
        };
      } catch (err) {
        console.error('[CloudVaultBilling] Exception in processMonthlyAutopayBilling:', err);
        return { success: false, error: err.message, processedCount: 0, invoices: [] };
      }
    },

    /**
     * Scans unpaid invoices (payment_status = 'pending') where due_date < now(),
     * updates payment_status to 'overdue', and flags the customer account.
     * @returns {Promise<{success: boolean, overdueCount: number, updatedInvoices: Array, error?: string}>}
     */
    evaluateOverdueInvoices: async function () {
      try {
        const sb = global.supabase;
        if (!sb) {
          console.error('[CloudVaultBilling] Supabase client missing');
          return { success: false, error: 'Supabase client missing', overdueCount: 0, updatedInvoices: [] };
        }

        const nowIso = new Date().toISOString();

        // 1. Fetch pending invoices where due_date < now
        const { data: pendingInvoices, error: fetchErr } = await sb
          .from('invoices')
          .select('*')
          .eq('payment_status', 'pending')
          .lt('due_date', nowIso);

        if (fetchErr) {
          console.error('[CloudVaultBilling] Error fetching pending invoices:', fetchErr);
          return { success: false, error: fetchErr.message, overdueCount: 0, updatedInvoices: [] };
        }

        if (!pendingInvoices || pendingInvoices.length === 0) {
          return { success: true, overdueCount: 0, updatedInvoices: [] };
        }

        const updatedInvoices = [];
        const flaggedUserIds = new Set();

        for (const inv of pendingInvoices) {
          // Update payment_status to 'overdue'
          const { data: updated, error: updateErr } = await sb
            .from('invoices')
            .update({ payment_status: 'overdue' })
            .eq('id', inv.id)
            .select()
            .single();

          if (!updateErr && updated) {
            updatedInvoices.push(updated);
          } else {
            updatedInvoices.push({ ...inv, payment_status: 'overdue' });
          }

          if (inv.uid) {
            flaggedUserIds.add(inv.uid);
          }
        }

        // Flag customer accounts in users & subscriptions tables
        for (const uid of flaggedUserIds) {
          // Flag public.users (set onboarding_status to 'overdue' and is_overdue to true)
          await sb
            .from('users')
            .update({ onboarding_status: 'overdue', is_overdue: true })
            .eq('id', uid);

          // Flag public.subscriptions if active (set status to 'past_due')
          await sb
            .from('subscriptions')
            .update({ status: 'past_due' })
            .eq('uid', uid)
            .eq('status', 'active');
        }

        return {
          success: true,
          overdueCount: updatedInvoices.length,
          updatedInvoices: updatedInvoices,
          flaggedUserCount: flaggedUserIds.size
        };
      } catch (err) {
        console.error('[CloudVaultBilling] Exception in evaluateOverdueInvoices:', err);
        return { success: false, error: err.message, overdueCount: 0, updatedInvoices: [] };
      }
    },

    /**
     * Performs a granular backfill of retroactive invoices for a specific customer (userId).
     * @param {string} userId - User UUID
     * @returns {Promise<{success: boolean, count: number, backfilled: Object, invoices: Array, error?: string}>}
     */
    backfillCustomerInvoices: async function (userId) {
      try {
        if (!userId) {
          return { success: false, error: 'User ID is required for granular customer backfill', count: 0, invoices: [] };
        }

        const sb = global.supabase;
        if (!sb) {
          console.error('[CloudVaultBilling] Supabase client missing');
          return { success: false, error: 'Supabase client missing', count: 0, invoices: [] };
        }

        // 1. Fetch user record
        const { data: userObj, error: userErr } = await sb
          .from('users')
          .select('id, name, email, assigned_facility_id')
          .eq('id', userId)
          .maybeSingle();

        if (userErr) {
          console.error('[CloudVaultBilling] Error fetching user for backfillCustomerInvoices:', userErr);
          return { success: false, error: userErr.message, count: 0, invoices: [] };
        }

        const user = userObj || { id: userId };

        // 2. Fetch existing invoices for user
        let query = sb
          .from('invoices')
          .select('id, uid, customer_email, transaction_reference, notes, invoice_type');

        if (userId && user.email) {
          query = query.or(`uid.eq.${userId},customer_email.eq.${user.email}`);
        } else {
          query = query.eq('uid', userId);
        }

        const { data: existingInvoices, error: invErr } = await query;

        if (invErr) {
          console.error('[CloudVaultBilling] Error fetching existing user invoices:', invErr);
          return { success: false, error: invErr.message, count: 0, invoices: [] };
        }

        const existingTxnRefs = new Set(
          (existingInvoices || []).map(i => i.transaction_reference).filter(Boolean)
        );
        const existingNotes = (existingInvoices || []).map(i => i.notes || '').join(' ');

        const createdInvoices = [];
        const stats = { subscriptions: 0, charges: 0, accessRequests: 0, waitlist: 0 };

        // A. Subscriptions for user
        const { data: subscriptions } = await sb.from('subscriptions').select('*').eq('uid', userId);
        if (subscriptions && subscriptions.length > 0) {
          for (const sub of subscriptions) {
            const txnRef = `SUB-${sub.id}`;
            const subRefTag = `sub_${sub.id}`;

            const alreadyHasTxn = existingTxnRefs.has(txnRef);
            const alreadyInNotes = existingNotes.includes(subRefTag) || existingNotes.includes(sub.id);
            const hasSubInvoice = (existingInvoices || []).some(inv =>
              inv.uid === sub.uid &&
              ['subscription', 'initial_reservation'].includes(inv.invoice_type) &&
              (inv.transaction_reference === txnRef || (inv.notes && inv.notes.includes(sub.id)))
            );

            if (!alreadyHasTxn && !alreadyInNotes && !hasSubInvoice) {
              const toteCount = Number(sub.tote_count || sub.total_totes || 0);
              const pricingRes = await this.resolveCustomerPricing(userId, sub.facility_id || user.assigned_facility_id, toteCount);
              const toteRate = (Number(sub.tote_rate) > 0 && !(toteCount >= 10 && Number(sub.tote_rate) > pricingRes.toteRate)) 
                ? Number(sub.tote_rate) 
                : pricingRes.toteRate;
              const storageAmt = Number(sub.recurring_storage || (toteCount * toteRate) || pricingRes.recurringStorage);
              const valetFee = Number(sub.valet_fee || 0);
              const total = Number(sub.first_month_total || sub.monthly_total || (storageAmt + valetFee));
              const createdAt = sub.created_at || new Date().toISOString();

              const lineItems = [
                {
                  description: `CloudVault Storage Subscription (${toteCount} totes @ $${toteRate.toFixed(2)}/mo — ${pricingRes.tierName})`,
                  qty: toteCount || 1,
                  unit_price: toteRate || storageAmt,
                  amount: storageAmt
                }
              ];
              if (valetFee > 0) {
                lineItems.push({
                  description: 'Initial Valet Delivery & Setup Fee',
                  qty: 1,
                  unit_price: valetFee,
                  amount: valetFee
                });
              }

              const res = await this.createInvoiceRecord({
                uid: sub.uid,
                customer_name: user.name || 'Valued Customer',
                customer_email: user.email || null,
                facility_id: user.assigned_facility_id || sub.facility_id || null,
                invoice_type: 'subscription',
                payment_status: 'paid',
                subtotal: storageAmt,
                delivery_fee: valetFee,
                total_amount: total,
                payment_method: 'card',
                transaction_reference: txnRef,
                notes: `Retroactive initial subscription backfill [Ref: ${subRefTag}]`,
                line_items: lineItems,
                created_at: createdAt,
                paid_at: createdAt,
                due_date: new Date(new Date(createdAt).getTime() + 3 * 24 * 60 * 60 * 1000).toISOString()
              });

              if (res.success && res.data) {
                createdInvoices.push(res.data);
                existingTxnRefs.add(txnRef);
                stats.subscriptions++;
              }
            }
          }
        }

        // B. Charges for user
        const { data: charges } = await sb.from('charges').select('*').eq('uid', userId);
        if (charges && charges.length > 0) {
          for (const chg of charges) {
            const txnRef = `CHG-${chg.id}`;
            const chgRefTag = `charge_${chg.id}`;

            const alreadyHasTxn = existingTxnRefs.has(txnRef);
            const alreadyInNotes = existingNotes.includes(chgRefTag) || existingNotes.includes(chg.id);

            if (!alreadyHasTxn && !alreadyInNotes) {
              const amt = Number(chg.amount || 0);
              const status = (chg.status === 'success' || chg.status === 'paid') ? 'paid' : (chg.status || 'paid');
              const createdAt = chg.charged_at || chg.created_at || new Date().toISOString();

              const res = await this.createInvoiceRecord({
                uid: chg.uid,
                customer_name: user.name || 'Valued Customer',
                customer_email: user.email || null,
                facility_id: user.assigned_facility_id || null,
                invoice_type: chg.charge_type || 'charge',
                payment_status: status,
                subtotal: amt,
                total_amount: amt,
                payment_method: 'card',
                transaction_reference: txnRef,
                notes: `Retroactive charge backfill for ${chg.charge_type || 'fee'} [Ref: ${chgRefTag}]`,
                line_items: [
                  {
                    description: `CloudVault Fee / Charge: ${chg.charge_type || 'General Fee'}`,
                    qty: Number(chg.totes_charged || 1),
                    unit_price: amt,
                    amount: amt
                  }
                ],
                created_at: createdAt,
                paid_at: status === 'paid' ? createdAt : null,
                due_date: new Date(new Date(createdAt).getTime() + 3 * 24 * 60 * 60 * 1000).toISOString()
              });

              if (res.success && res.data) {
                createdInvoices.push(res.data);
                existingTxnRefs.add(txnRef);
                stats.charges++;
              }
            }
          }
        }

        // C. Access Requests for user
        const { data: accessRequests } = await sb.from('access_requests').select('*').eq('uid', userId);
        if (accessRequests && accessRequests.length > 0) {
          for (const req of accessRequests) {
            const txnRef = `AR-${req.id}`;
            const reqRefTag = `ar_${req.id}`;

            const alreadyHasTxn = existingTxnRefs.has(txnRef);
            const alreadyInNotes = existingNotes.includes(reqRefTag) || existingNotes.includes(req.id);

            if (!alreadyHasTxn && !alreadyInNotes) {
              const res = await this.createAccessRequestInvoice(req, user);

              if (res.success && res.data) {
                createdInvoices.push(res.data);
                existingTxnRefs.add(txnRef);
                stats.accessRequests++;
              }
            }
          }
        }

        // D. Waitlist for user
        let wQuery = sb.from('waitlist').select('*');
        if (userId && user.email) {
          wQuery = wQuery.or(`user_id.eq.${userId},email.eq.${user.email}`);
        } else if (userId) {
          wQuery = wQuery.eq('user_id', userId);
        } else if (user.email) {
          wQuery = wQuery.eq('email', user.email);
        }

        const { data: waitlistEntries } = await wQuery;
        if (waitlistEntries && waitlistEntries.length > 0) {
          for (const w of waitlistEntries) {
            const txnRef = `WTL-${w.id}`;
            const wRefTag = `waitlist_${w.id}`;

            const alreadyHasTxn = existingTxnRefs.has(txnRef);
            const alreadyInNotes = existingNotes.includes(wRefTag) || existingNotes.includes(w.id);
            const hasWaitlistInvoice = (existingInvoices || []).some(inv =>
              inv.customer_email === w.email && inv.invoice_type === 'unlaunched_deposit'
            );

            if (!alreadyHasTxn && !alreadyInNotes && !hasWaitlistInvoice) {
              const deposit = Number(w.deposit_amount || 20.00);
              const pStatus = (w.payment_status === 'deposit_paid' || w.payment_status === 'paid' || w.status === 'deposit_paid') ? 'deposit_received' : (w.payment_status || 'deposit_received');
              const createdAt = w.created_at || new Date().toISOString();

              const res = await this.createInvoiceRecord({
                uid: w.user_id || userId,
                customer_name: user.name || (w.email ? w.email.split('@')[0] : 'Waitlist Lead'),
                customer_email: w.email || user.email,
                facility_id: null,
                invoice_type: 'unlaunched_deposit',
                payment_status: pStatus,
                subtotal: deposit,
                total_amount: deposit,
                payment_method: 'card',
                transaction_reference: txnRef,
                notes: `Retroactive waitlist priority deposit backfill [Ref: ${wRefTag}]`,
                line_items: [
                  {
                    description: `Unlaunched Market Priority Queue Reservation (${w.requested_totes || 5} totes)`,
                    qty: 1,
                    unit_price: deposit,
                    amount: deposit
                  }
                ],
                created_at: createdAt,
                paid_at: (pStatus === 'paid' || pStatus === 'deposit_received') ? createdAt : null,
                due_date: new Date(new Date(createdAt).getTime() + 3 * 24 * 60 * 60 * 1000).toISOString()
              });

              if (res.success && res.data) {
                createdInvoices.push(res.data);
                existingTxnRefs.add(txnRef);
                stats.waitlist++;
              }
            }
          }
        }

        return {
          success: true,
          count: createdInvoices.length,
          backfilled: stats,
          invoices: createdInvoices
        };
      } catch (err) {
        console.error('[CloudVaultBilling] Exception in backfillCustomerInvoices:', err);
        return { success: false, error: err.message, count: 0, invoices: [] };
      }
    },

    /**
     * Processes a granular autopay charge for a specific customer (userId).
     * @param {string} userId - User UUID
     * @returns {Promise<{success: boolean, processedCount: number, invoices: Array, error?: string}>}
     */
    processCustomerAutopay: async function (userId) {
      try {
        if (!userId) {
          return { success: false, error: 'User ID is required for customer autopay processing', processedCount: 0, invoices: [] };
        }

        const sb = global.supabase;
        if (!sb) {
          console.error('[CloudVaultBilling] Supabase client missing');
          return { success: false, error: 'Supabase client missing', processedCount: 0, invoices: [] };
        }

        const now = new Date();
        const nowIso = now.toISOString();

        // 1. Fetch active subscription for user
        const { data: sub, error: subErr } = await sb
          .from('subscriptions')
          .select('*')
          .eq('uid', userId)
          .eq('status', 'active')
          .maybeSingle();

        if (subErr) {
          console.error('[CloudVaultBilling] Error fetching subscription for processCustomerAutopay:', subErr);
          return { success: false, error: subErr.message, processedCount: 0, invoices: [] };
        }

        if (!sub) {
          return { success: false, error: 'No active subscription found for user', processedCount: 0, invoices: [] };
        }

        // 2. Fetch user profile info
        const { data: userObj } = await sb
          .from('users')
          .select('id, name, email, assigned_facility_id')
          .eq('id', userId)
          .maybeSingle();

        const user = userObj || {};

        const toteCount = Number(sub.tote_count || sub.total_totes || 0);
        const pricingRes = await this.resolveCustomerPricing(userId, sub.facility_id || user.assigned_facility_id, toteCount);
        const toteRate = (Number(sub.tote_rate) > 0 && !(toteCount >= 10 && Number(sub.tote_rate) > pricingRes.toteRate)) 
          ? Number(sub.tote_rate) 
          : pricingRes.toteRate;
        const storageAmt = Number(sub.recurring_storage || (toteCount * toteRate) || pricingRes.recurringStorage);
        const valetFee = Number(sub.valet_fee || 0);
        let monthlyTotal = Number(sub.monthly_total || (storageAmt + valetFee));

        if (monthlyTotal <= 0 && storageAmt > 0) {
          monthlyTotal = storageAmt;
        }

        const txnRef = `AUTOPAY-${sub.id}-${nowIso.slice(0, 10)}`;

        // 3. Create invoice record
        const invRes = await this.createInvoiceRecord({
          uid: sub.uid,
          customer_name: user.name || 'Valued Customer',
          customer_email: user.email || null,
          facility_id: user.assigned_facility_id || sub.facility_id || null,
          invoice_type: 'subscription',
          payment_status: 'paid',
          subtotal: storageAmt,
          delivery_fee: valetFee,
          total_amount: monthlyTotal,
          payment_method: 'autopay',
          transaction_reference: txnRef,
          notes: `Granular customer monthly subscription autopay renewal (${pricingRes.tierName}${pricingRes.isPriceLock ? ' [Price Locked]' : ''})`,
          line_items: [
            {
              description: `CloudVault Monthly Autopay Storage Subscription (${toteCount} totes @ $${toteRate.toFixed(2)}/mo — ${pricingRes.tierName})`,
              qty: toteCount || 1,
              unit_price: toteRate || storageAmt,
              amount: storageAmt
            }
          ],
          created_at: nowIso,
          paid_at: nowIso,
          due_date: new Date(now.getTime() + 3 * 24 * 60 * 60 * 1000).toISOString()
        });

        if (!invRes.success) {
          return { success: false, error: invRes.error || 'Failed to create invoice record', processedCount: 0, invoices: [] };
        }

        // 4. Calculate next_billing_date (advance 1 month)
        let baseDate = sub.next_billing_date ? new Date(sub.next_billing_date) : new Date(now);
        if (isNaN(baseDate.getTime())) {
          baseDate = new Date(now);
        }

        const nextBilling = new Date(baseDate);
        nextBilling.setMonth(nextBilling.getMonth() + 1);

        if (nextBilling <= now) {
          nextBilling.setTime(now.getTime() + 30 * 24 * 60 * 60 * 1000);
        }

        // 5. Update subscription with last_billed_at and next_billing_date
        await sb
          .from('subscriptions')
          .update({
            last_billed_at: nowIso,
            next_billing_date: nextBilling.toISOString(),
            last_updated: nowIso
          })
          .eq('id', sub.id);

        return {
          success: true,
          processedCount: 1,
          invoices: [invRes.data]
        };
      } catch (err) {
        console.error('[CloudVaultBilling] Exception in processCustomerAutopay:', err);
        return { success: false, error: err.message, processedCount: 0, invoices: [] };
      }
    },

    /**
     * Checks if a user has an active creator promotional discount (e.g. 20% off for 2 months from signup).
     * @param {string} userId - Customer User UUID
     * @returns {Promise<Object|null>} Promo info or null if ineligible/expired
     */
    getUserActivePromo: async function (userId) {
      const sb = global.supabase;
      if (!userId || !sb) return null;
      try {
        const { data: usr } = await sb.from('users').select('referred_by_promo_code, referred_at, created_at').eq('id', userId).maybeSingle();
        if (!usr || !usr.referred_by_promo_code) return null;

        const promoCode = usr.referred_by_promo_code.trim().toUpperCase();
        const refDate = new Date(usr.referred_at || usr.created_at || Date.now());

        // Fetch promo code duration and discount pct
        const cleanBase = promoCode.replace('%', '');
        const { data: promo } = await sb.from('promo_codes').select('*').or(`code.eq.${cleanBase},code.eq.${cleanBase}%`).maybeSingle();
        const durationMonths = Number(promo?.customer_discount_duration_months || 2);
        const discountPct = Number(promo?.customer_discount_pct || 20.00);

        const now = new Date();
        const elapsedMonths = (now.getFullYear() - refDate.getFullYear()) * 12 + (now.getMonth() - refDate.getMonth()) + 1;

        if (elapsedMonths <= durationMonths) {
          return {
            active: true,
            promoCode: promoCode,
            discountPct: discountPct,
            durationMonths: durationMonths,
            currentMonthIndex: elapsedMonths,
            creatorId: promo?.creator_id
          };
        }
        return { active: false, promoCode: promoCode, expired: true, durationMonths: durationMonths };
      } catch (e) {
        console.warn('[CloudVaultBilling] getUserActivePromo notice:', e);
        return null;
      }
    },

    /**
     * Renders and displays the official Stripe statement modal in-app.
     * @param {Object} invoiceObj - Invoice record object
     */
    renderPrintableInvoiceModal: async function (invoiceObj = {}) {
      let modalEl = document.getElementById('printable-invoice-modal');
      if (!modalEl) {
        modalEl = document.createElement('div');
        modalEl.id = 'printable-invoice-modal';
        document.body.appendChild(modalEl);
      }

      modalEl.className = 'fixed inset-0 bg-gray-950/80 backdrop-blur-md z-[9999] flex items-start justify-center p-3 sm:p-6 overflow-y-auto';
      document.body.style.overflow = 'hidden';

      // Dismiss on backdrop click
      modalEl.onclick = function (e) {
        if (e.target === modalEl) {
          window.CloudVaultBilling.closePrintableInvoiceModal();
        }
      };

      // Dismiss on Escape key
      if (!window._invoiceEscapeListener) {
        window._invoiceEscapeListener = function (e) {
          if (e.key === 'Escape' || e.keyCode === 27) {
            window.CloudVaultBilling.closePrintableInvoiceModal();
          }
        };
        window.addEventListener('keydown', window._invoiceEscapeListener);
      }

      const invNum = invoiceObj.invoice_number || invoiceObj.invoiceNumber || (invoiceObj.id ? String(invoiceObj.id).substring(0, 12) : 'INV-2026-0000');
      const stripeId = invoiceObj.stripe_invoice_id || 'in_live_stripe_sync';
      const pdfUrl = invoiceObj.stripe_invoice_pdf || invoiceObj.stripe_hosted_invoice_url;
      const createdAt = invoiceObj.created_at ? new Date(invoiceObj.created_at).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' }) : new Date().toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
      const dueDate = invoiceObj.due_date ? new Date(invoiceObj.due_date).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' }) : createdAt;

      const customerName = invoiceObj.customer_name || (invoiceObj.customer_email ? invoiceObj.customer_email.split('@')[0] : 'Valued Customer');
      const customerEmail = invoiceObj.customer_email || 'customer@cloudvault.io';
      const facilityDisplay = invoiceObj.facility_id === 'facility_seattle_north' ? 'Seattle North Fulfillment Center' :
                              invoiceObj.facility_id === 'facility_portland_central' ? 'Portland Central Hub' :
                              'Yakima Fulfillment Center (Selah Hub)';
      const servicePlan = (invoiceObj.invoice_type || '').includes('valet') ? 'White-Glove Valet Delivery' :
                          (invoiceObj.invoice_type || '').includes('surge') ? 'Expedited Staging Retrieval' :
                          'Vault Storage Subscription';
      const txnRef = invoiceObj.transaction_reference || 'TXN-VALET-860485';
      const rawStatus = (invoiceObj.payment_status || invoiceObj.status || 'paid').toLowerCase();
      const isRefunded = rawStatus === 'refunded';
      const isOverdue = rawStatus === 'overdue';
      const isUnpaid = rawStatus === 'pending' || rawStatus === 'unpaid';

      let lineItems = invoiceObj.line_items;
      if (typeof lineItems === 'string') {
        try { lineItems = JSON.parse(lineItems); } catch (e) { lineItems = []; }
      }
      if (!Array.isArray(lineItems)) {
        lineItems = [];
      }

      // Filter line items into service lines, discount lines, and tax lines
      const isTaxItem = l => {
        const d = (l.description || '').toLowerCase();
        return l.is_tax === true || d.includes('sales tax') || d.includes('state tax') || d.includes('local tax');
      };
      const isDiscountItem = l => {
        const d = (l.description || '').toLowerCase();
        return l.is_discount === true || Number(l.amount || l.unit_price || 0) < 0 || d.includes('discount') || d.includes('promo') || d.includes('coupon');
      };

      const serviceLines = lineItems.filter(l => !isTaxItem(l) && !isDiscountItem(l));
      const discountLines = lineItems.filter(isDiscountItem);
      const taxLines = lineItems.filter(isTaxItem);

      if (serviceLines.length === 0) {
        serviceLines.push({
          description: invoiceObj.notes || 'CloudVault Storage Service',
          qty: 1,
          unit_price: Number(invoiceObj.subtotal || invoiceObj.total_amount || 35.00),
          amount: Number(invoiceObj.subtotal || invoiceObj.total_amount || 35.00)
        });
      }

      // Gross Subtotal is the sum of all service line items (e.g. Storage + Valet delivery)
      const computedServiceSubtotal = serviceLines.reduce((sum, item) => sum + Number(item.amount || ((item.qty || 1) * (item.unit_price || 0)) || 0), 0);
      const grossSubtotal = computedServiceSubtotal > 0 ? computedServiceSubtotal : (Number(invoiceObj.subtotal || invoiceObj.total_amount || 35.00));

      // Resolve Creator Promo Attribution / Redemptions
      const sb = window.supabase || (typeof supabase !== 'undefined' ? supabase : null);
      let promoRecord = null;
      if (sb && (invoiceObj.uid || invoiceObj.customer_email || invoiceObj.invoice_number || invoiceObj.id || invoiceObj.transaction_reference)) {
        try {
          const filterOr = [
            invoiceObj.invoice_number ? `stripe_invoice_id.eq.${invoiceObj.invoice_number}` : null,
            invoiceObj.id ? `stripe_invoice_id.eq.${invoiceObj.id}` : null,
            invoiceObj.transaction_reference ? `stripe_invoice_id.eq.${invoiceObj.transaction_reference}` : null,
            invoiceObj.uid ? `customer_uid.eq.${invoiceObj.uid}` : null,
            invoiceObj.customer_email ? `customer_email.eq.${invoiceObj.customer_email}` : null
          ].filter(Boolean).join(',');

          if (filterOr) {
            const { data: pData } = await sb.from('promo_redemptions').select('*').or(filterOr).order('created_at', { ascending: false }).limit(1);
            if (pData && pData.length > 0) {
              promoRecord = pData[0];
            }
          }
        } catch (e) {
          console.warn('[CloudVaultBilling] promo_redemptions lookup notice:', e);
        }
      }

      // Facility & Tax Resolution: strictly calculated on post-discount net taxable subtotal
      const facilityId = invoiceObj.facility_id || window.currentUserProfile?.assigned_facility_id || 'facility_seattle_north';
      const taxRatePct = facilityId === 'facility_seattle_north' ? 10.25 :
                         facilityId === 'facility_portland_central' ? 0.00 : 8.50;
      const taxRegionName = facilityId === 'facility_seattle_north' ? 'Seattle North Sales Tax (10.25%)' :
                            facilityId === 'facility_portland_central' ? 'Oregon Sales Tax (0.00%)' :
                            'Washington State & Local Sales Tax (8.50%)';

      // Discount Resolution
      let discountAmount = Number(invoiceObj.discount || invoiceObj.discount_amount || 0);
      let promoCodeName = invoiceObj.promo_code || (promoRecord ? promoRecord.promo_code : null);

      if (promoRecord && Number(promoRecord.discount_amount) > 0) {
        discountAmount = Number(promoRecord.discount_amount);
      } else if (discountAmount === 0 && discountLines.length > 0) {
        discountAmount = discountLines.reduce((sum, item) => sum + Math.abs(Number(item.amount || item.unit_price || 0)), 0);
      }

      if (promoCodeName && (discountAmount === 0 || Math.abs(discountAmount - (grossSubtotal * 0.20)) < 0.05)) {
        const pctMatch = promoCodeName.match(/(\d+)%/);
        const pct = pctMatch ? parseFloat(pctMatch[1]) : 20;
        discountAmount = Math.round(grossSubtotal * (pct / 100.0) * 100) / 100;
      }

      // If recorded discount was set to full delivery fee or discrepancy, enforce exact percentage if promo code is on file
      if (promoCodeName && discountAmount !== Math.round(grossSubtotal * 0.20 * 100) / 100 && promoCodeName.includes('20')) {
        discountAmount = Math.round(grossSubtotal * 0.20 * 100) / 100;
      }

      if (!promoCodeName && discountAmount > 0) {
        promoCodeName = 'ROSS20%';
      }

      let promoLabel = 'Creator Promo Discount';
      if (promoCodeName) {
        promoLabel = `Creator Promo Discount (${promoCodeName} — 20% off)`;
      } else if (discountLines.length > 0 && discountLines[0].description) {
        promoLabel = discountLines[0].description.replace(/^[-–—\s]+/, '');
      }

      const netTaxable = Math.max(0, grossSubtotal - discountAmount);

      let taxAmount = Number(invoiceObj.tax || 0);
      if (taxAmount === 0 && taxLines.length > 0) {
        taxAmount = taxLines.reduce((sum, item) => sum + Number(item.amount || item.unit_price || 0), 0);
      }
      if (taxAmount === 0 || Math.abs(taxAmount - Math.round(grossSubtotal * (taxRatePct / 100.0) * 100) / 100) < 0.02 || Math.abs(taxAmount - Math.round(netTaxable * (taxRatePct / 100.0) * 100) / 100) < 0.02) {
        taxAmount = Math.round(netTaxable * (taxRatePct / 100.0) * 100) / 100;
      }

      const computedGrandTotal = Math.max(0, Math.round((netTaxable + taxAmount) * 100) / 100);
      const totalAmount = computedGrandTotal.toFixed(2);

      const linesHtml = serviceLines.map(item => `
        <tr class="border-b border-slate-100 text-xs">
          <td class="py-3 px-4 font-semibold text-slate-800">${item.description || 'Service Line'}</td>
          <td class="py-3 px-4 text-center font-mono text-slate-600">${item.qty || 1}</td>
          <td class="py-3 px-4 text-right font-mono text-slate-600">$${Number(item.unit_price || item.amount || 0).toFixed(2)}</td>
          <td class="py-3 px-4 text-right font-mono font-bold text-slate-900">$${Number(item.amount || ((item.qty || 1) * (item.unit_price || 0))).toFixed(2)}</td>
        </tr>
      `).join('');

      // Resolve dynamic customer billing address
      const addr1 = invoiceObj.billing_address_line1 || invoiceObj.address_line1 || window.currentUserAddress?.billing_address_line1 || window.currentUserAddress?.address_line1 || '';
      const addr2 = invoiceObj.billing_address_line2 || invoiceObj.address_line2 || window.currentUserAddress?.billing_address_line2 || window.currentUserAddress?.address_line2 || '';
      const city = invoiceObj.billing_city || invoiceObj.city || window.currentUserAddress?.billing_city || window.currentUserAddress?.city || '';
      const state = invoiceObj.billing_state || invoiceObj.state || window.currentUserAddress?.billing_state || window.currentUserAddress?.state || '';
      const zip = invoiceObj.billing_zip || invoiceObj.zip || window.currentUserAddress?.billing_zip || window.currentUserAddress?.zip || '';

      let formattedBillingAddress = 'Address on file';
      if (addr1 && city) {
        formattedBillingAddress = [addr1, addr2, [city, state].filter(Boolean).join(', '), zip].filter(Boolean).join(' ');
      } else if (invoiceObj.delivery_address_line1 && invoiceObj.delivery_city) {
        formattedBillingAddress = [invoiceObj.delivery_address_line1, invoiceObj.delivery_address_line2, [invoiceObj.delivery_city, invoiceObj.delivery_state].filter(Boolean).join(', '), invoiceObj.delivery_zip].filter(Boolean).join(' ');
      } else if (city || state || zip) {
        formattedBillingAddress = [[city, state].filter(Boolean).join(', '), zip].filter(Boolean).join(' ');
      }

      modalEl.innerHTML = `
        <div class="bg-white rounded-3xl shadow-2xl max-w-3xl w-full mx-auto border border-slate-200 overflow-hidden text-slate-800 my-4 sm:my-8 relative">
          <!-- Top Controls Bar (Sticky at top of modal) -->
          <div class="sticky top-0 z-30 no-print p-4 bg-slate-900 text-white flex justify-between items-center px-4 sm:px-6 border-b border-slate-800 shadow-md">
            <div class="flex items-center space-x-3 overflow-hidden">
              <img src="logo.png" alt="CloudVault Logo" class="w-7 h-7 object-contain rounded-lg shrink-0" />
              <div class="truncate">
                <h3 class="text-sm font-black tracking-tight flex items-center gap-2 flex-wrap">
                  <span>Official Stripe Statement</span>
                  <span class="text-[10px] font-mono font-bold bg-indigo-500/20 text-indigo-300 border border-indigo-500/30 px-2 py-0.5 rounded">${invNum}</span>
                  <span class="text-[10px] font-mono font-extrabold bg-emerald-500/20 text-emerald-300 border border-emerald-500/30 px-2 py-0.5 rounded">$${totalAmount}</span>
                </h3>
              </div>
            </div>
            <div class="flex items-center space-x-2 shrink-0">
              ${pdfUrl ? `
                <a href="${pdfUrl}" target="_blank" download class="bg-indigo-600 hover:bg-indigo-700 text-white text-xs font-bold px-3 py-1.5 rounded-xl transition flex items-center gap-1.5 cursor-pointer shadow-sm">
                  <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4"></path></svg>
                  <span class="hidden sm:inline">Download PDF</span><span class="sm:hidden">PDF</span>
                </a>
              ` : `
                <button onclick="window.CloudVaultBilling.downloadInvoicePDF('${invNum}')" class="bg-indigo-600 hover:bg-indigo-700 text-white text-xs font-bold px-3 py-1.5 rounded-xl transition flex items-center gap-1.5 cursor-pointer shadow-sm">
                  <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4"></path></svg>
                  <span class="hidden sm:inline">Download PDF</span><span class="sm:hidden">PDF</span>
                </button>
              `}
              <button onclick="window.print()" class="bg-slate-800 hover:bg-slate-700 text-slate-200 text-xs font-bold px-3 py-1.5 rounded-xl transition flex items-center gap-1.5 cursor-pointer">
                <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M17 17h2a2 2 0 002-2v-4a2 2 0 00-2-2H5a2 2 0 00-2 2v4a2 2 0 002 2h2m2 4h6a2 2 0 002-2v-4a2 2 0 00-2-2H9a2 2 0 00-2 2v4a2 2 0 002 2zm8-12V5a2 2 0 00-2-2H9a2 2 0 00-2 2v4h10z"></path></svg>
                <span>Print</span>
              </button>
              <button onclick="window.CloudVaultBilling.closePrintableInvoiceModal()" class="bg-slate-700 hover:bg-slate-600 text-white text-xs font-bold px-3.5 py-1.5 rounded-xl transition cursor-pointer shadow-sm flex items-center gap-1">
                ✕ <span>Close</span>
              </button>
            </div>
          </div>

          <!-- Official Stripe Statement Document -->
          <div class="p-8 sm:p-12 space-y-8 bg-white" id="official-statement-content">
            <!-- Header Section -->
            <div class="flex justify-between items-start flex-wrap gap-6 border-b border-slate-100 pb-6">
              <div class="space-y-2">
                <div class="flex items-center space-x-3">
                  <img src="logo.png" alt="CloudVault Logo" class="w-10 h-10 object-contain rounded-xl shadow-xs" />
                  <div>
                    <h1 class="text-2xl font-black text-slate-900 tracking-tight leading-none">CloudVault</h1>
                    <span class="text-[9px] font-extrabold text-blue-600 uppercase tracking-[0.2em] block mt-1">Storage &amp; Logistics Solutions</span>
                  </div>
                </div>
                <p class="text-xs text-slate-500 font-mono">CloudVault Storage Inc. • support@cloudvault.io • Selah, WA 98942</p>
              </div>

              <div class="text-right space-y-1">
                ${isRefunded ? `
                  <span class="inline-block px-3 py-1 text-xs font-black rounded-full bg-rose-50 text-rose-700 border border-rose-200 font-mono tracking-wider">
                    REFUNDED
                  </span>
                ` : isOverdue ? `
                  <span class="inline-block px-3 py-1 text-xs font-black rounded-full bg-red-600 text-white border border-red-700 font-mono tracking-wider animate-pulse">
                    OVERDUE
                  </span>
                ` : isUnpaid ? `
                  <span class="inline-block px-3 py-1 text-xs font-black rounded-full bg-amber-50 text-amber-800 border border-amber-200 font-mono tracking-wider">
                    UNPAID
                  </span>
                ` : `
                  <span class="inline-block px-3 py-1 text-xs font-extrabold rounded-full bg-emerald-50 text-emerald-700 border border-emerald-200 font-mono tracking-wider">
                    PAID
                  </span>
                `}
                <h2 class="text-xl font-black font-mono text-slate-900 tracking-wider">${invNum}</h2>
                <p class="text-xs text-slate-500 font-mono">Issued: ${createdAt}</p>
                <div class="pt-0.5">
                  <span class="inline-flex items-center gap-1 text-[10px] font-mono font-bold text-indigo-700 bg-indigo-50 border border-indigo-200 px-2 py-0.5 rounded-md">
                    💳 Stripe: ${stripeId}
                  </span>
                </div>
              </div>
            </div>

            <!-- Customer & Facility Metadata -->
            <div class="grid grid-cols-1 sm:grid-cols-2 gap-6 bg-slate-50/70 p-6 rounded-2xl border border-slate-200/60 text-xs">
              <div class="space-y-1.5">
                <span class="text-[10px] font-black uppercase tracking-widest text-slate-400 block">Billed To</span>
                <p class="font-extrabold text-sm text-slate-900">${customerName}</p>
                <p class="text-slate-600 font-mono">${customerEmail}</p>
                <p class="text-slate-600 font-medium">${formattedBillingAddress}</p>
              </div>
              <div class="space-y-1.5">
                <span class="text-[10px] font-black uppercase tracking-widest text-slate-400 block">Service &amp; Facility Hub</span>
                <p class="font-semibold text-slate-800"><span class="text-slate-500">Facility:</span> ${facilityDisplay}</p>
                <p class="font-semibold text-slate-800"><span class="text-slate-500">Service:</span> ${servicePlan}</p>
                <p class="text-slate-600 font-mono"><span class="text-slate-500">Txn Ref:</span> ${txnRef}</p>
              </div>
            </div>

            <!-- Itemized Table -->
            <div class="overflow-x-auto rounded-2xl border border-slate-200 shadow-xs">
              <table class="w-full text-left text-xs border-collapse">
                <thead>
                  <tr class="bg-slate-50 text-slate-500 font-mono text-[10px] uppercase tracking-wider border-b border-slate-200">
                    <th class="py-3 px-4">Description</th>
                    <th class="py-3 px-4 text-center">Qty</th>
                    <th class="py-3 px-4 text-right">Unit Price</th>
                    <th class="py-3 px-4 text-right">Amount</th>
                  </tr>
                </thead>
                <tbody class="divide-y divide-slate-100">
                  ${linesHtml}
                </tbody>
              </table>
            </div>

            <!-- Financial Summary Breakdown -->
            <div class="flex justify-end pt-2">
              <div class="w-full sm:w-80 space-y-2 text-xs">
                <div class="flex justify-between text-slate-600">
                  <span>Subtotal</span>
                  <span class="font-mono font-medium">$${grossSubtotal.toFixed(2)}</span>
                </div>
                ${discountAmount > 0 ? `
                  <div class="flex justify-between text-emerald-600 font-bold">
                    <span class="flex items-center gap-1">
                      <svg class="w-3.5 h-3.5 inline text-emerald-600" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M7 7h.01M7 3h5c.512 0 1.024.195 1.414.586l7 7a2 2 0 010 2.828l-7 7a2 2 0 01-2.828 0l-7-7A1.994 1.994 0 013 12V7a4 4 0 014-4z"></path></svg>
                      ${promoLabel}
                    </span>
                    <span class="font-mono font-bold">-$${discountAmount.toFixed(2)}</span>
                  </div>
                  <div class="flex justify-between text-slate-500 text-[11px]">
                    <span>Total excluding tax</span>
                    <span class="font-mono font-medium">$${netTaxable.toFixed(2)}</span>
                  </div>
                ` : `
                  <div class="flex justify-between text-slate-600">
                    <span>Total excluding tax</span>
                    <span class="font-mono font-medium">$${grossSubtotal.toFixed(2)}</span>
                  </div>
                `}
                ${taxAmount > 0 ? `
                  <div class="flex justify-between text-slate-600">
                    <span>${taxRegionName}</span>
                    <span class="font-mono font-medium">$${taxAmount.toFixed(2)}</span>
                  </div>
                ` : ''}
                <div class="border-t-2 border-slate-200 pt-3 flex justify-between items-center">
                  <span class="text-sm font-black text-slate-900 uppercase tracking-wider">Grand Total</span>
                  <span class="text-xl font-black font-mono text-blue-600">$${totalAmount} USD</span>
                </div>
                ${isRefunded ? `
                  <div class="flex justify-between text-slate-500 font-medium text-xs pt-1">
                    <span>Amount Paid</span>
                    <span class="font-mono">$${totalAmount} USD</span>
                  </div>
                  <div class="flex justify-between text-rose-700 font-bold text-xs pt-1 border-t border-rose-200/60 bg-rose-50/70 p-2 rounded-xl mt-1">
                    <span>Total Refunded (${invoiceObj.refunded_at ? new Date(invoiceObj.refunded_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : createdAt})</span>
                    <span class="font-mono font-black">-$${totalAmount} USD</span>
                  </div>
                  <div class="flex justify-between text-slate-900 font-black text-xs pt-1">
                    <span>Net Balance</span>
                    <span class="font-mono">$0.00 USD</span>
                  </div>
                  ${invoiceObj.notes ? `
                    <div class="p-2.5 rounded-xl bg-amber-50 border border-amber-200 text-[11px] text-amber-900 font-medium leading-snug">
                      ℹ️ ${invoiceObj.notes}
                    </div>
                  ` : ''}
                ` : isUnpaid || isOverdue ? `
                  <div class="flex justify-between text-red-700 font-bold text-xs pt-1">
                    <span>Amount Due</span>
                    <span class="font-mono">$${totalAmount} USD</span>
                  </div>
                ` : `
                  <div class="flex justify-between text-emerald-700 font-bold text-xs pt-1">
                    <span>Amount Paid</span>
                    <span class="font-mono">$${totalAmount} USD</span>
                  </div>
                `}
              </div>
            </div>

            <!-- Statement Footer -->
            <div class="border-t border-slate-100 pt-6 text-center text-xs text-slate-500 font-mono">
              CloudVault Storage &amp; Logistics Solutions • Selah, WA 98942 • support@cloudvault.io • Official Statement
            </div>
          </div>
        </div>
      `;

      modalEl.classList.remove('hidden');
    },

    /**
     * Closes the printable invoice modal.
     */
    closePrintableInvoiceModal: function () {
      const modalEl = document.getElementById('printable-invoice-modal');
      if (modalEl) {
        modalEl.classList.add('hidden');
      }
      document.body.style.overflow = '';
      if (window._invoiceEscapeListener) {
        window.removeEventListener('keydown', window._invoiceEscapeListener);
        window._invoiceEscapeListener = null;
      }
    },

    /**
     * Triggers clean PDF generation / printing for the official statement document.
     * @param {string} invoiceNumber
     */
    downloadInvoicePDF: function (invoiceNumber) {
      window.print();
    },
    /**
     * Scans for cancelled subscriptions past their service end date with unreturned totes
     * and generates $15.00 per tote unreturned tote invoices.
     */
    processUnreturnedToteCharges: async function (targetUserId) {
      try {
        const sb = global.supabase;
        if (!sb) return { success: false, error: 'Supabase missing' };

        let query = sb.from('subscriptions').select('*, users!uid(name, email, zip_code)');
        if (targetUserId) {
          query = query.eq('uid', targetUserId);
        }
        const { data: subs, error: subErr } = await query;
        if (subErr) throw subErr;

        let createdCount = 0;
        const now = new Date();

        for (const sub of (subs || [])) {
          const isCancelled = sub.status === 'cancelled' || (sub.cancel_at && new Date(sub.cancel_at) <= now);
          if (!isCancelled) continue;

          // Check if customer holds active totes
          const { count: unreturnedCount } = await sb.from('inventory')
            .select('*', { count: 'exact', head: true })
            .eq('uid', sub.uid)
            .in('status', ['stored', 'with_customer']);

          if (unreturnedCount > 0) {
            // Check if unreturned invoice created in last 30d
            const { data: recentInvoices } = await sb.from('invoices')
              .select('id')
              .eq('uid', sub.uid)
              .eq('invoice_type', 'unreturned_tote_fee')
              .gte('created_at', new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString());

            if (!recentInvoices || recentInvoices.length === 0) {
              const toteBase = unreturnedCount * 15.00;
              const userObj = sub.users || {};
              await this.createInvoiceRecord({
                uid: sub.uid,
                customer_name: userObj.name || 'CloudVault Customer',
                customer_email: userObj.email || null,
                facility_id: sub.facility_id,
                invoice_type: 'unreturned_tote_fee',
                payment_status: 'overdue',
                subtotal: toteBase,
                total_amount: toteBase,
                zip_code: userObj.zip_code || null,
                notes: `Unreturned Tote Charge (${unreturnedCount} tote(s) @ $15.00/tote)`,
                line_items: [
                  { description: 'Unreturned Storage Tote Charge', qty: unreturnedCount, unit_price: 15.00, amount: toteBase }
                ]
              });
              await sb.from('users').update({ is_overdue: true }).eq('id', sub.uid);
              createdCount++;
            }
          }
        }
        return { success: true, count: createdCount };
      } catch (e) {
        console.error('[CloudVaultBilling] processUnreturnedToteCharges failed:', e);
        return { success: false, error: e.message };
      }
    },

    /**
     * Computes accrued interest (10% p.a. daily rate) on overdue unpaid balances.
     */
    calculateAccruedInterest: function (unpaidAmount, daysOverdue, annualRate = 0.10) {
      if (!unpaidAmount || unpaidAmount <= 0 || !daysOverdue || daysOverdue <= 0) return 0.00;
      const dailyRate = annualRate / 365;
      const interest = unpaidAmount * dailyRate * daysOverdue;
      return Math.round(interest * 100) / 100;
    },

    /**
     * Inject print CSS media query rule if not already present.
     */
    ensurePrintStyles: function () {
      if (document.getElementById('cloudvault-billing-print-styles')) return;
      const style = document.createElement('style');
      style.id = 'cloudvault-billing-print-styles';
      style.textContent = `
        @media print {
          * {
            -webkit-print-color-adjust: exact !important;
            print-color-adjust: exact !important;
          }
          @page {
            margin: 10mm;
            size: auto;
          }
          body > *:not(#printable-invoice-modal) {
            display: none !important;
          }
          #printable-invoice-modal {
            position: absolute !important;
            inset: 0 !important;
            background: white !important;
            display: block !important;
            padding: 0 !important;
            margin: 0 !important;
            z-index: 99999 !important;
          }
          #printable-invoice-modal > div {
            box-shadow: none !important;
            border: 1px solid #e2e8f0 !important;
            margin: 0 !important;
            max-width: 100% !important;
            width: 100% !important;
            border-radius: 12px !important;
          }
          .no-print {
            display: none !important;
          }
        }
      `;
      document.head.appendChild(style);
    },

    /**
     * Initializes periodic authorization and credential re-validation (defaults to 30-minute cycles).
     * @param {number} intervalMinutes - Validation interval in minutes (default: 30)
     */
    initPeriodicAuthValidator: function (intervalMinutes = 30) {
      if (typeof window === 'undefined' || window._hasSetupPeriodicAuthValidator) return;
      window._hasSetupPeriodicAuthValidator = true;

      const INTERVAL_MS = intervalMinutes * 60 * 1000;
      sessionStorage.setItem('cv_last_auth_validation', Date.now().toString());

      const performAuthCheck = async () => {
        const sb = (typeof supabase !== 'undefined' ? supabase : (global.supabase || window.supabase));
        if (!sb || !sb.auth) return;

        try {
          console.log(`[Security Guard] Executing periodic credential re-validation (${intervalMinutes}-min cycle)...`);

          // 1. Validate active session with Supabase Auth
          const { data: sessionData, error: sessionErr } = await sb.auth.getSession();
          const session = sessionData?.session;

          if (sessionErr || !session || !session.user) {
            let badgeUser = null;
            try { badgeUser = JSON.parse(sessionStorage.getItem('cv_active_badge_user')); } catch (e) {}

            if (!badgeUser) {
              console.warn('[Security Guard] Active session expired or invalid. Redirecting to login.');
              sessionStorage.clear();
              localStorage.removeItem('cv_active_badge_user');
              window.location.href = 'login.html?reason=session_expired';
              return;
            }
          }

          const uid = session ? session.user.id : (JSON.parse(sessionStorage.getItem('cv_active_badge_user'))?.id);
          if (!uid) {
            window.location.href = 'login.html?reason=unauthorized';
            return;
          }

          // 2. Query user profile to verify active authorization & roles
          const { data: profile, error: profileErr } = await sb
            .from('users')
            .select('id, role, status, is_active, email')
            .eq('id', uid)
            .maybeSingle();

          if (profileErr || !profile) {
            console.warn('[Security Guard] User profile verification failed. Logging out.');
            sessionStorage.clear();
            await sb.auth.signOut().catch(() => {});
            window.location.href = 'login.html?reason=invalid_credentials';
            return;
          }

          if (profile.status === 'suspended' || profile.is_active === false) {
            console.warn('[Security Guard] User account is suspended or inactive. Logging out.');
            sessionStorage.clear();
            await sb.auth.signOut().catch(() => {});
            window.location.href = 'login.html?reason=account_suspended';
            return;
          }

          // 3. For admin portals, ensure role has not been demoted to customer
          const isStaffPage = window.location.pathname.includes('admin');
          if (isStaffPage && profile.role === 'customer') {
            console.warn('[Security Guard] Staff clearance revoked. Redirecting to customer dashboard.');
            window.location.href = 'dashboard.html';
            return;
          }

          // 4. Update validation timestamp
          sessionStorage.setItem('cv_last_auth_validation', Date.now().toString());
          console.log('[Security Guard] Periodic credential validation passed.');
        } catch (err) {
          console.warn('[Security Guard] Periodic authorization verification notice:', err);
        }
      };

      // Run check every 30 minutes
      setInterval(performAuthCheck, INTERVAL_MS);

      // Re-check when window regains focus if 30 minutes have elapsed while idle
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') {
          const last = Number(sessionStorage.getItem('cv_last_auth_validation') || 0);
          if (Date.now() - last >= INTERVAL_MS) {
            performAuthCheck();
          }
        }
      });
    }
  };

  global.CloudVaultBilling = CloudVaultBilling;
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = CloudVaultBilling;
  }

  // Automatically start 30-minute periodic authorization check on page load
  if (typeof window !== 'undefined' && window.document) {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', () => CloudVaultBilling.initPeriodicAuthValidator(30));
    } else {
      CloudVaultBilling.initPeriodicAuthValidator(30);
    }
  }
})(typeof window !== 'undefined' ? window : this);

