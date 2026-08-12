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
        const tax = Number(params.tax) || 0.00;
        const discount = Number(params.discount) || 0.00;

        let totalAmount = params.total_amount !== undefined ? params.total_amount : (params.totalAmount !== undefined ? params.totalAmount : params.total);
        if (totalAmount === undefined || totalAmount === null) {
          totalAmount = subtotal + deliveryFee + surgeFee + tax - discount;
        }
        totalAmount = Number(totalAmount) || 0;
        const invType = (params.invoice_type || params.invoiceType || '').toLowerCase();
        if (invType !== 'refund' && totalAmount < 0) {
          totalAmount = 0;
        }

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

        const paymentStatus = params.payment_status || params.paymentStatus || 'paid';
        const createdAt = params.created_at || params.createdAt || new Date().toISOString();
        const paidAt = params.paid_at || params.paidAt || (paymentStatus === 'paid' ? createdAt : null);

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
          tax: tax,
          discount: discount,
          total_amount: totalAmount,
          payment_method: params.payment_method || params.paymentMethod || 'card',
          transaction_reference: params.transaction_reference || params.transactionReference || null,
          notes: params.notes || null,
          line_items: lineItems,
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
