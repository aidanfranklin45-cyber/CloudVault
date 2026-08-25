-- ============================================================
-- Clean Rebuild (Drops existing schemas and functions)
-- ============================================================
DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
DROP FUNCTION IF EXISTS public.handle_new_user() CASCADE;
DROP FUNCTION IF EXISTS public.create_customer_profile(TEXT, TEXT, TEXT, INT, TEXT) CASCADE;
DROP FUNCTION IF EXISTS public.add_totes(INT, TEXT) CASCADE;
DROP FUNCTION IF EXISTS public.request_staging(UUID[]) CASCADE;
DROP FUNCTION IF EXISTS public.cancel_subscription(BOOLEAN) CASCADE;
DROP FUNCTION IF EXISTS public.simulate_onboarding_complete() CASCADE;
DROP FUNCTION IF EXISTS public.update_totes_held_sim(INT) CASCADE;
DROP FUNCTION IF EXISTS public.return_all_totes_sim() CASCADE;
DROP FUNCTION IF EXISTS public.trigger_tote_audit_test() CASCADE;
DROP FUNCTION IF EXISTS public.scan_tote(TEXT) CASCADE;
DROP FUNCTION IF EXISTS public.run_daily_autopay_billing() CASCADE;

DROP TABLE IF EXISTS public.invoices CASCADE;
DROP TABLE IF EXISTS public.charges CASCADE;
DROP TABLE IF EXISTS public.cancellations CASCADE;
DROP TABLE IF EXISTS public.access_requests CASCADE;
DROP TABLE IF EXISTS public.service_areas CASCADE;
DROP TABLE IF EXISTS public.waitlist CASCADE;
DROP TABLE IF EXISTS public.facilities CASCADE;
DROP TABLE IF EXISTS public.subscriptions CASCADE;
DROP TABLE IF EXISTS public.inventory CASCADE;
DROP TABLE IF EXISTS public.users CASCADE;
DROP TABLE IF EXISTS public.metadata CASCADE;

-- ============================================================
-- 1. Custom Types (Created conditionally)
-- ============================================================
DO $$ BEGIN
    CREATE TYPE public.user_role AS ENUM ('customer', 'warehouse_worker', 'warehouse_manager', 'executive', 'valet_driver');
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
    CREATE TYPE public.inventory_status AS ENUM ('stored', 'pending-stage', 'staged', 'pending-dispatch', 'out-for-delivery', 'with-customer');
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

-- ============================================================
-- 2. Tables
-- ============================================================

-- Facilities (Defined first for Foreign Key referencing with Regional Dynamic Pricing)
CREATE TABLE public.facilities (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    active_totes INTEGER DEFAULT 0,
    tier1_rate NUMERIC(10,2) DEFAULT 5.00,
    tier2_rate NUMERIC(10,2) DEFAULT 3.50,
    tier3_rate NUMERIC(10,2) DEFAULT 2.00,
    tier4_rate NUMERIC(10,2) DEFAULT 1.00,
    valet_base NUMERIC(10,2) DEFAULT 15.00,
    valet_tote_adder NUMERIC(10,2) DEFAULT 1.00,
    missing_tote_fee NUMERIC(10,2) DEFAULT 15.00,
    staging_rooms INTEGER DEFAULT 2,
    staging_config JSONB DEFAULT '{"allowed_days": [1,2,3,4,5,6,0], "allowed_slots": ["09:00 AM - 12:00 PM", "12:00 PM - 03:00 PM", "03:00 PM - 06:00 PM"]}'::jsonb
);

-- Safe migration fallback for pre-existing tables in Supabase
ALTER TABLE public.facilities ADD COLUMN IF NOT EXISTS staging_rooms INTEGER DEFAULT 2;
ALTER TABLE public.facilities ADD COLUMN IF NOT EXISTS missing_tote_fee NUMERIC(10,2) DEFAULT 15.00;
ALTER TABLE public.facilities ADD COLUMN IF NOT EXISTS tier1_rate NUMERIC(10,2) DEFAULT 5.00;
ALTER TABLE public.facilities ADD COLUMN IF NOT EXISTS tier2_rate NUMERIC(10,2) DEFAULT 3.50;
ALTER TABLE public.facilities ADD COLUMN IF NOT EXISTS tier3_rate NUMERIC(10,2) DEFAULT 2.00;
ALTER TABLE public.facilities ADD COLUMN IF NOT EXISTS tier4_rate NUMERIC(10,2) DEFAULT 1.00;
ALTER TABLE public.facilities ADD COLUMN IF NOT EXISTS valet_base NUMERIC(10,2) DEFAULT 17.00;
ALTER TABLE public.facilities ADD COLUMN IF NOT EXISTS valet_tote_adder NUMERIC(10,2) DEFAULT 1.00;
ALTER TABLE public.facilities ADD COLUMN IF NOT EXISTS next_day_surge_fee NUMERIC(10,2) DEFAULT 9.99;
ALTER TABLE public.facilities ADD COLUMN IF NOT EXISTS next_day_peak_surge_fee NUMERIC(10,2) DEFAULT 14.99;
ALTER TABLE public.facilities ADD COLUMN IF NOT EXISTS same_day_surge_fee NUMERIC(10,2) DEFAULT 19.99;
ALTER TABLE public.facilities ADD COLUMN IF NOT EXISTS same_day_peak_surge_fee NUMERIC(10,2) DEFAULT 24.99;
ALTER TABLE public.facilities ADD COLUMN IF NOT EXISTS evening_peak_slot_fee NUMERIC(10,2) DEFAULT 4.99;
ALTER TABLE public.facilities ADD COLUMN IF NOT EXISTS next_day_promo_free BOOLEAN DEFAULT false;
ALTER TABLE public.facilities ADD COLUMN IF NOT EXISTS max_scheduling_days_out INTEGER DEFAULT 30;
ALTER TABLE public.facilities ADD COLUMN IF NOT EXISTS min_lead_time_days INTEGER DEFAULT 0;
ALTER TABLE public.facilities ADD COLUMN IF NOT EXISTS staging_config JSONB DEFAULT '{"allowed_days": [1,2,3,4,5,6,0], "allowed_slots": ["09:00 AM - 12:00 PM", "12:00 PM - 03:00 PM", "03:00 PM - 06:00 PM"]}'::jsonb;
ALTER TABLE public.facilities ADD COLUMN IF NOT EXISTS valet_enabled BOOLEAN DEFAULT TRUE;
ALTER TABLE public.facilities ADD COLUMN IF NOT EXISTS valet_disabled_until TIMESTAMPTZ DEFAULT NULL;
ALTER TABLE public.facilities ADD COLUMN IF NOT EXISTS valet_disable_reason TEXT DEFAULT NULL;
ALTER TABLE public.facilities ADD COLUMN IF NOT EXISTS staging_enabled BOOLEAN DEFAULT TRUE;
ALTER TABLE public.facilities ADD COLUMN IF NOT EXISTS staging_disabled_until TIMESTAMPTZ DEFAULT NULL;
ALTER TABLE public.facilities ADD COLUMN IF NOT EXISTS staging_disable_reason TEXT DEFAULT NULL;

ALTER TABLE public.access_requests ADD COLUMN IF NOT EXISTS override_reason TEXT DEFAULT NULL;
ALTER TABLE public.access_requests ADD COLUMN IF NOT EXISTS override_notes TEXT DEFAULT NULL;
ALTER TABLE public.access_requests ADD COLUMN IF NOT EXISTS overridden_at TIMESTAMPTZ DEFAULT NULL;
ALTER TABLE public.access_requests ADD COLUMN IF NOT EXISTS overridden_by_name TEXT DEFAULT NULL;

-- Users table (extends auth.users)
CREATE TABLE public.users (
    id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
    email TEXT NOT NULL,
    name TEXT NOT NULL,
    phone TEXT,
    role user_role DEFAULT 'customer'::user_role NOT NULL,
    active_zone TEXT,
    assigned_facility_id TEXT REFERENCES public.facilities(id) ON DELETE SET NULL,
    stripe_customer_id TEXT,
    logistics_preference TEXT DEFAULT 'self_service',
    onboarding_status TEXT DEFAULT 'pending',
    active_totes_held INTEGER DEFAULT 0,
    has_price_lock BOOLEAN DEFAULT false,
    price_lock_rates JSONB DEFAULT NULL,
    price_lock_expires_at TIMESTAMPTZ DEFAULT NULL,
    deposit_paid_amount NUMERIC(10,2) DEFAULT 0.00,
    avatar_color TEXT DEFAULT 'blue',
    is_overdue BOOLEAN DEFAULT false,
    created_at TIMESTAMPTZ DEFAULT now() NOT NULL
);

-- Migration fallbacks for users
ALTER TABLE public.users ADD COLUMN IF NOT EXISTS has_price_lock BOOLEAN DEFAULT false;
ALTER TABLE public.users ADD COLUMN IF NOT EXISTS price_lock_rates JSONB DEFAULT NULL;
ALTER TABLE public.users ADD COLUMN IF NOT EXISTS price_lock_expires_at TIMESTAMPTZ DEFAULT NULL;
ALTER TABLE public.users ADD COLUMN IF NOT EXISTS deposit_paid_amount NUMERIC(10,2) DEFAULT 0.00;
ALTER TABLE public.users ADD COLUMN IF NOT EXISTS is_overdue BOOLEAN DEFAULT false;
ALTER TABLE public.users ADD COLUMN IF NOT EXISTS stripe_subscription_id TEXT;
ALTER TABLE public.users ADD COLUMN IF NOT EXISTS subscription_status TEXT DEFAULT 'incomplete';
ALTER TABLE public.users ADD COLUMN IF NOT EXISTS default_payment_method_id TEXT;
CREATE INDEX IF NOT EXISTS idx_users_stripe_customer_id ON public.users(stripe_customer_id);

-- Inventory (Totes)
CREATE TABLE public.inventory (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    uid UUID REFERENCES public.users(id) ON DELETE CASCADE,
    tote_code TEXT NOT NULL UNIQUE,
    label TEXT,
    status inventory_status DEFAULT 'stored'::inventory_status NOT NULL,
    facility_id TEXT REFERENCES public.facilities(id) ON DELETE SET NULL,
    image_url TEXT,
    category TEXT,
    location_code TEXT DEFAULT 'INTAKE-BAY-1',
    location_type TEXT DEFAULT 'intake',
    last_scanned_at TIMESTAMPTZ DEFAULT now(),
    last_scanned_by UUID REFERENCES public.users(id),
    activated BOOLEAN DEFAULT false,
    updated_at TIMESTAMPTZ DEFAULT now(),
    created_at TIMESTAMPTZ DEFAULT now() NOT NULL
);

-- Migration fallbacks for inventory
ALTER TABLE public.inventory ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT now();
ALTER TABLE public.inventory ADD COLUMN IF NOT EXISTS location_id UUID REFERENCES public.warehouse_locations(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_inventory_location_id ON public.inventory(location_id);

-- Warehouse Physical Locations
CREATE TABLE IF NOT EXISTS public.warehouse_locations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    facility_id TEXT REFERENCES public.facilities(id) ON DELETE CASCADE,
    zone_type VARCHAR(50) NOT NULL CHECK (zone_type IN ('VAULT', 'STAGING', 'LOGISTICS')),
    identifier VARCHAR(100) NOT NULL,
    is_occupied BOOLEAN DEFAULT false NOT NULL,
    capacity INTEGER DEFAULT 3,
    assigned_tote_id UUID REFERENCES public.inventory(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ DEFAULT now() NOT NULL,
    UNIQUE(facility_id, identifier)
);

ALTER TABLE public.warehouse_locations ADD COLUMN IF NOT EXISTS zone_type VARCHAR(50) DEFAULT 'VAULT';
ALTER TABLE public.warehouse_locations ADD COLUMN IF NOT EXISTS identifier VARCHAR(100);
ALTER TABLE public.warehouse_locations ADD COLUMN IF NOT EXISTS is_occupied BOOLEAN DEFAULT false;
ALTER TABLE public.warehouse_locations ALTER COLUMN location_code DROP NOT NULL;
ALTER TABLE public.warehouse_locations ALTER COLUMN location_type DROP NOT NULL;

-- Trigger to auto-sync location_code = identifier if location_code is omitted
CREATE OR REPLACE FUNCTION public.sync_warehouse_location_code()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.location_code IS NULL OR NEW.location_code = '' THEN
    NEW.location_code := NEW.identifier;
  END IF;
  IF NEW.location_type IS NULL OR NEW.location_type = '' THEN
    NEW.location_type := NEW.zone_type;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_sync_warehouse_location_code ON public.warehouse_locations;
CREATE TRIGGER trg_sync_warehouse_location_code
BEFORE INSERT OR UPDATE ON public.warehouse_locations
FOR EACH ROW EXECUTE FUNCTION public.sync_warehouse_location_code();

-- Index on facility_id
CREATE INDEX IF NOT EXISTS idx_warehouse_locations_facility_id ON public.warehouse_locations(facility_id);

-- Enable RLS
ALTER TABLE public.warehouse_locations ENABLE ROW LEVEL SECURITY;

-- Subscriptions
CREATE TABLE public.subscriptions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    uid UUID REFERENCES public.users(id) ON DELETE CASCADE,
    stripe_subscription_id TEXT,
    total_totes INTEGER DEFAULT 0,
    tote_count INTEGER DEFAULT 0,
    tote_rate NUMERIC(10,2) DEFAULT 0.00,
    recurring_storage NUMERIC(10,2) DEFAULT 0.00,
    logistics_type TEXT DEFAULT 'self_service',
    valet_fee NUMERIC(10,2) DEFAULT 0.00,
    first_month_total NUMERIC(10,2) DEFAULT 0.00,
    monthly_total NUMERIC(10,2) DEFAULT 0.00,
    plan_tier TEXT DEFAULT 'valet_flex',
    status TEXT DEFAULT 'active',
    has_price_lock BOOLEAN DEFAULT false,
    price_lock_rates JSONB DEFAULT NULL,
    current_period_end TIMESTAMPTZ,
    last_billed_at TIMESTAMPTZ,
    next_billing_date TIMESTAMPTZ,
    facility_id TEXT DEFAULT NULL,
    created_at TIMESTAMPTZ DEFAULT now() NOT NULL,
    last_updated TIMESTAMPTZ DEFAULT now()
);

-- Migration fallbacks for subscriptions
ALTER TABLE public.subscriptions ADD COLUMN IF NOT EXISTS facility_id TEXT DEFAULT NULL;
ALTER TABLE public.subscriptions ADD COLUMN IF NOT EXISTS has_price_lock BOOLEAN DEFAULT false;
ALTER TABLE public.subscriptions ADD COLUMN IF NOT EXISTS price_lock_rates JSONB DEFAULT NULL;
ALTER TABLE public.subscriptions ADD COLUMN IF NOT EXISTS price_lock_expires_at TIMESTAMPTZ DEFAULT NULL;
ALTER TABLE public.subscriptions ADD COLUMN IF NOT EXISTS last_billed_at TIMESTAMPTZ;
ALTER TABLE public.subscriptions ADD COLUMN IF NOT EXISTS next_billing_date TIMESTAMPTZ;
ALTER TABLE public.subscriptions ADD COLUMN IF NOT EXISTS cancel_at TIMESTAMPTZ DEFAULT NULL;
ALTER TABLE public.subscriptions ADD COLUMN IF NOT EXISTS stripe_customer_id TEXT;
ALTER TABLE public.subscriptions ADD COLUMN IF NOT EXISTS stripe_price_id TEXT;
ALTER TABLE public.subscriptions ADD COLUMN IF NOT EXISTS quantity INTEGER DEFAULT 1;
ALTER TABLE public.subscriptions ADD COLUMN IF NOT EXISTS current_period_start TIMESTAMPTZ;
ALTER TABLE public.subscriptions ADD COLUMN IF NOT EXISTS cancel_at_period_end BOOLEAN DEFAULT false;
ALTER TABLE public.subscriptions ADD COLUMN IF NOT EXISTS canceled_at TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS idx_subscriptions_stripe_sub_id ON public.subscriptions(stripe_subscription_id);
CREATE INDEX IF NOT EXISTS idx_subscriptions_stripe_customer_id ON public.subscriptions(stripe_customer_id);

-- Migration fallbacks for tax & interest
ALTER TABLE public.service_areas ADD COLUMN IF NOT EXISTS tax_rate NUMERIC(5,4) DEFAULT NULL;
ALTER TABLE public.service_areas ADD COLUMN IF NOT EXISTS tax_label TEXT DEFAULT NULL;
ALTER TABLE public.users ADD COLUMN IF NOT EXISTS unpaid_interest_rate NUMERIC(5,4) DEFAULT NULL;
ALTER TABLE public.users ADD COLUMN IF NOT EXISTS interest_starts_at TIMESTAMPTZ DEFAULT NULL;

-- Helper function to lookup tax rate for ZIP
CREATE OR REPLACE FUNCTION public.get_tax_rate_for_zip(p_zip TEXT)
RETURNS NUMERIC AS $$
DECLARE
  v_rate NUMERIC;
BEGIN
  SELECT tax_rate INTO v_rate
  FROM public.service_areas
  WHERE zip_code = p_zip
  LIMIT 1;
  RETURN v_rate;
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER;

-- Operational Zones / Service Markets
CREATE TABLE IF NOT EXISTS public.operational_zones (
    id TEXT PRIMARY KEY,
    city TEXT NOT NULL,
    facility_id TEXT REFERENCES public.facilities(id) ON DELETE SET NULL,
    active BOOLEAN DEFAULT true,
    base_valet_fee NUMERIC(10,2) DEFAULT 15.00,
    required_deposit NUMERIC(10,2) DEFAULT 25.00,
    service_days TEXT DEFAULT 'Mondays and Thursdays',
    zip_codes TEXT[] DEFAULT '{}'
);

ALTER TABLE public.operational_zones ADD COLUMN IF NOT EXISTS required_deposit NUMERIC(10,2) DEFAULT 25.00;

-- Service Areas (ZIP Code Mapping)
CREATE TABLE public.service_areas (
    zip_code TEXT PRIMARY KEY,
    facility_id TEXT REFERENCES public.facilities(id) ON DELETE CASCADE,
    city TEXT,
    state TEXT,
    active BOOLEAN DEFAULT true
);

-- Waitlist
CREATE TABLE public.waitlist (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID REFERENCES public.users(id) ON DELETE SET NULL,
    email TEXT NOT NULL,
    zip_code TEXT NOT NULL,
    city TEXT,
    requested_totes INTEGER DEFAULT 5,
    deposit_amount NUMERIC(10,2) DEFAULT 20.00,
    price_lock_years INTEGER DEFAULT 3,
    refund_guarantee_days INTEGER DEFAULT 365,
    payment_status TEXT DEFAULT 'deposit_paid',
    status TEXT DEFAULT 'deposit_paid',
    price_lock_rates JSONB DEFAULT NULL,
    terms_accepted_at TIMESTAMPTZ DEFAULT now(),
    created_at TIMESTAMPTZ DEFAULT now()
);

-- Safe migration fallback for pre-existing waitlist tables in Supabase
ALTER TABLE public.waitlist ADD COLUMN IF NOT EXISTS user_id UUID REFERENCES public.users(id) ON DELETE SET NULL;
ALTER TABLE public.waitlist ADD COLUMN IF NOT EXISTS deposit_amount NUMERIC(10,2) DEFAULT 20.00;
ALTER TABLE public.waitlist ADD COLUMN IF NOT EXISTS price_lock_years INTEGER DEFAULT 3;
ALTER TABLE public.waitlist ADD COLUMN IF NOT EXISTS refund_guarantee_days INTEGER DEFAULT 365;
ALTER TABLE public.waitlist ADD COLUMN IF NOT EXISTS payment_status TEXT DEFAULT 'deposit_paid';
ALTER TABLE public.waitlist ADD COLUMN IF NOT EXISTS status TEXT DEFAULT 'deposit_paid';
ALTER TABLE public.waitlist ADD COLUMN IF NOT EXISTS price_lock_rates JSONB DEFAULT NULL;
ALTER TABLE public.waitlist ADD COLUMN IF NOT EXISTS terms_accepted_at TIMESTAMPTZ DEFAULT now();

-- Access Requests (for Staging / Delivery & Slot Reservation)
CREATE TABLE public.access_requests (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    uid UUID REFERENCES public.users(id) ON DELETE CASCADE,
    request_type TEXT,
    fulfillment_type TEXT,
    additional_totes INTEGER DEFAULT 0,
    requested_items UUID[], -- Array of inventory IDs
    requested_tote_codes TEXT[], -- Array of tote codes (e.g. CV-SEA-49AK)
    facility_id TEXT REFERENCES public.facilities(id) ON DELETE SET NULL,
    pin TEXT,
    pin_expires_at TIMESTAMPTZ,
    valet_fee NUMERIC(10,2) DEFAULT 0.00,
    surge_fee NUMERIC(10,2) DEFAULT 0.00,
    surge_tier TEXT DEFAULT 'standard',
    status TEXT DEFAULT 'pending',
    overridden_by UUID REFERENCES public.users(id),
    requested_at TIMESTAMPTZ DEFAULT now() NOT NULL,
    target_date DATE DEFAULT CURRENT_DATE,
    time_slot TEXT DEFAULT '09:00 AM - 12:00 PM',
    delivery_notes TEXT
);

-- Safe migration fallback for pre-existing access_requests tables in Supabase
ALTER TABLE public.access_requests ADD COLUMN IF NOT EXISTS surge_fee NUMERIC(10,2) DEFAULT 0.00;
ALTER TABLE public.access_requests ADD COLUMN IF NOT EXISTS surge_tier TEXT DEFAULT 'standard';
ALTER TABLE public.access_requests ADD COLUMN IF NOT EXISTS time_slot TEXT DEFAULT '09:00 AM - 12:00 PM';
ALTER TABLE public.access_requests ADD COLUMN IF NOT EXISTS driver_name TEXT DEFAULT NULL;
ALTER TABLE public.access_requests ADD COLUMN IF NOT EXISTS driver_phone TEXT DEFAULT NULL;
ALTER TABLE public.access_requests ADD COLUMN IF NOT EXISTS vehicle_info TEXT DEFAULT NULL;
ALTER TABLE public.access_requests ADD COLUMN IF NOT EXISTS driver_lat NUMERIC(10,6) DEFAULT NULL;
ALTER TABLE public.access_requests ADD COLUMN IF NOT EXISTS driver_lng NUMERIC(10,6) DEFAULT NULL;
ALTER TABLE public.access_requests ADD COLUMN IF NOT EXISTS estimated_arrival_at TIMESTAMPTZ DEFAULT NULL;
-- NOTE: All request and tracking states are unified under the single 'status' column:
-- 'pending' | 'approved' | 'staged' | 'out-for-delivery' | 'arrived' | 'with-customer' | 'returned-to-vault' | 'completed' | 'missing-tote'

-- Staging Reservations
CREATE TABLE public.staging_reservations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    facility_id TEXT REFERENCES public.facilities(id) ON DELETE CASCADE NOT NULL,
    uid UUID REFERENCES public.users(id) ON DELETE CASCADE NOT NULL,
    access_request_id UUID REFERENCES public.access_requests(id) ON DELETE CASCADE,
    tote_ids UUID[] NOT NULL,
    start_time TIMESTAMPTZ NOT NULL,
    end_time TIMESTAMPTZ NOT NULL,
    status TEXT DEFAULT 'scheduled' CHECK (status IN ('scheduled', 'active', 'completed', 'cancelled', 'no_show')) NOT NULL,
    created_at TIMESTAMPTZ DEFAULT now() NOT NULL,
    CONSTRAINT valid_duration CHECK (
        EXTRACT(EPOCH FROM (end_time - start_time))/3600 >= 1.0 AND 
        EXTRACT(EPOCH FROM (end_time - start_time))/3600 <= 3.0
    )
);

CREATE INDEX idx_staging_reservations_time_range ON public.staging_reservations (facility_id, start_time, end_time) WHERE status IN ('scheduled', 'active');

-- Cancellations
CREATE TABLE public.cancellations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    uid UUID REFERENCES public.users(id) ON DELETE CASCADE,
    account_status TEXT DEFAULT 'pending_tote_return',
    active_totes_held INTEGER DEFAULT 0,
    cancellation_date TIMESTAMPTZ DEFAULT now() NOT NULL,
    deadline_date TIMESTAMPTZ NOT NULL,
    charge_amount NUMERIC(10,2) DEFAULT 0.00,
    charged_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT now() NOT NULL
);

-- Charges
CREATE TABLE public.charges (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    uid UUID REFERENCES public.users(id) ON DELETE CASCADE,
    charge_type TEXT NOT NULL,
    amount NUMERIC(10,2) NOT NULL,
    totes_charged INTEGER DEFAULT 0,
    status TEXT DEFAULT 'success',
    charged_at TIMESTAMPTZ DEFAULT now() NOT NULL
);

-- Invoices Table
CREATE TABLE IF NOT EXISTS public.invoices (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    invoice_number TEXT UNIQUE NOT NULL,
    uid UUID REFERENCES public.users(id) ON DELETE CASCADE,
    customer_name TEXT,
    customer_email TEXT,
    facility_id TEXT REFERENCES public.facilities(id) ON DELETE SET NULL,
    invoice_type TEXT DEFAULT 'subscription',
    payment_status TEXT DEFAULT 'paid' CHECK (payment_status IN ('paid', 'pending', 'overdue', 'failed', 'refunded', 'deposit_received')),
    subtotal NUMERIC(10,2) DEFAULT 0.00,
    delivery_fee NUMERIC(10,2) DEFAULT 0.00,
    surge_fee NUMERIC(10,2) DEFAULT 0.00,
    tax NUMERIC(10,2) DEFAULT 0.00,
    discount NUMERIC(10,2) DEFAULT 0.00,
    total_amount NUMERIC(10,2) DEFAULT 0.00,
    payment_method TEXT DEFAULT 'card',
    transaction_reference TEXT,
    notes TEXT,
    line_items JSONB DEFAULT '[]'::jsonb,
    due_date TIMESTAMPTZ DEFAULT (now() + interval '3 days'),
    created_at TIMESTAMPTZ DEFAULT now() NOT NULL,
    paid_at TIMESTAMPTZ DEFAULT now(),
    refunded_at TIMESTAMPTZ
);

-- Safe migration fallbacks for pre-existing invoices tables in Supabase
ALTER TABLE public.invoices ADD COLUMN IF NOT EXISTS invoice_number TEXT;
ALTER TABLE public.invoices ADD COLUMN IF NOT EXISTS uid UUID REFERENCES public.users(id) ON DELETE CASCADE;
ALTER TABLE public.invoices ADD COLUMN IF NOT EXISTS customer_name TEXT;
ALTER TABLE public.invoices ADD COLUMN IF NOT EXISTS customer_email TEXT;
ALTER TABLE public.invoices ADD COLUMN IF NOT EXISTS facility_id TEXT REFERENCES public.facilities(id) ON DELETE SET NULL;
ALTER TABLE public.invoices ADD COLUMN IF NOT EXISTS invoice_type TEXT DEFAULT 'subscription';
ALTER TABLE public.invoices ADD COLUMN IF NOT EXISTS payment_status TEXT DEFAULT 'paid';
ALTER TABLE public.invoices ADD COLUMN IF NOT EXISTS subtotal NUMERIC(10,2) DEFAULT 0.00;
ALTER TABLE public.invoices ADD COLUMN IF NOT EXISTS delivery_fee NUMERIC(10,2) DEFAULT 0.00;
ALTER TABLE public.invoices ADD COLUMN IF NOT EXISTS surge_fee NUMERIC(10,2) DEFAULT 0.00;
ALTER TABLE public.invoices ADD COLUMN IF NOT EXISTS tax NUMERIC(10,2) DEFAULT 0.00;
ALTER TABLE public.invoices ADD COLUMN IF NOT EXISTS discount NUMERIC(10,2) DEFAULT 0.00;
ALTER TABLE public.invoices ADD COLUMN IF NOT EXISTS total_amount NUMERIC(10,2) DEFAULT 0.00;
ALTER TABLE public.invoices ADD COLUMN IF NOT EXISTS payment_method TEXT DEFAULT 'card';
ALTER TABLE public.invoices ADD COLUMN IF NOT EXISTS transaction_reference TEXT;
ALTER TABLE public.invoices ADD COLUMN IF NOT EXISTS notes TEXT;
ALTER TABLE public.invoices ADD COLUMN IF NOT EXISTS line_items JSONB DEFAULT '[]'::jsonb;
ALTER TABLE public.invoices ADD COLUMN IF NOT EXISTS due_date TIMESTAMPTZ DEFAULT (now() + interval '3 days');
ALTER TABLE public.invoices ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ DEFAULT now();
ALTER TABLE public.invoices ADD COLUMN IF NOT EXISTS paid_at TIMESTAMPTZ;
ALTER TABLE public.invoices ADD COLUMN IF NOT EXISTS refunded_at TIMESTAMPTZ;
ALTER TABLE public.invoices ADD COLUMN IF NOT EXISTS stripe_invoice_id TEXT;
ALTER TABLE public.invoices ADD COLUMN IF NOT EXISTS stripe_customer_id TEXT;
ALTER TABLE public.invoices ADD COLUMN IF NOT EXISTS stripe_payment_intent_id TEXT;
ALTER TABLE public.invoices ADD COLUMN IF NOT EXISTS stripe_hosted_invoice_url TEXT;
ALTER TABLE public.invoices ADD COLUMN IF NOT EXISTS stripe_invoice_pdf TEXT;
ALTER TABLE public.invoices ADD COLUMN IF NOT EXISTS amount_due NUMERIC(10,2) DEFAULT 0.00;
ALTER TABLE public.invoices ADD COLUMN IF NOT EXISTS amount_paid NUMERIC(10,2) DEFAULT 0.00;
ALTER TABLE public.invoices ADD COLUMN IF NOT EXISTS amount_remaining NUMERIC(10,2) DEFAULT 0.00;
ALTER TABLE public.invoices DROP CONSTRAINT IF EXISTS invoices_payment_status_check;
ALTER TABLE public.invoices ADD CONSTRAINT invoices_payment_status_check CHECK (payment_status IN ('paid', 'pending', 'overdue', 'failed', 'refunded', 'deposit_received', 'open', 'void', 'uncollectible', 'draft'));

-- Indexes for invoices
CREATE INDEX IF NOT EXISTS idx_invoices_uid ON public.invoices(uid);
CREATE INDEX IF NOT EXISTS idx_invoices_customer_email ON public.invoices(customer_email);
CREATE INDEX IF NOT EXISTS idx_invoices_invoice_number ON public.invoices(invoice_number);
CREATE INDEX IF NOT EXISTS idx_invoices_stripe_invoice_id ON public.invoices(stripe_invoice_id);
CREATE INDEX IF NOT EXISTS idx_invoices_stripe_customer_id ON public.invoices(stripe_customer_id);
CREATE INDEX IF NOT EXISTS idx_invoices_payment_status ON public.invoices(payment_status);
CREATE INDEX IF NOT EXISTS idx_invoices_created_at ON public.invoices(created_at);
CREATE INDEX IF NOT EXISTS idx_invoices_uid_created ON public.invoices(uid, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_invoices_email_created ON public.invoices(customer_email, created_at DESC);

-- Safe migration fallbacks for charges
ALTER TABLE public.charges ADD COLUMN IF NOT EXISTS stripe_charge_id TEXT;
ALTER TABLE public.charges ADD COLUMN IF NOT EXISTS stripe_payment_intent_id TEXT;
ALTER TABLE public.charges ADD COLUMN IF NOT EXISTS receipt_url TEXT;
ALTER TABLE public.charges ADD COLUMN IF NOT EXISTS payment_method_brand TEXT;
ALTER TABLE public.charges ADD COLUMN IF NOT EXISTS payment_method_last4 TEXT;
CREATE INDEX IF NOT EXISTS idx_charges_stripe_charge_id ON public.charges(stripe_charge_id);

-- Stripe Webhook Events (Idempotency Ledger)
CREATE TABLE IF NOT EXISTS public.stripe_webhook_events (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    stripe_event_id TEXT UNIQUE NOT NULL,
    event_type TEXT NOT NULL,
    payload JSONB NOT NULL,
    status TEXT DEFAULT 'processed',
    created_at TIMESTAMPTZ DEFAULT now() NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_stripe_webhook_events_event_id ON public.stripe_webhook_events(stripe_event_id);
CREATE INDEX IF NOT EXISTS idx_stripe_webhook_events_type ON public.stripe_webhook_events(event_type);
ALTER TABLE public.stripe_webhook_events ENABLE ROW LEVEL SECURITY;

-- System Metadata / Financials (Singleton row)
CREATE TABLE public.metadata (
    id TEXT PRIMARY KEY,
    total_users INTEGER DEFAULT 0,
    total_totes INTEGER DEFAULT 0,
    total_mrr NUMERIC(10,2) DEFAULT 0.00
);
INSERT INTO public.metadata (id) VALUES ('financials') ON CONFLICT DO NOTHING;

-- Insert default facilities
INSERT INTO public.facilities (id, name, tier1_rate, tier2_rate, tier3_rate, tier4_rate, valet_base, valet_tote_adder) VALUES 
('facility_seattle_north', 'Seattle North Hub', 5.00, 3.50, 2.00, 1.00, 15.00, 1.00),
('facility_portland_central', 'Portland Central Hub', 5.00, 3.50, 2.00, 1.00, 15.00, 1.00),
('facility_yakima', 'Yakima Hub', 5.00, 3.50, 2.00, 1.00, 15.00, 1.00)
ON CONFLICT DO NOTHING;

-- Seed default Service Areas
INSERT INTO public.service_areas (zip_code, facility_id, city, state, active) VALUES 
('98101', 'facility_seattle_north', 'Seattle', 'WA', true),
('98102', 'facility_seattle_north', 'Seattle', 'WA', true),
('98103', 'facility_seattle_north', 'Seattle', 'WA', true),
('98104', 'facility_seattle_north', 'Seattle', 'WA', true),
('97201', 'facility_portland_central', 'Portland', 'OR', true),
('97202', 'facility_portland_central', 'Portland', 'OR', true),
('97203', 'facility_portland_central', 'Portland', 'OR', true),
('97204', 'facility_portland_central', 'Portland', 'OR', true),
('98908', 'facility_yakima', 'Yakima', 'WA', true),
('98942', 'facility_yakima', 'Yakima', 'WA', true)
ON CONFLICT DO NOTHING;


-- ============================================================
-- 3. Row Level Security (RLS)
-- ============================================================
ALTER TABLE public.users ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.inventory ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.subscriptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.service_areas ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.waitlist ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.facilities ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.access_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.staging_reservations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.cancellations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.charges ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.invoices ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.metadata ENABLE ROW LEVEL SECURITY;

-- Helper functions for RLS
CREATE OR REPLACE FUNCTION public.get_user_role() RETURNS public.user_role AS $$
  SELECT role FROM public.users WHERE id = auth.uid();
$$ LANGUAGE sql SECURITY DEFINER;

CREATE OR REPLACE FUNCTION public.get_user_facility_id() RETURNS TEXT AS $$
  SELECT assigned_facility_id FROM public.users WHERE id = auth.uid();
$$ LANGUAGE sql SECURITY DEFINER;


-- ------------------------------------------------------------
-- USERS Policies
-- ------------------------------------------------------------
DROP POLICY IF EXISTS "Users can view own profile" ON public.users;
CREATE POLICY "Users can view own profile" ON public.users
    FOR SELECT USING ((SELECT auth.uid()) = id);

DROP POLICY IF EXISTS "Users can update own profile" ON public.users;
CREATE POLICY "Users can update own profile" ON public.users
    FOR UPDATE USING ((SELECT auth.uid()) = id) WITH CHECK ((SELECT auth.uid()) = id);

DROP POLICY IF EXISTS "Staff can view all users" ON public.users;
CREATE POLICY "Staff can view all users" ON public.users
    FOR SELECT USING (public.get_user_role() IN ('warehouse_worker', 'warehouse_manager', 'executive'));

-- ------------------------------------------------------------
-- INVENTORY Policies
-- ------------------------------------------------------------
DROP POLICY IF EXISTS "Users view own inventory" ON public.inventory;
CREATE POLICY "Users view own inventory" ON public.inventory
    FOR SELECT USING (uid = (SELECT auth.uid()));

DROP POLICY IF EXISTS "Staff view all inventory" ON public.inventory;
CREATE POLICY "Staff view all inventory" ON public.inventory
    FOR SELECT USING (public.get_user_role() IN ('warehouse_worker', 'warehouse_manager', 'executive'));

DROP POLICY IF EXISTS "Users update own inventory labels" ON public.inventory;
CREATE POLICY "Users update own inventory labels" ON public.inventory
    FOR UPDATE USING (uid = (SELECT auth.uid()));
    
-- ------------------------------------------------------------
-- SUBSCRIPTIONS, CANCELLATIONS, CHARGES, ACCESS_REQUESTS
-- ------------------------------------------------------------
DROP POLICY IF EXISTS "Users view own records" ON public.subscriptions;
CREATE POLICY "Users view own records" ON public.subscriptions FOR SELECT USING (uid = (SELECT auth.uid()));

DROP POLICY IF EXISTS "Staff view all records" ON public.subscriptions;
CREATE POLICY "Staff view all records" ON public.subscriptions FOR SELECT USING (public.get_user_role() IN ('warehouse_worker', 'warehouse_manager', 'executive'));

DROP POLICY IF EXISTS "Users view own cancellations" ON public.cancellations;
CREATE POLICY "Users view own cancellations" ON public.cancellations FOR SELECT USING (uid = (SELECT auth.uid()));

DROP POLICY IF EXISTS "Staff view all cancellations" ON public.cancellations;
CREATE POLICY "Staff view all cancellations" ON public.cancellations FOR SELECT USING (public.get_user_role() IN ('warehouse_worker', 'warehouse_manager', 'executive'));

DROP POLICY IF EXISTS "Users view own charges" ON public.charges;
CREATE POLICY "Users view own charges" ON public.charges FOR SELECT USING (uid = (SELECT auth.uid()));

DROP POLICY IF EXISTS "Staff view all charges" ON public.charges;
CREATE POLICY "Staff view all charges" ON public.charges FOR SELECT USING (public.get_user_role() IN ('warehouse_worker', 'warehouse_manager', 'executive'));

DROP POLICY IF EXISTS "Users view own invoices" ON public.invoices;
CREATE POLICY "Users view own invoices" ON public.invoices FOR SELECT USING (uid = (SELECT auth.uid()) OR customer_email = (SELECT auth.email()));

DROP POLICY IF EXISTS "Users insert own invoices" ON public.invoices;
CREATE POLICY "Users insert own invoices" ON public.invoices FOR INSERT WITH CHECK (uid = (SELECT auth.uid()) OR (SELECT auth.uid()) IS NOT NULL);

DROP POLICY IF EXISTS "Staff manage all invoices" ON public.invoices;
CREATE POLICY "Staff manage all invoices" ON public.invoices FOR ALL USING (public.get_user_role() IN ('warehouse_worker', 'warehouse_manager', 'executive')) WITH CHECK (public.get_user_role() IN ('warehouse_worker', 'warehouse_manager', 'executive'));

DROP POLICY IF EXISTS "Users view own access requests" ON public.access_requests;
CREATE POLICY "Users view own access requests" ON public.access_requests FOR SELECT USING (uid = (SELECT auth.uid()));

DROP POLICY IF EXISTS "Staff view all access requests" ON public.access_requests;
CREATE POLICY "Staff view all access requests" ON public.access_requests FOR SELECT USING (public.get_user_role() IN ('warehouse_worker', 'warehouse_manager', 'executive'));

DROP POLICY IF EXISTS "Users view own reservations" ON public.staging_reservations;
CREATE POLICY "Users view own reservations" ON public.staging_reservations FOR SELECT USING (uid = (SELECT auth.uid()));

DROP POLICY IF EXISTS "Staff view all reservations" ON public.staging_reservations;
CREATE POLICY "Staff view all reservations" ON public.staging_reservations FOR SELECT USING (public.get_user_role() IN ('warehouse_worker', 'warehouse_manager', 'executive'));

DROP POLICY IF EXISTS "Managers update access requests" ON public.access_requests;
CREATE POLICY "Managers update access requests" ON public.access_requests
    FOR UPDATE USING (
        public.get_user_role() = 'executive' OR 
        (public.get_user_role() = 'warehouse_manager' AND facility_id = public.get_user_facility_id())
    );

-- ------------------------------------------------------------
-- SETTINGS Policies (Optimized InitPlan Caching)
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.settings (
    id TEXT PRIMARY KEY,
    valet_base NUMERIC(10,2) DEFAULT 15.00,
    valet_tote_adder NUMERIC(10,2) DEFAULT 2.00,
    settings_data JSONB DEFAULT '{}'::jsonb,
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    updated_by UUID REFERENCES public.users(id) ON DELETE SET NULL
);

ALTER TABLE public.settings ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Public Read Access for Settings" ON public.settings;
CREATE POLICY "Public Read Access for Settings" ON public.settings
    FOR SELECT
    TO authenticated, anon
    USING (true);

DROP POLICY IF EXISTS "Executive Write Access for Settings" ON public.settings;
CREATE POLICY "Executive Write Access for Settings" ON public.settings
    FOR ALL
    TO authenticated
    USING (
        EXISTS (
            SELECT 1 FROM public.users
            WHERE users.id = (SELECT auth.uid())
              AND users.role IN ('executive', 'warehouse_manager')
        )
    )
    WITH CHECK (
        EXISTS (
            SELECT 1 FROM public.users
            WHERE users.id = (SELECT auth.uid())
              AND users.role IN ('executive', 'warehouse_manager')
        )
    );

-- ------------------------------------------------------------
-- FACILITIES & METADATA
-- ------------------------------------------------------------
CREATE POLICY "Executives view all facilities" ON public.facilities
    FOR SELECT USING (public.get_user_role() = 'executive');

CREATE POLICY "Anyone can view active service areas" ON public.service_areas
    FOR SELECT USING (active = true);

CREATE POLICY "Anyone can insert to waitlist" ON public.waitlist
    FOR INSERT WITH CHECK (true);

CREATE POLICY "Executives view waitlist" ON public.waitlist
    FOR SELECT USING (public.get_user_role() = 'executive');

CREATE POLICY "Staff view assigned facility" ON public.facilities
    FOR SELECT USING (
        public.get_user_role() IN ('warehouse_worker', 'warehouse_manager') AND id = public.get_user_facility_id()
    );

CREATE POLICY "Allow select on metadata" ON public.metadata
    FOR SELECT USING (true);

-- ============================================================
-- 4. Auth Hook & Triggers (Auto-create user profile)
-- ============================================================
CREATE OR REPLACE FUNCTION public.handle_new_user() 
RETURNS trigger AS $$
DECLARE
  v_zip TEXT;
  v_facility_id TEXT;
  v_role public.user_role;
BEGIN
  v_zip := COALESCE(new.raw_user_meta_data->>'zip', '98101');
  v_facility_id := new.raw_user_meta_data->>'assigned_facility_id';
  
  IF (new.raw_user_meta_data->>'role') IS NOT NULL AND (new.raw_user_meta_data->>'role') != '' THEN
    BEGIN
      v_role := (new.raw_user_meta_data->>'role')::public.user_role;
    EXCEPTION WHEN OTHERS THEN
      v_role := 'customer'::public.user_role;
    END;
  ELSE
    v_role := 'customer'::public.user_role;
  END IF;

  IF v_facility_id IS NULL OR v_facility_id = '' THEN
    IF v_zip IS NOT NULL AND v_zip != '' THEN
      -- Try matching operational_zones
      SELECT facility_id INTO v_facility_id
      FROM public.operational_zones
      WHERE v_zip = ANY(zip_codes) AND facility_id IS NOT NULL
      LIMIT 1;

      -- Fallback to service_areas
      IF v_facility_id IS NULL THEN
        SELECT facility_id INTO v_facility_id
        FROM public.service_areas
        WHERE zip_code = v_zip AND facility_id IS NOT NULL
        LIMIT 1;
      END IF;
    END IF;

    -- Fail-safe default
    IF v_facility_id IS NULL THEN
      v_facility_id := 'facility_seattle_north';
    END IF;
  END IF;

  INSERT INTO public.users (id, email, name, phone, role, assigned_facility_id, active_zone)
  VALUES (
      new.id, 
      new.email, 
      COALESCE(new.raw_user_meta_data->>'name', 'Unknown'),
      COALESCE(new.raw_user_meta_data->>'phone', ''),
      v_role,
      v_facility_id,
      v_zip
  )
  ON CONFLICT (id) DO UPDATE SET
      name = EXCLUDED.name,
      role = EXCLUDED.role,
      assigned_facility_id = EXCLUDED.assigned_facility_id;
  RETURN new;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

CREATE OR REPLACE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE PROCEDURE public.handle_new_user();


-- Auto-sync trigger for active totes count on public.users
CREATE OR REPLACE FUNCTION public.sync_user_active_totes_held()
RETURNS trigger AS $$
DECLARE
  v_uid UUID;
BEGIN
  v_uid := COALESCE(NEW.uid, OLD.uid);
  IF v_uid IS NOT NULL THEN
    UPDATE public.users
    SET active_totes_held = (
      SELECT COUNT(*)::INT 
      FROM public.inventory 
      WHERE uid = v_uid 
        AND status::text NOT IN ('missing-tote', 'missing', 'decommissioned', 'discharged')
        AND (location_type IS NULL OR location_type::text NOT IN ('discharged', 'written_off', 'missing'))
    )
    WHERE id = v_uid;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

CREATE OR REPLACE TRIGGER trg_sync_user_active_totes_held
  AFTER INSERT OR UPDATE OF status, uid, location_type OR DELETE ON public.inventory
  FOR EACH ROW EXECUTE PROCEDURE public.sync_user_active_totes_held();


-- ============================================================
-- 5. Business Logic / Database RPC Functions
-- ============================================================

-- Helper function to derive 3-letter facility prefix from facility_id
CREATE OR REPLACE FUNCTION public.get_facility_prefix(p_facility_id TEXT)
RETURNS TEXT AS $$
BEGIN
  IF p_facility_id LIKE '%portland%' OR p_facility_id LIKE '%pdx%' THEN
    RETURN 'PDX';
  ELSIF p_facility_id LIKE '%seattle%' OR p_facility_id LIKE '%sea%' THEN
    RETURN 'SEA';
  ELSE
    RETURN 'HUB';
  END IF;
END;
$$ LANGUAGE plpgsql IMMUTABLE;

-- Generator function for unique structured tote codes with guaranteed alphanumeric mix (e.g. CV-SEA-49AK, CV-YAK-8K3M)
CREATE OR REPLACE FUNCTION public.generate_tote_code(p_facility_id TEXT)
RETURNS TEXT AS $$
DECLARE
  v_prefix TEXT;
  v_digits TEXT := '23456789';
  v_letters TEXT := 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  v_all_chars TEXT := '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
  v_random_code TEXT;
  v_tote_code TEXT;
  v_exists BOOLEAN;
BEGIN
  v_prefix := public.get_facility_prefix(p_facility_id);

  LOOP
    -- Guarantee at least one digit and one letter for a clean alphanumeric mixture
    v_random_code := substr(v_digits, floor(random() * length(v_digits) + 1)::int, 1)
                  || substr(v_letters, floor(random() * length(v_letters) + 1)::int, 1)
                  || substr(v_all_chars, floor(random() * length(v_all_chars) + 1)::int, 1)
                  || substr(v_all_chars, floor(random() * length(v_all_chars) + 1)::int, 1);
    
    -- Shuffle the 4 characters
    SELECT string_agg(ch, '' ORDER BY random()) INTO v_random_code
    FROM regexp_split_to_table(v_random_code, '') AS ch;

    v_tote_code := 'CV-' || v_prefix || '-' || v_random_code;

    -- Ensure uniqueness
    SELECT EXISTS (SELECT 1 FROM public.inventory WHERE tote_code = v_tote_code) INTO v_exists;
    EXIT WHEN NOT v_exists;
  END LOOP;

  RETURN v_tote_code;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Create Customer Profile & Subscription
CREATE OR REPLACE FUNCTION public.create_customer_profile(
  p_name TEXT,
  p_phone TEXT,
  p_zip TEXT,
  p_tote_count INT,
  p_logistics_type TEXT
) RETURNS JSONB SECURITY DEFINER AS $$
DECLARE
  v_uid UUID;
  v_email TEXT;
  v_tote_rate NUMERIC;
  v_recurring_storage NUMERIC;
  v_first_month_total NUMERIC;
  v_facility_id TEXT;
BEGIN
  v_uid := auth.uid();
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Unauthenticated';
  END IF;

  SELECT email INTO v_email FROM auth.users WHERE id = v_uid;

  -- Dynamic facility lookup from service_areas
  SELECT facility_id INTO v_facility_id
  FROM public.service_areas
  WHERE zip_code = p_zip AND active = true
  LIMIT 1;

  IF v_facility_id IS NULL THEN
    v_facility_id := 'facility_seattle_north';
  END IF;

  -- Dynamic regional rate & fee calculation from facilities table (or user's locked rates)
  DECLARE
    v_t1 NUMERIC; v_t2 NUMERIC; v_t3 NUMERIC; v_t4 NUMERIC;
    v_vbase NUMERIC; v_vadder NUMERIC;
    v_has_lock BOOLEAN := false;
    v_lock_rates JSONB := NULL;
  BEGIN
    SELECT 
      COALESCE(tier1_rate, 5.00), 
      COALESCE(tier2_rate, 3.50), 
      COALESCE(tier3_rate, 2.00), 
      COALESCE(tier4_rate, 1.00),
      COALESCE(valet_base, 15.00),
      COALESCE(valet_tote_adder, 1.00)
    INTO v_t1, v_t2, v_t3, v_t4, v_vbase, v_vadder
    FROM public.facilities
    WHERE id = v_facility_id;

    -- Override with Legacy Price Lock if user has active price lock
    SELECT COALESCE(has_price_lock, false), price_lock_rates 
    INTO v_has_lock, v_lock_rates 
    FROM public.users WHERE id = v_uid;

    IF v_has_lock IS TRUE AND v_lock_rates IS NOT NULL THEN
      v_t1 := COALESCE((v_lock_rates->>'tier1_rate')::NUMERIC, v_t1);
      v_t2 := COALESCE((v_lock_rates->>'tier2_rate')::NUMERIC, v_t2);
      v_t3 := COALESCE((v_lock_rates->>'tier3_rate')::NUMERIC, v_t3);
      v_t4 := COALESCE((v_lock_rates->>'tier4_rate')::NUMERIC, v_t4);
    END IF;

    IF p_tote_count >= 50 THEN v_tote_rate := v_t4;
    ELSIF p_tote_count >= 25 THEN v_tote_rate := v_t3;
    ELSIF p_tote_count >= 10 THEN v_tote_rate := v_t2;
    ELSE v_tote_rate := v_t1;
    END IF;

    v_recurring_storage := p_tote_count * v_tote_rate;
    IF p_logistics_type = 'valet_pickup' THEN
      v_valet_fee := v_vbase + (p_tote_count * v_vadder);
    ELSE
      v_valet_fee := 0.00;
    END IF;
  END;
  v_first_month_total := v_recurring_storage + v_valet_fee;

  -- Update user assigned facility
  UPDATE public.users 
  SET assigned_facility_id = v_facility_id
  WHERE id = v_uid;

  -- Remove any previously cancelled/stuck subscriptions for this user
  DELETE FROM public.subscriptions WHERE uid = v_uid;

  -- Update users table — set onboarding_status to 'active' so the dashboard renders immediately
  UPDATE public.users 
  SET name = p_name,
      phone = p_phone,
      active_zone = p_zip,
      logistics_preference = p_logistics_type,
      onboarding_status = 'active',
      active_totes_held = 0
  WHERE id = v_uid;

  -- Insert subscription
  INSERT INTO public.subscriptions (
    uid,
    stripe_subscription_id,
    total_totes,
    tote_count,
    tote_rate,
    recurring_storage,
    logistics_type,
    valet_fee,
    first_month_total,
    monthly_total,
    plan_tier,
    status,
    has_price_lock,
    price_lock_expires_at,
    current_period_end,
    next_billing_date,
    last_billed_at
  ) VALUES (
    v_uid,
    'stub_' || substring(md5(random()::text) from 1 for 9),
    p_tote_count,
    p_tote_count,
    v_tote_rate,
    v_recurring_storage,
    p_logistics_type,
    v_valet_fee,
    v_first_month_total,
    v_first_month_total,
    'valet_flex',
    'active',
    v_has_lock,
    CASE WHEN v_has_lock IS TRUE THEN now() + interval '3 years' ELSE NULL END,
    now() + interval '30 days',
    now() + interval '30 days',
    now()
  );
  IF p_logistics_type IN ('valet_pickup', 'valet_delivery') THEN
    v_initial_status := 'pending-dispatch';
  ELSE
    v_initial_status := 'pending-stage';
  END IF;

  -- Dynamic facility lookup from service_areas
  SELECT facility_id INTO v_facility_id
  FROM public.service_areas
  WHERE zip_code = p_zip AND active = true
  LIMIT 1;

  IF v_facility_id IS NULL THEN
    v_facility_id := 'facility_seattle_north';
  END IF;

  -- Create inventory items with facility-tethered tote codes (e.g. CV-SEA-49AK)
  FOR i IN 0..(p_tote_count - 1) LOOP
    INSERT INTO public.inventory (uid, tote_code, label, status, facility_id)
    VALUES (
      v_uid,
      public.generate_tote_code(v_facility_id),
      'Empty Tote #' || (i + 1),
      v_initial_status,
      v_facility_id
    );
  END LOOP;

  -- Update user totes held
  UPDATE public.users
  SET active_totes_held = p_tote_count
  WHERE id = v_uid;

  -- Update global financials
  INSERT INTO public.metadata (id, total_users, total_totes, total_mrr)
  VALUES ('financials', 1, p_tote_count, v_recurring_storage)
  ON CONFLICT (id) DO UPDATE 
  SET total_users = public.metadata.total_users + 1,
      total_totes = public.metadata.total_totes + p_tote_count,
      total_mrr = public.metadata.total_mrr + v_recurring_storage;

  RETURN jsonb_build_object(
    'success', true,
    'recurringStorage', v_recurring_storage,
    'valetFee', v_valet_fee,
    'firstMonthTotal', v_first_month_total,
    'toteRate', v_tote_rate
  );
END;
$$ LANGUAGE plpgsql;

-- ─────────────────────────────────────────────────────────────────────
-- 10. Subscription Billing Segments & Dynamic Pro-Rata Tier Engine
-- ─────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.subscription_billing_segments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  subscription_id UUID REFERENCES public.subscriptions(id) ON DELETE CASCADE,
  uid UUID REFERENCES public.users(id) ON DELETE CASCADE,
  facility_id TEXT,
  tote_count INT NOT NULL,
  unit_rate NUMERIC(10,2) NOT NULL,
  effective_start TIMESTAMPTZ NOT NULL,
  effective_end TIMESTAMPTZ,
  reason TEXT DEFAULT 'initial_subscription',
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_sub_billing_segs_uid ON public.subscription_billing_segments(uid);
CREATE INDEX IF NOT EXISTS idx_sub_billing_segs_sub ON public.subscription_billing_segments(subscription_id);
CREATE INDEX IF NOT EXISTS idx_sub_billing_segs_dates ON public.subscription_billing_segments(effective_start, effective_end);

ALTER TABLE public.subscription_billing_segments ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users can read own billing segments" ON public.subscription_billing_segments;
CREATE POLICY "Users can read own billing segments"
  ON public.subscription_billing_segments
  FOR SELECT
  USING (auth.uid() = uid);

DROP POLICY IF EXISTS "Staff full access to billing segments" ON public.subscription_billing_segments;
CREATE POLICY "Staff full access to billing segments"
  ON public.subscription_billing_segments
  FOR ALL
  USING (EXISTS (SELECT 1 FROM public.users WHERE id = auth.uid() AND role IN ('warehouse_worker', 'warehouse_manager', 'executive')));

-- Add Totes to Subscription (Pro-Rata Segment Driven)
CREATE OR REPLACE FUNCTION public.add_totes(
  p_additional_totes INT,
  p_logistics_type TEXT DEFAULT 'self_dropoff',
  p_target_date DATE DEFAULT NULL,
  p_time_slot TEXT DEFAULT NULL
) RETURNS JSONB SECURITY DEFINER AS $$
DECLARE
  v_uid UUID;
  v_user_name TEXT;
  v_user_email TEXT;
  v_current_totes INT;
  v_current_recurring NUMERIC;
  v_new_total INT;
  v_new_rate NUMERIC;
  v_new_recurring NUMERIC;
  v_delta NUMERIC;
  v_valet_fee NUMERIC;
  v_zip TEXT;
  v_facility_id TEXT;
  v_sub_id UUID;
  v_pin TEXT;
  v_expires_at TIMESTAMPTZ;
  v_inv_number TEXT;
  v_txn_ref TEXT;
  v_tax_rate NUMERIC := 0.00;
  v_valet_tax NUMERIC := 0.00;
  v_valet_total NUMERIC := 0.00;
  v_recycled_ids UUID[];
  v_recycled_count INT := 0;
  v_needed_new INT := 0;
  v_rec_id UUID;
  v_idx INT := 0;
BEGIN
  v_uid := auth.uid();
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Unauthenticated';
  END IF;

  -- Read user profile
  SELECT name, email, assigned_facility_id, active_zone 
  INTO v_user_name, v_user_email, v_facility_id, v_zip
  FROM public.users
  WHERE id = v_uid;

  -- Resolve facility if not explicitly assigned
  IF v_facility_id IS NULL THEN
    IF (v_zip ILIKE '%9890%' OR v_zip ILIKE '%yakima%') THEN
      v_facility_id := 'facility_yakima';
    ELSIF (v_zip ILIKE '%972%' OR v_zip ILIKE '%portland%') THEN
      v_facility_id := 'facility_portland_central';
    ELSE
      SELECT facility_id INTO v_facility_id
      FROM public.service_areas
      WHERE zip_code = v_zip AND active = true
      LIMIT 1;
    END IF;

    IF v_facility_id IS NULL THEN
      v_facility_id := 'facility_seattle_north';
    END IF;

    UPDATE public.users
    SET assigned_facility_id = v_facility_id
    WHERE id = v_uid;
  END IF;

  -- Lookup zip tax rate (0.00 if not found)
  SELECT COALESCE(tax_rate, 0.00) INTO v_tax_rate
  FROM public.service_areas
  WHERE zip_code = v_zip AND active = true
  LIMIT 1;
  IF v_tax_rate IS NULL THEN v_tax_rate := 0.00; END IF;

  -- Read current subscription
  SELECT id, total_totes, recurring_storage INTO v_sub_id, v_current_totes, v_current_recurring
  FROM public.subscriptions 
  WHERE uid = v_uid AND status = 'active'
  LIMIT 1;

  IF v_sub_id IS NULL THEN
    RAISE EXCEPTION 'No active subscription found';
  END IF;

  v_new_total := COALESCE(v_current_totes, 0) + p_additional_totes;
  IF v_new_total > 500 THEN
    RAISE EXCEPTION 'Cannot exceed 500 totes';
  END IF;

  -- Calculate rate based on whole active tote pool
  IF v_new_total >= 50 THEN v_new_rate := 1.00;
  ELSIF v_new_total >= 25 THEN v_new_rate := 2.00;
  ELSIF v_new_total >= 10 THEN v_new_rate := 3.50;
  ELSE v_new_rate := 5.00;
  END IF;

  v_new_recurring := v_new_total * v_new_rate;
  v_delta := v_new_recurring - COALESCE(v_current_recurring, 0);

  IF p_logistics_type = 'valet_pickup' THEN
    v_valet_fee := 15.00 + (p_additional_totes * 1.00);
    v_valet_tax := ROUND((v_valet_fee * v_tax_rate)::numeric, 2);
    v_valet_total := v_valet_fee + v_valet_tax;
  ELSE
    v_valet_fee := 0.00;
    v_valet_tax := 0.00;
    v_valet_total := 0.00;
  END IF;

  -- Update subscription record
  UPDATE public.subscriptions
  SET total_totes = v_new_total,
      tote_rate = v_new_rate,
      recurring_storage = v_new_recurring,
      logistics_type = p_logistics_type,
      last_updated = now()
  WHERE id = v_sub_id;

  -- Pro-Rata Segment Ledger: Close active segment & open new segment
  UPDATE public.subscription_billing_segments
  SET effective_end = now()
  WHERE subscription_id = v_sub_id AND effective_end IS NULL;

  INSERT INTO public.subscription_billing_segments (
    subscription_id,
    uid,
    facility_id,
    tote_count,
    unit_rate,
    effective_start,
    effective_end,
    reason
  ) VALUES (
    v_sub_id,
    v_uid,
    v_facility_id,
    v_new_total,
    v_new_rate,
    now(),
    NULL,
    'tote_addition'
  );

  -- ── RECYCLED-FIRST INTAKE PROVISIONING ──
  -- 1. Find unassigned recycled totes sitting in the Activation Room (INTAKE-BAY-1)
  SELECT array_agg(id) INTO v_recycled_ids
  FROM (
    SELECT id FROM public.inventory
    WHERE facility_id = v_facility_id
      AND uid IS NULL
      AND (activated = false OR status = 'stored')
    ORDER BY created_at ASC
    LIMIT p_additional_totes
  ) sub;

  IF v_recycled_ids IS NOT NULL THEN
    v_recycled_count := cardinality(v_recycled_ids);
    
    -- Claim and assign recycled totes to this customer sequentially
    v_idx := 1;
    FOREACH v_rec_id IN ARRAY v_recycled_ids LOOP
      UPDATE public.inventory
      SET uid = v_uid,
          label = 'Additional Tote #' || (COALESCE(v_current_totes, 0) + v_idx),
          status = (CASE WHEN p_logistics_type = 'valet_pickup' THEN 'with-customer' ELSE 'stored' END)::public.inventory_status,
          activated = false,
          location_code = 'INTAKE-BAY-1',
          location_type = 'intake',
          photo_url = NULL,
          notes = NULL,
          last_scanned_at = now()
      WHERE id = v_rec_id;
      v_idx := v_idx + 1;
    END LOOP;
  END IF;

  -- 2. If additional totes are still needed beyond recycled pool, insert new barcode rows
  v_needed_new := p_additional_totes - v_recycled_count;
  IF v_needed_new > 0 THEN
    FOR i IN 0..(v_needed_new - 1) LOOP
      INSERT INTO public.inventory (
        uid, tote_code, label, status, facility_id, activated, location_code, location_type
      ) VALUES (
        v_uid,
        public.generate_tote_code(v_facility_id),
        'Additional Tote #' || (COALESCE(v_current_totes, 0) + v_recycled_count + i + 1),
        (CASE WHEN p_logistics_type = 'valet_pickup' THEN 'with-customer' ELSE 'stored' END)::public.inventory_status,
        v_facility_id,
        false,
        'INTAKE-BAY-1',
        'intake'
      );
    END LOOP;
  END IF;

  -- Update users table
  UPDATE public.users 
  SET active_totes_held = active_totes_held + p_additional_totes
  WHERE id = v_uid;

  -- Update facility active totes count
  UPDATE public.facilities
  SET active_totes = active_totes + p_additional_totes
  WHERE id = v_facility_id;

  -- Update global financials
  UPDATE public.metadata
  SET total_totes = total_totes + p_additional_totes,
      total_mrr = total_mrr + v_delta
  WHERE id = 'financials';

  -- Create access request for BOTH valet and self-service so workers have the task in Admin Hub
  v_pin := floor(1000 + random() * 9000)::text;
  v_expires_at := now() + interval '48 hours';
  INSERT INTO public.access_requests (
    uid, 
    request_type, 
    additional_totes, 
    fulfillment_type, 
    pin, 
    pin_expires_at, 
    valet_fee, 
    facility_id, 
    status,
    target_date,
    time_slot
  ) VALUES (
    v_uid,
    'new_tote_delivery',
    p_additional_totes,
    CASE WHEN p_logistics_type = 'valet_pickup' THEN 'valet_delivery' ELSE 'staging' END,
    v_pin,
    v_expires_at,
    v_valet_fee,
    v_facility_id,
    'pending',
    COALESCE(p_target_date, CURRENT_DATE + INTERVAL '1 day'),
    COALESCE(p_time_slot, '09:00 AM - 12:00 PM')
  );

  -- If valet, generate immediate invoice for Valet Logistics Dispatch ONLY if not already invoiced
  IF p_logistics_type = 'valet_pickup' AND NOT EXISTS (
    SELECT 1 FROM public.invoices 
    WHERE uid = v_uid 
      AND invoice_type = 'valet_delivery' 
      AND created_at > NOW() - INTERVAL '5 minutes'
  ) THEN
    v_inv_number := 'INV-' || TO_CHAR(NOW(), 'YYYY') || '-' || LPAD(FLOOR(RANDOM() * 900000 + 100000)::TEXT, 6, '0');
    v_txn_ref := 'TXN-VALET-' || LPAD(FLOOR(RANDOM() * 900000 + 100000)::TEXT, 6, '0');

    INSERT INTO public.invoices (
      invoice_number,
      uid,
      customer_name,
      customer_email,
      facility_id,
      subscription_id,
      invoice_type,
      payment_status,
      subtotal,
      delivery_fee,
      tax,
      total_amount,
      payment_method,
      transaction_reference,
      notes,
      line_items,
      due_date,
      created_at,
      paid_at
    ) VALUES (
      v_inv_number,
      v_uid,
      COALESCE(v_user_name, 'Valued Customer'),
      v_user_email,
      v_facility_id,
      v_sub_id,
      'valet_delivery',
      'paid',
      0.00,
      v_valet_fee,
      v_valet_tax,
      v_valet_total,
      'card_on_file',
      v_txn_ref,
      'Valet container delivery for ' || p_additional_totes::TEXT || ' new containers',
      jsonb_build_array(
        jsonb_build_object(
          'description', 'Valet Delivery & Logistics Dispatch Fee (' || p_additional_totes::TEXT || ' containers)',
          'qty', 1,
          'unit_price', v_valet_fee,
          'amount', v_valet_fee
        ),
        jsonb_build_object(
          'description', 'State/Local Sales Tax (' || (v_tax_rate * 100)::TEXT || '%)',
          'qty', 1,
          'unit_price', v_valet_tax,
          'amount', v_valet_tax
        )
      ),
      NOW(),
      NOW(),
      NOW()
    );

    INSERT INTO public.charges (
      uid,
      charge_type,
      amount,
      totes_charged,
      status,
      charged_at
    ) VALUES (
      v_uid,
      'valet_delivery',
      v_valet_total,
      p_additional_totes,
      'succeeded',
      NOW()
    );
  END IF;

  RETURN jsonb_build_object(
    'success', true,
    'newTotal', v_new_total,
    'newRate', v_new_rate,
    'newMonthly', v_new_recurring,
    'delta', v_delta,
    'valetFee', v_valet_fee,
    'valetTotal', v_valet_total,
    'immediateBilled', v_valet_total,
    'message', 'Added ' || p_additional_totes::text || ' totes. Storage will be billed pro-rata on your monthly renewal date.'
  );
END;
$$ LANGUAGE plpgsql;

-- Inventory & Subscription Auto-Reconciliation Function
CREATE OR REPLACE FUNCTION public.reconcile_user_inventory(p_uid UUID DEFAULT NULL)
RETURNS JSONB SECURITY DEFINER AS $$
DECLARE
  v_rec RECORD;
  v_inv_count INT;
  v_deficit INT;
  v_created_total INT := 0;
  v_facility_id TEXT;
  v_pin TEXT;
BEGIN
  FOR v_rec IN 
    SELECT s.uid, s.total_totes, s.logistics_type, u.assigned_facility_id, u.active_zone
    FROM public.subscriptions s
    JOIN public.users u ON s.uid = u.id
    WHERE s.status = 'active'
      AND (p_uid IS NULL OR s.uid = p_uid)
  LOOP
    SELECT COUNT(*) INTO v_inv_count
    FROM public.inventory
    WHERE uid = v_rec.uid;

    v_facility_id := COALESCE(v_rec.assigned_facility_id, 'facility_yakima');

    IF v_rec.total_totes > v_inv_count THEN
      v_deficit := v_rec.total_totes - v_inv_count;
      
      -- Provision unactivated intake inventory totes
      FOR i IN 0..(v_deficit - 1) LOOP
        INSERT INTO public.inventory (
          uid,
          tote_code,
          label,
          status,
          facility_id,
          activated,
          location_code,
          location_type
        ) VALUES (
          v_rec.uid,
          public.generate_tote_code(v_facility_id),
          'Additional Tote #' || (v_inv_count + i + 1),
          (CASE WHEN v_rec.logistics_type = 'valet_pickup' THEN 'with-customer' ELSE 'stored' END)::public.inventory_status,
          v_facility_id,
          false,
          'INTAKE-BAY-1',
          'intake'
        );
      END LOOP;

      -- Update user active totes held
      UPDATE public.users
      SET active_totes_held = v_rec.total_totes
      WHERE id = v_rec.uid;

      -- Check if pending intake delivery request exists, create if not
      IF NOT EXISTS (
        SELECT 1 FROM public.access_requests 
        WHERE uid = v_rec.uid 
          AND request_type = 'new_tote_delivery' 
          AND status = 'pending'
      ) THEN
        v_pin := floor(1000 + random() * 9000)::text;
        INSERT INTO public.access_requests (
          uid,
          request_type,
          additional_totes,
          fulfillment_type,
          pin,
          pin_expires_at,
          valet_fee,
          facility_id,
          status,
          target_date,
          time_slot
        ) VALUES (
          v_rec.uid,
          'new_tote_delivery',
          v_deficit,
          CASE WHEN v_rec.logistics_type = 'valet_pickup' THEN 'valet_delivery' ELSE 'staging' END,
          v_pin,
          now() + interval '48 hours',
          0.00,
          v_facility_id,
          'pending',
          CURRENT_DATE + INTERVAL '1 day',
          '09:00 AM - 12:00 PM'
        );
      END IF;

      v_created_total := v_created_total + v_deficit;
    END IF;
  END LOOP;

  RETURN jsonb_build_object(
    'success', true,
    'provisionedTotes', v_created_total,
    'message', 'Inventory reconciled successfully'
  );
END;
$$ LANGUAGE plpgsql;

-- Partial Tote Unsubscribe / Reduction Function (Pro-Rata Segment Driven)
CREATE OR REPLACE FUNCTION public.reduce_subscription_totes(
    p_uid UUID,
    p_reduce_count INT
) RETURNS JSONB SECURITY DEFINER AS $$
DECLARE
  v_sub RECORD;
  v_facility_id TEXT;
  v_current_totes INT;
  v_new_total INT;
  v_new_rate NUMERIC;
  v_new_recurring NUMERIC;
  v_delta NUMERIC;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Unauthenticated';
  END IF;

  SELECT s.*, u.assigned_facility_id INTO v_sub
  FROM public.subscriptions s
  JOIN public.users u ON s.uid = u.id
  WHERE s.uid = p_uid AND s.status = 'active'
  LIMIT 1;

  IF v_sub IS NULL THEN
    RAISE EXCEPTION 'No active subscription found';
  END IF;

  v_current_totes := COALESCE(v_sub.total_totes, v_sub.tote_count, 1);
  v_new_total := v_current_totes - p_reduce_count;

  IF v_new_total < 1 THEN
    RAISE EXCEPTION 'Cannot reduce below 1 container. Please use Cancel Subscription to close account.';
  END IF;

  IF v_new_total >= 50 THEN v_new_rate := 1.00;
  ELSIF v_new_total >= 25 THEN v_new_rate := 2.00;
  ELSIF v_new_total >= 10 THEN v_new_rate := 3.50;
  ELSE v_new_rate := 5.00;
  END IF;

  v_new_recurring := v_new_total * v_new_rate;
  v_delta := v_new_recurring - COALESCE(v_sub.recurring_storage, 0);

  UPDATE public.subscriptions
  SET total_totes = v_new_total,
      tote_rate = v_new_rate,
      recurring_storage = v_new_recurring,
      last_updated = now()
  WHERE id = v_sub.id;

  -- Pro-Rata Segment Ledger: Close active segment & open new segment for reduced tote pool
  UPDATE public.subscription_billing_segments
  SET effective_end = now()
  WHERE subscription_id = v_sub.id AND effective_end IS NULL;

  INSERT INTO public.subscription_billing_segments (
    subscription_id,
    uid,
    facility_id,
    tote_count,
    unit_rate,
    effective_start,
    effective_end,
    reason
  ) VALUES (
    v_sub.id,
    p_uid,
    COALESCE(v_sub.assigned_facility_id, 'facility_seattle_north'),
    v_new_total,
    v_new_rate,
    now(),
    NULL,
    'tote_reduction'
  );

  UPDATE public.users
  SET active_totes_held = GREATEST(0, active_totes_held - p_reduce_count)
  WHERE id = p_uid;

  UPDATE public.metadata
  SET total_totes = GREATEST(0, total_totes - p_reduce_count),
      total_mrr = total_mrr + v_delta
  WHERE id = 'financials';

  RETURN jsonb_build_object(
    'success', true,
    'newTotal', v_new_total,
    'newRate', v_new_rate,
    'newMonthly', v_new_recurring,
    'message', 'Subscription updated to ' || v_new_total::text || ' containers. Pro-rata storage rate updated.'
  );
END;
$$ LANGUAGE plpgsql;
  v_new_rate NUMERIC;
  v_new_recurring NUMERIC;
  v_delta NUMERIC;
  v_removed_totes INT := 0;
BEGIN
  IF p_reduce_count <= 0 THEN
    RAISE EXCEPTION 'Reduction count must be greater than 0';
  END IF;

  SELECT * INTO v_user FROM public.users WHERE id = p_uid;
  IF v_user IS NULL THEN
    RAISE EXCEPTION 'User not found';
  END IF;

  SELECT * INTO v_sub FROM public.subscriptions WHERE uid = p_uid AND status = 'active' LIMIT 1;
  IF v_sub IS NULL THEN
    RAISE EXCEPTION 'No active subscription found';
  END IF;

  v_current_totes := COALESCE(v_sub.total_totes, v_sub.tote_count, 0);
  v_new_total := GREATEST(1, v_current_totes - p_reduce_count);

  -- Resolve facility / price lock rates
  v_facility_id := COALESCE(v_sub.facility_id, v_user.assigned_facility_id, 'facility_seattle_north');
  SELECT 
    COALESCE(tier1_rate, 5.00), COALESCE(tier2_rate, 3.50), COALESCE(tier3_rate, 2.00), COALESCE(tier4_rate, 1.00)
  INTO v_t1, v_t2, v_t3, v_t4
  FROM public.facilities WHERE id = v_facility_id;

  IF v_user.has_price_lock IS TRUE AND v_user.price_lock_rates IS NOT NULL THEN
    v_t1 := COALESCE((v_user.price_lock_rates->>'tier1_rate')::NUMERIC, (v_user.price_lock_rates->>'tier1')::NUMERIC, v_t1);
    v_t2 := COALESCE((v_user.price_lock_rates->>'tier2_rate')::NUMERIC, (v_user.price_lock_rates->>'tier2')::NUMERIC, v_t2);
    v_t3 := COALESCE((v_user.price_lock_rates->>'tier3_rate')::NUMERIC, (v_user.price_lock_rates->>'tier3')::NUMERIC, v_t3);
    v_t4 := COALESCE((v_user.price_lock_rates->>'tier4_rate')::NUMERIC, (v_user.price_lock_rates->>'tier4')::NUMERIC, v_t4);
  END IF;

  IF v_new_total >= 50 THEN v_new_rate := v_t4;
  ELSIF v_new_total >= 25 THEN v_new_rate := v_t3;
  ELSIF v_new_total >= 10 THEN v_new_rate := v_t2;
  ELSE v_new_rate := v_t1;
  END IF;

  v_new_recurring := v_new_total * v_new_rate;
  v_delta := v_new_recurring - COALESCE(v_sub.recurring_storage, 0);

  -- Update subscription
  UPDATE public.subscriptions
  SET total_totes = v_new_total,
      tote_rate = v_new_rate,
      recurring_storage = v_new_recurring,
      last_updated = now()
  WHERE id = v_sub.id;

  -- Archive / Remove unassigned empty inventory totes for user
  WITH empty_to_delete AS (
    SELECT id FROM public.inventory
    WHERE uid = p_uid AND status = 'stored' AND (label LIKE 'Empty Tote%' OR label LIKE 'Additional Tote%')
    LIMIT (v_current_totes - v_new_total)
  )
  DELETE FROM public.inventory WHERE id IN (SELECT id FROM empty_to_delete);
  GET DIAGNOSTICS v_removed_totes = ROW_COUNT;

  -- Update users table
  UPDATE public.users 
  SET active_totes_held = GREATEST(0, active_totes_held - (v_current_totes - v_new_total))
  WHERE id = p_uid;

  RETURN jsonb_build_object(
    'success', true,
    'oldTotes', v_current_totes,
    'newTotes', v_new_total,
    'oldRate', COALESCE(v_sub.tote_rate, 0),
    'newRate', v_new_rate,
    'oldMonthly', COALESCE(v_sub.recurring_storage, 0),
    'newMonthly', v_new_recurring,
    'delta', v_delta,
    'removedTotes', v_removed_totes
  );
END;
$$ LANGUAGE plpgsql;


-- Check Staging Capacity Engine
CREATE OR REPLACE FUNCTION public.check_staging_capacity(
    p_facility_id TEXT,
    p_start_time TIMESTAMPTZ,
    p_end_time TIMESTAMPTZ,
    p_tote_count INT
) RETURNS BOOLEAN AS $$
DECLARE
    v_total_capacity INT;
    v_overlapping_reserved_totes INT;
    v_available_capacity INT;
BEGIN
    -- 1. Get total physical staging capacity from facilities spec (assume 20 totes per staging room)
    SELECT COALESCE(staging_rooms * 20, 0) INTO v_total_capacity
    FROM public.facilities
    WHERE id = p_facility_id;

    IF v_total_capacity = 0 THEN
        RAISE EXCEPTION 'Facility % has no configured STAGING capacity.', p_facility_id;
    END IF;

    -- 2. Calculate how many totes are already scheduled in overlapping time windows
    SELECT COALESCE(SUM(array_length(tote_ids, 1)), 0) INTO v_overlapping_reserved_totes
    FROM public.staging_reservations
    WHERE facility_id = p_facility_id
      AND status IN ('scheduled', 'active')
      AND start_time < p_end_time
      AND end_time > p_start_time;

    -- 3. Check if available capacity can accommodate the requested totes
    v_available_capacity := v_total_capacity - v_overlapping_reserved_totes;

    IF v_available_capacity >= p_tote_count THEN
        RETURN TRUE;
    ELSE
        RAISE EXCEPTION 'Staging capacity exceeded. Available: %, Requested: %', v_available_capacity, p_tote_count;
    END IF;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Get Staging Availability for UI Calendar
CREATE OR REPLACE FUNCTION public.get_staging_availability(
    p_facility_id TEXT,
    p_target_date DATE
) RETURNS JSONB AS $$
DECLARE
    v_total_capacity INT;
    v_config JSONB;
    v_day_of_week INT;
    v_result JSONB := '[]'::jsonb;
    v_slot TEXT;
    v_start_time TIMESTAMPTZ;
    v_end_time TIMESTAMPTZ;
    v_overlapping_totes INT;
    v_available INT;
BEGIN
    -- Get facility capacity and config
    SELECT COALESCE(staging_rooms * 20, 0), COALESCE(staging_config, '{"allowed_days": [1,2,3,4,5], "allowed_slots": ["09:00 AM - 12:00 PM", "12:00 PM - 03:00 PM", "03:00 PM - 06:00 PM"]}'::jsonb)
    INTO v_total_capacity, v_config
    FROM public.facilities
    WHERE id = p_facility_id;

    IF v_total_capacity = 0 THEN
        RETURN '[]'::jsonb;
    END IF;

    -- Check if day is allowed
    v_day_of_week := EXTRACT(DOW FROM p_target_date);
    
    -- Extract allowed days as json array, then check if v_day_of_week is in it
    IF NOT (v_config->'allowed_days') @> to_jsonb(v_day_of_week) THEN
        RETURN '[]'::jsonb;
    END IF;

    -- Loop over slots in config
    FOR v_slot IN SELECT jsonb_array_elements_text(v_config->'allowed_slots')
    LOOP
        -- Parse start and end time from slot (e.g., "09:00 AM - 12:00 PM")
        IF v_slot = '09:00 AM - 12:00 PM' THEN
            v_start_time := p_target_date + time '09:00:00';
            v_end_time := p_target_date + time '12:00:00';
        ELSIF v_slot = '12:00 PM - 03:00 PM' THEN
            v_start_time := p_target_date + time '12:00:00';
            v_end_time := p_target_date + time '15:00:00';
        ELSIF v_slot = '03:00 PM - 06:00 PM' THEN
            v_start_time := p_target_date + time '15:00:00';
            v_end_time := p_target_date + time '18:00:00';
        ELSE
            CONTINUE;
        END IF;

        -- Count overlapping
        SELECT COALESCE(SUM(array_length(tote_ids, 1)), 0) INTO v_overlapping_totes
        FROM public.staging_reservations
        WHERE facility_id = p_facility_id
          AND status IN ('scheduled', 'active')
          AND start_time < v_end_time
          AND end_time > v_start_time;

        v_available := v_total_capacity - v_overlapping_totes;
        IF v_available < 0 THEN v_available := 0; END IF;

        v_result := v_result || jsonb_build_object(
            'slot', v_slot,
            'start_time', v_start_time,
            'end_time', v_end_time,
            'available_capacity', v_available
        );
    END LOOP;

    RETURN v_result;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Secure Staging Request with Calendar Date Reservation & Surge Pricing
CREATE OR REPLACE FUNCTION public.request_staging(
  p_tote_ids UUID[],
  p_fulfillment_type TEXT DEFAULT 'staging',
  p_delivery_notes TEXT DEFAULT NULL,
  p_target_date DATE DEFAULT NULL,
  p_time_slot TEXT DEFAULT '09:00 AM - 12:00 PM',
  p_surge_fee NUMERIC DEFAULT 0.00,
  p_surge_tier TEXT DEFAULT 'standard',
  p_start_time TIMESTAMPTZ DEFAULT NULL,
  p_end_time TIMESTAMPTZ DEFAULT NULL
) RETURNS JSONB SECURITY DEFINER AS $$
DECLARE
  v_uid UUID;
  v_cutoff_passed BOOLEAN;
  v_target_date DATE;
  v_pin TEXT;
  v_expires_at TIMESTAMPTZ;
  v_item_uid UUID;
  v_valet_fee NUMERIC(10,2) := 0.00;
  v_base_fee NUMERIC(10,2);
  v_adder_fee NUMERIC(10,2);
  v_tote_count INT;
  v_user_facility TEXT;
  v_access_request_id UUID;
BEGIN
  v_uid := auth.uid();
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Unauthenticated';
  END IF;

  v_tote_count := cardinality(p_tote_ids);
  IF v_tote_count = 0 THEN
    RAISE EXCEPTION 'No totes requested';
  END IF;

  -- Use provided reservation target date or compute cutoff fallback
  IF p_target_date IS NOT NULL THEN
    v_target_date := p_target_date;
  ELSE
    v_cutoff_passed := EXTRACT(HOUR FROM now()) >= 18;
    IF v_cutoff_passed THEN
      v_target_date := (current_date + interval '2 days')::date;
    ELSE
      v_target_date := (current_date + interval '1 day')::date;
    END IF;
  END IF;

  -- Calculate valet fee if applicable
  IF p_fulfillment_type = 'valet_delivery' THEN
    SELECT valet_base, valet_tote_adder INTO v_base_fee, v_adder_fee 
    FROM public.settings WHERE id = 'pricing';
    
    v_valet_fee := COALESCE(v_base_fee, 15.00) + (v_tote_count * COALESCE(v_adder_fee, 2.00));
  END IF;

  v_pin := floor(1000 + random() * 9000)::text;
  v_expires_at := now() + interval '24 hours';

  -- Verify ownership of all totes
  FOR i IN 1..v_tote_count LOOP
    SELECT uid INTO v_item_uid FROM public.inventory WHERE id = p_tote_ids[i];
    IF v_item_uid IS NULL OR v_item_uid != v_uid THEN
      RAISE EXCEPTION 'Item ownership mismatch or item not found';
    END IF;
  END LOOP;

  SELECT assigned_facility_id INTO v_user_facility FROM public.users WHERE id = v_uid;
  IF v_user_facility IS NULL THEN
    v_user_facility := 'facility_seattle_north';
  END IF;

  -- Update items status based on fulfillment type
  IF p_fulfillment_type = 'valet_delivery' THEN
    UPDATE public.inventory
    SET status = 'pending-dispatch'::inventory_status
    WHERE id = ANY(p_tote_ids);
  ELSE
    UPDATE public.inventory
    SET status = 'pending-stage'::inventory_status
    WHERE id = ANY(p_tote_ids);
  END IF;

  -- Check capacity if explicit timeblock provided
  IF p_start_time IS NOT NULL AND p_end_time IS NOT NULL THEN
      -- Verify duration constraints (1 to 3 hours)
      IF EXTRACT(EPOCH FROM (p_end_time - p_start_time))/3600 < 1.0 OR EXTRACT(EPOCH FROM (p_end_time - p_start_time))/3600 > 3.0 THEN
          RAISE EXCEPTION 'Reservation duration must be between 1 and 3 hours.';
      END IF;
      -- Fail-fast capacity check
      PERFORM public.check_staging_capacity(v_user_facility, p_start_time, p_end_time, v_tote_count);
  END IF;

  -- Create access request with reservation slot and surge pricing
  INSERT INTO public.access_requests (
    uid, request_type, fulfillment_type, requested_items, facility_id, pin, pin_expires_at, valet_fee, surge_fee, surge_tier, status, target_date, time_slot, delivery_notes
  ) VALUES (
    v_uid,
    'retrieval',
    p_fulfillment_type,
    p_tote_ids,
    v_user_facility,
    v_pin,
    v_expires_at,
    v_valet_fee,
    COALESCE(p_surge_fee, 0.00),
    COALESCE(p_surge_tier, 'standard'),
    'pending',
    v_target_date,
    p_time_slot,
    p_delivery_notes
  ) RETURNING id INTO v_access_request_id;

  -- Persist to calendar table
  IF p_start_time IS NOT NULL AND p_end_time IS NOT NULL THEN
      INSERT INTO public.staging_reservations (
          facility_id, uid, access_request_id, tote_ids, start_time, end_time, status
      ) VALUES (
          v_user_facility, v_uid, v_access_request_id, p_tote_ids, p_start_time, p_end_time, 'scheduled'
      );
  END IF;

  RETURN jsonb_build_object(
    'pin', v_pin,
    'expiresAt', v_expires_at,
    'targetDate', v_target_date,
    'valetFee', v_valet_fee
  );
END;
$$ LANGUAGE plpgsql;

-- Cancel Retrieval Request (Reverts items status to stored and cancels request)
CREATE OR REPLACE FUNCTION public.cancel_retrieval_request(
  p_request_id UUID
) RETURNS JSONB SECURITY DEFINER AS $$
DECLARE
  v_uid UUID;
  v_req RECORD;
  v_has_staged BOOLEAN;
BEGIN
  v_uid := auth.uid();
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Unauthenticated';
  END IF;

  SELECT * INTO v_req FROM public.access_requests WHERE id = p_request_id;
  IF v_req IS NULL THEN
    RAISE EXCEPTION 'Request not found';
  END IF;

  IF v_req.uid != v_uid THEN
    RAISE EXCEPTION 'Permission denied';
  END IF;

  IF v_req.status != 'pending' THEN
    RAISE EXCEPTION 'Only pending requests can be cancelled';
  END IF;

  -- Verify no items in the request are already staged or with customer
  IF v_req.requested_items IS NOT NULL AND cardinality(v_req.requested_items) > 0 THEN
    SELECT EXISTS (
      SELECT 1 FROM public.inventory
      WHERE id = ANY(v_req.requested_items)
        AND status IN ('staged', 'with-customer')
    ) INTO v_has_staged;

    IF v_has_staged THEN
      RAISE EXCEPTION 'Cannot cancel retrieval request: Items have already been staged in the access room.';
    END IF;
  END IF;

  UPDATE public.access_requests
  SET status = 'cancelled'
  WHERE id = p_request_id;

  IF v_req.requested_items IS NOT NULL AND cardinality(v_req.requested_items) > 0 THEN
    UPDATE public.inventory
    SET status = 'stored'::inventory_status
    WHERE id = ANY(v_req.requested_items) AND uid = v_uid;
  END IF;

  RETURN jsonb_build_object('success', true);
END;
$$ LANGUAGE plpgsql;

-- Cancel Subscription (creates cancellation ticket)
CREATE OR REPLACE FUNCTION public.cancel_subscription(
  p_simulate_expiry BOOLEAN
) RETURNS JSONB SECURITY DEFINER AS $$
DECLARE
  v_uid UUID;
  v_totes_held INT;
  v_sub_id UUID;
  v_total_totes INT;
  v_recurring_storage NUMERIC;
  v_deadline TIMESTAMPTZ;
  v_fac_id TEXT;
  v_count INT;
BEGIN
  v_uid := auth.uid();
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Unauthenticated';
  END IF;

  -- Get active totes held
  SELECT active_totes_held INTO v_totes_held FROM public.users WHERE id = v_uid;

  -- Get active subscription
  SELECT id, total_totes, recurring_storage INTO v_sub_id, v_total_totes, v_recurring_storage
  FROM public.subscriptions
  WHERE uid = v_uid AND status = 'active'
  LIMIT 1;

  -- Update subscription to cancelled
  IF v_sub_id IS NOT NULL THEN
    UPDATE public.subscriptions
    SET status = 'cancelled',
        last_updated = now()
    WHERE id = v_sub_id;
  END IF;

  -- Update user status
  UPDATE public.users
  SET onboarding_status = 'cancelled'
  WHERE id = v_uid;

  -- Decrement financials
  UPDATE public.metadata
  SET total_users = total_users - 1,
      total_totes = total_totes - COALESCE(v_total_totes, 0),
      total_mrr = total_mrr - COALESCE(v_recurring_storage, 0)
  WHERE id = 'financials';

  -- Decrement facility active totes for stored totes
  FOR v_fac_id, v_count IN 
    SELECT facility_id, count(*)
    FROM public.inventory
    WHERE uid = v_uid AND status IN ('stored', 'staged', 'pending-stage')
    GROUP BY facility_id
  LOOP
    UPDATE public.facilities
    SET active_totes = active_totes - v_count
    WHERE id = v_fac_id;
  END LOOP;

  -- Create cancellation ticket
  IF p_simulate_expiry THEN
    v_deadline := now() - interval '10 seconds';
  ELSE
    v_deadline := now() + interval '14 days';
  END IF;

  INSERT INTO public.cancellations (uid, account_status, active_totes_held, cancellation_date, deadline_date)
  VALUES (
    v_uid,
    'pending_tote_return',
    v_totes_held,
    now(),
    v_deadline
  );

  RETURN jsonb_build_object(
    'success', true,
    'totesHeld', v_totes_held,
    'deadline', v_deadline
  );
END;
$$ LANGUAGE plpgsql;

-- DEV ONLY: Simulate Onboarding Complete
CREATE OR REPLACE FUNCTION public.simulate_onboarding_complete()
RETURNS JSONB SECURITY DEFINER AS $$
DECLARE
  v_uid UUID;
  v_zip TEXT;
  v_facility_id TEXT;
  v_sub_exists BOOLEAN;
  v_total_totes INT := 5;
BEGIN
  v_uid := auth.uid();
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Unauthenticated';
  END IF;

  -- Get active zone
  SELECT COALESCE(active_zone, '98101') INTO v_zip FROM public.users WHERE id = v_uid;
  IF v_zip LIKE '972%' THEN
    v_facility_id := 'facility_portland_central';
  ELSE
    v_facility_id := 'facility_seattle_north';
  END IF;

  SELECT EXISTS(SELECT 1 FROM public.subscriptions WHERE uid = v_uid AND status = 'active') INTO v_sub_exists;

  -- Create default subscription if not exists
  IF NOT v_sub_exists THEN
    INSERT INTO public.subscriptions (uid, stripe_subscription_id, total_totes, tote_rate, recurring_storage, logistics_type, valet_fee, first_month_total, status, current_period_end, next_billing_date, last_billed_at)
    VALUES (
      v_uid,
      'stub_' || substring(md5(random()::text) from 1 for 9),
      v_total_totes,
      5.00,
      25.00,
      'self_service',
      0.00,
      25.00,
      'active',
      now() + interval '30 days',
      now() + interval '30 days',
      now()
    );

    UPDATE public.metadata
    SET total_totes = total_totes + v_total_totes,
        total_mrr = total_mrr + 25.00
    WHERE id = 'financials';
  ELSE
    SELECT total_totes INTO v_total_totes FROM public.subscriptions WHERE uid = v_uid AND status = 'active' LIMIT 1;
  END IF;

  -- Update user onboarding status
  UPDATE public.users
  SET onboarding_status = 'active',
      active_totes_held = v_total_totes
  WHERE id = v_uid;

  -- Delete existing inventory for simulation refresh
  DELETE FROM public.inventory WHERE uid = v_uid;

  -- Generate inventory items with facility-tethered scrambled tote codes
  FOR i IN 0..(v_total_totes - 1) LOOP
    INSERT INTO public.inventory (uid, tote_code, label, status, facility_id)
    VALUES (
      v_uid,
      public.generate_tote_code(v_facility_id),
      'Empty Tote #' || (i + 1),
      'stored',
      v_facility_id
    );
  END LOOP;

  -- Update facility active totes
  UPDATE public.facilities
  SET active_totes = active_totes + v_total_totes
  WHERE id = v_facility_id;

  RETURN jsonb_build_object(
    'success', true,
    'totesActivated', v_total_totes
  );
END;
$$ LANGUAGE plpgsql;

-- DEV ONLY: Update Totes Held Simulation
CREATE OR REPLACE FUNCTION public.update_totes_held_sim(p_amount INT)
RETURNS VOID SECURITY DEFINER AS $$
BEGIN
  UPDATE public.users
  SET active_totes_held = LEAST(500, GREATEST(0, active_totes_held + p_amount))
  WHERE id = auth.uid();
END;
$$ LANGUAGE plpgsql;

-- DEV ONLY: Return All Totes Simulation
CREATE OR REPLACE FUNCTION public.return_all_totes_sim()
RETURNS VOID SECURITY DEFINER AS $$
BEGIN
  UPDATE public.users
  SET active_totes_held = 0
  WHERE id = auth.uid();
END;
$$ LANGUAGE plpgsql;

-- DEV ONLY: Trigger Tote Billing Audit
CREATE OR REPLACE FUNCTION public.trigger_tote_audit_test()
RETURNS JSONB SECURITY DEFINER AS $$
DECLARE
  v_row RECORD;
  v_unreturned INT;
  v_charge_amount NUMERIC;
  v_result JSONB[] := ARRAY[]::JSONB[];
BEGIN
  FOR v_row IN 
    SELECT c.id, c.uid, c.active_totes_held, u.active_totes_held as current_held
    FROM public.cancellations c
    JOIN public.users u ON c.uid = u.id
    WHERE c.account_status = 'pending_tote_return'
      AND c.deadline_date <= now()
  LOOP
    v_unreturned := v_row.current_held;
    v_charge_amount := v_unreturned * 15.00;

    IF v_unreturned > 0 THEN
      INSERT INTO public.charges (uid, charge_type, amount, totes_charged, status)
      VALUES (v_row.uid, 'tote_replacement_fee', v_charge_amount, v_unreturned, 'success');
    END IF;

    UPDATE public.cancellations
    SET account_status = 'closed',
        charge_amount = v_charge_amount,
        charged_at = now()
    WHERE id = v_row.id;

    UPDATE public.users
    SET active_totes_held = 0
    WHERE id = v_row.uid;

    v_result := array_append(v_result, jsonb_build_object(
      'uid', v_row.uid,
      'unreturnedTotes', v_unreturned,
      'charged', v_charge_amount,
      'status', 'closed'
    ));
  END LOOP;

  RETURN jsonb_build_object('success', true, 'processed', v_result);
END;
$$ LANGUAGE plpgsql;


-- Atomic Location Move / Slotting RPC
CREATE OR REPLACE FUNCTION public.slot_tote_location(
  p_tote_code TEXT,
  p_location_code TEXT,
  p_location_type TEXT DEFAULT 'vault'
) RETURNS JSONB SECURITY DEFINER AS $$
DECLARE
  v_uid UUID;
  v_user_role public.user_role;
  v_item RECORD;
  v_new_status public.inventory_status;
  v_target_loc RECORD;
  v_current_count INTEGER;
BEGIN
  v_uid := auth.uid();
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Unauthenticated';
  END IF;

  SELECT role INTO v_user_role FROM public.users WHERE id = v_uid;
  IF v_user_role NOT IN ('warehouse_worker', 'warehouse_manager', 'executive') THEN
    RAISE EXCEPTION 'Access Denied: Staff clearance required';
  END IF;

  SELECT id, tote_code, uid, status, facility_id, location_id, activated INTO v_item 
  FROM public.inventory 
  WHERE tote_code = p_tote_code LIMIT 1;

  IF v_item IS NULL THEN
    RAISE EXCEPTION 'Fail-Fast Error: Tote code % not found in system', p_tote_code;
  END IF;

  -- Capacity Enforcement Check
  IF p_location_code IS NOT NULL THEN
    SELECT id, is_occupied, COALESCE(capacity, 3) as capacity INTO v_target_loc
    FROM public.warehouse_locations
    WHERE (facility_id = v_item.facility_id OR v_item.facility_id IS NULL) AND (identifier = p_location_code OR location_code = p_location_code)
    LIMIT 1;

    IF v_target_loc IS NOT NULL THEN
      v_capacity := v_target_loc.capacity;
    ELSIF p_location_code ILIKE '%ROOM%' OR p_location_code ILIKE '%STAGE%' THEN
      v_capacity := 100;
    ELSIF p_location_code ILIKE '%LOCKER%' THEN
      v_capacity := 1;
    ELSE
      v_capacity := 3;
    END IF;

    SELECT COUNT(*) INTO v_current_count
    FROM public.inventory
    WHERE (location_code = p_location_code OR (v_target_loc.id IS NOT NULL AND location_id = v_target_loc.id))
      AND (facility_id = v_item.facility_id OR v_item.facility_id IS NULL)
      AND status IN ('stored', 'staged', 'pending-stage')
      AND id != v_item.id;

    IF v_current_count >= v_capacity THEN
      RAISE EXCEPTION 'Location % is already FULL (%/% totes occupied). Shelves hold maximum % totes.', p_location_code, v_current_count, v_capacity, v_capacity;
    END IF;
  END IF;

  -- Determine status based on target location type
  IF p_location_type = 'vault' THEN
    v_new_status := 'stored'::public.inventory_status;
  ELSIF p_location_type = 'intake' THEN
    v_new_status := 'pending-stage'::public.inventory_status;
  ELSIF p_location_type = 'staging' THEN
    v_new_status := 'staged'::public.inventory_status;
  ELSIF p_location_type = 'dispatch' THEN
    v_new_status := 'out-for-delivery'::public.inventory_status;
  ELSIF p_location_type = 'with_customer' THEN
    v_new_status := 'with-customer'::public.inventory_status;
  ELSE
    v_new_status := v_item.status;
  END IF;

  -- Update inventory record with explicit physical coordinates
  UPDATE public.inventory
  SET location_code = p_location_code,
      location_type = p_location_type,
      location_id = COALESCE(v_target_loc.id, location_id),
      status = v_new_status,
      activated = true,
      last_scanned_at = now(),
      last_scanned_by = v_uid
  WHERE id = v_item.id;

  -- Update or insert warehouse_locations tracking
  IF v_item.facility_id IS NOT NULL AND p_location_code IS NOT NULL THEN
    INSERT INTO public.warehouse_locations (facility_id, location_code, location_type, is_occupied, assigned_tote_id)
    VALUES (v_item.facility_id, p_location_code, p_location_type, true, v_item.id)
    ON CONFLICT (facility_id, location_code) 
    DO UPDATE SET is_occupied = true, assigned_tote_id = v_item.id;
  END IF;

  RETURN jsonb_build_object(
    'success', true,
    'toteCode', p_tote_code,
    'newLocationCode', p_location_code,
    'newLocationType', p_location_type,
    'newStatus', v_new_status
  );
END;
$$ LANGUAGE plpgsql;

-- Batch Stage Customer Totes (Single-Customer Order Fulfillment)
CREATE OR REPLACE FUNCTION public.batch_stage_customer_totes(
  p_customer_uid UUID,
  p_target_location TEXT DEFAULT 'STAGE-BAY-A1',
  p_staging_location_code TEXT DEFAULT NULL
) RETURNS JSONB SECURITY DEFINER AS $$
DECLARE
  v_uid UUID;
  v_user_role public.user_role;
  v_updated_count INT := 0;
  v_effective_location TEXT;
BEGIN
  v_effective_location := COALESCE(NULLIF(p_staging_location_code, ''), NULLIF(p_target_location, ''), 'STAGE-BAY-A1');

  v_uid := auth.uid();
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Unauthenticated';
  END IF;

  SELECT role INTO v_user_role FROM public.users WHERE id = v_uid;
  IF v_user_role NOT IN ('warehouse_worker', 'warehouse_manager', 'executive') THEN
    RAISE EXCEPTION 'Access Denied: Staff clearance required';
  END IF;

  -- Update ONLY explicitly pending totes for this customer (never touch unrequested stored totes)
  UPDATE public.inventory
  SET status = CASE WHEN status = 'pending-dispatch' THEN 'out-for-delivery'::public.inventory_status ELSE 'staged'::public.inventory_status END,
      location_code = v_effective_location,
      location_type = CASE WHEN status = 'pending-dispatch' THEN 'dispatch' ELSE 'staging' END,
      activated = true,
      last_scanned_at = now(),
      last_scanned_by = v_uid
  WHERE uid = p_customer_uid
    AND status IN ('pending-stage', 'pending-dispatch');

  GET DIAGNOSTICS v_updated_count = ROW_COUNT;

  -- Update access requests for this customer
  UPDATE public.access_requests
  SET status = 'staged'
  WHERE uid = p_customer_uid AND status = 'pending';

  RETURN jsonb_build_object(
    'success', true,
    'customerUid', p_customer_uid,
    'totesUpdated', v_updated_count,
    'targetLocation', v_effective_location
  );
END;
$$ LANGUAGE plpgsql;

-- Staging Schedule & Reservation Calendar RPC
CREATE OR REPLACE FUNCTION public.get_facility_staging_schedule(
  p_facility_id TEXT,
  p_target_date DATE DEFAULT CURRENT_DATE
) RETURNS JSONB SECURITY DEFINER AS $$
DECLARE
  v_uid UUID;
  v_user_role public.user_role;
  v_facility RECORD;
  v_num_rooms INT := 3;
  v_stg_loc_rooms INT := 0;
  v_reservations JSONB;
BEGIN
  v_uid := auth.uid();
  IF v_uid IS NOT NULL THEN
    SELECT role INTO v_user_role FROM public.users WHERE id = v_uid;
    IF v_user_role IS NOT NULL AND v_user_role NOT IN ('warehouse_worker', 'warehouse_manager', 'executive') THEN
      RAISE EXCEPTION 'Access Denied: Staff clearance required';
    END IF;
  END IF;

  -- 1. Fetch configured rooms from facilities table
  SELECT num_staging_rooms, staging_rooms INTO v_facility
  FROM public.facilities
  WHERE id = p_facility_id LIMIT 1;

  IF v_facility IS NOT NULL THEN
    v_num_rooms := COALESCE(v_facility.num_staging_rooms, v_facility.staging_rooms, 3);
  END IF;

  -- 2. Count distinct staging rooms in warehouse_locations
  SELECT COUNT(DISTINCT 
    CASE 
      WHEN identifier ~ '^ROOM-[0-9]+' THEN substring(identifier from 'ROOM-([0-9]+)')::int
      ELSE 1 
    END
  ) INTO v_stg_loc_rooms
  FROM public.warehouse_locations
  WHERE facility_id = p_facility_id AND zone_type = 'STAGING';

  IF v_stg_loc_rooms IS NOT NULL AND v_stg_loc_rooms > v_num_rooms THEN
    v_num_rooms := v_stg_loc_rooms;
  END IF;

  -- 3. Query active access requests and staging room reservations for target date and facility
  SELECT COALESCE(jsonb_agg(
    jsonb_build_object(
      'id', ar.id,
      'uid', ar.uid,
      'customer_name', COALESCE(u.name, 'Customer ' || SUBSTRING(ar.uid::text, 1, 8)),
      'customer_email', u.email,
      'customer_phone', u.phone,
      'facility_id', ar.facility_id,
      'request_type', ar.request_type,
      'fulfillment_type', ar.fulfillment_type,
      'status', ar.status,
      'pin', ar.pin,
      'target_date', ar.target_date,
      'time_slot', COALESCE(ar.time_slot, '09:00 AM - 12:00 PM'),
      'surge_tier', ar.surge_tier,
      'requested_items', ar.requested_items,
      'tote_count', CASE WHEN ar.requested_items IS NOT NULL THEN cardinality(ar.requested_items) ELSE 1 END
    ) ORDER BY ar.requested_at DESC
  ), '[]'::jsonb) INTO v_reservations
  FROM public.access_requests ar
  LEFT JOIN public.users u ON ar.uid = u.id
  WHERE (ar.facility_id = p_facility_id OR u.assigned_facility_id = p_facility_id)
    AND (ar.target_date = p_target_date OR ar.target_date IS NULL)
    AND ar.status IN ('pending', 'staged', 'out-for-delivery');

  RETURN jsonb_build_object(
    'success', true,
    'facilityId', p_facility_id,
    'targetDate', p_target_date,
    'numStagingRooms', GREATEST(v_num_rooms, 3),
    'reservations', v_reservations
  );
END;
$$ LANGUAGE plpgsql;

-- Secure Barcode Tote Scanning (Staff only) — Fulfillment-Type-Aware & Location-Deterministic
CREATE OR REPLACE FUNCTION public.scan_tote(
  p_tote_code TEXT,
  p_expected_status TEXT DEFAULT NULL,
  p_target_location_code TEXT DEFAULT NULL,
  p_staff_uid UUID DEFAULT NULL
) RETURNS JSONB SECURITY DEFINER AS $$
DECLARE
  v_uid UUID;
  v_item RECORD;
  v_next_status public.inventory_status;
  v_user_role public.user_role;
  v_fulfillment_type TEXT;
  v_has_pending_request BOOLEAN := FALSE;
  v_next_location_code TEXT;
  v_next_location_type TEXT;
BEGIN
  v_uid := COALESCE(auth.uid(), p_staff_uid);
  IF v_uid IS NULL THEN
    SELECT id INTO v_uid FROM public.users WHERE role IN ('warehouse_worker', 'warehouse_manager', 'executive') LIMIT 1;
  END IF;

  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Unauthenticated';
  END IF;

  SELECT role INTO v_user_role FROM public.users WHERE id = v_uid;
  IF v_user_role NOT IN ('warehouse_worker', 'warehouse_manager', 'executive') THEN
    RAISE EXCEPTION 'Access Denied: Staff clearance required';
  END IF;

  SELECT id, tote_code, status, uid, activated, location_code, location_type, facility_id INTO v_item 
  FROM public.inventory 
  WHERE tote_code = p_tote_code LIMIT 1;

  IF v_item IS NULL THEN
    RAISE EXCEPTION 'Fail-Fast Error: Tote code % not found in system', p_tote_code;
  END IF;

  -- Look up fulfillment type from active access request ONLY if this specific tote was requested
  SELECT ar.fulfillment_type INTO v_fulfillment_type
  FROM public.access_requests ar
  WHERE ar.uid = v_item.uid
    AND ar.status = 'pending'
    AND (
      ar.requested_items IS NULL 
      OR cardinality(ar.requested_items) = 0
      OR v_item.id = ANY(ar.requested_items)
      OR (ar.requested_tote_codes IS NOT NULL AND v_item.tote_code = ANY(ar.requested_tote_codes))
    )
  ORDER BY ar.requested_at DESC
  LIMIT 1;

  IF v_fulfillment_type IS NOT NULL THEN
    v_has_pending_request := TRUE;
  END IF;

  -- Determine physical state transition
  IF v_item.activated = false THEN
    v_next_status := 'pending-stage'::public.inventory_status;
    v_next_location_code := COALESCE(p_target_location_code, 'INTAKE-PROCESSING');
    v_next_location_type := CASE WHEN p_target_location_code IS NOT NULL THEN 'vault' ELSE 'intake' END;

  ELSIF v_item.status = 'pending-stage' THEN
    v_next_status := 'staged'::public.inventory_status;
    v_next_location_code := p_target_location_code;
    v_next_location_type := 'staging';

  ELSIF v_item.status = 'staged' THEN
    v_next_status := 'with-customer'::public.inventory_status;
    v_next_location_code := 'CUSTOMER-PREMISES';
    v_next_location_type := 'with_customer';

  ELSIF v_item.status = 'pending-dispatch' THEN
    v_next_status := 'out-for-delivery'::public.inventory_status;
    v_next_location_code := 'VALET-TRUCK-A';
    v_next_location_type := 'dispatch';

  ELSIF v_item.status = 'out-for-delivery' THEN
    v_next_status := 'with-customer'::public.inventory_status;
    v_next_location_code := 'CUSTOMER-PREMISES';
    v_next_location_type := 'with_customer';

  ELSIF v_item.status = 'with-customer' THEN
    v_next_status := 'stored'::public.inventory_status;
    v_next_location_type := 'vault';

    -- Require explicit scanned/locked target location when returning to vault
    IF p_target_location_code IS NOT NULL AND p_target_location_code <> '' AND p_target_location_code NOT IN ('CUSTOMER-PREMISES', 'CUSTOMER-DELIVERED', 'VALET-TRUCK-A', 'INTAKE-PROCESSING', 'DROP-OFF-BUFFER') THEN
      v_next_location_code := p_target_location_code;
    ELSE
      RAISE EXCEPTION 'No Vault Shelf Locked: Please scan or lock a destination shelf/bay barcode (e.g. A1-B01-S1 or V-A01-S01) before putting totes into storage.';
    END IF;

  ELSIF v_item.status = 'stored' THEN
    IF v_has_pending_request AND v_fulfillment_type = 'valet_delivery' THEN
      v_next_status := 'pending-dispatch'::public.inventory_status;
      v_next_location_code := 'DISPATCH-BAY-1';
      v_next_location_type := 'dispatch';
    ELSIF v_has_pending_request THEN
      v_next_status := 'pending-stage'::public.inventory_status;
      v_next_location_code := p_target_location_code;
      v_next_location_type := 'vault';
    ELSE
      v_next_status := 'stored'::public.inventory_status;
      v_next_location_type := 'vault';

      IF p_target_location_code IS NOT NULL AND p_target_location_code <> '' AND p_target_location_code NOT IN ('CUSTOMER-PREMISES', 'CUSTOMER-DELIVERED', 'VALET-TRUCK-A', 'INTAKE-PROCESSING', 'DROP-OFF-BUFFER') THEN
        v_next_location_code := p_target_location_code;
      ELSIF v_item.location_code IS NOT NULL AND v_item.location_code NOT IN ('CUSTOMER-PREMISES', 'CUSTOMER-DELIVERED', 'VALET-TRUCK-A', 'INTAKE-PROCESSING', 'DROP-OFF-BUFFER') THEN
        v_next_location_code := v_item.location_code;
      ELSE
        RAISE EXCEPTION 'No Vault Shelf Locked: Please scan or lock a target shelf/bay barcode before putting totes into storage.';
      END IF;
    END IF;

  ELSE
    v_next_status := 'stored'::public.inventory_status;
    v_next_location_type := 'vault';
    IF p_target_location_code IS NOT NULL AND p_target_location_code <> '' AND p_target_location_code NOT IN ('CUSTOMER-PREMISES', 'CUSTOMER-DELIVERED', 'VALET-TRUCK-A', 'INTAKE-PROCESSING', 'DROP-OFF-BUFFER') THEN
      v_next_location_code := p_target_location_code;
    ELSE
      RAISE EXCEPTION 'No Vault Shelf Locked: Please scan or lock a target shelf/bay barcode before putting totes into storage.';
    END IF;
  END IF;

  -- Overwrite with explicit scanned target location if provided
  IF p_target_location_code IS NOT NULL AND p_target_location_code <> '' THEN
    v_next_location_code := p_target_location_code;
    IF p_target_location_code ILIKE 'ROOM-%' OR p_target_location_code ILIKE '%STAGE%' OR p_target_location_code ILIKE '%BAY%' THEN
      v_next_location_type := 'staging';
    ELSIF p_target_location_code ILIKE '%TRUCK%' OR p_target_location_code ILIKE '%DISPATCH%' THEN
      v_next_location_type := 'dispatch';
    ELSIF p_target_location_code ILIKE '%INTAKE%' THEN
      v_next_location_type := 'intake';
    ELSE
      v_next_location_type := 'vault';
    END IF;
  END IF;

  -- Capacity Enforcement Check if shelving into vault storage
  IF v_next_status = 'stored' AND v_next_location_code IS NOT NULL AND v_next_location_code NOT IN ('CUSTOMER-PREMISES', 'CUSTOMER-DELIVERED', 'VALET-TRUCK-A', 'INTAKE-PROCESSING', 'DROP-OFF-BUFFER') THEN
    SELECT id, COALESCE(capacity, 4) as capacity INTO v_target_loc
    FROM public.warehouse_locations
    WHERE (facility_id = v_item.facility_id OR v_item.facility_id IS NULL)
      AND (identifier = v_next_location_code OR location_code = v_next_location_code)
    LIMIT 1;

    IF v_target_loc IS NOT NULL THEN
      v_capacity := COALESCE(v_target_loc.capacity, 4);
    ELSE
      v_capacity := 4;
    END IF;

    SELECT COUNT(*) INTO v_current_count
    FROM public.inventory
    WHERE location_code = v_next_location_code
      AND (facility_id = v_item.facility_id OR v_item.facility_id IS NULL)
      AND status IN ('stored', 'staged', 'pending-stage')
      AND id != v_item.id;

    IF v_current_count >= v_capacity THEN
      RAISE EXCEPTION 'Shelf % is at FULL CAPACITY (%/% totes occupied). Maximum capacity for this shelf is % totes. Please lock another shelf.', v_next_location_code, v_current_count, v_capacity, v_capacity;
    END IF;
  END IF;

  -- Apply physical state transition
  UPDATE public.inventory
  SET status = v_next_status,
      location_code = v_next_location_code,
      location_type = v_next_location_type,
      activated = true,
      last_scanned_at = now(),
      last_scanned_by = v_uid
  WHERE id = v_item.id;

  -- If returned to vault (status = 'stored'), mark pending access request completed
  IF v_next_status = 'stored' AND v_has_pending_request THEN
    UPDATE public.access_requests
    SET status = 'completed'
    WHERE uid = v_item.uid AND status = 'pending';
  END IF;

  RETURN jsonb_build_object(
    'success', true,
    'status', v_next_status,
    'locationCode', v_next_location_code,
    'locationType', v_next_location_type,
    'fulfillmentType', v_fulfillment_type,
    'customerUid', v_item.uid
  );
END;
$$ LANGUAGE plpgsql;

-- =========================================================================
-- EVENT 0: REVERT TOTE STAGE / MISSCAN UNDO HANDLER
-- =========================================================================
CREATE OR REPLACE FUNCTION public.revert_tote_stage(
  p_tote_code TEXT,
  p_target_status TEXT DEFAULT NULL,
  p_staff_uid UUID DEFAULT NULL,
  p_target_location_code TEXT DEFAULT NULL
) RETURNS JSONB SECURITY DEFINER AS $$
DECLARE
  v_uid UUID;
  v_item RECORD;
  v_user_role public.user_role;
  v_prev_status public.inventory_status;
  v_target_status public.inventory_status;
  v_target_location_code TEXT;
  v_target_location_type TEXT;
  v_fulfillment_type TEXT;
  v_customer_pin TEXT;
  v_assigned_room INT;
BEGIN
  v_uid := COALESCE(auth.uid(), p_staff_uid);
  IF v_uid IS NULL THEN
    SELECT id INTO v_uid FROM public.users WHERE role IN ('warehouse_worker', 'warehouse_manager', 'executive') LIMIT 1;
  END IF;

  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Unauthenticated';
  END IF;

  SELECT role INTO v_user_role FROM public.users WHERE id = v_uid;
  IF v_user_role NOT IN ('warehouse_worker', 'warehouse_manager', 'executive') THEN
    RAISE EXCEPTION 'Access Denied: Staff clearance required';
  END IF;

  SELECT id, tote_code, status, uid, activated, location_code, location_type, facility_id INTO v_item 
  FROM public.inventory 
  WHERE tote_code = p_tote_code LIMIT 1;

  IF v_item IS NULL THEN
    RAISE EXCEPTION 'Tote % not found in inventory', p_tote_code;
  END IF;

  v_prev_status := v_item.status;

  -- Determine if customer had a valet vs staging request
  SELECT ar.fulfillment_type, ar.pin, ar.assigned_room INTO v_fulfillment_type, v_customer_pin, v_assigned_room
  FROM public.access_requests ar
  WHERE ar.uid = v_item.uid
    AND (
      ar.requested_items IS NULL 
      OR cardinality(ar.requested_items) = 0
      OR v_item.id = ANY(ar.requested_items)
      OR (ar.requested_tote_codes IS NOT NULL AND v_item.tote_code = ANY(ar.requested_tote_codes))
    )
  ORDER BY ar.requested_at DESC
  LIMIT 1;

  -- Determine target status and location
  IF p_target_status IS NOT NULL AND p_target_status <> '' THEN
    v_target_status := p_target_status::public.inventory_status;
  ELSIF v_item.status = 'with-customer' THEN
    v_target_status := CASE WHEN v_fulfillment_type = 'valet_delivery' THEN 'out-for-delivery'::public.inventory_status ELSE 'staged'::public.inventory_status END;
  ELSIF v_item.status = 'out-for-delivery' OR v_item.status = 'pending-dispatch' THEN
    v_target_status := 'stored'::public.inventory_status;
  ELSIF v_item.status = 'staged' THEN
    v_target_status := 'stored'::public.inventory_status;
  ELSIF v_item.status = 'pending-stage' THEN
    v_target_status := 'stored'::public.inventory_status;
  ELSE
    v_target_status := 'stored'::public.inventory_status;
  END IF;

  -- Determine target location code
  IF p_target_location_code IS NOT NULL AND p_target_location_code <> '' THEN
    v_target_location_code := p_target_location_code;
    v_target_location_type := CASE 
      WHEN v_target_location_code ~* '^ROOM-' THEN 'staging'
      WHEN v_target_location_code ~* '^VALET-' THEN 'dispatch'
      WHEN v_target_location_code ~* '^INTAKE-' THEN 'intake'
      ELSE 'vault'
    END;
  ELSIF v_target_status = 'staged' THEN
    v_target_location_code := 'ROOM-' || COALESCE(v_assigned_room, 1);
    v_target_location_type := 'staging';
  ELSIF v_target_status = 'out-for-delivery' THEN
    v_target_location_code := 'VALET-TRUCK-A';
    v_target_location_type := 'dispatch';
  ELSIF v_target_status = 'pending-dispatch' THEN
    v_target_location_code := 'VALET-LOADING-BAY-A';
    v_target_location_type := 'dispatch';
  ELSIF v_target_status = 'pending-stage' THEN
    v_target_location_code := 'INTAKE-PROCESSING';
    v_target_location_type := 'intake';
  ELSE
    -- Stored in vault: preserve existing vault shelf if valid, or use authentic shelf location
    IF v_item.location_code IS NOT NULL AND NOT (v_item.location_code ~* '^(ROOM-|VALET-|CUSTOMER-|INTAKE-)') THEN
      v_target_location_code := v_item.location_code;
    ELSE
      v_target_location_code := COALESCE((SELECT identifier FROM public.warehouse_locations WHERE zone_type = 'VAULT' AND facility_id = v_item.facility_id LIMIT 1), 'A1-B01-S1');
    END IF;
    v_target_location_type := 'vault';
  END IF;

  -- Reopen access request if it was completed prematurely
  IF v_target_status IN ('staged', 'out-for-delivery', 'pending-dispatch', 'pending-stage', 'stored') THEN
    UPDATE public.access_requests
    SET status = 'pending'
    WHERE uid = v_item.uid
      AND (
        requested_items IS NULL 
        OR cardinality(requested_items) = 0 
        OR v_item.id = ANY(requested_items) 
        OR (requested_tote_codes IS NOT NULL AND v_item.tote_code = ANY(requested_tote_codes))
      );
  END IF;

  -- Update inventory table
  UPDATE public.inventory
  SET status = v_target_status,
      location_code = v_target_location_code,
      location_type = v_target_location_type,
      activated = true,
      last_scanned_at = now(),
      last_scanned_by = v_uid,
      updated_at = now()
  WHERE id = v_item.id;

  RETURN jsonb_build_object(
    'success', true,
    'event', 'TOTE_STAGE_REVERTED',
    'toteCode', p_tote_code,
    'previousStatus', v_prev_status,
    'revertedStatus', v_target_status,
    'locationCode', v_target_location_code,
    'locationType', v_target_location_type,
    'customerUid', v_item.uid,
    'message', 'Tote successfully moved back to previous stage (' || v_target_status::text || ')'
  );
END;
$$ LANGUAGE plpgsql;

-- =========================================================================
-- EVENT 1: TOTE RETURN & VAULT SHELVING HANDLER
-- =========================================================================
CREATE OR REPLACE FUNCTION public.process_tote_return(
  p_tote_code TEXT,
  p_target_location_code TEXT DEFAULT NULL,
  p_staff_uid UUID DEFAULT NULL,
  p_request_id UUID DEFAULT NULL
) RETURNS JSONB SECURITY DEFINER AS $$
DECLARE
  v_uid               UUID;
  v_item              RECORD;
  v_target_loc        RECORD;
  v_shelf_code        TEXT;
  v_capacity          INT  := 3;
  v_current_count     INT  := 0;
  v_requests_closed   INT  := 0;
BEGIN
  -- ── 1. Auth ───────────────────────────────────────────────────────────────
  v_uid := COALESCE(p_staff_uid, auth.uid());
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'process_tote_return: unauthenticated — no staff_uid or session uid available';
  END IF;

  -- ── 2. Fetch tote ─────────────────────────────────────────────────────────
  SELECT * INTO v_item
  FROM public.inventory
  WHERE tote_code = p_tote_code
  LIMIT 1;

  IF v_item IS NULL THEN
    RAISE EXCEPTION 'process_tote_return: tote % not found in inventory', p_tote_code;
  END IF;

  -- ── 3. Resolve target shelf ───────────────────────────────────────────────
  v_shelf_code := NULLIF(TRIM(COALESCE(p_target_location_code, '')), '');

  -- Reject non-vault pseudo-locations that must never be used as a return shelf
  IF v_shelf_code IS NULL
    OR v_shelf_code ILIKE 'CUSTOMER%'
    OR v_shelf_code ILIKE 'VALET%'
    OR v_shelf_code ILIKE 'INTAKE%'
    OR v_shelf_code ILIKE 'ROOM%'
    OR v_shelf_code ILIKE 'STAGE%'
    OR v_shelf_code ILIKE 'TRUCK%'
    OR v_shelf_code ILIKE 'DISPATCH%'
  THEN
    RAISE EXCEPTION
      'process_tote_return: a physical vault shelf code is required (got: %). '
      'ROOM/VALET/INTAKE locations are not valid return destinations.',
      COALESCE(v_shelf_code, 'NULL');
  END IF;

  -- ── 4. Capacity check ─────────────────────────────────────────────────────
  SELECT id, COALESCE(capacity, 3) AS capacity INTO v_target_loc
  FROM public.warehouse_locations
  WHERE (facility_id = v_item.facility_id OR v_item.facility_id IS NULL)
    AND (identifier = v_shelf_code OR location_code = v_shelf_code)
  LIMIT 1;

  v_capacity := COALESCE(v_target_loc.capacity, 3);

  SELECT COUNT(*) INTO v_current_count
  FROM public.inventory
  WHERE location_code = v_shelf_code
    AND (facility_id = v_item.facility_id OR v_item.facility_id IS NULL)
    AND status IN ('stored', 'staged', 'pending-stage')
    AND id <> v_item.id;

  IF v_current_count >= v_capacity THEN
    RAISE EXCEPTION
      'process_tote_return: shelf % is at FULL CAPACITY (%/% totes). Please lock a different shelf.',
      v_shelf_code, v_current_count, v_capacity;
  END IF;

  -- ── 5. Move tote to vault storage ─────────────────────────────────────────
  UPDATE public.inventory
  SET status        = 'stored'::public.inventory_status,
      location_code = v_shelf_code,
      location_type = 'vault',
      activated     = true,
      last_scanned_at = now(),
      last_scanned_by = v_uid,
      updated_at      = now()
  WHERE id = v_item.id;

  -- ── 6. Update warehouse_locations occupancy ────────────────────────────────
  -- Free old shelf if tote was previously on a different shelf
  IF v_item.location_code IS NOT NULL AND v_item.location_code <> v_shelf_code THEN
    UPDATE public.warehouse_locations
    SET is_occupied = (
      (SELECT COUNT(*) FROM public.inventory
       WHERE location_code = v_item.location_code
         AND status IN ('stored', 'staged', 'pending-stage'))
      >= COALESCE(capacity, 3)
    )
    WHERE (identifier = v_item.location_code OR location_code = v_item.location_code)
      AND (facility_id = v_item.facility_id OR v_item.facility_id IS NULL);
  END IF;

  -- Mark new shelf as occupied if now at capacity
  UPDATE public.warehouse_locations
  SET is_occupied    = ((v_current_count + 1) >= COALESCE(capacity, 3)),
      assigned_tote_id = v_item.id
  WHERE (identifier = v_shelf_code OR location_code = v_shelf_code)
    AND (facility_id = v_item.facility_id OR v_item.facility_id IS NULL);

  -- ── 7. Close the linked access_request ────────────────────────────────────
  -- Works for both valet_delivery and staging fulfillment_types.
  -- If a specific request_id is supplied, close only that one.
  -- Otherwise match by tote code / item id so partial multi-tote orders are
  -- handled correctly (only the request that actually listed this tote closes).
  IF p_request_id IS NOT NULL THEN
    UPDATE public.access_requests
    SET status = 'returned-to-vault'
    WHERE id = p_request_id
      AND uid = v_item.uid
      AND status IN ('pending', 'staged');

    GET DIAGNOSTICS v_requests_closed = ROW_COUNT;
  ELSE
    UPDATE public.access_requests
    SET status = 'returned-to-vault'
    WHERE uid = v_item.uid
      AND status IN ('pending', 'staged')
      AND (
        (requested_tote_codes IS NOT NULL AND p_tote_code = ANY(requested_tote_codes))
        OR (requested_items IS NOT NULL AND v_item.id = ANY(requested_items))
      );

    GET DIAGNOSTICS v_requests_closed = ROW_COUNT;
  END IF;

  -- ── 8. Return payload ─────────────────────────────────────────────────────
  RETURN jsonb_build_object(
    'success',          true,
    'status',           'stored',
    'nextStatus',       'stored',
    'locationCode',     v_shelf_code,
    'toteCode',         p_tote_code,
    'currentOccupancy', v_current_count + 1,
    'maxCapacity',      v_capacity,
    'isFull',           (v_current_count + 1 >= v_capacity),
    'requestsClosed',   v_requests_closed
  );
END;
$$ LANGUAGE plpgsql;


-- =========================================================================
-- EVENT 2: SELECTIVE CUSTOMER RETRIEVAL REQUEST HANDLER
-- =========================================================================
CREATE OR REPLACE FUNCTION public.submit_customer_retrieval(
  p_uid UUID,
  p_tote_ids UUID[],
  p_fulfillment_type TEXT DEFAULT 'self_serve_pickup',
  p_target_date DATE DEFAULT CURRENT_DATE,
  p_time_slot TEXT DEFAULT '09:00 AM - 12:00 PM',
  p_delivery_notes TEXT DEFAULT NULL,
  p_start_time TIMESTAMPTZ DEFAULT NULL,
  p_end_time TIMESTAMPTZ DEFAULT NULL,
  p_surge_fee NUMERIC DEFAULT 0.00,
  p_surge_tier TEXT DEFAULT 'standard'
) RETURNS JSONB SECURITY DEFINER AS $$
DECLARE
  v_user_facility TEXT;
  v_pin TEXT;
  v_next_status public.inventory_status;
  v_req_id UUID;
  v_tote_codes TEXT[];
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Unauthenticated';
  END IF;

  IF p_tote_ids IS NULL OR cardinality(p_tote_ids) = 0 THEN
    RAISE EXCEPTION 'Retrieval Error: At least one tote must be selected for retrieval';
  END IF;

  SELECT array_agg(tote_code) INTO v_tote_codes
  FROM public.inventory
  WHERE id = ANY(p_tote_ids) AND uid = p_uid;

  IF v_tote_codes IS NULL OR cardinality(v_tote_codes) = 0 THEN
    RAISE EXCEPTION 'Retrieval Error: Selected totes do not belong to customer or were not found';
  END IF;

  -- Validation: Ensure none of the requested totes are already in an active retrieval request
  IF EXISTS (
    SELECT 1 FROM public.access_requests ar
    WHERE ar.uid = p_uid
      AND ar.status IN ('pending', 'staged', 'out-for-delivery', 'with-customer')
      AND (
        ar.requested_items && p_tote_ids
        OR (ar.requested_tote_codes IS NOT NULL AND ar.requested_tote_codes && v_tote_codes)
      )
  ) THEN
    RAISE EXCEPTION 'Retrieval Error: One or more selected totes are already part of an active retrieval request in progress.';
  END IF;

  -- Validation: Ensure all requested totes are currently stored in vault
  IF EXISTS (
    SELECT 1 FROM public.inventory
    WHERE id = ANY(p_tote_ids) AND status <> 'stored'
  ) THEN
    RAISE EXCEPTION 'Retrieval Error: Only totes stored in the vault can be retrieved.';
  END IF;

  SELECT assigned_facility_id INTO v_user_facility FROM public.users WHERE id = p_uid;
  IF v_user_facility IS NULL THEN
    v_user_facility := 'facility_seattle_north';
  END IF;

  v_pin := lpad(floor(random() * 10000)::text, 4, '0');
  v_next_status := CASE WHEN p_fulfillment_type = 'valet_delivery' THEN 'pending-dispatch'::public.inventory_status ELSE 'pending-stage'::public.inventory_status END;

  UPDATE public.inventory
  SET status = v_next_status,
      last_scanned_at = now()
  WHERE id = ANY(p_tote_ids) AND uid = p_uid;

  INSERT INTO public.access_requests (
    uid, request_type, fulfillment_type, requested_items, requested_tote_codes, facility_id, pin, pin_expires_at, status, target_date, time_slot, delivery_notes
  ) VALUES (
    p_uid,
    'retrieval',
    p_fulfillment_type,
    p_tote_ids,
    v_tote_codes,
    v_user_facility,
    v_pin,
    now() + interval '48 hours',
    'pending',
    p_target_date,
    p_time_slot,
    p_delivery_notes
  ) RETURNING id INTO v_req_id;

  RETURN jsonb_build_object(
    'success', true,
    'event', 'RETRIEVAL_SUBMITTED',
    'requestId', v_req_id,
    'requestedToteIds', p_tote_ids,
    'requestedToteCodes', v_tote_codes,
    'fulfillmentType', p_fulfillment_type,
    'pin', v_pin,
    'targetDate', p_target_date,
    'timeSlot', p_time_slot
  );
END;
$$ LANGUAGE plpgsql;


-- =========================================================================
-- EVENT 3: VAULT PULL TO STAGING / DISPATCH HANDLER
-- =========================================================================
CREATE OR REPLACE FUNCTION public.process_vault_pull(
  p_tote_code TEXT,
  p_target_staging_code TEXT DEFAULT NULL,
  p_staff_uid UUID DEFAULT NULL
) RETURNS JSONB SECURITY DEFINER AS $$
DECLARE
  v_uid UUID;
  v_item RECORD;
  v_user_role public.user_role;
  v_next_status public.inventory_status;
  v_next_location_code TEXT;
  v_next_location_type TEXT;
  v_customer_pin TEXT;
  v_req_id UUID;
BEGIN
  v_uid := COALESCE(auth.uid(), p_staff_uid);
  IF v_uid IS NULL THEN
    SELECT id INTO v_uid FROM public.users WHERE role IN ('warehouse_worker', 'warehouse_manager', 'executive') ORDER BY created_at ASC LIMIT 1;
  END IF;

  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Unauthenticated';
  END IF;

  SELECT role INTO v_user_role FROM public.users WHERE id = v_uid;
  IF v_user_role NOT IN ('warehouse_worker', 'warehouse_manager', 'executive') THEN
    RAISE EXCEPTION 'Access Denied: Staff clearance required';
  END IF;

  SELECT id, tote_code, status, uid, facility_id INTO v_item 
  FROM public.inventory 
  WHERE tote_code = p_tote_code LIMIT 1;

  IF v_item IS NULL THEN
    RAISE EXCEPTION 'Pull Error: Tote % not found in inventory', p_tote_code;
  END IF;

  -- Find active request linked to this tote
  SELECT id, pin INTO v_req_id, v_customer_pin
  FROM public.access_requests
  WHERE uid = v_item.uid 
    AND (p_tote_code = ANY(requested_tote_codes) OR v_item.id::text = ANY(requested_items))
    AND status NOT IN ('completed', 'cancelled', 'returned-to-vault')
  ORDER BY requested_at DESC LIMIT 1;

  IF v_item.status = 'pending-dispatch' OR p_target_staging_code ILIKE '%TRUCK%' OR p_target_staging_code ILIKE '%DISPATCH%' THEN
    v_next_status := 'out-for-delivery'::public.inventory_status;
    v_next_location_code := COALESCE(p_target_staging_code, 'VALET-TRUCK-A');
    v_next_location_type := 'dispatch';
  ELSE
    v_next_status := 'staged'::public.inventory_status;
    v_next_location_code := COALESCE(p_target_staging_code, 'ROOM-1');
    v_next_location_type := 'staging';

    -- Strict Staging Room Conflict Check: Scoped strictly to THIS facility!
    IF v_next_location_code ~* '^ROOM-[0-9]+' THEN
      IF EXISTS (
        SELECT 1 
        FROM public.inventory i
        LEFT JOIN public.access_requests ar ON (i.tote_code = ANY(ar.requested_tote_codes) OR i.id = ANY(ar.requested_items))
        WHERE i.location_code = v_next_location_code
          AND (i.facility_id = v_item.facility_id OR v_item.facility_id IS NULL)
          AND i.status IN ('staged', 'pending-stage')
          AND i.id <> v_item.id
          AND (
            (v_req_id IS NOT NULL AND ar.id IS NOT NULL AND ar.id <> v_req_id)
            OR (v_req_id IS NULL AND i.uid <> v_item.uid)
          )
      ) THEN
        RAISE EXCEPTION 'Staging Room Conflict: % is already occupied by another retrieval order in this facility! Please select a vacant room.', v_next_location_code;
      END IF;
    END IF;
  END IF;

  UPDATE public.inventory
  SET status = v_next_status,
      location_code = v_next_location_code,
      location_type = v_next_location_type,
      activated = true,
      last_scanned_at = now(),
      last_scanned_by = v_uid
  WHERE id = v_item.id;

  RETURN jsonb_build_object(
    'success', true,
    'event', 'PULLED_TO_STAGING',
    'toteCode', p_tote_code,
    'nextStatus', v_next_status,
    'locationCode', v_next_location_code,
    'locationType', v_next_location_type,
    'customerPin', v_customer_pin,
    'customerUid', v_item.uid
  );
END;
$$ LANGUAGE plpgsql;


-- =========================================================================
-- EVENT 4: TOTE INTAKE & ACTIVATION HANDLER
-- =========================================================================
CREATE OR REPLACE FUNCTION public.process_tote_activation(
  p_tote_code TEXT,
  p_intake_location_code TEXT DEFAULT 'INTAKE-PROCESSING'
) RETURNS JSONB SECURITY DEFINER AS $$
DECLARE
  v_uid UUID;
  v_item RECORD;
  v_user_role public.user_role;
BEGIN
  v_uid := auth.uid();
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Unauthenticated';
  END IF;

  SELECT role INTO v_user_role FROM public.users WHERE id = v_uid;
  IF v_user_role NOT IN ('warehouse_worker', 'warehouse_manager', 'executive') THEN
    RAISE EXCEPTION 'Access Denied: Staff clearance required';
  END IF;

  SELECT id, tote_code, status, uid INTO v_item 
  FROM public.inventory 
  WHERE tote_code = p_tote_code LIMIT 1;

  IF v_item IS NULL THEN
    RAISE EXCEPTION 'Activation Error: Tote % not found in inventory', p_tote_code;
  END IF;

  UPDATE public.inventory
  SET status = 'pending-stage'::public.inventory_status,
      location_code = COALESCE(p_intake_location_code, 'INTAKE-PROCESSING'),
      location_type = 'intake',
      activated = true,
      last_scanned_at = now(),
      last_scanned_by = v_uid
  WHERE id = v_item.id;

  RETURN jsonb_build_object(
    'success', true,
    'event', 'TOTE_ACTIVATED',
    'toteCode', p_tote_code,
    'nextStatus', 'pending-stage',
    'locationCode', COALESCE(p_intake_location_code, 'INTAKE-PROCESSING'),
    'locationType', 'intake',
    'customerUid', v_item.uid
  );
END;
$$ LANGUAGE plpgsql;

-- ============================================================
-- Automated Onboarding Status Trigger
-- ============================================================
CREATE OR REPLACE FUNCTION public.update_user_onboarding_status()
RETURNS TRIGGER AS $$
DECLARE
  v_uid UUID;
  v_onboarding_status TEXT;
  v_pending_count INT;
  v_staged_count INT;
  v_total_count INT;
  v_facility_id TEXT;
BEGIN
  IF TG_OP = 'DELETE' THEN
    v_uid := OLD.uid;
  ELSE
    v_uid := NEW.uid;
  END IF;

  -- Find the owner's current onboarding status
  SELECT onboarding_status INTO v_onboarding_status 
  FROM public.users 
  WHERE id = v_uid;

  -- Only automate if they are in the onboarding phase ('pending' or 'totes-ready')
  IF v_onboarding_status IN ('pending', 'totes-ready') THEN
    SELECT COUNT(*), 
           COUNT(*) FILTER (WHERE status = 'pending-stage'),
           COUNT(*) FILTER (WHERE status = 'staged')
    INTO v_total_count, v_pending_count, v_staged_count
    FROM public.inventory
    WHERE uid = v_uid;

    IF v_total_count > 0 THEN
      IF v_pending_count > 0 THEN
        UPDATE public.users SET onboarding_status = 'pending' WHERE id = v_uid;
      ELSIF v_staged_count > 0 THEN
        UPDATE public.users SET onboarding_status = 'totes-ready' WHERE id = v_uid;
      ELSE
        UPDATE public.users SET onboarding_status = 'active' WHERE id = v_uid;
      END IF;
    END IF;
  END IF;

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  ELSE
    RETURN NEW;
  END IF;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE TRIGGER trg_update_user_onboarding_status
AFTER INSERT OR UPDATE OF status OR DELETE ON public.inventory
FOR EACH ROW
EXECUTE FUNCTION public.update_user_onboarding_status();

-- ============================================================
-- PIN Keypad Door Verification RPC for Staging Kiosk
-- ============================================================
CREATE OR REPLACE FUNCTION public.verify_staging_pin(
  p_pin TEXT
) RETURNS JSONB SECURITY DEFINER AS $$
DECLARE
  v_req RECORD;
  v_user_name TEXT;
  v_item_count INT;
BEGIN
  IF p_pin IS NULL OR length(trim(p_pin)) = 0 THEN
    RETURN jsonb_build_object('success', false, 'message', 'PIN cannot be empty.');
  END IF;

  SELECT ar.*, u.name as user_name INTO v_req
  FROM public.access_requests ar
  JOIN public.users u ON u.id = ar.uid
  WHERE ar.pin = trim(p_pin)
    AND ar.status IN ('pending', 'overridden')
    AND (ar.pin_expires_at IS NULL OR ar.pin_expires_at > now())
  ORDER BY ar.requested_at DESC
  LIMIT 1;

  IF v_req IS NULL THEN
    RETURN jsonb_build_object('success', false, 'message', 'Invalid, expired, or already used Keypad PIN.');
  END IF;

  v_item_count := COALESCE(array_length(v_req.requested_items, 1), 0);

  UPDATE public.access_requests
  SET status = 'completed'
  WHERE id = v_req.id;

  IF v_item_count > 0 THEN
    UPDATE public.inventory
    SET status = 'with-customer'::inventory_status
    WHERE id = ANY(v_req.requested_items);

    UPDATE public.users
    SET active_totes_held = COALESCE(active_totes_held, 0) + v_item_count
    WHERE id = v_req.uid;
  END IF;

  RETURN jsonb_build_object(
    'success', true,
    'requestId', v_req.id,
    'userName', v_req.user_name,
    'toteCount', v_item_count,
    'fulfillmentType', v_req.fulfillment_type,
    'targetDate', v_req.target_date
  );
END;
$$ LANGUAGE plpgsql;

-- ============================================================
-- Cancellation Tote Return Scheduling RPC
-- ============================================================
CREATE OR REPLACE FUNCTION public.schedule_cancellation_tote_return(
  p_fulfillment_type TEXT DEFAULT 'staging'
) RETURNS JSONB SECURITY DEFINER AS $$
DECLARE
  v_uid UUID;
  v_canc RECORD;
  v_pin TEXT;
  v_target_date DATE;
  v_expires_at TIMESTAMPTZ;
  v_cutoff_passed BOOLEAN;
  v_user_facility TEXT;
BEGIN
  v_uid := auth.uid();
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Unauthenticated';
  END IF;

  SELECT assigned_facility_id INTO v_user_facility FROM public.users WHERE id = v_uid;
  IF v_user_facility IS NULL THEN
    v_user_facility := 'facility_seattle_north';
  END IF;

  SELECT * INTO v_canc
  FROM public.cancellations
  WHERE uid = v_uid AND account_status = 'pending_tote_return'
  ORDER BY created_at DESC LIMIT 1;

  IF v_canc IS NULL THEN
    RAISE EXCEPTION 'No pending cancellation tote return found.';
  END IF;

  v_cutoff_passed := EXTRACT(HOUR FROM now()) >= 18;
  IF v_cutoff_passed THEN
    v_target_date := (current_date + interval '2 days')::date;
  ELSE
    v_target_date := (current_date + interval '1 day')::date;
  END IF;

  v_pin := floor(1000 + random() * 9000)::text;
  v_expires_at := now() + interval '48 hours';

  INSERT INTO public.access_requests (
    uid, request_type, fulfillment_type, pin, pin_expires_at, target_date, facility_id, status
  ) VALUES (
    v_uid, 'cancellation_tote_return', p_fulfillment_type, v_pin, v_expires_at, v_target_date, v_user_facility, 'pending'
  );

  RETURN jsonb_build_object(
    'success', true,
    'pin', v_pin,
    'targetDate', v_target_date,
    'totesHeld', v_canc.active_totes_held
  );
END;
$$ LANGUAGE plpgsql;

-- ============================================================
-- Complete Cancellation Tote Return RPC
-- ============================================================
CREATE OR REPLACE FUNCTION public.complete_cancellation_tote_return(
  p_cancellation_id UUID
) RETURNS JSONB SECURITY DEFINER AS $$
DECLARE
  v_uid UUID;
BEGIN
  v_uid := auth.uid();
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Unauthenticated';
  END IF;

  UPDATE public.cancellations
  SET account_status = 'totes_returned',
      active_totes_held = 0
  WHERE id = p_cancellation_id AND uid = v_uid;

  UPDATE public.users
  SET active_totes_held = 0
  WHERE id = v_uid;

  RETURN jsonb_build_object('success', true);
END;
$$ LANGUAGE plpgsql;

-- ============================================================
-- Charge Missing / Damaged Tote Penalty RPC (Manager & Exec Only)
-- ============================================================
CREATE OR REPLACE FUNCTION public.charge_missing_tote(
  p_tote_id UUID,
  p_fee NUMERIC DEFAULT 15.00,
  p_reason TEXT DEFAULT 'Missing / Damaged Tote Penalty Fee'
) RETURNS JSONB SECURITY DEFINER AS $$
DECLARE
  v_uid UUID;
  v_user_role public.user_role;
  v_item RECORD;
BEGIN
  v_uid := auth.uid();
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Unauthenticated';
  END IF;

  SELECT role INTO v_user_role FROM public.users WHERE id = v_uid;
  IF v_user_role NOT IN ('warehouse_manager', 'executive') THEN
    RAISE EXCEPTION 'Access Denied: Managers & Executives only';
  END IF;

  SELECT id, uid, tote_code, status INTO v_item FROM public.inventory WHERE id = p_tote_id LIMIT 1;
  IF v_item IS NULL THEN
    RAISE EXCEPTION 'Tote not found';
  END IF;

  INSERT INTO public.charges (
    uid,
    charge_type,
    amount,
    totes_charged,
    status
  ) VALUES (
    v_item.uid,
    COALESCE(p_reason, 'missing_tote_fee'),
    COALESCE(p_fee, 15.00),
    1,
    'success'
  );

  RETURN jsonb_build_object(
    'success', true,
    'tote_code', v_item.tote_code,
    'charged_uid', v_item.uid,
    'fee_charged', COALESCE(p_fee, 15.00)
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- ------------------------------------------------------------
-- RLS DELETE POLICIES & DECOMMISSION RPC
-- ------------------------------------------------------------
DROP POLICY IF EXISTS "Executives delete facilities" ON public.facilities;
CREATE POLICY "Executives delete facilities" ON public.facilities FOR DELETE USING (public.get_user_role() = 'executive'::user_role);

DROP POLICY IF EXISTS "Executives delete operational_zones" ON public.operational_zones;
CREATE POLICY "Executives delete operational_zones" ON public.operational_zones FOR DELETE USING (public.get_user_role() = 'executive'::user_role);

DROP POLICY IF EXISTS "Executives delete service_areas" ON public.service_areas;
CREATE POLICY "Executives delete service_areas" ON public.service_areas FOR DELETE USING (public.get_user_role() = 'executive'::user_role);

CREATE OR REPLACE FUNCTION public.decommission_facility(p_facility_id TEXT)
RETURNS JSONB AS $$
DECLARE
  v_fallback_id TEXT;
  v_fac_name TEXT;
BEGIN
  SELECT name INTO v_fac_name FROM public.facilities WHERE id = p_facility_id;
  IF v_fac_name IS NULL THEN
    RETURN jsonb_build_object('success', false, 'message', 'Facility not found');
  END IF;

  SELECT id INTO v_fallback_id FROM public.facilities WHERE id != p_facility_id LIMIT 1;
  IF v_fallback_id IS NULL THEN
    v_fallback_id := 'facility_seattle_north';
  END IF;

  UPDATE public.users SET assigned_facility_id = v_fallback_id WHERE assigned_facility_id = p_facility_id;
  UPDATE public.inventory SET facility_id = v_fallback_id WHERE facility_id = p_facility_id;

  DELETE FROM public.warehouse_locations WHERE facility_id = p_facility_id;
  DELETE FROM public.service_areas WHERE facility_id = p_facility_id;
  DELETE FROM public.operational_zones WHERE facility_id = p_facility_id;
  DELETE FROM public.facilities WHERE id = p_facility_id;

  RETURN jsonb_build_object(
    'success', true,
    'deleted_id', p_facility_id,
    'deleted_name', v_fac_name,
    'reassigned_to', v_fallback_id
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;


-- ─────────────────────────────────────────────────────────────────────
-- move_tote_location RPC (Warehouse Digital Mapping Slotting Engine)
-- ─────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.move_tote_location(
  p_tote_id UUID,
  p_new_location_id UUID
) RETURNS JSONB SECURITY DEFINER AS $$
DECLARE
  v_old_location_id UUID;
  v_new_zone_type VARCHAR(50);
  v_new_identifier VARCHAR(100);
  v_capacity INTEGER;
  v_current_count INTEGER;
  v_old_count INTEGER;
  v_tote_code TEXT;
  v_is_occupied BOOLEAN;
  v_item_facility_id TEXT;
BEGIN
  -- 1. Verify tote exists and fetch current location & facility
  SELECT location_id, tote_code, facility_id 
  INTO v_old_location_id, v_tote_code, v_item_facility_id
  FROM public.inventory
  WHERE id = p_tote_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Tote with ID % not found', p_tote_id;
  END IF;

  -- 2. Verify new location if provided
  IF p_new_location_id IS NOT NULL THEN
    SELECT zone_type, COALESCE(capacity, 1), identifier, is_occupied
    INTO v_new_zone_type, v_capacity, v_new_identifier, v_is_occupied
    FROM public.warehouse_locations
    WHERE id = p_new_location_id;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'Target location with ID % not found', p_new_location_id;
    END IF;

    -- Count active totes assigned to target location strictly within THIS facility
    SELECT COUNT(*) INTO v_current_count 
    FROM public.inventory 
    WHERE (location_id = p_new_location_id OR (location_code = v_new_identifier AND (facility_id = v_item_facility_id OR v_item_facility_id IS NULL)))
      AND id != p_tote_id;

    -- Fail-Fast Logic: Check if at/above capacity limit
    IF (v_old_location_id IS NULL OR v_old_location_id != p_new_location_id) AND (v_current_count >= COALESCE(v_capacity, 3)) THEN
      RAISE EXCEPTION 'Location % is already full (%/% totes occupied). Shelves hold maximum % totes.', v_new_identifier, v_current_count, COALESCE(v_capacity, 3), COALESCE(v_capacity, 3);
    END IF;
  END IF;

  -- 3. Atomic Location Update
  -- Update tote location_id
  UPDATE public.inventory
  SET location_id = p_new_location_id,
      location_code = COALESCE(v_new_identifier, location_code),
      last_scanned_at = now(),
      updated_at = now()
  WHERE id = p_tote_id;

  -- Recalculate occupation status for old location
  IF v_old_location_id IS NOT NULL AND (p_new_location_id IS NULL OR v_old_location_id != p_new_location_id) THEN
    SELECT COUNT(*) INTO v_old_count FROM public.inventory WHERE location_id = v_old_location_id;
    UPDATE public.warehouse_locations
    SET is_occupied = (v_old_count >= COALESCE(capacity, 3))
    WHERE id = v_old_location_id;
  END IF;

  -- Recalculate occupation status for new location
  IF p_new_location_id IS NOT NULL THEN
    SELECT COUNT(*) INTO v_current_count FROM public.inventory WHERE location_id = p_new_location_id;
    UPDATE public.warehouse_locations
    SET is_occupied = (v_current_count >= COALESCE(capacity, 3))
    WHERE id = p_new_location_id;
  END IF;

  RETURN jsonb_build_object(
    'success', true,
    'tote_id', p_tote_id,
    'tote_code', v_tote_code,
    'old_location_id', v_old_location_id,
    'new_location_id', p_new_location_id,
    'new_identifier', v_new_identifier,
    'location_code', v_new_identifier,
    'totes_at_location', v_current_count,
    'location_capacity', v_capacity,
    'message', 'Tote moved successfully'
  );
END;
$$ LANGUAGE plpgsql;


-- ─────────────────────────────────────────────────────────────────────
-- run_daily_autopay_billing RPC & pg_cron Schedule
-- ─────────────────────────────────────────────────────────────────────
DROP FUNCTION IF EXISTS public.run_daily_autopay_billing() CASCADE;

CREATE OR REPLACE FUNCTION public.run_daily_autopay_billing()
RETURNS JSONB SECURITY DEFINER AS $$
DECLARE
  v_sub RECORD;
  v_seg RECORD;
  v_inv_count INT := 0;
  v_overdue_count INT := 0;
  v_inv_number TEXT;
  v_txn_ref TEXT;
  v_period_start TIMESTAMPTZ;
  v_period_end TIMESTAMPTZ;
  v_total_days NUMERIC;
  v_seg_start TIMESTAMPTZ;
  v_seg_end TIMESTAMPTZ;
  v_seg_days NUMERIC;
  v_seg_amount NUMERIC;
  v_subtotal NUMERIC := 0.00;
  v_tax_rate NUMERIC := 0.00;
  v_tax NUMERIC := 0.00;
  v_total_amount NUMERIC := 0.00;
  v_line_items JSONB := '[]'::jsonb;
  v_seg_count INT := 0;
BEGIN
  -- Process active subscriptions due for billing (next_billing_date <= CURRENT_DATE or NULL)
  FOR v_sub IN 
    SELECT s.*, u.name AS user_name, u.email AS user_email, u.assigned_facility_id, u.active_zone
    FROM public.subscriptions s
    LEFT JOIN public.users u ON s.uid = u.id
    WHERE s.status = 'active' 
      AND (s.next_billing_date IS NULL OR s.next_billing_date <= CURRENT_DATE)
  LOOP
    v_subtotal := 0.00;
    v_line_items := '[]'::jsonb;
    v_seg_count := 0;

    -- Define billing cycle window
    v_period_start := COALESCE(v_sub.last_billed_at, v_sub.created_at, now() - interval '1 month');
    v_period_end := now();

    -- Calculate total duration in days (e.g. 28, 30, 31)
    v_total_days := GREATEST(1.0, EXTRACT(EPOCH FROM (v_period_end - v_period_start)) / 86400.0);

    -- Fetch exact zip tax rate from service_areas (0.00 if none configured)
    SELECT COALESCE(tax_rate, 0.00) INTO v_tax_rate
    FROM public.service_areas
    WHERE zip_code = v_sub.active_zone AND active = true
    LIMIT 1;
    IF v_tax_rate IS NULL THEN v_tax_rate := 0.00; END IF;

    -- Query all active segments for this subscription
    FOR v_seg IN
      SELECT *
      FROM public.subscription_billing_segments
      WHERE subscription_id = v_sub.id
        AND effective_start < v_period_end
        AND (effective_end IS NULL OR effective_end > v_period_start)
      ORDER BY effective_start ASC
    LOOP
      v_seg_count := v_seg_count + 1;
      v_seg_start := GREATEST(v_period_start, v_seg.effective_start);
      v_seg_end := LEAST(v_period_end, COALESCE(v_seg.effective_end, v_period_end));
      v_seg_days := GREATEST(0.01, EXTRACT(EPOCH FROM (v_seg_end - v_seg_start)) / 86400.0);

      -- Pro-rata formula: Tote Count * Monthly Tier Rate * (Days in Segment / Total Days in Month)
      v_seg_amount := ROUND((v_seg.tote_count * v_seg.unit_rate * (v_seg_days / v_total_days))::numeric, 2);
      v_subtotal := v_subtotal + v_seg_amount;

      -- Add traceable math line item
      v_line_items := v_line_items || jsonb_build_array(jsonb_build_object(
        'description', 'Storage: ' || v_seg.tote_count::text || ' Totes @ $' || TO_CHAR(v_seg.unit_rate, 'FM999.00') || '/mo (' || TO_CHAR(v_seg_start, 'Mon DD') || ' – ' || TO_CHAR(v_seg_end, 'Mon DD') || ' • ' || ROUND(v_seg_days, 1)::text || ' of ' || ROUND(v_total_days, 1)::text || ' days)',
        'qty', v_seg.tote_count,
        'unit_price', v_seg.unit_rate,
        'days_active', ROUND(v_seg_days, 1),
        'total_cycle_days', ROUND(v_total_days, 1),
        'amount', v_seg_amount
      ));
    END LOOP;

    -- Fallback if no segments existed: use current subscription snapshot
    IF v_seg_count = 0 THEN
      v_subtotal := COALESCE(v_sub.recurring_storage, v_sub.total_totes * v_sub.tote_rate, 5.00);
      v_line_items := jsonb_build_array(jsonb_build_object(
        'description', 'CloudVault Monthly Storage Plan (' || COALESCE(v_sub.total_totes, 1)::text || ' totes @ $' || TO_CHAR(COALESCE(v_sub.tote_rate, 5.00), 'FM999.00') || '/mo)',
        'qty', COALESCE(v_sub.total_totes, 1),
        'unit_price', COALESCE(v_sub.tote_rate, 5.00),
        'amount', v_subtotal
      ));
    END IF;

    -- Tax calculation
    v_tax := ROUND((v_subtotal * v_tax_rate)::numeric, 2);
    v_total_amount := v_subtotal + v_tax;

    -- Add Tax line item if applicable
    IF v_tax > 0 THEN
      v_line_items := v_line_items || jsonb_build_array(jsonb_build_object(
        'description', 'State/Local Sales Tax (' || (v_tax_rate * 100)::text || '%)',
        'qty', 1,
        'unit_price', v_tax,
        'amount', v_tax
      ));
    END IF;

    -- Generate unique invoice number and transaction reference
    v_inv_number := 'INV-' || TO_CHAR(NOW(), 'YYYY') || '-' || LPAD(FLOOR(RANDOM() * 900000 + 100000)::TEXT, 6, '0');
    v_txn_ref := 'AUTOPAY-' || v_sub.id || '-' || TO_CHAR(CURRENT_DATE, 'YYYY-MM-DD');

    -- Insert consolidated monthly recurring invoice
    INSERT INTO public.invoices (
      invoice_number,
      uid,
      customer_name,
      customer_email,
      facility_id,
      subscription_id,
      invoice_type,
      payment_status,
      subtotal,
      tax,
      total_amount,
      payment_method,
      transaction_reference,
      notes,
      line_items,
      due_date,
      created_at,
      paid_at
    ) VALUES (
      v_inv_number,
      v_sub.uid,
      COALESCE(v_sub.user_name, 'Valued Customer'),
      v_sub.user_email,
      COALESCE(v_sub.assigned_facility_id, 'facility_seattle_north'),
      v_sub.id,
      'subscription',
      'paid',
      v_subtotal,
      v_tax,
      v_total_amount,
      'autopay',
      v_txn_ref,
      'Comprehensive monthly pro-rata storage renewal',
      v_line_items,
      NOW() + INTERVAL '3 days',
      NOW(),
      NOW()
    );

    -- Close historical segments for this past period
    UPDATE public.subscription_billing_segments
    SET effective_end = now()
    WHERE subscription_id = v_sub.id AND (effective_end IS NULL OR effective_end <= now());

    -- Seed clean base segment for the upcoming new month
    INSERT INTO public.subscription_billing_segments (
      subscription_id,
      uid,
      facility_id,
      tote_count,
      unit_rate,
      effective_start,
      effective_end,
      reason
    ) VALUES (
      v_sub.id,
      v_sub.uid,
      COALESCE(v_sub.assigned_facility_id, 'facility_seattle_north'),
      COALESCE(v_sub.total_totes, 1),
      COALESCE(v_sub.tote_rate, 5.00),
      now(),
      NULL,
      'cycle_renewal'
    );

    -- Advance next_billing_date by 1 month and update last_billed_at
    UPDATE public.subscriptions
    SET last_billed_at = now(),
        next_billing_date = CURRENT_DATE + INTERVAL '1 month',
        last_updated = now()
    WHERE id = v_sub.id;

    v_inv_count := v_inv_count + 1;
  END LOOP;

  -- 2. Evaluate unpaid invoices past due_date setting payment_status = 'overdue' and users.is_overdue = true
  WITH overdue_invs AS (
    UPDATE public.invoices
    SET payment_status = 'overdue'
    WHERE payment_status IN ('pending', 'unpaid')
      AND due_date < NOW()
    RETURNING uid
  )
  UPDATE public.users
  SET is_overdue = true,
      onboarding_status = 'overdue'
  WHERE id IN (SELECT uid FROM overdue_invs WHERE uid IS NOT NULL);

  GET DIAGNOSTICS v_overdue_count = ROW_COUNT;

  RETURN jsonb_build_object(
    'success', true,
    'invoices_generated', v_inv_count,
    'overdue_users_flagged', v_overdue_count
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- pg_cron schedule statement
SELECT cron.schedule('daily-autopay-job', '0 0 * * *', $$SELECT public.run_daily_autopay_billing();$$);

-- ============================================================
-- 31. Employee Badges & Silent Scan-to-Login System
-- ============================================================

CREATE TABLE IF NOT EXISTS public.employee_badges (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
    token_hash TEXT NOT NULL UNIQUE,
    badge_label TEXT DEFAULT 'Standard Employee Badge',
    is_active BOOLEAN DEFAULT true NOT NULL,
    issued_at TIMESTAMPTZ DEFAULT now() NOT NULL,
    revoked_at TIMESTAMPTZ,
    last_scanned_at TIMESTAMPTZ,
    created_by UUID REFERENCES public.users(id)
);

CREATE INDEX IF NOT EXISTS idx_employee_badges_token_hash ON public.employee_badges(token_hash);
CREATE INDEX IF NOT EXISTS idx_employee_badges_user_id ON public.employee_badges(user_id);
CREATE INDEX IF NOT EXISTS idx_employee_badges_active ON public.employee_badges(is_active);

ALTER TABLE public.employee_badges ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Staff can view employee badges" ON public.employee_badges;
CREATE POLICY "Staff can view employee badges" ON public.employee_badges
    FOR SELECT USING (
        public.get_user_role() IN ('warehouse_worker', 'warehouse_manager', 'executive')
        OR auth.uid() = user_id
    );

DROP POLICY IF EXISTS "Managers and executives can manage employee badges" ON public.employee_badges;
CREATE POLICY "Managers and executives can manage employee badges" ON public.employee_badges
    FOR ALL USING (
        public.get_user_role() IN ('warehouse_manager', 'executive')
    ) WITH CHECK (
        public.get_user_role() IN ('warehouse_manager', 'executive')
    );

-- Verify Token Hash & Return User Profile (Strict Employee Boundary)
CREATE OR REPLACE FUNCTION public.verify_employee_badge_login(p_token_hash TEXT)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_badge RECORD;
    v_user RECORD;
BEGIN
    IF p_token_hash IS NULL OR length(trim(p_token_hash)) = 0 THEN
        RAISE EXCEPTION 'Invalid token hash provided';
    END IF;

    -- Lookup active badge
    SELECT b.id, b.user_id, b.is_active, b.revoked_at
    INTO v_badge
    FROM public.employee_badges b
    WHERE b.token_hash = p_token_hash
      AND b.is_active = true
      AND b.revoked_at IS NULL
    LIMIT 1;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Invalid or revoked employee badge token';
    END IF;

    -- Fetch user profile and strictly enforce non-customer role boundary
    SELECT u.id, u.email, u.name, u.role, u.assigned_facility_id, u.active_zone
    INTO v_user
    FROM public.users u
    WHERE u.id = v_badge.user_id;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Associated user profile not found';
    END IF;

    -- Block customer role completely
    IF v_user.role = 'customer'::public.user_role OR v_user.role NOT IN ('warehouse_worker', 'warehouse_manager', 'executive') THEN
        RAISE EXCEPTION 'Access Denied: Badge authentication is restricted strictly to authorized internal staff';
    END IF;

    -- Update last scanned timestamp on badge
    UPDATE public.employee_badges
    SET last_scanned_at = now()
    WHERE id = v_badge.id;

    RETURN jsonb_build_object(
        'success', true,
        'user', jsonb_build_object(
            'id', v_user.id,
            'email', v_user.email,
            'name', v_user.name,
            'role', v_user.role,
            'assigned_facility_id', v_user.assigned_facility_id,
            'active_zone', v_user.active_zone
        ),
        'badge_id', v_badge.id,
        'scanned_at', now()
    );
END;
$$;

GRANT EXECUTE ON FUNCTION public.verify_employee_badge_login(TEXT) TO anon, authenticated, service_role;

-- Issue Badge (Strict Non-Customer Check & Automatic Superseding)
CREATE OR REPLACE FUNCTION public.issue_employee_badge(
    p_user_id UUID,
    p_token_hash TEXT,
    p_badge_label TEXT DEFAULT 'Standard Employee Badge'
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_user RECORD;
    v_new_badge_id UUID;
BEGIN
    IF p_token_hash IS NULL OR length(trim(p_token_hash)) = 0 THEN
        RAISE EXCEPTION 'Token hash is required';
    END IF;

    -- Verify target user exists and is internal employee
    SELECT id, email, name, role, assigned_facility_id
    INTO v_user
    FROM public.users
    WHERE id = p_user_id;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'User not found';
    END IF;

    IF v_user.role = 'customer'::public.user_role THEN
        RAISE EXCEPTION 'Badge issuance forbidden: Badges cannot be issued to customer accounts.';
    END IF;

    -- Deactivate any existing active badges for this employee
    UPDATE public.employee_badges
    SET is_active = false,
        revoked_at = now()
    WHERE user_id = p_user_id
      AND is_active = true;

    -- Insert new badge
    INSERT INTO public.employee_badges (
        user_id,
        token_hash,
        badge_label,
        is_active,
        issued_at,
        created_by
    ) VALUES (
        p_user_id,
        p_token_hash,
        COALESCE(p_badge_label, 'Standard Employee Badge'),
        true,
        now(),
        auth.uid()
    )
    RETURNING id INTO v_new_badge_id;

    RETURN jsonb_build_object(
        'success', true,
        'badge_id', v_new_badge_id,
        'user_id', p_user_id,
        'user_name', v_user.name,
        'user_role', v_user.role,
        'badge_label', COALESCE(p_badge_label, 'Standard Employee Badge'),
        'issued_at', now()
    );
END;
$$;

GRANT EXECUTE ON FUNCTION public.issue_employee_badge(UUID, TEXT, TEXT) TO anon, authenticated, service_role;

-- Revoke Badge
CREATE OR REPLACE FUNCTION public.revoke_employee_badge(p_badge_id UUID)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_badge RECORD;
BEGIN
    SELECT id, user_id, is_active
    INTO v_badge
    FROM public.employee_badges
    WHERE id = p_badge_id;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Badge not found';
    END IF;

    UPDATE public.employee_badges
    SET is_active = false,
        revoked_at = now()
    WHERE id = p_badge_id;

    RETURN jsonb_build_object(
        'success', true,
        'badge_id', p_badge_id,
        'revoked_at', now()
    );
END;
$$;

GRANT EXECUTE ON FUNCTION public.revoke_employee_badge(UUID) TO anon, authenticated, service_role;

-- Get Badges
CREATE OR REPLACE FUNCTION public.get_employee_badges(p_facility_id TEXT DEFAULT NULL)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_results JSONB;
BEGIN
    SELECT jsonb_agg(
        jsonb_build_object(
            'badge_id', b.id,
            'user_id', u.id,
            'user_name', u.name,
            'user_email', u.email,
            'user_role', u.role,
            'assigned_facility_id', u.assigned_facility_id,
            'badge_label', b.badge_label,
            'is_active', b.is_active,
            'issued_at', b.issued_at,
            'revoked_at', b.revoked_at,
            'last_scanned_at', b.last_scanned_at
        ) ORDER BY b.issued_at DESC
    )
    INTO v_results
    FROM public.employee_badges b
    JOIN public.users u ON u.id = b.user_id
    WHERE (p_facility_id IS NULL OR u.assigned_facility_id = p_facility_id);

    RETURN COALESCE(v_results, '[]'::jsonb);
END;
$$;

GRANT EXECUTE ON FUNCTION public.get_employee_badges(TEXT) TO anon, authenticated, service_role;

-- =========================================================================
-- MACHINE LEARNING & RETRIEVAL PROPENSITY TELEMETRY
-- =========================================================================

CREATE TABLE IF NOT EXISTS public.tote_retrieval_analytics (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    
    -- Entity Identifiers
    tote_id UUID REFERENCES public.inventory(id) ON DELETE SET NULL,
    tote_code TEXT NOT NULL,
    user_id UUID REFERENCES public.users(id) ON DELETE SET NULL,
    facility_id TEXT REFERENCES public.facilities(id) ON DELETE SET NULL,
    
    -- Customer Demographics & Behavioral Propensity
    customer_name TEXT,
    customer_email TEXT,
    customer_plan_tier TEXT,
    customer_logistics_pref TEXT DEFAULT 'self_service',
    customer_account_age_days NUMERIC(10,2) DEFAULT 0,
    customer_total_totes_held INTEGER DEFAULT 1,
    customer_cumulative_retrievals INTEGER DEFAULT 1,
    customer_retrievals_last_30d INTEGER DEFAULT 1,
    customer_propensity_score NUMERIC(6,4) DEFAULT 0.0000,
    
    -- Tote Content NLP & Categorization Features
    tote_label TEXT,
    tote_category TEXT,
    tote_tags TEXT[] DEFAULT '{}'::text[],
    has_contents_photo BOOLEAN DEFAULT false,
    tote_cumulative_retrievals INTEGER DEFAULT 1,
    tote_age_days NUMERIC(10,2) DEFAULT 0,
    dwell_time_days NUMERIC(10,2) DEFAULT 0,
    
    -- Physical Origin & Spatial Slotting Features
    origin_location_code TEXT,
    origin_zone_type TEXT DEFAULT 'VAULT',
    origin_aisle TEXT,
    origin_bay TEXT,
    origin_shelf_level INTEGER,
    origin_shelf_code TEXT,
    
    -- Retrieval Channel & Staging Destination
    retrieval_channel TEXT DEFAULT 'valet_delivery',
    dest_staging_code TEXT,
    dest_room TEXT,
    dest_bay TEXT,
    access_request_id UUID REFERENCES public.access_requests(id) ON DELETE SET NULL,
    staging_reservation_id UUID DEFAULT NULL,
    
    -- Temporal & Seasonality Features for ML
    retrieved_at TIMESTAMPTZ DEFAULT now() NOT NULL,
    retrieval_year INTEGER,
    retrieval_month INTEGER,
    retrieval_day_of_week INTEGER,
    retrieval_hour_of_day INTEGER,
    is_weekend BOOLEAN DEFAULT false,
    is_holiday_season BOOLEAN DEFAULT false,
    
    -- Operational Performance
    pulled_by_worker_id UUID REFERENCES public.users(id) ON DELETE SET NULL,
    pull_duration_seconds NUMERIC(10,2) DEFAULT NULL,
    
    metadata JSONB DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ DEFAULT now() NOT NULL
);

-- Performance & ML Query Indexes
CREATE INDEX IF NOT EXISTS idx_retrieval_analytics_user_id ON public.tote_retrieval_analytics(user_id);
CREATE INDEX IF NOT EXISTS idx_retrieval_analytics_tote_id ON public.tote_retrieval_analytics(tote_id);
CREATE INDEX IF NOT EXISTS idx_retrieval_analytics_facility_id ON public.tote_retrieval_analytics(facility_id);
CREATE INDEX IF NOT EXISTS idx_retrieval_analytics_retrieved_at ON public.tote_retrieval_analytics(retrieved_at DESC);
CREATE INDEX IF NOT EXISTS idx_retrieval_analytics_origin_shelf ON public.tote_retrieval_analytics(origin_shelf_level);
CREATE INDEX IF NOT EXISTS idx_retrieval_analytics_tote_category ON public.tote_retrieval_analytics(tote_category);
CREATE INDEX IF NOT EXISTS idx_retrieval_analytics_channel ON public.tote_retrieval_analytics(retrieval_channel);

-- Enable RLS
ALTER TABLE public.tote_retrieval_analytics ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
    DROP POLICY IF EXISTS "Admins and warehouse staff have full access to retrieval telemetry" ON public.tote_retrieval_analytics;
    CREATE POLICY "Admins and warehouse staff have full access to retrieval telemetry"
    ON public.tote_retrieval_analytics
    FOR ALL
    TO authenticated
    USING (
        EXISTS (
            SELECT 1 FROM public.users 
            WHERE id = auth.uid() 
            AND role IN ('warehouse_worker', 'warehouse_manager', 'executive')
        )
    );
EXCEPTION WHEN OTHERS THEN NULL;
END $$;

DO $$ BEGIN
    DROP POLICY IF EXISTS "Customers can view their own tote retrieval analytics" ON public.tote_retrieval_analytics;
    CREATE POLICY "Customers can view their own tote retrieval analytics"
    ON public.tote_retrieval_analytics
    FOR SELECT
    TO authenticated
    USING (user_id = auth.uid());
EXCEPTION WHEN OTHERS THEN NULL;
END $$;

-- Automated Telemetry Ingestion Function
CREATE OR REPLACE FUNCTION public.record_tote_retrieval_telemetry(
    p_tote_id UUID,
    p_retrieval_channel TEXT DEFAULT 'valet_delivery',
    p_worker_id UUID DEFAULT NULL,
    p_dest_code TEXT DEFAULT NULL,
    p_access_req_id UUID DEFAULT NULL,
    p_staging_res_id UUID DEFAULT NULL
) RETURNS UUID SECURITY DEFINER AS $$
DECLARE
    v_tote RECORD;
    v_user RECORD;
    v_now TIMESTAMPTZ := now();
    v_origin_loc TEXT;
    v_origin_zone TEXT := 'VAULT';
    v_origin_aisle TEXT := NULL;
    v_origin_bay TEXT := NULL;
    v_origin_shelf_lvl INTEGER := NULL;
    v_origin_shelf_code TEXT := NULL;
    v_dest_room TEXT := NULL;
    v_dest_bay TEXT := NULL;
    
    v_customer_cumul_retrievals INTEGER := 1;
    v_customer_last_30d INTEGER := 1;
    v_customer_account_age_days NUMERIC(10,2) := 0;
    v_customer_totes_held INTEGER := 1;
    v_customer_propensity NUMERIC(6,4) := 0.0000;
    
    v_tote_cumul_retrievals INTEGER := 1;
    v_tote_age_days NUMERIC(10,2) := 0;
    v_dwell_time_days NUMERIC(10,2) := 0;
    
    v_year INTEGER;
    v_month INTEGER;
    v_dow INTEGER;
    v_hour INTEGER;
    v_is_weekend BOOLEAN;
    v_is_holiday BOOLEAN;
    
    v_tote_tags TEXT[] := '{}'::text[];
    v_new_id UUID;
BEGIN
    SELECT * INTO v_tote FROM public.inventory WHERE id = p_tote_id;
    IF v_tote IS NULL THEN
        RETURN NULL;
    END IF;

    IF v_tote.uid IS NOT NULL THEN
        SELECT * INTO v_user FROM public.users WHERE id = v_tote.uid;
    END IF;

    -- Temporal Decomposition
    v_year := EXTRACT(YEAR FROM v_now)::INTEGER;
    v_month := EXTRACT(MONTH FROM v_now)::INTEGER;
    v_dow := EXTRACT(DOW FROM v_now)::INTEGER;
    v_hour := EXTRACT(HOUR FROM v_now)::INTEGER;
    v_is_weekend := (v_dow IN (0, 6));
    v_is_holiday := (v_month IN (11, 12, 1));

    -- Origin Coordinates Parsing
    v_origin_loc := COALESCE(v_tote.location_code, 'VAULT');
    IF v_origin_loc ~* '^(?:V-)?(A\d+)-?(B\d+)?-?(S\d+)?' THEN
        v_origin_aisle := (regexp_matches(v_origin_loc, '^(?:V-)?(A\d+)', 'i'))[1];
        v_origin_bay := (regexp_matches(v_origin_loc, '-(B\d+)', 'i'))[1];
        v_origin_shelf_code := (regexp_matches(v_origin_loc, '-(S\d+)', 'i'))[1];
        IF v_origin_shelf_code IS NOT NULL THEN
            v_origin_shelf_lvl := substring(v_origin_shelf_code from '\d+')::INTEGER;
        END IF;
    END IF;

    -- Destination Parsing
    IF p_dest_code IS NOT NULL THEN
        IF p_dest_code ~* '^(ROOM-\d+)' THEN
            v_dest_room := (regexp_matches(p_dest_code, '^(ROOM-\d+)', 'i'))[1];
            v_dest_bay := (regexp_matches(p_dest_code, '-(BAY-\d+)', 'i'))[1];
        END IF;
    END IF;

    -- Customer Propensity
    IF v_user IS NOT NULL THEN
        v_customer_account_age_days := GREATEST(0, ROUND(EXTRACT(EPOCH FROM (v_now - v_user.created_at)) / 86400.0, 2));
        v_customer_totes_held := COALESCE(v_user.active_totes_held, 1);
        
        SELECT COUNT(*) + 1 INTO v_customer_cumul_retrievals
        FROM public.tote_retrieval_analytics
        WHERE user_id = v_user.id;
        
        SELECT COUNT(*) + 1 INTO v_customer_last_30d
        FROM public.tote_retrieval_analytics
        WHERE user_id = v_user.id AND retrieved_at >= (v_now - INTERVAL '30 days');

        IF v_customer_totes_held > 0 AND v_customer_account_age_days > 0 THEN
            v_customer_propensity := ROUND((v_customer_cumul_retrievals::NUMERIC / v_customer_totes_held::NUMERIC) * (30.0 / GREATEST(30.0, v_customer_account_age_days)), 4);
        END IF;
    END IF;

    -- Tote Level Metrics
    v_tote_age_days := GREATEST(0, ROUND(EXTRACT(EPOCH FROM (v_now - v_tote.created_at)) / 86400.0, 2));
    IF v_tote.last_scanned_at IS NOT NULL THEN
        v_dwell_time_days := GREATEST(0, ROUND(EXTRACT(EPOCH FROM (v_now - v_tote.last_scanned_at)) / 86400.0, 2));
    ELSE
        v_dwell_time_days := v_tote_age_days;
    END IF;

    SELECT COUNT(*) + 1 INTO v_tote_cumul_retrievals
    FROM public.tote_retrieval_analytics
    WHERE tote_id = v_tote.id;

    IF v_tote.label IS NOT NULL THEN
        SELECT array_agg(m[1]) INTO v_tote_tags
        FROM regexp_matches(v_tote.label, '#([A-Za-z0-9_]+)', 'g') AS m;
    END IF;
    IF v_tote_tags IS NULL THEN
        v_tote_tags := '{}'::text[];
    END IF;

    INSERT INTO public.tote_retrieval_analytics (
        tote_id,
        tote_code,
        user_id,
        facility_id,
        customer_name,
        customer_email,
        customer_plan_tier,
        customer_logistics_pref,
        customer_account_age_days,
        customer_total_totes_held,
        customer_cumulative_retrievals,
        customer_retrievals_last_30d,
        customer_propensity_score,
        tote_label,
        tote_category,
        tote_tags,
        has_contents_photo,
        tote_cumulative_retrievals,
        tote_age_days,
        dwell_time_days,
        origin_location_code,
        origin_zone_type,
        origin_aisle,
        origin_bay,
        origin_shelf_level,
        origin_shelf_code,
        retrieval_channel,
        dest_staging_code,
        dest_room,
        dest_bay,
        access_request_id,
        staging_reservation_id,
        pulled_by_worker_id,
        retrieved_at,
        retrieval_year,
        retrieval_month,
        retrieval_day_of_week,
        retrieval_hour_of_day,
        is_weekend,
        is_holiday_season
    ) VALUES (
        v_tote.id,
        v_tote.tote_code,
        v_tote.uid,
        v_tote.facility_id,
        v_user.name,
        v_user.email,
        COALESCE(v_user.onboarding_status, 'standard'),
        COALESCE(v_user.logistics_preference, 'self_service'),
        v_customer_account_age_days,
        v_customer_totes_held,
        v_customer_cumul_retrievals,
        v_customer_last_30d,
        v_customer_propensity,
        v_tote.label,
        COALESCE(v_tote.category, 'General Storage'),
        v_tote_tags,
        (v_tote.image_url IS NOT NULL AND v_tote.image_url <> ''),
        v_tote_cumul_retrievals,
        v_tote_age_days,
        v_dwell_time_days,
        v_origin_loc,
        v_origin_zone,
        v_origin_aisle,
        v_origin_bay,
        v_origin_shelf_lvl,
        v_origin_shelf_code,
        p_retrieval_channel,
        p_dest_code,
        v_dest_room,
        v_dest_bay,
        p_access_req_id,
        p_staging_res_id,
        p_worker_id,
        v_now,
        v_year,
        v_month,
        v_dow,
        v_hour,
        v_is_weekend,
        v_is_holiday
    ) RETURNING id INTO v_new_id;

    RETURN v_new_id;
END;
$$ LANGUAGE plpgsql;

-- =========================================================================
-- DATA PRIVACY & STATUTORY RETENTION COMPLIANCE (GDPR & CCPA)
-- =========================================================================

-- Privacy Audit Logs Table
CREATE TABLE IF NOT EXISTS public.privacy_audit_logs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    executed_by UUID,
    executed_by_email TEXT,
    target_uid UUID NOT NULL,
    compliance_reason TEXT NOT NULL,
    action_type TEXT DEFAULT 'gdpr_ccpa_customer_erasure' NOT NULL,
    totes_returned_to_pool INT DEFAULT 0,
    invoices_anonymized INT DEFAULT 0,
    executed_at TIMESTAMPTZ DEFAULT now() NOT NULL
);

ALTER TABLE public.privacy_audit_logs ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'privacy_audit_logs' AND policyname = 'Executives view privacy logs') THEN
    CREATE POLICY "Executives view privacy logs" ON public.privacy_audit_logs 
    FOR SELECT USING (
      EXISTS (SELECT 1 FROM public.users WHERE id = auth.uid() AND role = 'executive')
    );
  END IF;
END $$;

GRANT ALL ON public.privacy_audit_logs TO authenticated, service_role;

-- Executive-Only Customer Data Erasure RPC (Permanent Auth Purge & Statutory Ledger Retention)
CREATE OR REPLACE FUNCTION public.delete_customer_data_privacy(
    p_target_uid UUID,
    p_reason TEXT DEFAULT 'GDPR / CCPA Customer Right to Erasure Request'
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_executing_uid UUID;
    v_executing_role TEXT;
    v_executing_email TEXT;
    v_target_user RECORD;
    v_totes_count INT := 0;
    v_invoices_count INT := 0;
    v_audit_id UUID;
    v_facility_id TEXT;
BEGIN
    v_executing_uid := auth.uid();
    IF v_executing_uid IS NULL THEN
        RAISE EXCEPTION 'Unauthenticated. You must be signed in.';
    END IF;

    -- Strict clearance check: Executive (Super Admin) ONLY
    SELECT role, email INTO v_executing_role, v_executing_email 
    FROM public.users 
    WHERE id = v_executing_uid;

    IF v_executing_role != 'executive' THEN
        RAISE EXCEPTION 'Access Denied. Customer data deletion is strictly restricted to Executives (Super Admins).';
    END IF;

    -- Prevent self-deletion of executing executive
    IF v_executing_uid = p_target_uid THEN
        RAISE EXCEPTION 'Safety Violation: Cannot delete your own executive account via data privacy tool.';
    END IF;

    -- Verify target user exists
    SELECT * INTO v_target_user FROM public.users WHERE id = p_target_uid;
    IF v_target_user.id IS NULL THEN
        RAISE EXCEPTION 'Customer account with ID % does not exist or has already been erased.', p_target_uid;
    END IF;

    v_facility_id := v_target_user.assigned_facility_id;
    IF v_facility_id IS NULL THEN
        v_facility_id := 'facility_seattle_north';
    END IF;

    -- 1. Anonymize financial records for statutory tax/accounting record-keeping
    UPDATE public.invoices
    SET customer_name = 'Anonymized Customer (GDPR Erased)',
        customer_email = 'deleted@anonymized.cloudvault.internal',
        notes = COALESCE(notes, '') || ' [Account data erased under GDPR/CCPA on ' || now()::date || ']',
        uid = NULL
    WHERE uid = p_target_uid;
    GET DIAGNOSTICS v_invoices_count = ROW_COUNT;

    UPDATE public.charges
    SET uid = NULL
    WHERE uid = p_target_uid;

    -- 2. Sanitize and release physical inventory totes back to facility available pool
    SELECT COUNT(*) INTO v_totes_count FROM public.inventory WHERE uid = p_target_uid;

    DELETE FROM public.inventory WHERE uid = p_target_uid;

    -- 3. Delete active access requests and staging reservations
    DELETE FROM public.staging_reservations WHERE uid = p_target_uid;
    DELETE FROM public.access_requests WHERE uid = p_target_uid;
    DELETE FROM public.cancellations WHERE uid = p_target_uid;
    DELETE FROM public.subscriptions WHERE uid = p_target_uid;

    -- 4. Update facility active totes counter and metadata
    UPDATE public.facilities
    SET active_totes = GREATEST(0, active_totes - COALESCE(v_target_user.active_totes_held, 0))
    WHERE id = v_facility_id;

    UPDATE public.metadata
    SET total_users = GREATEST(0, total_users - 1),
        total_totes = GREATEST(0, total_totes - COALESCE(v_target_user.active_totes_held, 0))
    WHERE id = 'financials';

    -- 5. Delete user profile from public.users
    DELETE FROM public.users WHERE id = p_target_uid;

    -- 6. Purge user from auth.users (No ghost accounts)
    DELETE FROM auth.users WHERE id = p_target_uid;

    -- 7. Write immutable privacy audit record
    INSERT INTO public.privacy_audit_logs (
        executed_by,
        executed_by_email,
        target_uid,
        compliance_reason,
        action_type,
        totes_returned_to_pool,
        invoices_anonymized,
        executed_at
    ) VALUES (
        v_executing_uid,
        v_executing_email,
        p_target_uid,
        COALESCE(p_reason, 'GDPR / CCPA Right to Erasure Request'),
        'gdpr_ccpa_customer_erasure',
        v_totes_count,
        v_invoices_count,
        now()
    ) RETURNING id INTO v_audit_id;

    RETURN jsonb_build_object(
        'success', true,
        'audit_id', v_audit_id,
        'deleted_uid', p_target_uid,
        'totes_returned', v_totes_count,
        'invoices_anonymized', v_invoices_count,
        'message', 'Customer data and authentication records have been permanently erased in compliance with GDPR/CCPA standards.'
    );
END;
$$;

-- =========================================================================
-- CREATE EXIT RETRIEVAL REQUEST RPC (Customer Tote Reduction Pull)
-- =========================================================================
CREATE OR REPLACE FUNCTION public.create_exit_retrieval_request(
    p_tote_ids UUID[],
    p_fulfillment_type TEXT DEFAULT 'staging',
    p_target_date DATE DEFAULT CURRENT_DATE + 1,
    p_time_slot TEXT DEFAULT '09:00 AM - 12:00 PM',
    p_delivery_notes TEXT DEFAULT NULL
) RETURNS JSONB SECURITY DEFINER AS $$
DECLARE
  v_uid UUID;
  v_user RECORD;
  v_sub RECORD;
  v_user_facility TEXT;
  v_pin TEXT;
  v_next_status public.inventory_status;
  v_req_id UUID;
  v_tote_codes TEXT[];
  v_valet_fee NUMERIC(10,2) := 0.00;
  v_valet_base NUMERIC(10,2) := 15.00;
  v_valet_adder NUMERIC(10,2) := 1.00;
  v_tote_count INT;
  v_max_allowed_date DATE;
BEGIN
  v_uid := auth.uid();
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Unauthenticated';
  END IF;

  IF p_tote_ids IS NULL OR cardinality(p_tote_ids) = 0 THEN
    RAISE EXCEPTION 'Exit Retrieval Error: At least one tote must be selected for return/exit';
  END IF;

  -- Enforce 3-Day Grace Window Limit on scheduled retrieval target date
  v_max_allowed_date := (current_date + interval '3 days')::DATE;
  IF p_target_date > v_max_allowed_date THEN
    RAISE EXCEPTION 'Schedule Error: Exit retrieval must be scheduled within your 3-day grace window (on or before %)', v_max_allowed_date;
  END IF;

  v_tote_count := cardinality(p_tote_ids);

  SELECT * INTO v_user FROM public.users WHERE id = v_uid;
  IF v_user IS NULL THEN
    RAISE EXCEPTION 'User profile not found';
  END IF;

  SELECT * INTO v_sub FROM public.subscriptions WHERE uid = v_uid AND status = 'active' LIMIT 1;

  SELECT array_agg(tote_code) INTO v_tote_codes
  FROM public.inventory
  WHERE id = ANY(p_tote_ids) AND uid = v_uid;

  IF v_tote_codes IS NULL OR cardinality(v_tote_codes) <> v_tote_count THEN
    RAISE EXCEPTION 'Exit Retrieval Error: One or more selected totes do not belong to customer or were not found';
  END IF;

  v_user_facility := COALESCE(v_user.assigned_facility_id, 'facility_seattle_north');

  -- Calculate Valet fee if valet delivery selected (Drop-off + Return leg)
  IF p_fulfillment_type = 'valet_delivery' THEN
    SELECT 
      COALESCE(valet_base_rate, 15.00),
      COALESCE(valet_tote_rate, 1.00)
    INTO v_valet_base, v_valet_adder
    FROM public.facilities WHERE id = v_user_facility LIMIT 1;

    v_valet_fee := v_valet_base + (v_tote_count * v_valet_adder);
  END IF;

  -- 4-digit PIN for Staging Room entry & verification
  v_pin := lpad(floor(random() * 10000)::text, 4, '0');
  v_next_status := CASE WHEN p_fulfillment_type = 'valet_delivery' THEN 'pending-dispatch'::public.inventory_status ELSE 'pending-stage'::public.inventory_status END;

  UPDATE public.inventory
  SET status = v_next_status,
      last_scanned_at = now()
  WHERE id = ANY(p_tote_ids) AND uid = v_uid;

  INSERT INTO public.access_requests (
    uid,
    request_type,
    fulfillment_type,
    requested_items,
    requested_tote_codes,
    facility_id,
    pin,
    pin_expires_at,
    valet_fee,
    status,
    target_date,
    time_slot,
    delivery_notes
  ) VALUES (
    v_uid,
    'exit_retrieval',
    p_fulfillment_type,
    p_tote_ids,
    v_tote_codes,
    v_user_facility,
    v_pin,
    now() + interval '72 hours', -- 3-day grace period
    v_valet_fee,
    'pending',
    p_target_date,
    p_time_slot,
    p_delivery_notes
  ) RETURNING id INTO v_req_id;

  RETURN jsonb_build_object(
    'success', true,
    'event', 'EXIT_RETRIEVAL_SUBMITTED',
    'requestId', v_req_id,
    'requestedToteIds', p_tote_ids,
    'requestedToteCodes', v_tote_codes,
    'toteCount', v_tote_count,
    'fulfillmentType', p_fulfillment_type,
    'valetFee', v_valet_fee,
    'pin', v_pin,
    'targetDate', p_target_date,
    'timeSlot', p_time_slot,
    'graceDays', 3,
    'message', 'Exit retrieval scheduled. 3-day grace period active to empty and return containers.'
  );
END;
$$ LANGUAGE plpgsql;

-- =========================================================================
-- CHECK-IN & RECIRCULATE RETURNED EXIT TOTES RPC (Warehouse Worker)
-- =========================================================================
-- CHECK-IN & RECIRCULATE RETURNED EXIT TOTES RPC (Warehouse Worker)
-- =========================================================================
CREATE OR REPLACE FUNCTION public.checkin_returned_exit_totes(
    p_tote_code TEXT,
    p_shelf_location_code TEXT DEFAULT 'INTAKE-BAY-1',
    p_staff_uid UUID DEFAULT NULL
) RETURNS JSONB SECURITY DEFINER AS $$
DECLARE
  v_uid UUID;
  v_user_role public.user_role;
  v_item RECORD;
  v_owner_uid UUID;
  v_new_held INT;
  v_active_req RECORD;
  v_all_returned BOOLEAN := true;
  v_code TEXT;
BEGIN
  v_uid := COALESCE(auth.uid(), p_staff_uid);
  IF v_uid IS NULL THEN
    SELECT id INTO v_uid FROM public.users WHERE role IN ('warehouse_worker', 'warehouse_manager', 'executive') ORDER BY created_at ASC LIMIT 1;
  END IF;

  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Unauthenticated';
  END IF;

  SELECT role INTO v_user_role FROM public.users WHERE id = v_uid;
  IF v_user_role NOT IN ('warehouse_worker', 'warehouse_manager', 'executive') THEN
    RAISE EXCEPTION 'Access Denied: Warehouse Staff clearance required';
  END IF;

  SELECT id, tote_code, uid, facility_id, status INTO v_item
  FROM public.inventory
  WHERE tote_code = p_tote_code LIMIT 1;

  IF v_item IS NULL THEN
    RAISE EXCEPTION 'Check-In Error: Tote % not found in inventory', p_tote_code;
  END IF;

  v_owner_uid := v_item.uid;

  -- 1. Delete/retire the old container tag record from active inventory
  DELETE FROM public.inventory WHERE id = v_item.id;

  -- 2. Decrement customer active_totes_held if customer was attached
  IF v_owner_uid IS NOT NULL THEN
    UPDATE public.users
    SET active_totes_held = GREATEST(0, COALESCE(active_totes_held, 0) - 1)
    WHERE id = v_owner_uid
    RETURNING active_totes_held INTO v_new_held;

    -- 3. Check for matching pending exit_retrieval or cancellation request
    SELECT * INTO v_active_req
    FROM public.access_requests
    WHERE uid = v_owner_uid 
      AND p_tote_code = ANY(requested_tote_codes)
      AND status IN ('pending', 'staged', 'out-for-delivery', 'with-customer')
    ORDER BY requested_at DESC LIMIT 1;

    IF v_active_req IS NOT NULL THEN
      IF v_active_req.requested_tote_codes IS NOT NULL THEN
        FOREACH v_code IN ARRAY v_active_req.requested_tote_codes LOOP
          IF EXISTS (
            SELECT 1 FROM public.inventory 
            WHERE tote_code = v_code 
              AND uid = v_owner_uid 
              AND status IN ('pending-stage', 'staged', 'pending-dispatch', 'out-for-delivery', 'with-customer')
          ) THEN
            v_all_returned := false;
          END IF;
        END LOOP;
      END IF;

      IF v_all_returned THEN
        UPDATE public.access_requests
        SET status = 'completed'
        WHERE id = v_active_req.id;
      END IF;
    END IF;
  END IF;

  RETURN jsonb_build_object(
    'success', true,
    'toteCode', p_tote_code,
    'recirculated', true,
    'tagRetired', true,
    'previousOwnerUid', v_owner_uid,
    'activeTotesHeld', v_new_held,
    'allRequestTotesReturned', v_all_returned,
    'message', 'Tote ' || p_tote_code || ' surrendered: old tag retired and plastic bin returned to clean facility tote stack.'
  );
END;
$$ LANGUAGE plpgsql;

-- =========================================================================
-- BATCH CHECK-IN RETURNED EXIT TOTES (1-Click Recirculate All to Activation Room)
-- =========================================================================
CREATE OR REPLACE FUNCTION public.batch_checkin_returned_exit_totes(
    p_tote_codes TEXT[],
    p_shelf_location_code TEXT DEFAULT 'INTAKE-BAY-1',
    p_staff_uid UUID DEFAULT NULL
) RETURNS JSONB SECURITY DEFINER AS $$
DECLARE
  v_uid UUID;
  v_user_role public.user_role;
  v_count INT := 0;
  v_owner_uid UUID;
  v_new_held INT;
BEGIN
  v_uid := COALESCE(auth.uid(), p_staff_uid);
  IF v_uid IS NULL THEN
    SELECT id INTO v_uid FROM public.users WHERE role IN ('warehouse_worker', 'warehouse_manager', 'executive') ORDER BY created_at ASC LIMIT 1;
  END IF;

  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Unauthenticated';
  END IF;

  SELECT role INTO v_user_role FROM public.users WHERE id = v_uid;
  IF v_user_role NOT IN ('warehouse_worker', 'warehouse_manager', 'executive') THEN
    RAISE EXCEPTION 'Access Denied: Warehouse Staff clearance required';
  END IF;

  IF p_tote_codes IS NULL OR cardinality(p_tote_codes) = 0 THEN
    RAISE EXCEPTION 'No tote codes provided for batch check-in';
  END IF;

  -- Find owner UID from first tote
  SELECT uid INTO v_owner_uid
  FROM public.inventory
  WHERE tote_code = p_tote_codes[1] AND uid IS NOT NULL
  LIMIT 1;

  -- Delete all specified surrendered tote records from active inventory
  DELETE FROM public.inventory
  WHERE tote_code = ANY(p_tote_codes);

  GET DIAGNOSTICS v_count = ROW_COUNT;

  -- Decrement customer active_totes_held if customer was attached
  IF v_owner_uid IS NOT NULL THEN
    UPDATE public.users
    SET active_totes_held = GREATEST(0, COALESCE(active_totes_held, 0) - v_count)
    WHERE id = v_owner_uid
    RETURNING active_totes_held INTO v_new_held;

    -- Mark matching pending requests as completed
    UPDATE public.access_requests
    SET status = 'completed'
    WHERE uid = v_owner_uid
      AND (p_tote_codes && requested_tote_codes)
      AND status IN ('pending', 'staged', 'out-for-delivery', 'with-customer');
  END IF;

  RETURN jsonb_build_object(
    'success', true,
    'recirculatedCount', v_count,
    'tagsRetired', true,
    'previousOwnerUid', v_owner_uid,
    'activeTotesHeld', v_new_held,
    'message', 'Successfully retired ' || v_count::text || ' surrendered tote tags. Plastic bins returned to clean facility tote stack.'
  );
END;
$$ LANGUAGE plpgsql;

-- =========================================================================
-- CREATOR & PROMOTIONAL ATTRIBUTION REVENUE ENGINE (GDPR & SOC-2 COMPLIANT)
-- =========================================================================

-- Extend Users table with referral tracking columns if missing
ALTER TABLE public.users ADD COLUMN IF NOT EXISTS referred_by_promo_code TEXT;
ALTER TABLE public.users ADD COLUMN IF NOT EXISTS referred_by_creator_id UUID;
ALTER TABLE public.users ADD COLUMN IF NOT EXISTS referred_at TIMESTAMPTZ;

-- 1. Creators Master Table
CREATE TABLE IF NOT EXISTS public.creators (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name TEXT NOT NULL,
    handle TEXT,
    email TEXT NOT NULL,
    payout_email TEXT,
    stripe_connect_id TEXT,
    tier VARCHAR(50) DEFAULT 'Standard Influencer',
    default_commission_pct NUMERIC(5,2) DEFAULT 10.00,
    commission_duration_months INT DEFAULT 6,
    status VARCHAR(20) DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'PAUSED', 'SUSPENDED')),
    total_attributed_revenue NUMERIC(12,2) DEFAULT 0.00,
    total_commission_earned NUMERIC(12,2) DEFAULT 0.00,
    total_commission_paid NUMERIC(12,2) DEFAULT 0.00,
    notes TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- 2. Promotional Checkout Codes Table
CREATE TABLE IF NOT EXISTS public.promo_codes (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    creator_id UUID REFERENCES public.creators(id) ON DELETE SET NULL,
    code TEXT NOT NULL UNIQUE,
    stripe_coupon_id TEXT,
    stripe_promo_code_id TEXT,
    customer_discount_pct NUMERIC(5,2) DEFAULT 20.00,
    customer_discount_duration_months INT DEFAULT 2,
    commission_rate_pct NUMERIC(5,2) DEFAULT 10.00,
    commission_duration_months INT DEFAULT 6,
    max_redemptions INT DEFAULT NULL,
    current_redemptions INT DEFAULT 0,
    total_revenue_generated NUMERIC(12,2) DEFAULT 0.00,
    is_active BOOLEAN DEFAULT TRUE,
    expires_at TIMESTAMPTZ DEFAULT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- 3. Promotional Attribution & Commission Redemptions Ledger
CREATE TABLE IF NOT EXISTS public.promo_redemptions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    promo_code_id UUID REFERENCES public.promo_codes(id) ON DELETE SET NULL,
    promo_code TEXT NOT NULL,
    creator_id UUID REFERENCES public.creators(id) ON DELETE SET NULL,
    customer_uid UUID REFERENCES public.users(id) ON DELETE SET NULL,
    customer_id UUID REFERENCES public.users(id) ON DELETE SET NULL,
    customer_email TEXT,
    stripe_invoice_id TEXT,
    stripe_charge_id TEXT,
    invoice_gross_amount NUMERIC(10,2) NOT NULL,
    gross_amount NUMERIC(10,2),
    discount_amount NUMERIC(10,2) DEFAULT 0.00,
    net_paid_amount NUMERIC(10,2) NOT NULL,
    commission_rate_applied NUMERIC(5,2) NOT NULL,
    commission_amount NUMERIC(10,2) NOT NULL,
    creator_commission_amount NUMERIC(10,2),
    month_index INT DEFAULT 1,
    is_commission_eligible BOOLEAN DEFAULT TRUE,
    payout_status VARCHAR(20) DEFAULT 'PENDING' CHECK (payout_status IN ('PENDING', 'APPROVED', 'PAID', 'VOIDED')),
    payout_reference TEXT,
    paid_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Atomic increment helper for promo code statistics
CREATE OR REPLACE FUNCTION public.increment_promo_code_stats(
    p_promo_id UUID,
    p_revenue_amount NUMERIC
) RETURNS VOID SECURITY DEFINER AS $$
BEGIN
    UPDATE public.promo_codes
    SET current_redemptions = COALESCE(current_redemptions, 0) + 1,
        total_revenue_generated = COALESCE(total_revenue_generated, 0.00) + COALESCE(p_revenue_amount, 0.00),
        updated_at = NOW()
    WHERE id = p_promo_id;
END;
$$ LANGUAGE plpgsql;

-- 4. Enable Row Level Security (RLS)
ALTER TABLE public.creators ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.promo_codes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.promo_redemptions ENABLE ROW LEVEL SECURITY;

-- 5. RLS Policies: Executive and Warehouse Managers have full access (Optimized InitPlan Caching)
DROP POLICY IF EXISTS admin_creators_policy ON public.creators;
CREATE POLICY admin_creators_policy ON public.creators
    FOR ALL
    USING (
        (SELECT (auth.jwt() ->> 'role')) = 'service_role'
        OR EXISTS (SELECT 1 FROM public.users u WHERE u.id = (SELECT auth.uid()) AND u.role IN ('executive', 'warehouse_manager'))
    );

DROP POLICY IF EXISTS admin_promo_codes_policy ON public.promo_codes;
CREATE POLICY admin_promo_codes_policy ON public.promo_codes
    FOR ALL
    USING (
        (SELECT (auth.jwt() ->> 'role')) = 'service_role'
        OR is_active = TRUE
        OR EXISTS (SELECT 1 FROM public.users u WHERE u.id = (SELECT auth.uid()) AND u.role IN ('executive', 'warehouse_manager'))
    );

DROP POLICY IF EXISTS admin_promo_redemptions_policy ON public.promo_redemptions;
CREATE POLICY admin_promo_redemptions_policy ON public.promo_redemptions
    FOR ALL
    USING (
        (SELECT (auth.jwt() ->> 'role')) = 'service_role'
        OR customer_uid = (SELECT auth.uid())
        OR EXISTS (SELECT 1 FROM public.users u WHERE u.id = (SELECT auth.uid()) AND u.role IN ('executive', 'warehouse_manager'))
    );

-- 6. RPC: Validate Promo Code For Checkout
CREATE OR REPLACE FUNCTION public.validate_promo_code_for_checkout(
    p_code TEXT,
    p_user_uid UUID DEFAULT NULL,
    p_gross_amount NUMERIC DEFAULT 0.00
) RETURNS JSONB SECURITY DEFINER AS $$
DECLARE
    v_promo RECORD;
    v_creator RECORD;
    v_discount_amt NUMERIC(10,2) := 0.00;
    v_net_amt NUMERIC(10,2) := p_gross_amount;
    v_clean_code TEXT;
BEGIN
    IF p_code IS NULL OR TRIM(p_code) = '' THEN
        RETURN jsonb_build_object('valid', false, 'message', 'Please enter a valid promotional code');
    END IF;

    v_clean_code := UPPER(TRIM(p_code));

    SELECT * INTO v_promo
    FROM public.promo_codes
    WHERE UPPER(code) = v_clean_code
    LIMIT 1;

    IF v_promo.id IS NULL THEN
        RETURN jsonb_build_object('valid', false, 'message', 'Promo code not found');
    END IF;

    IF NOT v_promo.is_active THEN
        RETURN jsonb_build_object('valid', false, 'message', 'This promo code is currently paused or inactive');
    END IF;

    IF v_promo.expires_at IS NOT NULL AND v_promo.expires_at < NOW() THEN
        RETURN jsonb_build_object('valid', false, 'message', 'This promo code has expired');
    END IF;

    IF v_promo.max_redemptions IS NOT NULL AND v_promo.current_redemptions >= v_promo.max_redemptions THEN
        RETURN jsonb_build_object('valid', false, 'message', 'This promo code has reached its maximum redemption limit');
    END IF;

    -- Calculate Discount Amount
    v_discount_amt := ROUND(p_gross_amount * (COALESCE(v_promo.customer_discount_pct, 20.00) / 100.0), 2);
    v_net_amt := GREATEST(0.00, p_gross_amount - v_discount_amt);

    SELECT name, handle INTO v_creator FROM public.creators WHERE id = v_promo.creator_id;

    RETURN jsonb_build_object(
        'valid', true,
        'promo_id', v_promo.id,
        'code', v_promo.code,
        'creator_name', COALESCE(v_creator.name, 'Creator Partner'),
        'customer_discount_pct', v_promo.customer_discount_pct,
        'customer_discount_duration_months', v_promo.customer_discount_duration_months,
        'gross_amount', p_gross_amount,
        'discount_amount', v_discount_amt,
        'net_amount', v_net_amt,
        'message', 'Success! ' || v_promo.customer_discount_pct::text || '% off applied for your first ' || v_promo.customer_discount_duration_months::text || ' months!'
    );
END;
$$ LANGUAGE plpgsql;

-- 7. RPC: Record Invoice Attribution & Calculate 6-Month Window Commission
CREATE OR REPLACE FUNCTION public.record_invoice_promo_attribution(
    p_code TEXT,
    p_customer_uid UUID,
    p_invoice_id TEXT,
    p_gross_amount NUMERIC,
    p_net_amount NUMERIC DEFAULT NULL
) RETURNS JSONB SECURITY DEFINER AS $$
DECLARE
    v_promo RECORD;
    v_creator RECORD;
    v_user RECORD;
    v_clean_code TEXT;
    v_discount_amt NUMERIC(10,2) := 0.00;
    v_net_paid NUMERIC(10,2);
    v_first_ref_date TIMESTAMPTZ;
    v_month_diff INT := 1;
    v_commission_eligible BOOLEAN := true;
    v_comm_rate NUMERIC(5,2) := 10.00;
    v_comm_amount NUMERIC(10,2) := 0.00;
    v_redemption_id UUID;
BEGIN
    IF p_code IS NULL OR TRIM(p_code) = '' THEN
        RETURN jsonb_build_object('success', false, 'message', 'No promo code provided');
    END IF;

    v_clean_code := UPPER(TRIM(p_code));

    SELECT * INTO v_promo FROM public.promo_codes WHERE UPPER(code) = v_clean_code LIMIT 1;
    IF v_promo.id IS NULL THEN
        RETURN jsonb_build_object('success', false, 'message', 'Promo code not recognized');
    END IF;

    SELECT * INTO v_creator FROM public.creators WHERE id = v_promo.creator_id LIMIT 1;
    SELECT * INTO v_user FROM public.users WHERE id = p_customer_uid LIMIT 1;

    -- Calculate Discount applied
    v_discount_amt := ROUND(p_gross_amount * (COALESCE(v_promo.customer_discount_pct, 20.00) / 100.0), 2);
    v_net_paid := COALESCE(p_net_amount, GREATEST(0.00, p_gross_amount - v_discount_amt));

    -- Determine month index & commission attribution window (Default: 6 months)
    v_first_ref_date := COALESCE(v_user.referred_at, NOW());

    -- Month difference calculation
    v_month_diff := GREATEST(1, (EXTRACT(YEAR FROM NOW()) - EXTRACT(YEAR FROM v_first_ref_date)) * 12 + 
                                (EXTRACT(MONTH FROM NOW()) - EXTRACT(MONTH FROM v_first_ref_date)) + 1);

    v_comm_rate := COALESCE(v_promo.commission_rate_pct, v_creator.default_commission_pct, 10.00);

    -- Only grant commission if within the creator's commission duration (default 6 months)
    IF v_month_diff <= COALESCE(v_promo.commission_duration_months, 6) THEN
        v_commission_eligible := true;
        v_comm_amount := ROUND(p_gross_amount * (v_comm_rate / 100.0), 2);
    ELSE
        v_commission_eligible := false;
        v_comm_amount := 0.00;
    END IF;

    -- Insert Redemption Ledger Record
    INSERT INTO public.promo_redemptions (
        promo_code_id,
        promo_code,
        creator_id,
        customer_uid,
        customer_email,
        stripe_invoice_id,
        invoice_gross_amount,
        discount_amount,
        net_paid_amount,
        commission_rate_applied,
        commission_amount,
        month_index,
        is_commission_eligible,
        payout_status
    ) VALUES (
        v_promo.id,
        v_promo.code,
        v_creator.id,
        p_customer_uid,
        v_user.email,
        p_invoice_id,
        p_gross_amount,
        v_discount_amt,
        v_net_paid,
        v_comm_rate,
        v_comm_amount,
        v_month_diff,
        v_commission_eligible,
        'PENDING'
    ) RETURNING id INTO v_redemption_id;

    -- Update Promo Code Stats
    UPDATE public.promo_codes
    SET current_redemptions = current_redemptions + 1,
        updated_at = NOW()
    WHERE id = v_promo.id;

    -- Update Creator Lifetime Stats
    IF v_creator.id IS NOT NULL THEN
        UPDATE public.creators
        SET total_attributed_revenue = total_attributed_revenue + p_gross_amount,
            total_commission_earned = total_commission_earned + v_comm_amount,
            updated_at = NOW()
        WHERE id = v_creator.id;
    END IF;

    -- Update User Record with Referral Association
    IF p_customer_uid IS NOT NULL THEN
        UPDATE public.users
        SET referred_by_promo_code = COALESCE(referred_by_promo_code, v_promo.code),
            referred_by_creator_id = COALESCE(referred_by_creator_id, v_creator.id),
            referred_at = COALESCE(referred_at, NOW())
        WHERE id = p_customer_uid;
    END IF;

    RETURN jsonb_build_object(
        'success', true,
        'redemption_id', v_redemption_id,
        'creator_id', v_creator.id,
        'creator_name', v_creator.name,
        'gross_amount', p_gross_amount,
        'discount_amount', v_discount_amt,
        'commission_rate', v_comm_rate,
        'commission_amount', v_comm_amount,
        'month_index', v_month_diff,
        'is_commission_eligible', v_commission_eligible
    );
END;
$$ LANGUAGE plpgsql;

-- 8. RPC: Settle Creator Payout
CREATE OR REPLACE FUNCTION public.settle_creator_payout(
    p_creator_id UUID,
    p_amount NUMERIC,
    p_payout_ref TEXT DEFAULT 'MANUAL_ACH_SETTLEMENT'
) RETURNS JSONB SECURITY DEFINER AS $$
DECLARE
    v_updated_count INT := 0;
BEGIN
    -- Mark all pending redemptions for creator as PAID up to settled amount
    UPDATE public.promo_redemptions
    SET payout_status = 'PAID',
        payout_reference = p_payout_ref,
        paid_at = NOW()
    WHERE creator_id = p_creator_id AND payout_status IN ('PENDING', 'APPROVED');

    GET DIAGNOSTICS v_updated_count = ROW_COUNT;

    -- Update Creator Total Paid
    UPDATE public.creators
    SET total_commission_paid = total_commission_paid + p_amount,
        updated_at = NOW()
    WHERE id = p_creator_id;

    RETURN jsonb_build_object(
        'success', true,
        'creator_id', p_creator_id,
        'settled_amount', p_amount,
        'redemptions_settled', v_updated_count,
        'reference', p_payout_ref
    );
END;
$$ LANGUAGE plpgsql;

-- 9. RPC: Save Facility Configuration & Reconcile Active Subscriptions Dynamically
CREATE OR REPLACE FUNCTION public.save_facility_configuration(
    p_facility_data JSONB,
    p_zone_data JSONB DEFAULT NULL,
    p_staff_uid TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_fac_id TEXT;
    v_fac_name TEXT;
    v_tier1 NUMERIC;
    v_tier2 NUMERIC;
    v_tier3 NUMERIC;
    v_tier4 NUMERIC;
    v_missing_fee NUMERIC;
    v_valet_base NUMERIC;
    v_valet_adder NUMERIC;
    v_subs_updated INT := 0;
    v_sub RECORD;
    v_tote_count INT;
    v_resolved_rate NUMERIC;
    v_new_recurring NUMERIC;
BEGIN
    v_fac_id := p_facility_data->>'id';
    v_fac_name := p_facility_data->>'name';
    v_tier1 := (p_facility_data->>'tier1_rate')::NUMERIC;
    v_tier2 := (p_facility_data->>'tier2_rate')::NUMERIC;
    v_tier3 := (p_facility_data->>'tier3_rate')::NUMERIC;
    v_tier4 := (p_facility_data->>'tier4_rate')::NUMERIC;
    v_missing_fee := (p_facility_data->>'missing_tote_fee')::NUMERIC;
    v_valet_base := (p_facility_data->>'valet_base')::NUMERIC;
    v_valet_adder := (p_facility_data->>'valet_tote_adder')::NUMERIC;

    IF v_fac_id IS NULL OR v_fac_id = '' THEN
        RAISE EXCEPTION 'Facility ID is required';
    END IF;

    -- Upsert facility specification
    INSERT INTO public.facilities (
        id,
        name,
        manager_name,
        manager_email,
        address,
        city,
        state,
        zip,
        usable_warehouse_sqft,
        sqft_per_tote,
        tote_capacity,
        num_staging_rooms,
        staging_rooms,
        num_valet_trucks,
        valet_trucks,
        monthly_rent_cost,
        monthly_labor_cost,
        monthly_utilities_cost,
        monthly_insurance_cost,
        tier1_rate,
        tier2_rate,
        tier3_rate,
        tier4_rate,
        valet_base,
        valet_tote_adder,
        missing_tote_fee,
        next_day_surge_fee,
        next_day_peak_surge_fee,
        same_day_surge_fee,
        same_day_peak_surge_fee,
        next_day_promo_free,
        max_scheduling_days_out,
        min_lead_time_days,
        evening_peak_slot_fee,
        staging_config,
        updated_at
    ) VALUES (
        v_fac_id,
        COALESCE(v_fac_name, v_fac_id),
        p_facility_data->>'manager_name',
        p_facility_data->>'manager_email',
        p_facility_data->>'address',
        p_facility_data->>'city',
        p_facility_data->>'state',
        p_facility_data->>'zip',
        COALESCE((p_facility_data->>'usable_warehouse_sqft')::NUMERIC, 0),
        COALESCE((p_facility_data->>'sqft_per_tote')::NUMERIC, 1.0),
        COALESCE((p_facility_data->>'tote_capacity')::INT, 0),
        COALESCE((p_facility_data->>'num_staging_rooms')::INT, 0),
        COALESCE((p_facility_data->>'staging_rooms')::INT, 0),
        COALESCE((p_facility_data->>'num_valet_trucks')::INT, 0),
        COALESCE((p_facility_data->>'valet_trucks')::INT, 0),
        COALESCE((p_facility_data->>'monthly_rent_cost')::NUMERIC, 0),
        COALESCE((p_facility_data->>'monthly_labor_cost')::NUMERIC, 0),
        COALESCE((p_facility_data->>'monthly_utilities_cost')::NUMERIC, 0),
        COALESCE((p_facility_data->>'monthly_insurance_cost')::NUMERIC, 0),
        v_tier1,
        v_tier2,
        v_tier3,
        v_tier4,
        COALESCE(v_valet_base, 0),
        COALESCE(v_valet_adder, 0),
        COALESCE(v_missing_fee, 0),
        COALESCE((p_facility_data->>'next_day_surge_fee')::NUMERIC, 0),
        COALESCE((p_facility_data->>'next_day_peak_surge_fee')::NUMERIC, 0),
        COALESCE((p_facility_data->>'same_day_surge_fee')::NUMERIC, 0),
        COALESCE((p_facility_data->>'same_day_peak_surge_fee')::NUMERIC, 0),
        COALESCE((p_facility_data->>'next_day_promo_free')::BOOLEAN, false),
        COALESCE((p_facility_data->>'max_scheduling_days_out')::INT, 30),
        COALESCE((p_facility_data->>'min_lead_time_days')::INT, 0),
        COALESCE((p_facility_data->>'evening_peak_slot_fee')::NUMERIC, 0),
        p_facility_data->'staging_config',
        NOW()
    )
    ON CONFLICT (id) DO UPDATE SET
        name = EXCLUDED.name,
        manager_name = EXCLUDED.manager_name,
        manager_email = EXCLUDED.manager_email,
        address = EXCLUDED.address,
        city = EXCLUDED.city,
        state = EXCLUDED.state,
        zip = EXCLUDED.zip,
        usable_warehouse_sqft = EXCLUDED.usable_warehouse_sqft,
        sqft_per_tote = EXCLUDED.sqft_per_tote,
        tote_capacity = EXCLUDED.tote_capacity,
        num_staging_rooms = EXCLUDED.num_staging_rooms,
        staging_rooms = EXCLUDED.staging_rooms,
        num_valet_trucks = EXCLUDED.num_valet_trucks,
        valet_trucks = EXCLUDED.valet_trucks,
        monthly_rent_cost = EXCLUDED.monthly_rent_cost,
        monthly_labor_cost = EXCLUDED.monthly_labor_cost,
        monthly_utilities_cost = EXCLUDED.monthly_utilities_cost,
        monthly_insurance_cost = EXCLUDED.monthly_insurance_cost,
        tier1_rate = EXCLUDED.tier1_rate,
        tier2_rate = EXCLUDED.tier2_rate,
        tier3_rate = EXCLUDED.tier3_rate,
        tier4_rate = EXCLUDED.tier4_rate,
        valet_base = EXCLUDED.valet_base,
        valet_tote_adder = EXCLUDED.valet_tote_adder,
        missing_tote_fee = EXCLUDED.missing_tote_fee,
        next_day_surge_fee = EXCLUDED.next_day_surge_fee,
        next_day_peak_surge_fee = EXCLUDED.next_day_peak_surge_fee,
        same_day_surge_fee = EXCLUDED.same_day_surge_fee,
        same_day_peak_surge_fee = EXCLUDED.same_day_peak_surge_fee,
        next_day_promo_free = EXCLUDED.next_day_promo_free,
        max_scheduling_days_out = EXCLUDED.max_scheduling_days_out,
        min_lead_time_days = EXCLUDED.min_lead_time_days,
        evening_peak_slot_fee = EXCLUDED.evening_peak_slot_fee,
        staging_config = EXCLUDED.staging_config,
        updated_at = NOW();

    -- Upsert zone data if provided
    IF p_zone_data IS NOT NULL AND p_zone_data->>'id' IS NOT NULL THEN
        INSERT INTO public.operational_zones (
            id,
            facility_id,
            city,
            required_deposit,
            active,
            zip_codes,
            updated_at
        ) VALUES (
            p_zone_data->>'id',
            v_fac_id,
            COALESCE(p_zone_data->>'city', v_fac_name, 'Active Market'),
            COALESCE((p_zone_data->>'required_deposit')::NUMERIC, 0),
            COALESCE((p_zone_data->>'active')::BOOLEAN, true),
            CASE WHEN p_zone_data->'zip_codes' IS NOT NULL THEN ARRAY(SELECT jsonb_array_elements_text(p_zone_data->'zip_codes')) ELSE ARRAY[]::TEXT[] END,
            NOW()
        )
        ON CONFLICT (id) DO UPDATE SET
            facility_id = EXCLUDED.facility_id,
            city = EXCLUDED.city,
            required_deposit = EXCLUDED.required_deposit,
            active = EXCLUDED.active,
            zip_codes = EXCLUDED.zip_codes,
            updated_at = NOW();
    END IF;

    -- Dynamically reconcile all non-price-locked subscriptions for this facility
    IF v_tier1 IS NOT NULL AND v_tier2 IS NOT NULL AND v_tier3 IS NOT NULL AND v_tier4 IS NOT NULL THEN
        FOR v_sub IN
            SELECT s.id, s.uid, s.total_totes, s.tote_count, s.has_price_lock, u.has_price_lock AS u_lock
            FROM public.subscriptions s
            LEFT JOIN public.users u ON u.id = s.uid
            WHERE (s.facility_id = v_fac_id OR u.assigned_facility_id = v_fac_id)
              AND s.status = 'active'
              AND COALESCE(s.has_price_lock, false) = false
              AND COALESCE(u.has_price_lock, false) = false
        LOOP
            v_tote_count := COALESCE(v_sub.total_totes, v_sub.tote_count, 1);
            IF v_tote_count >= 50 THEN
                v_resolved_rate := v_tier4;
            ELSIF v_tote_count >= 25 THEN
                v_resolved_rate := v_tier3;
            ELSIF v_tote_count >= 10 THEN
                v_resolved_rate := v_tier2;
            ELSE
                v_resolved_rate := v_tier1;
            END IF;

            v_new_recurring := v_tote_count * v_resolved_rate;

            UPDATE public.subscriptions
            SET tote_rate = v_resolved_rate,
                recurring_storage = v_new_recurring,
                monthly_total = v_new_recurring,
                last_updated = NOW()
            WHERE id = v_sub.id;

            v_subs_updated := v_subs_updated + 1;
        END LOOP;
    END IF;

    RETURN jsonb_build_object(
        'success', true,
        'facility_id', v_fac_id,
        'subscriptions_updated', v_subs_updated,
        'timestamp', NOW()
    );
END;
$$;
CREATE OR REPLACE FUNCTION public.sync_warehouse_location_occupancy()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  -- Update occupancy for NEW location if present
  IF NEW.location_code IS NOT NULL THEN
    UPDATE public.warehouse_locations wl
    SET is_occupied = (
      SELECT COUNT(*) >= COALESCE(wl.capacity, 3)
      FROM public.inventory i
      WHERE (i.location_id = wl.id OR i.location_code = wl.identifier OR i.location_code = wl.location_code)
        AND (i.facility_id = wl.facility_id OR wl.facility_id IS NULL)
        AND i.status IN ('stored', 'staged', 'pending-stage')
    )
    WHERE (wl.identifier = NEW.location_code OR wl.location_code = NEW.location_code OR wl.id = NEW.location_id)
      AND (wl.facility_id = NEW.facility_id OR NEW.facility_id IS NULL);
  END IF;

  -- Update occupancy for OLD location if changed
  IF TG_OP = 'UPDATE' AND OLD.location_code IS NOT NULL AND OLD.location_code != COALESCE(NEW.location_code, '') THEN
    UPDATE public.warehouse_locations wl
    SET is_occupied = (
      SELECT COUNT(*) >= COALESCE(wl.capacity, 3)
      FROM public.inventory i
      WHERE (i.location_id = wl.id OR i.location_code = wl.identifier OR i.location_code = wl.location_code)
        AND (i.facility_id = wl.facility_id OR wl.facility_id IS NULL)
        AND i.status IN ('stored', 'staged', 'pending-stage')
    )
    WHERE (wl.identifier = OLD.location_code OR wl.location_code = OLD.location_code OR wl.id = OLD.location_id)
      AND (wl.facility_id = OLD.facility_id OR OLD.facility_id IS NULL);
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_sync_inventory_location_occupancy ON public.inventory;
CREATE TRIGGER trg_sync_inventory_location_occupancy
AFTER INSERT OR UPDATE OF location_code, location_id, status, facility_id
ON public.inventory
FOR EACH ROW
EXECUTE FUNCTION public.sync_warehouse_location_occupancy();

-- ============================================================
-- 10. Consumer App Feedback & Bug Reporting System
-- ============================================================
CREATE TABLE IF NOT EXISTS public.feedback_reports (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_uid UUID REFERENCES auth.users(id) ON DELETE SET NULL,
    user_email TEXT,
    user_name TEXT,
    report_type TEXT NOT NULL CHECK (report_type IN ('bug', 'enhancement')),
    flow_area TEXT NOT NULL DEFAULT 'general',
    title TEXT NOT NULL,
    description TEXT NOT NULL,
    severity TEXT DEFAULT 'medium' CHECK (severity IN ('low', 'medium', 'high', 'critical')),
    diagnostics JSONB DEFAULT '{}'::jsonb,
    github_issue_number INT,
    github_issue_url TEXT,
    status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'in_progress', 'resolved', 'closed')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE public.feedback_reports ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_policies 
        WHERE tablename = 'feedback_reports' AND policyname = 'Anyone can insert feedback reports'
    ) THEN
        CREATE POLICY "Anyone can insert feedback reports" 
        ON public.feedback_reports 
        FOR INSERT 
        WITH CHECK (true);
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_policies 
        WHERE tablename = 'feedback_reports' AND policyname = 'Users can view own feedback reports'
    ) THEN
        CREATE POLICY "Users can view own feedback reports" 
        ON public.feedback_reports 
        FOR SELECT 
        USING (user_uid IS NULL OR auth.uid() = user_uid OR auth.role() = 'authenticated');
    END IF;
END $$;

-- =========================================================================
-- Waitlist Creator Code & Stripe Priority Deposit Integration
-- =========================================================================
ALTER TABLE public.waitlist 
ADD COLUMN IF NOT EXISTS promo_code TEXT,
ADD COLUMN IF NOT EXISTS promo_code_id UUID REFERENCES public.promo_codes(id) ON DELETE SET NULL,
ADD COLUMN IF NOT EXISTS creator_id UUID REFERENCES public.creators(id) ON DELETE SET NULL,
ADD COLUMN IF NOT EXISTS deposit_discount_pct NUMERIC DEFAULT 0,
ADD COLUMN IF NOT EXISTS deposit_discount_amount NUMERIC DEFAULT 0,
ADD COLUMN IF NOT EXISTS net_deposit_paid NUMERIC DEFAULT 0,
ADD COLUMN IF NOT EXISTS stripe_payment_intent_id TEXT;

ALTER TABLE public.promo_codes
ADD COLUMN IF NOT EXISTS allow_waitlist_deposits BOOLEAN DEFAULT true,
ADD COLUMN IF NOT EXISTS waitlist_deposit_discount_pct NUMERIC DEFAULT 20.00;

-- RPC: Validate Promo Code for Waitlist
CREATE OR REPLACE FUNCTION public.validate_promo_code_for_waitlist(
    p_code TEXT,
    p_deposit_amount NUMERIC DEFAULT 20.00
) RETURNS JSONB SECURITY DEFINER AS $$
DECLARE
    v_promo RECORD;
    v_creator RECORD;
    v_discount_pct NUMERIC(5,2) := 20.00;
    v_discount_amt NUMERIC(10,2) := 0.00;
    v_net_amt NUMERIC(10,2) := p_deposit_amount;
    v_clean_code TEXT;
BEGIN
    IF p_code IS NULL OR TRIM(p_code) = '' THEN
        RETURN jsonb_build_object('valid', false, 'message', 'Please enter a valid promotional or creator code.');
    END IF;

    v_clean_code := UPPER(TRIM(p_code));

    SELECT * INTO v_promo
    FROM public.promo_codes
    WHERE UPPER(code) = v_clean_code
    LIMIT 1;

    IF v_promo.id IS NULL THEN
        RETURN jsonb_build_object('valid', false, 'message', 'Creator code not found.');
    END IF;

    IF NOT v_promo.is_active THEN
        RETURN jsonb_build_object('valid', false, 'message', 'This creator code is currently inactive or deactivated.');
    END IF;

    IF v_promo.allow_waitlist_deposits IS FALSE THEN
        RETURN jsonb_build_object('valid', false, 'message', 'This creator code is valid for active market checkouts only, not waitlist deposits.');
    END IF;

    IF v_promo.expires_at IS NOT NULL AND v_promo.expires_at < NOW() THEN
        RETURN jsonb_build_object('valid', false, 'message', 'This creator code has expired.');
    END IF;

    IF v_promo.max_redemptions IS NOT NULL AND v_promo.current_redemptions >= v_promo.max_redemptions THEN
        RETURN jsonb_build_object('valid', false, 'message', 'This creator code has reached its maximum redemption limit.');
    END IF;

    v_discount_pct := COALESCE(v_promo.waitlist_deposit_discount_pct, v_promo.customer_discount_pct, 20.00);
    v_discount_amt := ROUND(p_deposit_amount * (v_discount_pct / 100.0), 2);
    v_net_amt := GREATEST(0.00, p_deposit_amount - v_discount_amt);

    SELECT name, handle INTO v_creator FROM public.creators WHERE id = v_promo.creator_id;

    RETURN jsonb_build_object(
        'valid', true,
        'promo_id', v_promo.id,
        'code', v_promo.code,
        'creator_id', v_promo.creator_id,
        'creator_name', COALESCE(v_creator.name, 'Creator Partner'),
        'creator_handle', v_creator.handle,
        'customer_discount_pct', v_discount_pct,
        'customer_discount_duration_months', COALESCE(v_promo.customer_discount_duration_months, 2),
        'gross_deposit', p_deposit_amount,
        'discount_amount', v_discount_amt,
        'net_deposit_paid', v_net_amt,
        'message', '✓ Creator code ' || v_promo.code || ' applied! ' || v_discount_pct::text || '% off deposit ($' || v_net_amt::text || ' net) + ' || COALESCE(v_promo.customer_discount_duration_months, 2)::text || ' months discount at launch!'
    );
END;
$$ LANGUAGE plpgsql;

-- RPC: Record Waitlist Promo Redemption
CREATE OR REPLACE FUNCTION public.record_waitlist_promo_redemption(
    p_code TEXT,
    p_waitlist_id UUID,
    p_user_uid UUID DEFAULT NULL,
    p_deposit_amount NUMERIC DEFAULT 20.00,
    p_discount_amount NUMERIC DEFAULT 0.00,
    p_net_deposit_paid NUMERIC DEFAULT 20.00
) RETURNS JSONB SECURITY DEFINER AS $$
DECLARE
    v_promo RECORD;
    v_creator RECORD;
    v_clean_code TEXT;
    v_comm_rate NUMERIC(5,2) := 10.00;
    v_comm_amt NUMERIC(10,2) := 0.00;
    v_redemption_id UUID;
BEGIN
    IF p_code IS NULL OR TRIM(p_code) = '' THEN
        RETURN jsonb_build_object('success', false, 'message', 'No creator code provided');
    END IF;

    v_clean_code := UPPER(TRIM(p_code));

    SELECT * INTO v_promo FROM public.promo_codes WHERE UPPER(code) = v_clean_code LIMIT 1;
    IF v_promo.id IS NULL THEN
        RETURN jsonb_build_object('success', false, 'message', 'Promo code not recognized');
    END IF;

    SELECT * INTO v_creator FROM public.creators WHERE id = v_promo.creator_id LIMIT 1;

    v_comm_rate := COALESCE(v_promo.commission_rate_pct, v_creator.default_commission_pct, 10.00);
    v_comm_amt := ROUND(p_net_deposit_paid * (v_comm_rate / 100.0), 2);

    -- Update promo code stats
    UPDATE public.promo_codes 
    SET current_redemptions = COALESCE(current_redemptions, 0) + 1,
        total_revenue_generated = COALESCE(total_revenue_generated, 0.00) + p_net_deposit_paid,
        total_commission_earned = COALESCE(total_commission_earned, 0.00) + v_comm_amt
    WHERE id = v_promo.id;

    -- Update creator stats
    IF v_creator.id IS NOT NULL THEN
        UPDATE public.creators
        SET total_referrals = COALESCE(total_referrals, 0) + 1,
            total_earned = COALESCE(total_earned, 0.00) + v_comm_amt,
            unpaid_balance = COALESCE(unpaid_balance, 0.00) + v_comm_amt
        WHERE id = v_creator.id;
    END IF;

    -- Record in promo_redemptions table
    INSERT INTO public.promo_redemptions (
        promo_code_id,
        creator_id,
        customer_uid,
        invoice_id,
        gross_invoice_amount,
        customer_discount_amount,
        net_paid_amount,
        commission_rate_pct,
        commission_amount,
        commission_month_index,
        commission_eligible,
        payout_status,
        notes
    ) VALUES (
        v_promo.id,
        v_promo.creator_id,
        p_user_uid,
        'WAITLIST-' || COALESCE(p_waitlist_id::text, gen_random_uuid()::text),
        p_deposit_amount,
        p_discount_amount,
        p_net_deposit_paid,
        v_comm_rate,
        v_comm_amt,
        1,
        true,
        'pending',
        'Waitlist Priority Deposit Price Lock: Code ' || v_clean_code
    ) RETURNING id INTO v_redemption_id;

    -- Update waitlist row if ID provided
    IF p_waitlist_id IS NOT NULL THEN
        UPDATE public.waitlist
        SET promo_code = v_clean_code,
            promo_code_id = v_promo.id,
            creator_id = v_promo.creator_id,
            deposit_discount_pct = COALESCE(v_promo.customer_discount_pct, 20.00),
            deposit_discount_amount = p_discount_amount,
            net_deposit_paid = p_net_deposit_paid
        WHERE id = p_waitlist_id;
    END IF;

    RETURN jsonb_build_object(
        'success', true,
        'redemption_id', v_redemption_id,
        'commission_amount', v_comm_amt,
        'net_deposit_paid', p_net_deposit_paid
    );
END;
$$ LANGUAGE plpgsql;
