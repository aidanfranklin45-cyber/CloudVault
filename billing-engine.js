/**
 * CloudVault Core Billing Engine & Invoice Management Module
 * Window Global: window.CloudVaultBilling
 */
(function (global) {
  'use strict';

  const CloudVaultBilling = {
    /**
     * Generates a standard CloudVault invoice number.
     * Example: "INV-2026-89421"
     * @returns {string}
     */
    generateInvoiceNumber: function () {
      const year = new Date().getFullYear();
      const randomPart = Math.floor(10000 + Math.random() * 90000);
      return `INV-${year}-${randomPart}`;
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

        // --- Tax Resolution ---
        // Look up tax rate from service_areas by customer ZIP. Never assume a rate.
        // If admin hasn't configured a ZIP rate, tax = $0.
        let resolvedTaxRate = params.tax_rate != null ? Number(params.tax_rate) : null;
        let resolvedTaxLabel = params.tax_label || null;
        if (resolvedTaxRate == null && params.zip_code) {
          try {
            const { data: saRow } = await sb.from('service_areas')
              .select('tax_rate, tax_label')
              .eq('zip_code', params.zip_code)
              .maybeSingle();
            if (saRow && saRow.tax_rate != null) {
              resolvedTaxRate = Number(saRow.tax_rate);
              resolvedTaxLabel = saRow.tax_label || null;
            }
          } catch (e) {
            console.warn('[CloudVaultBilling] Tax rate lookup failed, defaulting to $0:', e.message);
          }
        }
        const taxableBase = Number(params.subtotal || 0);
        const taxAmount = resolvedTaxRate != null ? Math.round(taxableBase * resolvedTaxRate * 100) / 100 : (Number(params.tax) || 0.00);
        // Recompute total with tax
        const computedTotal = taxableBase
          + Number(params.delivery_fee || 0)
          + Number(params.surge_fee || 0)
          + taxAmount
          - Number(params.discount || 0);

        if (resolvedTaxRate != null) {
          lineItems.push({
            description: resolvedTaxLabel || 'Sales Tax',
            qty: 1,
            unit_price: taxAmount,
            amount: taxAmount,
            tax_rate: resolvedTaxRate
          });
        }

        let totalAmount = params.total_amount != null ? Number(params.total_amount) : computedTotal;
        const invType = (params.invoice_type || params.invoiceType || '').toLowerCase();
        if (invType !== 'refund' && totalAmount < 0) {
          totalAmount = 0;
        }

        const paymentStatus = params.payment_status || params.paymentStatus || 'paid';
        const createdAt = params.created_at || params.createdAt || new Date().toISOString();
        const paidAt = params.paid_at || params.paidAt || (paymentStatus === 'paid' ? createdAt : null);
        const dueDate = params.due_date || params.dueDate || new Date(new Date(createdAt).getTime() + 3 * 24 * 60 * 60 * 1000).toISOString();

        const record = {
          invoice_number: invoiceNumber,
          uid: params.uid || params.userId || params.user_id || null,
          customer_name: params.customer_name || params.customerName || null,
          customer_email: params.customer_email || params.customerEmail || null,
          facility_id: params.facility_id || params.facilityId || null,
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

        const { data, error } = await sb
          .from('invoices')
          .insert([record])
          .select()
          .single();

        if (error) {
          console.error('[CloudVaultBilling] Error creating invoice record:', error);
          return { success: false, error: error.message, details: error };
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
     */
    createSignupInvoice: async function(userId, subscriptionData, userZip) {
      if (!userId || !subscriptionData) return { success: false, error: 'Missing params' };
      const toteCount = Number(subscriptionData.total_totes || subscriptionData.tote_count || 0);
      const toteRate = Number(subscriptionData.tote_rate || 0);
      const storageAmt = Number(subscriptionData.recurring_storage || (toteCount * toteRate) || 0);
      const valetFee = Number(subscriptionData.valet_fee || 0);
      const now = new Date().toISOString();
      return this.createInvoiceRecord({
        uid: userId,
        customer_name: subscriptionData.customer_name || 'CloudVault Customer',
        customer_email: subscriptionData.customer_email || null,
        invoice_type: 'initial_reservation',
        payment_status: 'paid',
        subtotal: storageAmt,
        delivery_fee: valetFee,
        total_amount: storageAmt + valetFee, // tax will be added by createInvoiceRecord
        payment_method: 'card',
        zip_code: userZip || null,
        transaction_reference: window.CloudVaultStripe
          ? window.CloudVaultStripe.generateChargeId()
          : 'ch_signup_' + Date.now(),
        notes: 'First month — charged at signup',
        line_items: [
          { description: `CloudVault Storage (${toteCount} totes @ $${toteRate.toFixed(2)}/mo)`, qty: toteCount || 1, unit_price: toteRate, amount: storageAmt },
          ...(valetFee > 0 ? [{ description: 'Valet Delivery Service Fee', qty: 1, unit_price: valetFee, amount: valetFee }] : [])
        ],
        created_at: now,
        paid_at: now,
        due_date: new Date(new Date(now).getTime() + 3 * 24 * 60 * 60 * 1000).toISOString()
      });
    },

    /**
     * Fetches invoice records for a user by userId or customerEmail.
     * @param {string} userId - User UUID
     * @param {string} customerEmail - User Email address
     * @returns {Promise<{success: boolean, invoices: Array, error?: string}>}
     */
    fetchInvoicesForUser: async function (userId, customerEmail) {
      try {
        const sb = global.supabase;
        if (!sb) {
          console.error('[CloudVaultBilling] Supabase client missing');
          return { success: false, error: 'Supabase client missing', invoices: [] };
        }

        let query = sb.from('invoices').select('*');

        if (userId && customerEmail) {
          query = query.or(`uid.eq.${userId},customer_email.eq.${customerEmail}`);
        } else if (userId) {
          query = query.eq('uid', userId);
        } else if (customerEmail) {
          query = query.eq('customer_email', customerEmail);
        } else {
          console.warn('[CloudVaultBilling] Neither userId nor customerEmail provided to fetchInvoicesForUser');
          return { success: true, invoices: [] };
        }

        const { data, error } = await query.order('created_at', { ascending: false });

        if (error) {
          console.error('[CloudVaultBilling] Error fetching invoices:', error);
          return { success: false, error: error.message, invoices: [] };
        }

        return { success: true, invoices: data || [] };
      } catch (err) {
        console.error('[CloudVaultBilling] Exception in fetchInvoicesForUser:', err);
        return { success: false, error: err.message, invoices: [] };
      }
    },

    /**
     * Scans subscriptions, charges, access_requests, and waitlist for unbilled records,
     * creating retroactive invoices in public.invoices without duplicates.
     * @returns {Promise<{success: boolean, count: number, backfilled: Object, invoices: Array, error?: string}>}
     */
    backfillRetroactiveInvoices: async function () {
      try {
        const sb = global.supabase;
        if (!sb) {
          console.error('[CloudVaultBilling] Supabase client missing');
          return { success: false, error: 'Supabase client missing', count: 0, invoices: [] };
        }

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
              const toteRate = Number(sub.tote_rate || 0);
              const storageAmt = Number(sub.recurring_storage || (toteCount * toteRate) || 0);
              const valetFee = Number(sub.valet_fee || 0);
              const total = Number(sub.first_month_total || sub.monthly_total || (storageAmt + valetFee));
              const createdAt = sub.created_at || new Date().toISOString();

              const lineItems = [
                {
                  description: `CloudVault Storage Subscription (${toteCount} totes @ $${toteRate.toFixed(2)}/mo)`,
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
              const valetFee = Number(req.valet_fee || 0);
              const surgeFee = Number(req.surge_fee || 0);
              const total = valetFee + surgeFee;
              const invType = req.fulfillment_type === 'valet_delivery' || req.request_type === 'valet' ? 'valet_delivery' : (req.request_type || 'access_request');
              const createdAt = req.requested_at || new Date().toISOString();

              const lineItems = [];
              if (valetFee > 0) {
                lineItems.push({ description: 'Valet Delivery Service Fee', qty: 1, unit_price: valetFee, amount: valetFee });
              }
              if (surgeFee > 0) {
                lineItems.push({ description: `Priority / Surge Slot Fee (${req.surge_tier || 'surge'})`, qty: 1, unit_price: surgeFee, amount: surgeFee });
              }
              if (lineItems.length === 0) {
                const toteCount = Array.isArray(req.requested_items) ? req.requested_items.length : 1;
                lineItems.push({ description: `Staging Tote Access Request (${toteCount} totes)`, qty: toteCount, unit_price: 0, amount: 0 });
              }

              const res = await this.createInvoiceRecord({
                uid: req.uid,
                customer_name: userObj.name || 'Valued Customer',
                customer_email: userObj.email || null,
                facility_id: req.facility_id || userObj.assigned_facility_id || null,
                invoice_type: invType,
                payment_status: req.status === 'cancelled' ? 'refunded' : 'paid',
                subtotal: 0,
                delivery_fee: valetFee,
                surge_fee: surgeFee,
                total_amount: total,
                payment_method: 'card',
                transaction_reference: txnRef,
                notes: `Retroactive access request backfill [Ref: ${reqRefTag}]`,
                line_items: lineItems,
                created_at: createdAt,
                paid_at: createdAt,
                due_date: new Date(new Date(createdAt).getTime() + 3 * 24 * 60 * 60 * 1000).toISOString()
              });

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
          const toteRate = Number(sub.tote_rate || 0);
          const storageAmt = Number(sub.recurring_storage || (toteCount * toteRate) || 0);
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
            notes: 'Automated monthly subscription autopay renewal',
            line_items: [
              {
                description: `CloudVault Monthly Autopay Storage Subscription (${toteCount} totes @ $${toteRate.toFixed(2)}/mo)`,
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
              const toteRate = Number(sub.tote_rate || 0);
              const storageAmt = Number(sub.recurring_storage || (toteCount * toteRate) || 0);
              const valetFee = Number(sub.valet_fee || 0);
              const total = Number(sub.first_month_total || sub.monthly_total || (storageAmt + valetFee));
              const createdAt = sub.created_at || new Date().toISOString();

              const lineItems = [
                {
                  description: `CloudVault Storage Subscription (${toteCount} totes @ $${toteRate.toFixed(2)}/mo)`,
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
              const valetFee = Number(req.valet_fee || 0);
              const surgeFee = Number(req.surge_fee || 0);
              const total = valetFee + surgeFee;
              const invType = req.fulfillment_type === 'valet_delivery' || req.request_type === 'valet' ? 'valet_delivery' : (req.request_type || 'access_request');
              const createdAt = req.requested_at || new Date().toISOString();

              const lineItems = [];
              if (valetFee > 0) {
                lineItems.push({ description: 'Valet Delivery Service Fee', qty: 1, unit_price: valetFee, amount: valetFee });
              }
              if (surgeFee > 0) {
                lineItems.push({ description: `Priority / Surge Slot Fee (${req.surge_tier || 'surge'})`, qty: 1, unit_price: surgeFee, amount: surgeFee });
              }
              if (lineItems.length === 0) {
                const toteCount = Array.isArray(req.requested_items) ? req.requested_items.length : 1;
                lineItems.push({ description: `Staging Tote Access Request (${toteCount} totes)`, qty: toteCount, unit_price: 0, amount: 0 });
              }

              const res = await this.createInvoiceRecord({
                uid: req.uid,
                customer_name: user.name || 'Valued Customer',
                customer_email: user.email || null,
                facility_id: req.facility_id || user.assigned_facility_id || null,
                invoice_type: invType,
                payment_status: req.status === 'cancelled' ? 'refunded' : 'paid',
                subtotal: 0,
                delivery_fee: valetFee,
                surge_fee: surgeFee,
                total_amount: total,
                payment_method: 'card',
                transaction_reference: txnRef,
                notes: `Retroactive access request backfill [Ref: ${reqRefTag}]`,
                line_items: lineItems,
                created_at: createdAt,
                paid_at: createdAt,
                due_date: new Date(new Date(createdAt).getTime() + 3 * 24 * 60 * 60 * 1000).toISOString()
              });

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
        const toteRate = Number(sub.tote_rate || 0);
        const storageAmt = Number(sub.recurring_storage || (toteCount * toteRate) || 0);
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
          notes: 'Granular customer monthly subscription autopay renewal',
          line_items: [
            {
              description: `CloudVault Monthly Autopay Storage Subscription (${toteCount} totes @ $${toteRate.toFixed(2)}/mo)`,
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
    renderPrintableInvoiceModal: function (invoiceObj = {}) {
      this.ensurePrintStyles();

      let modalEl = document.getElementById('printable-invoice-modal');
      if (!modalEl) {
        modalEl = document.createElement('div');
        modalEl.id = 'printable-invoice-modal';
        document.body.appendChild(modalEl);
      }

      modalEl.className = 'fixed inset-0 bg-gray-900/70 backdrop-blur-sm z-[9999] flex items-center justify-center p-4 sm:p-6 overflow-y-auto';

      const invoiceNum = invoiceObj.invoice_number || invoiceObj.invoiceNumber || 'INV-2026-00000';
      const status = (invoiceObj.payment_status || invoiceObj.paymentStatus || 'paid').toUpperCase();
      const customerName = invoiceObj.customer_name || invoiceObj.customerName || 'Valued CloudVault Customer';
      const customerEmail = invoiceObj.customer_email || invoiceObj.customerEmail || 'N/A';
      const facilityId = invoiceObj.facility_id || invoiceObj.facilityId || 'CloudVault Central Facility';
      const paymentMethod = invoiceObj.payment_method || invoiceObj.paymentMethod || 'Credit Card (Stripe)';
      const txnRef = invoiceObj.transaction_reference || invoiceObj.transactionReference || 'N/A';
      const notes = invoiceObj.notes || '';

      const createdAt = invoiceObj.created_at || invoiceObj.createdAt
        ? new Date(invoiceObj.created_at || invoiceObj.createdAt).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
        : new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });

      const paidAt = invoiceObj.paid_at || invoiceObj.paidAt
        ? new Date(invoiceObj.paid_at || invoiceObj.paidAt).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' })
        : (status === 'PAID' ? createdAt : 'Pending');

      const subtotal = Number(invoiceObj.subtotal || 0);
      const deliveryFee = Number(invoiceObj.delivery_fee || invoiceObj.deliveryFee || 0);
      const surgeFee = Number(invoiceObj.surge_fee || invoiceObj.surgeFee || 0);
      const tax = Number(invoiceObj.tax || 0);
      const discount = Number(invoiceObj.discount || 0);
      const grandTotal = Number(invoiceObj.total_amount || invoiceObj.totalAmount || (subtotal + deliveryFee + surgeFee + tax - discount));

      let lineItems = invoiceObj.line_items || invoiceObj.lineItems || [];
      if (typeof lineItems === 'string') {
        try { lineItems = JSON.parse(lineItems); } catch (e) { lineItems = []; }
      }
      if (!Array.isArray(lineItems) || lineItems.length === 0) {
        lineItems = [
          { description: 'CloudVault Monthly Tote Storage Subscription', qty: 1, unit_price: subtotal, amount: subtotal }
        ];
      }

      let statusBadgeClasses = 'bg-emerald-100 text-emerald-800 border-emerald-300';
      if (status === 'PENDING') statusBadgeClasses = 'bg-amber-100 text-amber-800 border-amber-300';
      else if (status === 'OVERDUE' || status === 'FAILED') statusBadgeClasses = 'bg-red-100 text-red-800 border-red-300';
      else if (status === 'REFUNDED') statusBadgeClasses = 'bg-rose-100 text-rose-800 border-rose-300';

      const formatMoney = (val) => {
        const n = Number(val) || 0;
        if (n < 0) return `-$${Math.abs(n).toFixed(2)}`;
        return `$${n.toFixed(2)}`;
      };

      const lineItemsRowsHtml = lineItems.map(item => {
        const desc = item.description || item.name || 'Storage / Service Charge';
        const qty = Number(item.qty || item.quantity || 1);
        const rate = Number(item.unit_price || item.unitPrice || item.rate || item.amount || 0);
        const amt = Number(item.amount || (qty * rate));
        return `
          <tr class="border-b border-gray-100 text-sm">
            <td class="py-3 px-4 text-gray-800 font-medium">${desc}</td>
            <td class="py-3 px-4 text-center text-gray-600">${qty}</td>
            <td class="py-3 px-4 text-right text-gray-600">${formatMoney(rate)}</td>
            <td class="py-3 px-4 text-right font-bold text-gray-900">${formatMoney(amt)}</td>
          </tr>
        `;
      }).join('');

      modalEl.innerHTML = `
        <div class="bg-white rounded-3xl shadow-2xl max-w-3xl w-full mx-auto border border-gray-100 overflow-hidden text-gray-800 my-8">
          <!-- Printable Invoice Header -->
          <div class="bg-gradient-to-r from-slate-900 via-indigo-950 to-blue-900 p-6 sm:p-8 text-white relative">
            <div class="flex justify-between items-start flex-wrap gap-4">
              <div>
                <div class="flex items-center space-x-3">
                  <div class="w-10 h-10 rounded-xl bg-blue-500/20 border border-blue-400/30 flex items-center justify-center font-black text-xl text-blue-300">
                    CV
                  </div>
                  <div>
                    <h1 class="text-2xl font-extrabold tracking-tight">CloudVault</h1>
                    <p class="text-xs text-blue-200 uppercase tracking-widest font-semibold">Storage &amp; Logistics Solutions</p>
                  </div>
                </div>
              </div>
              <div class="text-right">
                <span class="inline-block px-3 py-1 text-xs font-bold rounded-full border ${statusBadgeClasses} mb-1">
                  ${status}
                </span>
                <h2 class="text-xl font-bold tracking-wider">${invoiceNum}</h2>
                <p class="text-xs text-slate-300">Issued: ${createdAt}</p>
              </div>
            </div>
          </div>

          <!-- Body Container -->
          <div class="p-6 sm:p-8 space-y-6">
            <!-- Customer & Transaction Details -->
            <div class="grid grid-cols-1 sm:grid-cols-2 gap-6 bg-slate-50 p-5 rounded-2xl border border-slate-100 text-xs">
              <div>
                <span class="text-[10px] font-extrabold uppercase tracking-wider text-slate-400 block mb-1">Billed To</span>
                <p class="font-bold text-sm text-slate-900">${customerName}</p>
                <p class="text-slate-600">${customerEmail}</p>
                <p class="text-slate-500 mt-1"><span class="font-semibold text-slate-700">Facility Hub:</span> ${facilityId}</p>
              </div>
              <div>
                <span class="text-[10px] font-extrabold uppercase tracking-wider text-slate-400 block mb-1">Payment Information</span>
                <p class="font-semibold text-slate-800"><span class="text-slate-500">Method:</span> ${paymentMethod}</p>
                <p class="text-slate-600"><span class="text-slate-500">Txn Ref:</span> ${txnRef}</p>
                <p class="text-slate-600"><span class="text-slate-500">Paid Date:</span> ${paidAt}</p>
              </div>
            </div>

            <!-- Itemized Line Items Table -->
            <div class="overflow-x-auto">
              <table class="w-full text-left border-collapse">
                <thead>
                  <tr class="border-b-2 border-slate-200 text-[11px] font-extrabold uppercase tracking-wider text-slate-500 bg-slate-50/50">
                    <th class="py-2.5 px-4">Item Description</th>
                    <th class="py-2.5 px-4 text-center">Qty</th>
                    <th class="py-2.5 px-4 text-right">Unit Price</th>
                    <th class="py-2.5 px-4 text-right">Amount</th>
                  </tr>
                </thead>
                <tbody>
                  ${lineItemsRowsHtml}
                </tbody>
              </table>
            </div>

            <!-- Breakdown Summary -->
            <div class="flex justify-end pt-4 border-t border-slate-100">
              <div class="w-full sm:w-72 space-y-2 text-xs">
                <div class="flex justify-between text-slate-600">
                  <span>Subtotal</span>
                  <span class="font-semibold text-slate-800">${formatMoney(subtotal)}</span>
                </div>
                ${deliveryFee > 0 ? `
                <div class="flex justify-between text-slate-600">
                  <span>Valet Delivery Fee</span>
                  <span class="font-semibold text-slate-800">${formatMoney(deliveryFee)}</span>
                </div>` : ''}
                ${surgeFee > 0 ? `
                <div class="flex justify-between text-slate-600">
                  <span>Surge / Priority Fee</span>
                  <span class="font-semibold text-slate-800">${formatMoney(surgeFee)}</span>
                </div>` : ''}
                ${tax > 0 ? `
                <div class="flex justify-between text-slate-600">
                  <span>Estimated Tax</span>
                  <span class="font-semibold text-slate-800">${formatMoney(tax)}</span>
                </div>` : ''}
                ${discount > 0 ? `
                <div class="flex justify-between text-emerald-600">
                  <span>Discount Applied</span>
                  <span class="font-semibold">-${formatMoney(discount)}</span>
                </div>` : ''}
                <div class="flex justify-between text-base font-extrabold text-slate-900 pt-3 border-t-2 border-slate-200">
                  <span>Grand Total</span>
                  <span class="text-blue-700">${formatMoney(grandTotal)}</span>
                </div>
              </div>
            </div>

            ${notes ? `
            <div class="p-4 bg-amber-50 rounded-xl border border-amber-200 text-xs text-amber-900">
              <span class="font-bold">Notes:</span> ${notes}
            </div>` : ''}
          </div>

          <!-- Printable Modal Footer Controls -->
          <div class="no-print bg-slate-50 px-6 py-4 border-t border-slate-200 flex justify-between items-center">
            <p class="text-xs text-slate-500 font-medium">CloudVault Automated Invoice Engine</p>
            <div class="flex space-x-3">
              <button onclick="window.print()" class="bg-blue-600 hover:bg-blue-700 text-white text-xs font-bold px-5 py-2.5 rounded-xl transition shadow flex items-center space-x-1.5 cursor-pointer">
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
     * Inject print CSS media query rule if not already present.
     */
    ensurePrintStyles: function () {
      if (document.getElementById('cloudvault-billing-print-styles')) return;
      const style = document.createElement('style');
      style.id = 'cloudvault-billing-print-styles';
      style.textContent = `
        @media print {
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
            border: none !important;
            margin: 0 !important;
            max-width: 100% !important;
            width: 100% !important;
            border-radius: 0 !important;
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
