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
    CREATE TYPE public.user_role AS ENUM ('customer', 'warehouse_worker', 'warehouse_manager', 'executive');
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
    staging_rooms INTEGER DEFAULT 2,
    staging_config JSONB DEFAULT '{"allowed_days": [1,2,3,4,5,6,0], "allowed_slots": ["09:00 AM - 12:00 PM", "12:00 PM - 03:00 PM", "03:00 PM - 06:00 PM"]}'::jsonb
);

-- Safe migration fallback for pre-existing tables in Supabase
ALTER TABLE public.facilities ADD COLUMN IF NOT EXISTS staging_rooms INTEGER DEFAULT 2;
ALTER TABLE public.facilities ADD COLUMN IF NOT EXISTS tier1_rate NUMERIC(10,2) DEFAULT 5.00;
ALTER TABLE public.facilities ADD COLUMN IF NOT EXISTS tier2_rate NUMERIC(10,2) DEFAULT 3.50;
ALTER TABLE public.facilities ADD COLUMN IF NOT EXISTS tier3_rate NUMERIC(10,2) DEFAULT 2.00;
ALTER TABLE public.facilities ADD COLUMN IF NOT EXISTS tier4_rate NUMERIC(10,2) DEFAULT 1.00;
ALTER TABLE public.facilities ADD COLUMN IF NOT EXISTS valet_base NUMERIC(10,2) DEFAULT 15.00;
ALTER TABLE public.facilities ADD COLUMN IF NOT EXISTS valet_tote_adder NUMERIC(10,2) DEFAULT 1.00;
ALTER TABLE public.facilities ADD COLUMN IF NOT EXISTS staging_config JSONB DEFAULT '{"allowed_days": [1,2,3,4,5,6,0], "allowed_slots": ["09:00 AM - 12:00 PM", "12:00 PM - 03:00 PM", "03:00 PM - 06:00 PM"]}'::jsonb;

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
    deposit_paid_amount NUMERIC(10,2) DEFAULT 0.00,
    avatar_color TEXT DEFAULT 'blue',
    is_overdue BOOLEAN DEFAULT false,
    created_at TIMESTAMPTZ DEFAULT now() NOT NULL
);

-- Migration fallbacks for users
ALTER TABLE public.users ADD COLUMN IF NOT EXISTS has_price_lock BOOLEAN DEFAULT false;
ALTER TABLE public.users ADD COLUMN IF NOT EXISTS price_lock_rates JSONB DEFAULT NULL;
ALTER TABLE public.users ADD COLUMN IF NOT EXISTS deposit_paid_amount NUMERIC(10,2) DEFAULT 0.00;
ALTER TABLE public.users ADD COLUMN IF NOT EXISTS is_overdue BOOLEAN DEFAULT false;

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
ALTER TABLE public.subscriptions ADD COLUMN IF NOT EXISTS last_billed_at TIMESTAMPTZ;
ALTER TABLE public.subscriptions ADD COLUMN IF NOT EXISTS next_billing_date TIMESTAMPTZ;
ALTER TABLE public.subscriptions ADD COLUMN IF NOT EXISTS cancel_at TIMESTAMPTZ DEFAULT NULL;

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
    price_lock_years INTEGER DEFAULT 5,
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
ALTER TABLE public.waitlist ADD COLUMN IF NOT EXISTS price_lock_years INTEGER DEFAULT 5;
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
ALTER TABLE public.access_requests ADD COLUMN IF NOT EXISTS tracking_status TEXT DEFAULT 'pending';

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
ALTER TABLE public.invoices DROP CONSTRAINT IF EXISTS invoices_payment_status_check;
ALTER TABLE public.invoices ADD CONSTRAINT invoices_payment_status_check CHECK (payment_status IN ('paid', 'pending', 'overdue', 'failed', 'refunded', 'deposit_received'));

-- Indexes for invoices
CREATE INDEX IF NOT EXISTS idx_invoices_uid ON public.invoices(uid);
CREATE INDEX IF NOT EXISTS idx_invoices_customer_email ON public.invoices(customer_email);
CREATE INDEX IF NOT EXISTS idx_invoices_invoice_number ON public.invoices(invoice_number);
CREATE INDEX IF NOT EXISTS idx_invoices_payment_status ON public.invoices(payment_status);
CREATE INDEX IF NOT EXISTS idx_invoices_created_at ON public.invoices(created_at);

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
CREATE POLICY "Users can view own profile" ON public.users
    FOR SELECT USING (auth.uid() = id);

CREATE POLICY "Users can update own profile" ON public.users
    FOR UPDATE USING (auth.uid() = id) WITH CHECK (auth.uid() = id);

CREATE POLICY "Staff can view all users" ON public.users
    FOR SELECT USING (public.get_user_role() IN ('warehouse_worker', 'warehouse_manager', 'executive'));

-- ------------------------------------------------------------
-- INVENTORY Policies
-- ------------------------------------------------------------
CREATE POLICY "Users view own inventory" ON public.inventory
    FOR SELECT USING (uid = auth.uid());

CREATE POLICY "Staff view all inventory" ON public.inventory
    FOR SELECT USING (public.get_user_role() IN ('warehouse_worker', 'warehouse_manager', 'executive'));

CREATE POLICY "Users update own inventory labels" ON public.inventory
    FOR UPDATE USING (uid = auth.uid());
    
-- ------------------------------------------------------------
-- SUBSCRIPTIONS, CANCELLATIONS, CHARGES, ACCESS_REQUESTS
-- ------------------------------------------------------------
CREATE POLICY "Users view own records" ON public.subscriptions FOR SELECT USING (uid = auth.uid());
CREATE POLICY "Staff view all records" ON public.subscriptions FOR SELECT USING (public.get_user_role() IN ('warehouse_worker', 'warehouse_manager', 'executive'));

CREATE POLICY "Users view own cancellations" ON public.cancellations FOR SELECT USING (uid = auth.uid());
CREATE POLICY "Staff view all cancellations" ON public.cancellations FOR SELECT USING (public.get_user_role() IN ('warehouse_worker', 'warehouse_manager', 'executive'));

CREATE POLICY "Users view own charges" ON public.charges FOR SELECT USING (uid = auth.uid());
CREATE POLICY "Staff view all charges" ON public.charges FOR SELECT USING (public.get_user_role() IN ('warehouse_worker', 'warehouse_manager', 'executive'));

CREATE POLICY "Users view own invoices" ON public.invoices FOR SELECT USING (uid = auth.uid() OR customer_email = auth.email());
CREATE POLICY "Users insert own invoices" ON public.invoices FOR INSERT WITH CHECK (uid = auth.uid() OR auth.uid() IS NOT NULL);
CREATE POLICY "Staff manage all invoices" ON public.invoices FOR ALL USING (public.get_user_role() IN ('warehouse_worker', 'warehouse_manager', 'executive')) WITH CHECK (public.get_user_role() IN ('warehouse_worker', 'warehouse_manager', 'executive'));

CREATE POLICY "Users view own access requests" ON public.access_requests FOR SELECT USING (uid = auth.uid());
CREATE POLICY "Staff view all access requests" ON public.access_requests FOR SELECT USING (public.get_user_role() IN ('warehouse_worker', 'warehouse_manager', 'executive'));

CREATE POLICY "Users view own reservations" ON public.staging_reservations FOR SELECT USING (uid = auth.uid());
CREATE POLICY "Staff view all reservations" ON public.staging_reservations FOR SELECT USING (public.get_user_role() IN ('warehouse_worker', 'warehouse_manager', 'executive'));

CREATE POLICY "Managers update access requests" ON public.access_requests
    FOR UPDATE USING (
        public.get_user_role() = 'executive' OR 
        (public.get_user_role() = 'warehouse_manager' AND facility_id = public.get_user_facility_id())
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

CREATE POLICY "Executives view metadata" ON public.metadata
    FOR SELECT USING (public.get_user_role() = 'executive');

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
CREATE OR REPLACE FUNCTION public.sync_user_active_totes()
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
      WHERE uid = v_uid AND status IN ('stored', 'staged', 'with-customer', 'pending-stage')
    )
    WHERE id = v_uid;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

CREATE OR REPLACE TRIGGER on_inventory_tote_count_change
  AFTER INSERT OR UPDATE OF status, uid OR DELETE ON public.inventory
  FOR EACH ROW EXECUTE PROCEDURE public.sync_user_active_totes();


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

-- Add Totes to Subscription
CREATE OR REPLACE FUNCTION public.add_totes(
  p_additional_totes INT,
  p_logistics_type TEXT
) RETURNS JSONB SECURITY DEFINER AS $$
DECLARE
  v_uid UUID;
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
BEGIN
  v_uid := auth.uid();
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Unauthenticated';
  END IF;

  -- Read current user's assigned facility & active zone
  SELECT assigned_facility_id, active_zone INTO v_facility_id, v_zip
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

    -- Persist resolved assigned_facility_id back to user profile
    UPDATE public.users
    SET assigned_facility_id = v_facility_id
    WHERE id = v_uid;
  END IF;

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

  -- Calculate rate
  IF v_new_total >= 50 THEN v_new_rate := 1.00;
  ELSIF v_new_total >= 25 THEN v_new_rate := 2.00;
  ELSIF v_new_total >= 10 THEN v_new_rate := 3.50;
  ELSE v_new_rate := 5.00;
  END IF;

  v_new_recurring := v_new_total * v_new_rate;
  v_delta := v_new_recurring - COALESCE(v_current_recurring, 0);
  IF p_logistics_type = 'valet_pickup' THEN
    v_valet_fee := 15.00 + (p_additional_totes * 1.00);
  ELSE
    v_valet_fee := 0.00;
  END IF;

  -- Update subscription
  UPDATE public.subscriptions
  SET total_totes = v_new_total,
      tote_rate = v_new_rate,
      recurring_storage = v_new_recurring,
      logistics_type = p_logistics_type,
      last_updated = now()
  WHERE id = v_sub_id;

  -- Create inventory items with facility-tethered scrambled tote codes (e.g. CV-SEA-49AK)
  FOR i IN 0..(p_additional_totes - 1) LOOP
    INSERT INTO public.inventory (uid, tote_code, label, status, facility_id)
    VALUES (
      v_uid,
      public.generate_tote_code(v_facility_id),
      'Additional Tote #' || (COALESCE(v_current_totes, 0) + i + 1),
      (CASE WHEN p_logistics_type = 'valet_pickup' THEN 'with-customer' ELSE 'stored' END)::inventory_status,
      v_facility_id
    );
  END LOOP;

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

  -- If valet, create access request
  IF p_logistics_type = 'valet_pickup' THEN
    v_pin := floor(1000 + random() * 9000)::text;
    v_expires_at := now() + interval '24 hours';
    INSERT INTO public.access_requests (uid, request_type, additional_totes, fulfillment_type, pin, pin_expires_at, valet_fee, facility_id, status)
    VALUES (
      v_uid,
      'new_tote_delivery',
      p_additional_totes,
      'valet_delivery',
      v_pin,
      v_expires_at,
      v_valet_fee,
      v_user_facility,
      'pending'
    );
  END IF;

  RETURN jsonb_build_object(
    'success', true,
    'newTotal', v_new_total,
    'newRate', v_new_rate,
    'newMonthly', v_new_recurring,
    'delta', v_delta,
    'valetFee', v_valet_fee
  );
END;
$$ LANGUAGE plpgsql;

-- Partial Tote Unsubscribe / Reduction Function
CREATE OR REPLACE FUNCTION public.reduce_subscription_totes(
    p_uid UUID,
    p_reduce_count INT
) RETURNS JSONB SECURITY DEFINER AS $$
DECLARE
  v_sub RECORD;
  v_user RECORD;
  v_facility_id TEXT;
  v_current_totes INT;
  v_new_total INT;
  v_t1 NUMERIC; v_t2 NUMERIC; v_t3 NUMERIC; v_t4 NUMERIC;
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
    ELSIF p_location_code ILIKE '%ROOM%' OR p_location_code ILIKE '%STAGE%' OR p_location_code ILIKE '%LOCKER%' THEN
      v_capacity := 1;
    ELSE
      v_capacity := 3;
    END IF;

    SELECT COUNT(*) INTO v_current_count
    FROM public.inventory
    WHERE (location_code = p_location_code OR (v_target_loc.id IS NOT NULL AND location_id = v_target_loc.id))
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
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Unauthenticated';
  END IF;

  SELECT role INTO v_user_role FROM public.users WHERE id = v_uid;
  IF v_user_role NOT IN ('warehouse_worker', 'warehouse_manager', 'executive') THEN
    RAISE EXCEPTION 'Access Denied: Staff clearance required';
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
  p_target_location_code TEXT DEFAULT NULL
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
  v_uid := auth.uid();
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Unauthenticated';
  END IF;

  SELECT role INTO v_user_role FROM public.users WHERE id = v_uid;
  IF v_user_role NOT IN ('warehouse_worker', 'warehouse_manager', 'executive') THEN
    RAISE EXCEPTION 'Access Denied: Staff clearance required';
  END IF;

  SELECT id, status, uid, activated, location_code, location_type, facility_id INTO v_item 
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
      OR v_item.tote_code = ANY(ar.requested_tote_codes)
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
    IF p_target_location_code IS NOT NULL AND p_target_location_code <> '' AND p_target_location_code NOT IN ('CUSTOMER-PREMISES', 'CUSTOMER-DELIVERED', 'VALET-TRUCK-A', 'INTAKE-PROCESSING') THEN
      v_next_location_code := p_target_location_code;
    ELSE
      RAISE EXCEPTION 'Target Location Required: Please scan or set a target shelf/bay location barcode before executing a reshelf.';
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

      IF p_target_location_code IS NOT NULL AND p_target_location_code <> '' THEN
        v_next_location_code := p_target_location_code;
      ELSIF v_item.location_code IS NOT NULL AND v_item.location_code NOT IN ('CUSTOMER-PREMISES', 'CUSTOMER-DELIVERED', 'VALET-TRUCK-A', 'INTAKE-PROCESSING') THEN
        v_next_location_code := v_item.location_code;
      ELSE
        SELECT COALESCE(identifier, location_code) INTO v_next_location_code
        FROM public.warehouse_locations
        WHERE (facility_id = v_item.facility_id OR v_item.facility_id IS NULL)
          AND (zone_type = 'VAULT' OR location_type = 'vault' OR identifier ILIKE 'V-%')
          AND (is_occupied = false OR is_occupied IS NULL)
        ORDER BY created_at ASC
        LIMIT 1;

        IF v_next_location_code IS NULL THEN
          RAISE EXCEPTION 'No Available Warehouse Location: Please scan or set a target shelf/bay barcode, or generate vault locations in Facility Config.';
        END IF;
      END IF;
    END IF;

  ELSE
    v_next_status := 'stored'::public.inventory_status;
    v_next_location_type := 'vault';
    IF p_target_location_code IS NOT NULL AND p_target_location_code <> '' THEN
      v_next_location_code := p_target_location_code;
    ELSE
      SELECT COALESCE(identifier, location_code) INTO v_next_location_code
      FROM public.warehouse_locations
      WHERE (facility_id = v_item.facility_id OR v_item.facility_id IS NULL)
        AND (zone_type = 'VAULT' OR location_type = 'vault' OR identifier ILIKE 'V-%')
        AND (is_occupied = false OR is_occupied IS NULL)
      ORDER BY created_at ASC
      LIMIT 1;

      IF v_next_location_code IS NULL THEN
        RAISE EXCEPTION 'No Available Warehouse Location: Please scan or set a target shelf/bay barcode, or generate vault locations in Facility Config.';
      END IF;
    END IF;
  END IF;

  -- Overwrite with explicit scanned target location if provided
  IF p_target_location_code IS NOT NULL AND p_target_location_code <> '' THEN
    v_next_location_code := p_target_location_code;
    IF p_target_location_code ILIKE 'ROOM-%' OR p_target_location_code ILIKE '%STAGE%' OR p_target_location_code ILIKE '%BAY%' THEN
      v_next_location_type := 'staging';
    ELSE
      v_next_location_type := 'vault';
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
    'nextStatus', v_next_status,
    'locationCode', v_next_location_code,
    'locationType', v_next_location_type,
    'fulfillmentType', v_fulfillment_type,
    'customerUid', v_item.uid
  );
END;
$$ LANGUAGE plpgsql;

-- =========================================================================
-- EVENT 1: TOTE RETURN & VAULT SHELVING HANDLER
-- =========================================================================
CREATE OR REPLACE FUNCTION public.process_tote_return(
  p_tote_code TEXT,
  p_target_location_code TEXT DEFAULT NULL
) RETURNS JSONB SECURITY DEFINER AS $$
DECLARE
  v_uid UUID;
  v_item RECORD;
  v_user_role public.user_role;
  v_assigned_location_code TEXT;
  v_capacity INT := 3;
  v_current_count INT := 0;
  v_target_loc RECORD;
BEGIN
  v_uid := auth.uid();
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Unauthenticated';
  END IF;

  SELECT role INTO v_user_role FROM public.users WHERE id = v_uid;
  IF v_user_role NOT IN ('warehouse_worker', 'warehouse_manager', 'executive') THEN
    RAISE EXCEPTION 'Access Denied: Staff clearance required';
  END IF;

  SELECT id, tote_code, status, uid, location_code, facility_id INTO v_item 
  FROM public.inventory 
  WHERE tote_code = p_tote_code LIMIT 1;

  IF v_item IS NULL THEN
    RAISE EXCEPTION 'Return Error: Tote % not found in inventory system', p_tote_code;
  END IF;

  IF v_item.status NOT IN ('with-customer', 'out-for-delivery', 'stored', 'staged') THEN
    RAISE EXCEPTION 'Return Error: Tote % is in status % and cannot be processed for return', p_tote_code, v_item.status;
  END IF;

  IF p_target_location_code IS NULL OR trim(p_target_location_code) = '' OR p_target_location_code IN ('CUSTOMER-PREMISES', 'CUSTOMER-DELIVERED', 'VALET-TRUCK-A', 'INTAKE-PROCESSING') THEN
    RAISE EXCEPTION 'Target Location Required: Please scan or enter a shelf/bay code before executing a reshelf for tote %.', p_tote_code;
  END IF;

  v_assigned_location_code := trim(p_target_location_code);

  -- Capacity Enforcement Check
  SELECT id, COALESCE(capacity, 3) as capacity INTO v_target_loc
  FROM public.warehouse_locations
  WHERE (facility_id = v_item.facility_id OR v_item.facility_id IS NULL)
    AND (identifier = v_assigned_location_code OR location_code = v_assigned_location_code)
  LIMIT 1;

  IF v_target_loc IS NOT NULL THEN
    v_capacity := v_target_loc.capacity;
  ELSIF v_assigned_location_code ILIKE '%ROOM%' OR v_assigned_location_code ILIKE '%STAGE%' OR v_assigned_location_code ILIKE '%LOCKER%' THEN
    v_capacity := 1;
  ELSE
    v_capacity := 3;
  END IF;

  SELECT COUNT(*) INTO v_current_count
  FROM public.inventory
  WHERE location_code = v_assigned_location_code
    AND status IN ('stored', 'staged', 'pending-stage')
    AND id != v_item.id;

  IF v_current_count >= v_capacity THEN
    RAISE EXCEPTION 'Shelf/Location % is already FULL (%/% totes occupied). Maximum capacity for this location is % totes.', v_assigned_location_code, v_current_count, v_capacity, v_capacity;
  END IF;

  UPDATE public.inventory
  SET status = 'stored'::public.inventory_status,
      location_code = v_assigned_location_code,
      location_type = 'vault',
      activated = true,
      last_scanned_at = now(),
      last_scanned_by = v_uid
  WHERE id = v_item.id;

  IF v_item.location_code IS NOT NULL AND v_item.location_code <> v_assigned_location_code THEN
    UPDATE public.warehouse_locations
    SET is_occupied = false, assigned_tote_id = NULL
    WHERE (identifier = v_item.location_code OR location_code = v_item.location_code)
      AND (facility_id = v_item.facility_id OR v_item.facility_id IS NULL);
  END IF;

  UPDATE public.warehouse_locations
  SET is_occupied = true, assigned_tote_id = v_item.id
  WHERE (identifier = v_assigned_location_code OR location_code = v_assigned_location_code)
    AND (facility_id = v_item.facility_id OR v_item.facility_id IS NULL);

  UPDATE public.access_requests
  SET status = 'completed'
  WHERE uid = v_item.uid AND status = 'pending'
    AND (requested_items IS NULL OR cardinality(requested_items) = 0 OR v_item.id = ANY(requested_items) OR (requested_tote_codes IS NOT NULL AND v_item.tote_code = ANY(requested_tote_codes)));

  RETURN jsonb_build_object(
    'success', true,
    'event', 'TOTE_RETURNED',
    'toteCode', p_tote_code,
    'nextStatus', 'stored',
    'locationCode', v_assigned_location_code,
    'locationType', 'vault',
    'customerUid', v_item.uid,
    'message', 'Tote successfully returned and shelved in vault'
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
  p_target_staging_code TEXT DEFAULT NULL
) RETURNS JSONB SECURITY DEFINER AS $$
DECLARE
  v_uid UUID;
  v_item RECORD;
  v_user_role public.user_role;
  v_next_status public.inventory_status;
  v_next_location_code TEXT;
  v_next_location_type TEXT;
  v_customer_pin TEXT;
BEGIN
  v_uid := auth.uid();
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

  IF v_item.status = 'pending-dispatch' OR p_target_staging_code ILIKE '%TRUCK%' OR p_target_staging_code ILIKE '%DISPATCH%' THEN
    v_next_status := 'out-for-delivery'::public.inventory_status;
    v_next_location_code := COALESCE(p_target_staging_code, 'VALET-TRUCK-A');
    v_next_location_type := 'dispatch';
  ELSE
    v_next_status := 'staged'::public.inventory_status;
    v_next_location_code := COALESCE(p_target_staging_code, 'STAGE-BAY-A1');
    v_next_location_type := 'staging';

    -- Physical Staging Room Occupancy Check: Prevent staging into a room with totes for another customer!
    IF p_target_staging_code IS NOT NULL AND p_target_staging_code <> '' THEN
      IF EXISTS (
        SELECT 1 FROM public.inventory
        WHERE location_code = p_target_staging_code
          AND status IN ('staged', 'pending-stage')
          AND id <> v_item.id
          AND uid <> v_item.uid
      ) THEN
        RAISE EXCEPTION 'Staging Room Conflict: Room % is currently occupied by active totes for another customer! Please select a vacant room.', p_target_staging_code;
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

  SELECT pin INTO v_customer_pin
  FROM public.access_requests
  WHERE uid = v_item.uid AND status = 'pending'
  ORDER BY requested_at DESC LIMIT 1;

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
BEGIN
  -- 1. Verify tote exists and fetch current location
  SELECT location_id, tote_code INTO v_old_location_id, v_tote_code
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

    -- Count active totes assigned to target location or matching identifier (excluding current tote if re-slotting)
    SELECT COUNT(*) INTO v_current_count 
    FROM public.inventory 
    WHERE (location_id = p_new_location_id OR location_code = v_new_identifier) AND id != p_tote_id;

    -- Fail-Fast Logic: Check if at/above capacity limit or if location is marked full (default max 3 totes per shelf)
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
    'totes_at_location', v_current_count,
    'location_capacity', v_capacity
  );
END;
$$ LANGUAGE plpgsql;


-- ─────────────────────────────────────────────────────────────────────
-- run_daily_autopay_billing RPC & pg_cron Schedule
-- ─────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.run_daily_autopay_billing()
RETURNS JSONB SECURITY DEFINER AS $$
DECLARE
  v_sub RECORD;
  v_inv_count INT := 0;
  v_overdue_count INT := 0;
  v_inv_number TEXT;
  v_subtotal NUMERIC;
  v_valet_fee NUMERIC;
  v_total NUMERIC;
BEGIN
  -- 1. Process active subscriptions due for billing (next_billing_date <= CURRENT_DATE or NULL)
  FOR v_sub IN 
    SELECT s.*, u.name AS user_name, u.email AS user_email, u.assigned_facility_id
    FROM public.subscriptions s
    LEFT JOIN public.users u ON s.uid = u.id
    WHERE s.status = 'active' 
      AND (s.next_billing_date IS NULL OR s.next_billing_date <= CURRENT_DATE)
  LOOP
    v_subtotal := COALESCE(v_sub.recurring_storage, v_sub.tote_count * v_sub.tote_rate, 0.00);
    v_valet_fee := COALESCE(v_sub.valet_fee, 0.00);
    v_total := COALESCE(v_sub.monthly_total, v_subtotal + v_valet_fee);
    IF v_total <= 0 AND v_subtotal > 0 THEN
      v_total := v_subtotal;
    END IF;

    -- Generate unique invoice number
    v_inv_number := 'INV-' || TO_CHAR(NOW(), 'YYYY') || '-' || LPAD(FLOOR(RANDOM() * 90000 + 10000)::TEXT, 5, '0');

    -- Insert recurring subscription invoice into public.invoices
    INSERT INTO public.invoices (
      invoice_number,
      uid,
      customer_name,
      customer_email,
      facility_id,
      invoice_type,
      payment_status,
      subtotal,
      delivery_fee,
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
      'subscription',
      'paid',
      v_subtotal,
      v_valet_fee,
      v_total,
      'autopay',
      'AUTOPAY-' || v_sub.id || '-' || TO_CHAR(CURRENT_DATE, 'YYYY-MM-DD'),
      'Automated daily recurring subscription autopay renewal',
      jsonb_build_array(
        jsonb_build_object(
          'description', 'CloudVault Monthly Autopay Storage Subscription (' || COALESCE(v_sub.tote_count, 0) || ' totes @ $' || COALESCE(v_sub.tote_rate, 0) || '/mo)',
          'qty', COALESCE(v_sub.tote_count, 1),
          'unit_price', COALESCE(v_sub.tote_rate, v_subtotal),
          'amount', v_subtotal
        )
      ),
      NOW() + INTERVAL '3 days',
      NOW(),
      NOW()
    );

    -- Update last_billed_at = NOW(), advance next_billing_date = CURRENT_DATE + INTERVAL '1 month'
    UPDATE public.subscriptions
    SET last_billed_at = NOW(),
        next_billing_date = CURRENT_DATE + INTERVAL '1 month',
        last_updated = NOW()
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


