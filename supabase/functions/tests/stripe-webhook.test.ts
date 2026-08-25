import { assertEquals, assertExists } from "std/assert";
import { handleWebhookRequest } from "../stripe-webhook/index.ts";

const TEST_SECRET = "whsec_test_secret_for_cloudvault_automated_testing_123";

interface MockDbState {
  users: any[];
  invoices: any[];
  subscriptions: any[];
  cancellations: any[];
  stripe_webhook_events: any[];
  privacy_audit_logs: any[];
  promo_redemptions: any[];
  promo_codes: any[];
  creators: any[];
  charges: any[];
}

function createMockSupabase(initialState?: Partial<MockDbState>) {
  const state: MockDbState = {
    users: [],
    invoices: [],
    subscriptions: [],
    cancellations: [],
    stripe_webhook_events: [],
    privacy_audit_logs: [],
    promo_redemptions: [],
    promo_codes: [],
    creators: [],
    charges: [],
    ...initialState,
  };

  const logs: { table: string; method: string; data?: any; filter?: any }[] = [];

  function createQueryBuilder(tableName: keyof MockDbState) {
    let selectedFields: string | undefined;
    let filters: { field: string; op: string; value: any }[] = [];
    let pendingUpdate: any = null;

    const builder: any = {
      select: (fields = "*", _opts?: any) => {
        selectedFields = fields;
        return builder;
      },
      eq: (field: string, value: any) => {
        filters.push({ field, op: "eq", value });
        return builder;
      },
      or: (conditionString: string) => {
        filters.push({ field: "_or", op: "or", value: conditionString });
        return builder;
      },
      ilike: (field: string, value: any) => {
        filters.push({ field, op: "ilike", value });
        return builder;
      },
      insert: (data: any) => {
        const rows = Array.isArray(data) ? data : [data];
        (state[tableName] as any[]).push(...rows);
        logs.push({ table: tableName as string, method: "insert", data });
        return builder;
      },
      update: (data: any) => {
        pendingUpdate = data;
        logs.push({ table: tableName as string, method: "update", data });
        return builder;
      },
      upsert: (data: any, _opts?: any) => {
        const rows = Array.isArray(data) ? data : [data];
        (state[tableName] as any[]).push(...rows);
        logs.push({ table: tableName as string, method: "upsert", data });
        return Promise.resolve({ data: rows, error: null });
      },
      maybeSingle: async () => {
        const results = await executeQuery();
        return { data: results.length > 0 ? results[0] : null, error: null };
      },
      single: async () => {
        const results = await executeQuery();
        return { data: results[0] || null, error: results.length ? null : { message: "Not found" } };
      },
      then: (resolve: any, reject: any) => {
        return executeQuery().then((data) => resolve({ data, error: null }), reject);
      },
    };

    async function executeQuery() {
      let rows = [...(state[tableName] as any[])];

      if (pendingUpdate) {
        for (const f of filters) {
          if (f.op === "eq") {
            rows = rows.filter((r) => r[f.field] === f.value);
            for (const r of rows) {
              Object.assign(r, pendingUpdate);
            }
          }
        }
        return rows;
      }

      for (const f of filters) {
        if (f.op === "eq") {
          rows = rows.filter((r) => r[f.field] === f.value);
        } else if (f.op === "ilike") {
          rows = rows.filter((r) =>
            typeof r[f.field] === "string" &&
            r[f.field].toLowerCase() === String(f.value).toLowerCase()
          );
        }
      }

      return rows;
    }

    return builder;
  }

  const client = {
    state,
    logs,
    from: (table: keyof MockDbState) => createQueryBuilder(table),
    rpc: async (fnName: string, params: any) => {
      logs.push({ table: "rpc", method: fnName, data: params });
      return { data: null, error: null };
    },
  };

  return client;
}

async function generateStripeSignatureHeader(payload: string, secret = TEST_SECRET): Promise<string> {
  const timestamp = Math.floor(Date.now() / 1000);
  const encoder = new TextEncoder();
  const keyData = encoder.encode(secret);
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    keyData,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const signatureData = encoder.encode(`${timestamp}.${payload}`);
  const signatureBuffer = await crypto.subtle.sign("HMAC", cryptoKey, signatureData);
  const signatureHex = Array.from(new Uint8Array(signatureBuffer))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");

  return `t=${timestamp},v1=${signatureHex}`;
}

async function makeSignedWebhookRequest(eventPayload: Record<string, any>, secret = TEST_SECRET): Promise<Request> {
  const bodyText = JSON.stringify(eventPayload);
  const signature = await generateStripeSignatureHeader(bodyText, secret);

  return new Request("http://localhost:54321/functions/v1/stripe-webhook", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "stripe-signature": signature,
    },
    body: bodyText,
  });
}

Deno.test("Stripe Webhook - Security & Signature Verification", async (t) => {
  Deno.env.set("STRIPE_WEBHOOK_SECRET", TEST_SECRET);

  await t.step("rejects requests missing stripe-signature header", async () => {
    const req = new Request("http://localhost:54321/functions/v1/stripe-webhook", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: "evt_1", type: "invoice.paid" }),
    });

    const res = await handleWebhookRequest(req);
    assertEquals(res.status, 400);
    const data = await res.json();
    assertEquals(data.error, "Missing stripe-signature header");
  });

  await t.step("rejects requests with invalid stripe-signature", async () => {
    const req = new Request("http://localhost:54321/functions/v1/stripe-webhook", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "stripe-signature": "t=1600000000,v1=invalid_signature_hash_bytes",
      },
      body: JSON.stringify({ id: "evt_invalid", type: "invoice.paid" }),
    });

    const res = await handleWebhookRequest(req);
    assertEquals(res.status, 400);
    const data = await res.json();
    assertEquals(data.error.includes("Webhook signature verification failed"), true);
  });
});

Deno.test("Stripe Webhook - Event: invoice.paid", async () => {
  Deno.env.set("STRIPE_WEBHOOK_SECRET", TEST_SECRET);

  const mockDb = createMockSupabase({
    users: [
      {
        id: "usr_cloudvault_test_01",
        stripe_customer_id: "cus_customer_paid_01",
        email: "customer@example.com",
        subscription_status: "past_due",
        is_overdue: true,
      },
    ],
    invoices: [
      {
        id: "inv_db_record_01",
        stripe_invoice_id: "in_stripe_paid_12345",
        payment_status: "open",
        amount_paid: 0,
      },
    ],
    subscriptions: [
      {
        id: "sub_db_record_01",
        stripe_subscription_id: "sub_stripe_active_01",
        status: "past_due",
      },
    ],
  });

  const event = {
    id: "evt_invoice_paid_001",
    object: "event",
    api_version: "2023-10-16",
    created: Math.floor(Date.now() / 1000),
    type: "invoice.paid",
    data: {
      object: {
        id: "in_stripe_paid_12345",
        object: "invoice",
        customer: "cus_customer_paid_01",
        customer_email: "customer@example.com",
        customer_name: "Jane CloudVault",
        subscription: "sub_stripe_active_01",
        payment_intent: "pi_paid_12345",
        status: "paid",
        subtotal: 5000,
        tax: 0,
        total: 5000,
        amount_paid: 5000,
        amount_due: 5000,
        amount_remaining: 0,
        status_transitions: {
          paid_at: Math.floor(Date.now() / 1000),
        },
        lines: {
          data: [
            {
              id: "il_item_01",
              description: "CloudVault Monthly Tier 2 Storage (10 Totes)",
              amount: 5000,
              quantity: 1,
            },
          ],
        },
      },
    },
  };

  const req = await makeSignedWebhookRequest(event);
  const res = await handleWebhookRequest(req, mockDb);

  assertEquals(res.status, 200);
  const resBody = await res.json();
  assertEquals(resBody.received, true);

  // Assert user restored to active standing
  const user = mockDb.state.users.find((u) => u.id === "usr_cloudvault_test_01");
  assertExists(user);
  assertEquals(user.subscription_status, "active");
  assertEquals(user.is_overdue, false);

  // Assert invoice marked paid
  const invoice = mockDb.state.invoices.find((i) => i.stripe_invoice_id === "in_stripe_paid_12345");
  assertExists(invoice);
  assertEquals(invoice.payment_status, "paid");
  assertEquals(invoice.amount_paid, 50);
  assertEquals(invoice.amount_remaining, 0);

  // Assert subscription marked active
  const sub = mockDb.state.subscriptions.find((s) => s.stripe_subscription_id === "sub_stripe_active_01");
  assertExists(sub);
  assertEquals(sub.status, "active");
});

Deno.test("Stripe Webhook - Event: invoice.payment_failed", async () => {
  Deno.env.set("STRIPE_WEBHOOK_SECRET", TEST_SECRET);

  const mockDb = createMockSupabase({
    users: [
      {
        id: "usr_cloudvault_test_02",
        stripe_customer_id: "cus_customer_failed_02",
        email: "failed@example.com",
        subscription_status: "active",
        is_overdue: false,
      },
    ],
    invoices: [
      {
        id: "inv_db_record_02",
        stripe_invoice_id: "in_stripe_failed_67890",
        payment_status: "open",
        amount_due: 75,
      },
    ],
    subscriptions: [
      {
        id: "sub_db_record_02",
        stripe_subscription_id: "sub_stripe_delinquent_02",
        status: "active",
      },
    ],
  });

  const event = {
    id: "evt_invoice_failed_002",
    object: "event",
    api_version: "2023-10-16",
    created: Math.floor(Date.now() / 1000),
    type: "invoice.payment_failed",
    data: {
      object: {
        id: "in_stripe_failed_67890",
        object: "invoice",
        customer: "cus_customer_failed_02",
        subscription: "sub_stripe_delinquent_02",
        payment_intent: "pi_failed_67890",
        amount_due: 7500,
        attempt_count: 2,
        due_date: Math.floor(Date.now() / 1000) - 3600, // Past due date
        last_payment_error: {
          code: "card_declined",
          decline_code: "insufficient_funds",
          message: "Your card has insufficient funds.",
        },
      },
    },
  };

  const req = await makeSignedWebhookRequest(event);
  const res = await handleWebhookRequest(req, mockDb);

  assertEquals(res.status, 200);
  const resBody = await res.json();
  assertEquals(resBody.received, true);

  // Assert user marked as delinquent/overdue
  const user = mockDb.state.users.find((u) => u.id === "usr_cloudvault_test_02");
  assertExists(user);
  assertEquals(user.is_overdue, true);
  assertEquals(user.subscription_status, "past_due");

  // Assert invoice marked overdue/failed
  const invoice = mockDb.state.invoices.find((i) => i.stripe_invoice_id === "in_stripe_failed_67890");
  assertExists(invoice);
  assertEquals(invoice.payment_status, "overdue");
  assertEquals(invoice.amount_due, 75);
  assertEquals(invoice.notes.includes("insufficient_funds"), true);

  // Assert subscription marked past_due
  const sub = mockDb.state.subscriptions.find((s) => s.stripe_subscription_id === "sub_stripe_delinquent_02");
  assertExists(sub);
  assertEquals(sub.status, "past_due");

  // Assert privacy audit log recorded
  assertEquals(mockDb.state.privacy_audit_logs.length > 0, true);
  assertEquals(mockDb.state.privacy_audit_logs[0].action, "stripe_invoice_payment_failed");
});

Deno.test("Stripe Webhook - Event: customer.subscription.deleted", async () => {
  Deno.env.set("STRIPE_WEBHOOK_SECRET", TEST_SECRET);

  const mockDb = createMockSupabase({
    users: [
      {
        id: "usr_cloudvault_test_03",
        stripe_customer_id: "cus_customer_canceled_03",
        email: "canceled@example.com",
        subscription_status: "active",
        onboarding_status: "active",
      },
    ],
    subscriptions: [
      {
        id: "sub_db_record_03",
        stripe_subscription_id: "sub_stripe_canceled_03",
        status: "active",
      },
    ],
    cancellations: [],
  });

  const event = {
    id: "evt_sub_deleted_003",
    object: "event",
    api_version: "2023-10-16",
    created: Math.floor(Date.now() / 1000),
    type: "customer.subscription.deleted",
    data: {
      object: {
        id: "sub_stripe_canceled_03",
        object: "subscription",
        customer: "cus_customer_canceled_03",
        status: "canceled",
      },
    },
  };

  const req = await makeSignedWebhookRequest(event);
  const res = await handleWebhookRequest(req, mockDb);

  assertEquals(res.status, 200);
  const resBody = await res.json();
  assertEquals(resBody.received, true);

  // Assert user subscription status changed to canceled
  const user = mockDb.state.users.find((u) => u.id === "usr_cloudvault_test_03");
  assertExists(user);
  assertEquals(user.subscription_status, "canceled");
  assertEquals(user.onboarding_status, "canceled");

  // Assert subscription marked as canceled
  const sub = mockDb.state.subscriptions.find((s) => s.stripe_subscription_id === "sub_stripe_canceled_03");
  assertExists(sub);
  assertEquals(sub.status, "canceled");

  // Assert cancellation record added to ledger
  assertEquals(mockDb.state.cancellations.length, 1);
  assertEquals(mockDb.state.cancellations[0].uid, "usr_cloudvault_test_03");
  assertEquals(mockDb.state.cancellations[0].account_status, "canceled");
});