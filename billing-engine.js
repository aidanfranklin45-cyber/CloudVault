/**
 * CloudVault Core Billing Engine & Invoice Management Module
 * Window Global: window.CloudVaultBilling
 */
(function (global) {
  'use strict';

  const CloudVaultBilling = {
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
      let rates = { tier1: 5.00, tier2: 3.50, tier3: 2.00, tier4: 1.00 };
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

        const oldTotes = rpcRes.oldTotes;
        const newTotes = rpcRes.newTotes;
        const oldRate = Number(rpcRes.oldRate) || 0;
        const newRate = Number(rpcRes.newRate) || 0;
        const newMonthly = Number(rpcRes.newMonthly) || 0;

        const rateChanged = oldRate !== newRate;
        const noteText = rateChanged
          ? `Partial Tote Unsubscribe: Reduced ${reduceCount} tote(s) (${oldTotes} -> ${newTotes}). Volume tier rate updated from $${oldRate.toFixed(2)} to $${newRate.toFixed(2)}/tote/mo.`
          : `Partial Tote Unsubscribe: Reduced ${reduceCount} tote(s) (${oldTotes} -> ${newTotes}). Maintained rate of $${newRate.toFixed(2)}/tote/mo.`;

        const invRes = await this.createInvoiceRecord({
          uid: userId,
          customer_name: user.name || 'Valued Customer',
          customer_email: user.email,
          facility_id: user.assigned_facility_id,
          invoice_type: 'subscription_modification',
          payment_status: 'processed',
          subtotal: newMonthly,
          total_amount: newMonthly,
          payment_method: 'account_adjustment',
          transaction_reference: `SUB-MOD-${Date.now().toString().slice(-6)}`,
          notes: noteText,
          line_items: [
            {
              description: `Subscription Modification: Tote Reduction (${oldTotes} totes down to ${newTotes} totes @ $${newRate.toFixed(2)}/mo)`,
              qty: newTotes,
              unit_price: newRate,
              amount: newMonthly
            }
          ]
        });

        return {
          success: true,
          result: rpcRes,
          invoice: invRes.data || null,
          message: noteText
        };
      } catch (err) {
        console.error('[CloudVaultBilling] Exception in processToteReduction:', err);
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
        let valetBase = 15.00;
        let valetAdder = 1.00;
        const facId = req.facility_id || userObj.assigned_facility_id;
        if (sb && facId) {
          try {
            const { data: fac } = await sb.from('facilities')
              .select('valet_base, valet_tote_adder')
              .eq('id', facId)
              .maybeSingle();
            if (fac) {
              valetBase = Number(fac.valet_base) || 15.00;
              valetAdder = Number(fac.valet_tote_adder) || 1.00;
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
        let valetBase = 15.00;
        let valetAdder = 1.00;
        const facId = req.facility_id || userObj.assigned_facility_id;
        if (sb && facId) {
          try {
            const { data: fac } = await sb.from('facilities')
              .select('valet_base, valet_tote_adder')
              .eq('id', facId)
              .maybeSingle();
            if (fac) {
              valetBase = Number(fac.valet_base) || 15.00;
              valetAdder = Number(fac.valet_tote_adder) || 1.00;
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

        // 2. Direct indexed query on public.invoices (single fast round-trip)
        let query = sb.from('invoices').select('*');

        if (userId && customerEmail) {
          query = query.or(`uid.eq.${userId},customer_email.eq.${customerEmail}`);
        } else if (userId) {
          query = query.eq('uid', userId);
        } else {
          query = query.eq('customer_email', customerEmail);
        }

        let { data, error } = await query.order('created_at', { ascending: false });

        if (error) {
          console.error('[CloudVaultBilling] Error fetching invoices:', error);
          return { success: false, error: error.message, invoices: [] };
        }

        // 3. If no invoices exist for this user, check if they have an active subscription and synthesize only their initial invoice
        if ((!data || data.length === 0) && userId) {
          try {
            const { data: sub } = await sb.from('subscriptions').select('*').eq('uid', userId).maybeSingle();
            if (sub) {
              const toteCount = Number(sub.total_totes || sub.tote_count || 1);
              const toteRate = Number(sub.tote_rate || 3.50);
              const storageAmt = Number(sub.recurring_storage || (toteCount * toteRate));
              const valetFee = Number(sub.valet_fee || 0);
              const total = Number(sub.first_month_total || (storageAmt + valetFee));
              const createdAt = sub.created_at || new Date().toISOString();

              const created = await this.createInvoiceRecord({
                uid: userId,
                customer_name: customerEmail ? customerEmail.split('@')[0] : 'Valued Customer',
                customer_email: customerEmail || null,
                facility_id: sub.facility_id || 'facility_seattle_north',
                invoice_type: 'subscription',
                payment_status: 'paid',
                subtotal: storageAmt,
                delivery_fee: valetFee,
                total_amount: total,
                payment_method: 'card',
                notes: 'Initial subscription signup invoice receipt',
                line_items: [
                  {
                    description: `CloudVault Storage Subscription (${toteCount} totes @ $${toteRate.toFixed(2)}/mo)`,
                    qty: toteCount,
                    unit_price: toteRate,
                    amount: storageAmt
                  }
                ],
                created_at: createdAt,
                paid_at: createdAt
              });
              if (created && created.success && created.data) {
                data = [created.data];
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
                const { count: invToteCount } = await sb.from('inventory').select('*', { count: 'exact', head: true }).eq('uid', inv.uid);
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
     * Renders and displays the executive printable invoice modal (#printable-invoice-modal).
     * @param {Object} invoiceObj - Invoice record object
     */
    /**
     * Renders and displays the executive printable invoice modal (#printable-invoice-modal).
     * @param {Object} invoiceObj - Invoice record object
     */
    renderPrintableInvoiceModal: async function (invoiceObj = {}) {
      this.ensurePrintStyles();

      let modalEl = document.getElementById('printable-invoice-modal');
      if (!modalEl) {
        modalEl = document.createElement('div');
        modalEl.id = 'printable-invoice-modal';
        document.body.appendChild(modalEl);
      }

      modalEl.className = 'fixed inset-0 bg-gray-900/70 backdrop-blur-sm z-[9999] flex items-center justify-center p-4 sm:p-6 overflow-y-auto';

      const sb = global.supabase;
      const invType = (invoiceObj.invoice_type || invoiceObj.invoiceType || '').toLowerCase();
      const isSubscriptionInvoice = invType === 'subscription' || invType === 'initial_reservation' || invType === 'monthly_subscription';

      let activeToteCount = Number(invoiceObj.tote_count || invoiceObj.total_totes || invoiceObj.totes || 0);
      let userSub = null;
      let userObj = null;

      // Cross-reference customer's subscription & user records from Supabase if available
      if (sb && (invoiceObj.uid || invoiceObj.customer_email)) {
        try {
          if (invoiceObj.uid) {
            const { data: sData } = await sb.from('subscriptions').select('*').eq('uid', invoiceObj.uid).maybeSingle();
            userSub = sData;
            const { data: uData } = await sb.from('users').select('*').eq('id', invoiceObj.uid).maybeSingle();
            userObj = uData;
          } else if (invoiceObj.customer_email) {
            const { data: uData } = await sb.from('users').select('*').eq('email', invoiceObj.customer_email).maybeSingle();
            userObj = uData;
            if (userObj) {
              const { data: sData } = await sb.from('subscriptions').select('*').eq('uid', userObj.id).maybeSingle();
              userSub = sData;
            }
          }
        } catch (e) {
          console.warn('[CloudVaultBilling] Modal subscription cross-reference notice:', e);
        }
      }

      if (userSub && Number(userSub.total_totes || userSub.tote_count || 0) > 0) {
        activeToteCount = Number(userSub.total_totes || userSub.tote_count);
      }

      let lineItems = invoiceObj.line_items || invoiceObj.lineItems || [];
      if (typeof lineItems === 'string') {
        try { lineItems = JSON.parse(lineItems); } catch (e) { lineItems = []; }
      }
      if (!Array.isArray(lineItems)) lineItems = [];

      const targetUid = invoiceObj.uid || (userObj ? userObj.id : null);
      
      // Cross-reference user's inventory & access requests to accurately resolve true home facility
      let resolvedFacId = invoiceObj.facility_id || userSub?.facility_id || userObj?.assigned_facility_id || null;
      if (sb && targetUid) {
        try {
          const { data: uData } = await sb.from('users').select('id, name, email, active_zone, assigned_facility_id').eq('id', targetUid).maybeSingle();
          if (uData && uData.assigned_facility_id) {
            resolvedFacId = uData.assigned_facility_id;
          }
          if (!resolvedFacId) {
            const { data: invTotes } = await sb.from('inventory').select('facility_id').eq('uid', targetUid).limit(1);
            if (invTotes && invTotes[0] && invTotes[0].facility_id) {
              resolvedFacId = invTotes[0].facility_id;
            }
          }
          if (!resolvedFacId) {
            const { data: arData } = await sb.from('access_requests').select('facility_id').eq('uid', targetUid).order('created_at', { ascending: false }).limit(1);
            if (arData && arData[0] && arData[0].facility_id) {
              resolvedFacId = arData[0].facility_id;
            }
          }
        } catch (e) {
          console.warn('[CloudVaultBilling] Facility lookup cross-reference notice:', e);
        }
      }

      // Check customer profile context for regional hints (e.g. ZIPs: 972xx -> Portland, 989xx -> Yakima, 981xx -> Seattle)
      const userZip = String(userObj?.active_zone || invoiceObj.zip_code || (userObj?.address ? String(userObj.address).match(/\b\d{5}\b/)?.[0] : '') || '').trim();
      const contextStr = `${invoiceObj.customer_name || ''} ${invoiceObj.customerEmail || ''} ${invoiceObj.notes || ''} ${userObj?.name || ''} ${userZip}`.toLowerCase();
      
      if (!resolvedFacId || resolvedFacId === 'facility_seattle_north') {
        if (contextStr.includes('portland') || contextStr.includes('pdx') || userZip.startsWith('972')) {
          resolvedFacId = 'facility_portland_central';
        } else if (contextStr.includes('yakima') || userZip.startsWith('989')) {
          resolvedFacId = 'facility_yakima';
        } else if (contextStr.includes('seattle') || userZip.startsWith('981')) {
          resolvedFacId = 'facility_seattle_north';
        }
      }
      const targetFacId = resolvedFacId || 'facility_portland_central';

      let facilityDisplay = 'Portland Central Hub (facility_portland_central)';
      const facKey = String(targetFacId).toLowerCase();
      if (facKey.includes('portland') || contextStr.includes('portland') || userZip.startsWith('972')) {
        facilityDisplay = 'Portland Central Hub (facility_portland_central)';
      } else if (facKey.includes('yakima') || contextStr.includes('yakima') || userZip.startsWith('989')) {
        facilityDisplay = 'Yakima Hub (facility_yakima)';
      } else if (facKey.includes('seattle') || contextStr.includes('seattle') || userZip.startsWith('981')) {
        facilityDisplay = 'Seattle North Hub (facility_seattle_north)';
      } else {
        facilityDisplay = `${targetFacId.replace(/facility_/g, '').replace(/_/g, ' ').toUpperCase()} (${targetFacId})`;
      }

      let subtotal = Number(invoiceObj.subtotal || 0);
      let deliveryFee = Number(invoiceObj.delivery_fee || invoiceObj.deliveryFee || 0);
      let surgeFee = Number(invoiceObj.surge_fee || invoiceObj.surgeFee || 0);
      let tax = Number(invoiceObj.tax || 0);
      let discount = Number(invoiceObj.discount || 0);

      // Dynamically resolve tax rate from database tables (service_areas, operational_zones, RPC)
      let dbTaxRate = null;
      let dbTaxLabel = null;

      if (sb) {
        try {
          const custZip = userZip || null;
          
          // 1. Direct query against public.service_areas table for customer's ZIP
          if (custZip) {
            const { data: saZip } = await sb.from('service_areas')
              .select('tax_rate, tax_label, city, state')
              .eq('zip_code', custZip)
              .maybeSingle();
            if (saZip && saZip.tax_rate != null) {
              dbTaxRate = Number(saZip.tax_rate);
              const loc = [saZip.city, saZip.state].filter(Boolean).join(', ');
              dbTaxLabel = saZip.tax_label || `${loc || 'Local'} Sales Tax (${(dbTaxRate * 100).toFixed(2)}%)`;
            }
          }

          // 2. Query service_areas by facility_id — only if it's a *primary* row for this facility
          // (avoid picking up another facility's zone for cross-city customers)
          if (dbTaxRate == null && targetFacId) {
            const { data: saFac } = await sb.from('service_areas')
              .select('tax_rate, tax_label, city, state, facility_id')
              .eq('facility_id', targetFacId)
              .not('tax_rate', 'is', null)
              .limit(1);
            if (saFac && saFac[0] && saFac[0].tax_rate != null && saFac[0].facility_id === targetFacId) {
              dbTaxRate = Number(saFac[0].tax_rate);
              const loc = [saFac[0].city, saFac[0].state].filter(Boolean).join(', ');
              dbTaxLabel = saFac[0].tax_label || `${loc || 'Regional'} Sales Tax (${(dbTaxRate * 100).toFixed(2)}%)`;
            }
          }

          // 3. Query get_tax_rate_for_zip database function
          if (dbTaxRate == null && custZip) {
            const { data: rpcRate } = await sb.rpc('get_tax_rate_for_zip', { p_zip: custZip });
            if (rpcRate != null) {
              dbTaxRate = Number(rpcRate);
              dbTaxLabel = `State & Local Sales Tax (${(dbTaxRate * 100).toFixed(2)}%)`;
            }
          }
        } catch (dbTaxErr) {
          console.warn('[CloudVaultBilling] Database dynamic tax rate lookup notice:', dbTaxErr);
        }
      }

      // service_areas table is the sole source of truth for tax rates.
      // No hardcoded city/ZIP fallbacks — if not configured, tax is $0.00.
      const taxRate = dbTaxRate != null ? dbTaxRate : 0.00;
      const taxRegionLabel = dbTaxLabel || (dbTaxRate === 0 ? 'Tax-Exempt Region (0.00%)' : 'Not Configured');

      const taxableBase = Math.max(0, subtotal + deliveryFee + surgeFee);
      if ((!tax || tax === 0) && taxableBase > 0 && taxRate > 0) {
        tax = Math.round(taxableBase * taxRate * 100) / 100;
      }

      let grandTotal = Number(invoiceObj.total_amount || invoiceObj.totalAmount || 0);
      if (grandTotal === 0 || Math.abs(grandTotal - (subtotal + deliveryFee + surgeFee)) < 0.01) {
        grandTotal = Math.max(0, subtotal + deliveryFee + surgeFee + tax - discount);
      }

      const formatMoney = (val) => {
        const n = Number(val) || 0;
        if (n < 0) return `-$${Math.abs(n).toFixed(2)}`;
        return `$${n.toFixed(2)}`;
      };

      const invoiceNum = invoiceObj.invoice_number || invoiceObj.invoiceNumber || 'INV-2026-00000';
      const status = (invoiceObj.payment_status || invoiceObj.paymentStatus || 'paid').toUpperCase();
      const customerName = invoiceObj.customer_name || (userObj ? userObj.name : null) || invoiceObj.customerName || 'Valued CloudVault Customer';
      const customerEmail = invoiceObj.customer_email || (userObj ? userObj.email : null) || invoiceObj.customerEmail || 'N/A';
      const facilityId = invoiceObj.facility_id || (userObj ? userObj.assigned_facility_id : null) || invoiceObj.facilityId || 'CloudVault Central Facility';
      const paymentMethod = invoiceObj.payment_method || invoiceObj.paymentMethod || 'Credit Card (Stripe)';
      const txnRef = invoiceObj.transaction_reference || invoiceObj.transactionReference || 'N/A';
      const notes = invoiceObj.notes || '';

      const createdAt = invoiceObj.created_at || invoiceObj.createdAt
        ? new Date(invoiceObj.created_at || invoiceObj.createdAt).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
        : new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });

      const paidAt = invoiceObj.paid_at || invoiceObj.paidAt
        ? new Date(invoiceObj.paid_at || invoiceObj.paidAt).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' })
        : (status === 'PAID' ? createdAt : 'Pending');

      let statusBadgeClasses = 'bg-emerald-500/10 text-emerald-700 border-emerald-300';
      if (status === 'PENDING') statusBadgeClasses = 'bg-amber-500/10 text-amber-700 border-amber-300';
      else if (status === 'OVERDUE' || status === 'FAILED') statusBadgeClasses = 'bg-red-500/10 text-red-700 border-red-300';

      let upsellBannerHtml = '';
      let currentTier = { tierName: 'Standard Volume', toteRate: 5.00 };
      let effectiveRate = 5.00;

      if (isSubscriptionInvoice) {
        const hasStoredLineItems = lineItems.length > 0;
        if (!hasStoredLineItems) {
          if (!activeToteCount || activeToteCount < 1) activeToteCount = 1;
          // Resolve dynamic customer pricing (Price Lock immunity + facility regional rates)
          const pricingRes = await this.resolveCustomerPricing(targetUid, targetFacId, activeToteCount);
          currentTier = pricingRes;
          effectiveRate = pricingRes.toteRate;
          const accurateStorageSubtotal = activeToteCount * effectiveRate;
          subtotal = accurateStorageSubtotal;
          lineItems.unshift({
            description: `CloudVault Storage Subscription (${activeToteCount} totes @ $${effectiveRate.toFixed(2)}/mo — ${currentTier.tierName})`,
            qty: activeToteCount,
            unit_price: effectiveRate,
            amount: subtotal
          });
        } else {
          // Respect immutable stored line items from database
          const storageItem = lineItems.find(i => {
            const d = (i.description || '').toLowerCase();
            return d.includes('subscription') || d.includes('storage') || d.includes('tote');
          });
          if (storageItem && storageItem.qty) {
            activeToteCount = Number(storageItem.qty);
          }
          if (storageItem && storageItem.unit_price) {
            effectiveRate = Number(storageItem.unit_price);
          }
          const pricingRes = await this.resolveCustomerPricing(targetUid, targetFacId, activeToteCount);
          currentTier = pricingRes;
        }

        grandTotal = Math.max(0, subtotal + deliveryFee + surgeFee + tax - discount);

        // Dynamic Smart Volume Expansion Calculation based on actual volume tier thresholds
        let targetTierCount = 10;
        if (activeToteCount >= 50) {
          targetTierCount = activeToteCount + 25; // Already at max Tier 4 Enterprise, suggest next 25-tote bulk milestone
        } else if (activeToteCount >= 25) {
          targetTierCount = 50; // Current: Tier 3 Commercial (25-49 totes). Next Tier: Tier 4 Enterprise (50 totes)
        } else if (activeToteCount >= 10) {
          targetTierCount = 25; // Current: Tier 2 Preferred (10-24 totes). Next Tier: Tier 3 Commercial (25 totes)
        } else {
          targetTierCount = 10; // Current: Tier 1 Standard (1-9 totes). Next Tier: Tier 2 Preferred (10 totes)
        }

        const additionalTotesNeeded = Math.max(1, targetTierCount - activeToteCount);
        const nextTierObj = await this.resolveCustomerPricing(targetUid, targetFacId, targetTierCount);
        const nextTierTotalCost = targetTierCount * nextTierObj.toteRate;
        const diff = nextTierTotalCost - subtotal;
        const marginalPerTote = additionalTotesNeeded > 0 ? (diff / additionalTotesNeeded) : 0;

        if (diff <= 0) {
          const isFreeExpansion = Math.abs(diff) < 0.01;
          const diffText = isFreeExpansion ? `+$0.00/mo (FREE Expansion)` : `Save ${formatMoney(Math.abs(diff))}/mo`;
          const actionText = isFreeExpansion 
            ? `Adding +${additionalTotesNeeded} Totes is <span class="text-emerald-700 font-mono font-black">FREE (+$0.00/mo)</span> by unlocking lower unit rates!` 
            : `Adding +${additionalTotesNeeded} Totes REDUCES your total monthly bill by <span class="text-emerald-700 font-mono font-black text-base">${formatMoney(Math.abs(diff))}/mo</span>!`;

          upsellBannerHtml = `
            <div class="bg-gradient-to-r from-emerald-500/10 via-teal-500/10 to-indigo-500/10 border-2 border-emerald-500/40 rounded-2xl p-4 sm:p-5 text-xs text-slate-800 space-y-2 no-print shadow-sm">
              <div class="flex items-center justify-between">
                <span class="inline-flex items-center gap-1.5 bg-emerald-600 text-white font-extrabold text-[10px] uppercase px-2.5 py-0.5 rounded-full tracking-wider">
                  💡 Volume Tier Discount Alert
                </span>
                <span class="font-mono font-black text-emerald-700 text-xs">${diffText}</span>
              </div>
              <p class="font-black text-sm text-slate-900 leading-snug">
                Unlock Volume Tier Savings: ${actionText}
              </p>
              <p class="text-slate-600 leading-relaxed text-[11px]">
                You are currently renting <strong>${activeToteCount} tote${activeToteCount !== 1 ? 's' : ''}</strong> at ${formatMoney(effectiveRate)}/tote/mo (${formatMoney(subtotal)}/mo). Upgrading to <strong>${targetTierCount} totes</strong> (+${additionalTotesNeeded} tote${additionalTotesNeeded !== 1 ? 's' : ''}) automatically unlocks our <strong>${nextTierObj.tierName}</strong> ($${nextTierObj.toteRate.toFixed(2)}/tote/mo), bringing your total monthly bill to <strong>${formatMoney(nextTierTotalCost)}/mo</strong>!
              </p>
            </div>`;
        } else {
          upsellBannerHtml = `
            <div class="bg-gradient-to-r from-blue-500/10 via-indigo-500/10 to-purple-500/10 border border-blue-500/30 rounded-2xl p-4 sm:p-5 text-xs text-slate-800 space-y-2 no-print shadow-sm">
              <div class="flex items-center justify-between">
                <span class="inline-flex items-center gap-1.5 bg-blue-600 text-white font-extrabold text-[10px] uppercase px-2.5 py-0.5 rounded-full tracking-wider">
                  🚀 Smart Volume Expansion Opportunity
                </span>
                <span class="font-mono font-bold text-blue-700 text-xs">+${additionalTotesNeeded} Tote${additionalTotesNeeded !== 1 ? 's' : ''} for +${formatMoney(diff)}/mo</span>
              </div>
              <p class="font-black text-sm text-slate-900 leading-snug">
                Adding +${additionalTotesNeeded} tote${additionalTotesNeeded !== 1 ? 's' : ''} will only increase your monthly bill by <span class="text-blue-700 font-mono font-black">+${formatMoney(diff)}/mo</span> (just <span class="text-blue-700 font-mono font-bold">+${formatMoney(marginalPerTote)}/tote/mo</span>)!
              </p>
              <p class="text-slate-600 leading-relaxed text-[11px]">
                You are currently renting <strong>${activeToteCount} tote${activeToteCount !== 1 ? 's' : ''}</strong> (${formatMoney(subtotal)}/mo). Upgrading to <strong>${targetTierCount} totes</strong> (+${additionalTotesNeeded} tote${additionalTotesNeeded !== 1 ? 's' : ''}) unlocks our <strong>${nextTierObj.tierName}</strong> ($${nextTierObj.toteRate.toFixed(2)}/tote/mo) for a total of <strong>${formatMoney(nextTierTotalCost)}/mo</strong>.
              </p>
            </div>`;
        }
      } else {
        // Non-subscription service invoice (retrieval / valet / expansion)
        // Clean out any misplaced storage subscription rows and $0 retrieval placeholder rows
        lineItems = lineItems.filter(i => {
          const desc = (i.description || i.name || '').toLowerCase();
          const amt = Number(i.amount || 0);
          const unit = Number(i.unit_price || i.unitPrice || 0);
          if (desc.includes('storage subscription') || (desc.includes('subscription (') && desc.includes('tier'))) {
            return false;
          }
          if ((desc.includes('retrieval') || desc.includes('staging') || desc.includes('vault')) && amt === 0 && unit === 0) {
            return false;
          }
          return true;
        });

        // Check if line items has an un-itemized lump sum valet delivery fee (e.g. $17.00) or needs normalization
        const valetLumpIndex = lineItems.findIndex(i => {
          const d = (i.description || '').toLowerCase();
          return (d.includes('valet doorstep delivery') || d.includes('valet delivery')) && !d.includes('base fee') && !d.includes('base service') && !d.includes('per tote');
        });

        if (valetLumpIndex !== -1 || (deliveryFee > 0 && !lineItems.some(i => (i.description || '').toLowerCase().includes('base')))) {
          const totalValet = deliveryFee > 0 ? deliveryFee : Number(lineItems[valetLumpIndex]?.amount || 17);
          const baseFee = 15.00;
          const adderTotal = Math.max(0, totalValet - baseFee);
          const adderPerTote = 1.00;
          const inferredToteCount = adderTotal > 0 ? Math.round(adderTotal / adderPerTote) : 1;

          if (valetLumpIndex !== -1) {
            lineItems.splice(valetLumpIndex, 1);
          }

          lineItems.push({
            description: `Valet Base Fee`,
            qty: 1,
            unit_price: baseFee,
            amount: baseFee
          });

          if (adderTotal > 0) {
            lineItems.push({
              description: `Per Tote Valet Fee ($${adderPerTote.toFixed(2)}/tote)`,
              qty: inferredToteCount,
              unit_price: adderPerTote,
              amount: adderTotal
            });
          }
        } else {
          // Normalize existing valet line item descriptions
          lineItems.forEach(it => {
            const d = (it.description || '').toLowerCase();
            if (d.includes('base service') || d.includes('doorstep delivery base')) {
              it.description = 'Valet Base Fee';
            } else if (d.includes('handling surcharge') || d.includes('tote handling')) {
              const uRate = Number(it.unit_price || it.unitPrice || 1.00);
              it.description = `Per Tote Valet Fee ($${uRate.toFixed(2)}/tote)`;
            }
          });
        }

        if (lineItems.length === 0) {
          if (surgeFee > 0) lineItems.push({ description: 'Expedited Staging Access', qty: 1, unit_price: surgeFee, amount: surgeFee });
          if (deliveryFee > 0) lineItems.push({ description: 'Valet Base Fee', qty: 1, unit_price: deliveryFee, amount: deliveryFee });
        }
        upsellBannerHtml = '';
      }

      const renderItemBreakdown = (item) => {
        const desc = (item.description || item.name || '').toLowerCase();
        let details = item.details || item.notes || item.subtext || '';
        let badges = [];

        if (isSubscriptionInvoice && (desc.includes('subscription') || desc.includes('storage') || invType === 'initial_reservation')) {
          badges.push(`📦 ${activeToteCount} Active Storage Tote${activeToteCount !== 1 ? 's' : ''}`);
          badges.push(`📊 ${currentTier.tierName} (${formatMoney(effectiveRate)}/tote/mo)`);
        } else if (desc.includes('base fee') || desc.includes('base service')) {
          badges.push('🚚 White-Glove Doorstep Valet');
          badges.push('📍 Real-Time Live Driver Tracking');
        } else if (desc.includes('per tote valet') || desc.includes('tote valet') || desc.includes('handling') || desc.includes('adder') || desc.includes('surcharge')) {
          badges.push('🏷️ Valet Tote Unit Handling Cost');
        } else if (desc.includes('valet') || desc.includes('delivery') || invType === 'valet_delivery') {
          badges.push('🚚 White-Glove Doorstep Valet');
          badges.push('📍 Real-Time Live Driver Tracking');
        } else if (desc.includes('surge') || desc.includes('priority') || desc.includes('expedited')) {
          badges.push('⚡ Expedited Rush Queue Dispatch');
        } else if (desc.includes('unreturned') || desc.includes('tote fee')) {
          badges.push('📦 Industrial Stackable Tote Replacement');
        } else if (desc.includes('deposit') || desc.includes('waitlist')) {
          badges.push('⭐ Priority Launch Queue Slot');
          badges.push('💯 100% Fully Refundable Deposit');
        } else if (desc.includes('tax')) {
          badges.push('🏛️ State & Local Tax Compliance');
        }

        const badgesHtml = badges.map(b => `<span class="inline-flex items-center gap-1 bg-blue-50/90 border border-blue-200/80 text-blue-900 px-2.5 py-0.5 rounded-md text-[10px] font-extrabold font-mono">${b}</span>`).join(' ');

        return `
          <div class="mt-1.5 space-y-1.5">
            ${details ? `<p class="text-[11px] text-slate-500 font-normal leading-relaxed">${details}</p>` : ''}
            ${badgesHtml ? `<div class="flex flex-wrap gap-1.5 pt-0.5">${badgesHtml}</div>` : ''}
          </div>
        `;
      };

      // Exclude any tax line items from the line items table — tax belongs in the totals section only
      const filteredLineItems = lineItems.filter(item => {
        const d = (item.description || item.name || '').toLowerCase();
        return !(d.includes('sales tax') || d.includes('state tax') || item.tax_rate != null);
      });

      const lineItemsRowsHtml = filteredLineItems.map((item, idx) => {
        const desc = item.description || item.name || 'Storage / Service Charge';
        const qty = Number(item.qty || item.quantity || 1);
        const rate = Number(item.unit_price || item.unitPrice || item.rate || item.amount || 0);
        const amt = Number(item.amount || (qty * rate));
        const rowBg = idx % 2 === 0 ? 'bg-white' : 'bg-slate-50/50';
        const breakdownHtml = renderItemBreakdown(item);

        return `
          <tr class="border-b border-slate-100 ${rowBg} text-xs transition">
            <td class="py-4 px-4 align-top">
              <span class="font-extrabold text-slate-900 text-sm block">${desc}</span>
              ${breakdownHtml}
            </td>
            <td class="py-4 px-4 text-center font-mono font-semibold text-slate-700 align-top">${qty}</td>
            <td class="py-4 px-4 text-right font-mono font-semibold text-slate-700 align-top">${formatMoney(rate)}</td>
            <td class="py-4 px-4 text-right font-mono font-black text-slate-900 text-sm align-top">${formatMoney(amt)}</td>
          </tr>
        `;
      }).join('');

      const resolveInvoiceTypeLabel = (inv) => {
        if (!inv) return 'Service Invoice';
        const rawType = (inv.invoice_type || inv.invoiceType || inv.charge_type || '').toLowerCase().replace(/[\s-]/g, '_');
        const delFee = Number(inv.delivery_fee || inv.deliveryFee || 0);
        const surgeFee = Number(inv.surge_fee || inv.surgeFee || 0);
        const subtotal = Number(inv.subtotal || 0);
        const notes = (inv.notes || '').toLowerCase();
        
        let lineItems = inv.line_items || inv.lineItems || [];
        if (typeof lineItems === 'string') {
          try { lineItems = JSON.parse(lineItems); } catch (e) { lineItems = []; }
        }
        const hasValetLine = Array.isArray(lineItems) && lineItems.some(li => (li.description || '').toLowerCase().includes('valet'));
        const hasStagingLine = Array.isArray(lineItems) && lineItems.some(li => (li.description || '').toLowerCase().includes('staging') || (li.description || '').toLowerCase().includes('self-service'));
        const hasStorageLine = Array.isArray(lineItems) && lineItems.some(li => (li.description || '').toLowerCase().includes('storage') || (li.description || '').toLowerCase().includes('subscription'));

        if (rawType === 'unreturned_tote_fee' || rawType === 'missing_tote_fee' || rawType === 'missing_tote' || notes.includes('missing tote') || notes.includes('unreturned')) {
          return 'Missing Container Replacement Fee';
        }
        if (rawType === 'unlaunched_deposit' || notes.includes('deposit')) {
          return 'Pre-Launch Deposit';
        }
        if (rawType === 'refund') {
          return 'Account Refund';
        }
        if (rawType === 'initial_reservation') {
          return 'Initial Plan Reservation';
        }
        if (rawType === 'subscription_expansion' || rawType === 'subscription_modification') {
          return 'Plan Modification';
        }

        const isValet = rawType.includes('valet') || delFee > 0 || hasValetLine || notes.includes('valet');
        const isStaging = rawType.includes('staging') || hasStagingLine || notes.includes('staging') || notes.includes('self-service');
        const hasSurge = surgeFee > 0 || rawType.includes('surge') || rawType.includes('expedited') || notes.includes('surge') || notes.includes('same_day') || notes.includes('expedited');

        if (isValet) {
          return hasSurge ? 'Expedited Valet Delivery' : 'Valet Delivery';
        }
        if (isStaging) {
          return hasSurge ? 'Expedited Staging Access' : 'Self-Service Staging';
        }

        if (rawType === 'surge_delivery') {
          if (delFee > 0 || notes.includes('valet')) {
            return 'Expedited Valet Delivery';
          }
          return 'Expedited Staging Access';
        }

        if (rawType === 'subscription' || rawType === 'monthly_subscription' || hasStorageLine || subtotal > 0) {
          return 'Monthly Storage Plan';
        }

        return rawType ? rawType.replace(/_/g, ' ').replace(/\b\w/g, l => l.toUpperCase()) : 'Service Invoice';
      };

      const resolvedInvoiceTypeTitle = resolveInvoiceTypeLabel(invoiceObj);

      modalEl.innerHTML = `
        <div class="bg-white rounded-3xl shadow-2xl max-w-3xl w-full mx-auto border border-slate-200/80 overflow-hidden text-slate-800 my-8">
          <!-- Top Gradient Accent Bar -->
          <div class="h-2 bg-gradient-to-r from-blue-600 via-indigo-600 to-purple-600"></div>

          <!-- Printable Invoice Header -->
          <div class="p-6 sm:p-8 bg-white border-b border-slate-100">
            <div class="flex justify-between items-start flex-wrap gap-6">
              <!-- Logo & Brand Header -->
              <div class="space-y-2">
                <div class="flex items-center space-x-3">
                  <img src="logo.png" alt="CloudVault Logo" class="w-10 h-10 object-contain rounded-xl shadow-xs" />
                  <div>
                    <h1 class="text-2xl font-black text-slate-900 tracking-tight leading-none">CloudVault</h1>
                    <span class="text-[9px] font-extrabold text-blue-600 uppercase tracking-[0.2em] block mt-1">Storage &amp; Logistics Solutions</span>
                    <span class="text-xs font-bold font-mono text-indigo-700 bg-indigo-50 border border-indigo-200 px-2.5 py-0.5 rounded-full inline-block mt-2">${resolvedInvoiceTypeTitle}</span>
                  </div>
                </div>
                <p class="text-[11px] text-slate-500 font-mono">CloudVault Storage Inc. &bull; support@cloudvault.io</p>
              </div>

              <!-- Invoice Status & Number Meta -->
              <div class="text-right space-y-1">
                <span class="inline-block px-3 py-1 text-xs font-extrabold rounded-full border ${statusBadgeClasses} font-mono tracking-wider">
                  ${status}
                </span>
                <h2 class="text-xl font-black font-mono text-slate-900 tracking-wider">${invoiceNum}</h2>
                <p class="text-xs text-slate-500 font-mono">Issued: ${createdAt}</p>
              </div>
            </div>
          </div>

          <!-- Body Container -->
          <div class="p-6 sm:p-8 space-y-6">
            <!-- Customer & Payment Details Grid -->
            <div class="grid grid-cols-1 sm:grid-cols-2 gap-5 bg-slate-50/80 p-5 rounded-2xl border border-slate-200/70 text-xs">
              <div class="space-y-1">
                <span class="text-[10px] font-black uppercase tracking-widest text-slate-400 block">Billed To</span>
                <p class="font-extrabold text-sm text-slate-900">${customerName}</p>
                <p class="text-slate-600 font-mono text-[11px]">${customerEmail}</p>
                <p class="text-slate-500 pt-1"><span class="font-semibold text-slate-700">Facility Hub:</span> ${facilityDisplay}</p>
              </div>
              <div class="space-y-1">
                <span class="text-[10px] font-black uppercase tracking-widest text-slate-400 block">Payment Information</span>
                <p class="font-semibold text-slate-800"><span class="text-slate-500">Method:</span> ${paymentMethod}</p>
                <p class="text-slate-600 text-[11px]"><span class="text-slate-500">Txn Ref:</span> <span class="font-mono bg-slate-200/70 px-1.5 py-0.5 rounded text-slate-800">${txnRef}</span></p>
                <p class="text-slate-600"><span class="text-slate-500">Paid Date:</span> ${paidAt}</p>
              </div>
            </div>

            <!-- Itemized Line Items Table -->
            <div class="overflow-x-auto rounded-xl border border-slate-200/80">
              <table class="w-full text-left border-collapse">
                <thead>
                  <tr class="border-b border-slate-200 text-[10px] font-black uppercase tracking-wider text-slate-500 bg-slate-100/70">
                    <th class="py-3 px-4">Item Description</th>
                    <th class="py-3 px-4 text-center">Qty</th>
                    <th class="py-3 px-4 text-right">Unit Price</th>
                    <th class="py-3 px-4 text-right">Amount</th>
                  </tr>
                </thead>
                <tbody class="divide-y divide-slate-100">
                  ${lineItemsRowsHtml}
                </tbody>
              </table>
            </div>

            <!-- Smart Volume Expansion & Tier Savings Metric Banner -->
            ${upsellBannerHtml}

            <!-- Financial Summary Breakdown -->
            <div class="flex justify-end pt-2">
              <div class="w-full sm:w-80 space-y-2 text-xs">
                <div class="flex justify-between text-slate-600">
                  <span>Subtotal</span>
                  <span class="font-bold text-slate-900 font-mono">${formatMoney(subtotal)}</span>
                </div>
                ${deliveryFee > 0 ? `
                <div class="flex justify-between text-slate-600">
                  <span>Valet Delivery Fee</span>
                  <span class="font-bold text-slate-900 font-mono">${formatMoney(deliveryFee)}</span>
                </div>` : ''}
                ${surgeFee > 0 ? `
                <div class="flex justify-between text-slate-600">
                  <span>Surge / Priority Fee</span>
                  <span class="font-bold text-slate-900 font-mono">${formatMoney(surgeFee)}</span>
                </div>` : ''}
                ${tax > 0 ? `
                <div class="flex justify-between text-slate-600">
                  <span>Sales Tax (${taxRegionLabel})</span>
                  <span class="font-bold text-slate-900 font-mono">${formatMoney(tax)}</span>
                </div>` : (taxRegionLabel && (taxRegionLabel.includes('0.00%') || taxRegionLabel.includes('Oregon') || taxRegionLabel.includes('0%')) ? `
                <div class="flex justify-between text-slate-600">
                  <span>Sales Tax (${taxRegionLabel})</span>
                  <span class="font-bold text-slate-500 font-mono">$0.00</span>
                </div>` : '')}
                ${discount > 0 ? `
                <div class="flex justify-between text-emerald-600 font-medium">
                  <span>Discount Applied</span>
                  <span class="font-bold font-mono">-${formatMoney(discount)}</span>
                </div>` : ''}
                <div class="bg-gradient-to-r from-blue-50 to-indigo-50 border border-blue-200 p-4 rounded-2xl flex justify-between items-center mt-3 shadow-xs">
                  <span class="text-sm font-black text-slate-900 uppercase tracking-wider">Grand Total</span>
                  <span class="text-xl font-black font-mono text-blue-700">${formatMoney(grandTotal)}</span>
                </div>
              </div>
            </div>

            ${notes ? `
            <div class="p-4 bg-amber-50/80 rounded-2xl border border-amber-200 text-xs text-amber-900 flex items-start gap-2.5">
              <span class="text-base">📝</span>
              <div>
                <span class="font-extrabold uppercase text-[10px] tracking-wider text-amber-800 block mb-0.5">Invoice Notes</span>
                <p class="font-medium">${notes}</p>
              </div>
            </div>` : ''}
          </div>

          <!-- Printable Modal Footer Controls -->
          <div class="no-print bg-slate-50 px-6 py-4 border-t border-slate-200 flex justify-between items-center">
            <p class="text-xs text-slate-500 font-medium font-mono">CloudVault Automated Invoice Engine &bull; Official Statement</p>
            <div class="flex space-x-3">
              <button onclick="window.print()" class="bg-blue-600 hover:bg-blue-700 text-white text-xs font-bold px-5 py-2.5 rounded-xl transition shadow-lg shadow-blue-600/20 flex items-center space-x-1.5 cursor-pointer">
                <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M17 17h2a2 2 0 002-2v-4a2 2 0 00-2-2H5a2 2 0 00-2 2v4a2 2 0 002 2h2m2 4h6a2 2 0 002-2v-4a2 2 0 00-2-2H9a2 2 0 00-2 2v4a2 2 0 002 2zm8-12V5a2 2 0 00-2-2H9a2 2 0 00-2 2v4h10z"></path></svg>
                <span>Print Invoice</span>
              </button>
              <button onclick="window.CloudVaultBilling.closePrintableInvoiceModal()" class="bg-white hover:bg-slate-100 border border-slate-300 text-slate-700 text-xs font-bold px-4 py-2.5 rounded-xl transition cursor-pointer">
                Close
              </button>
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

    closePrintableInvoiceModal: function () {
      const modalEl = document.getElementById('printable-invoice-modal');
      if (modalEl) {
        modalEl.classList.add('hidden');
      }
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
    }
  };

  global.CloudVaultBilling = CloudVaultBilling;
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = CloudVaultBilling;
  }
})(typeof window !== 'undefined' ? window : this);
