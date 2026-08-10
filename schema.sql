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
    valet_tote_adder NUMERIC(10,2) DEFAULT 1.00
    staging_rooms INTEGER DEFAULT 2
);

-- Safe migration fallback for pre-existing tables in Supabase
ALTER TABLE public.facilities ADD COLUMN IF NOT EXISTS staging_rooms INTEGER DEFAULT 2;
ALTER TABLE public.facilities ADD COLUMN IF NOT EXISTS tier1_rate NUMERIC(10,2) DEFAULT 5.00;
ALTER TABLE public.facilities ADD COLUMN IF NOT EXISTS tier2_rate NUMERIC(10,2) DEFAULT 3.50;
ALTER TABLE public.facilities ADD COLUMN IF NOT EXISTS tier3_rate NUMERIC(10,2) DEFAULT 2.00;
ALTER TABLE public.facilities ADD COLUMN IF NOT EXISTS tier4_rate NUMERIC(10,2) DEFAULT 1.00;
ALTER TABLE public.facilities ADD COLUMN IF NOT EXISTS valet_base NUMERIC(10,2) DEFAULT 15.00;
ALTER TABLE public.facilities ADD COLUMN IF NOT EXISTS valet_tote_adder NUMERIC(10,2) DEFAULT 1.00;

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
    avatar_color TEXT DEFAULT 'blue',
    created_at TIMESTAMPTZ DEFAULT now() NOT NULL
);

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
    capacity INTEGER DEFAULT 1,
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
    current_period_end TIMESTAMPTZ,
    next_billing_date TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT now() NOT NULL,
    last_updated TIMESTAMPTZ DEFAULT now()
);

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
    email TEXT NOT NULL,
    zip_code TEXT NOT NULL,
    city TEXT,
    requested_totes INTEGER DEFAULT 5,
    deposit_amount NUMERIC(10,2) DEFAULT 25.00,
    price_lock_years INTEGER DEFAULT 5,
    refund_guarantee_days INTEGER DEFAULT 365,
    payment_status TEXT DEFAULT 'deposit_paid',
    created_at TIMESTAMPTZ DEFAULT now()
);

-- Safe migration fallback for pre-existing waitlist tables in Supabase
ALTER TABLE public.waitlist ADD COLUMN IF NOT EXISTS deposit_amount NUMERIC(10,2) DEFAULT 25.00;
ALTER TABLE public.waitlist ADD COLUMN IF NOT EXISTS price_lock_years INTEGER DEFAULT 5;
ALTER TABLE public.waitlist ADD COLUMN IF NOT EXISTS refund_guarantee_days INTEGER DEFAULT 365;
ALTER TABLE public.waitlist ADD COLUMN IF NOT EXISTS payment_status TEXT DEFAULT 'deposit_paid';

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
ALTER TABLE public.cancellations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.charges ENABLE ROW LEVEL SECURITY;
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

CREATE POLICY "Users view own access requests" ON public.access_requests FOR SELECT USING (uid = auth.uid());
CREATE POLICY "Staff view all access requests" ON public.access_requests FOR SELECT USING (public.get_user_role() IN ('warehouse_worker', 'warehouse_manager', 'executive'));

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

-- Generator function for unique structured tote codes (e.g. CV-SEA-49AK)
CREATE OR REPLACE FUNCTION public.generate_tote_code(p_facility_id TEXT)
RETURNS TEXT AS $$
DECLARE
  v_prefix TEXT;
  v_charset TEXT := '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
  v_random_code TEXT;
  v_tote_code TEXT;
  v_exists BOOLEAN;
  v_i INT;
BEGIN
  v_prefix := public.get_facility_prefix(p_facility_id);

  LOOP
    v_random_code := '';
    FOR v_i IN 1..4 LOOP
      v_random_code := v_random_code || substr(v_charset, floor(random() * length(v_charset) + 1)::int, 1);
    END LOOP;

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

  -- Dynamic regional rate & fee calculation from facilities table
  DECLARE
    v_t1 NUMERIC; v_t2 NUMERIC; v_t3 NUMERIC; v_t4 NUMERIC;
    v_vbase NUMERIC; v_vadder NUMERIC;
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
    next_billing_date
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
    now() + interval '30 days'
  );

  -- Set initial tote status based on logistics_type
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

  -- Create inventory items with sequence-based unique tote codes assigned to the user's home facility
  FOR i IN 0..(p_additional_totes - 1) LOOP
    INSERT INTO public.inventory (uid, tote_code, label, status, facility_id)
    VALUES (
      v_uid,
      'CV-' || nextval('public.tote_code_seq'),
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

-- Secure Staging Request with Calendar Date Reservation & Surge Pricing
CREATE OR REPLACE FUNCTION public.request_staging(
  p_tote_ids UUID[],
  p_fulfillment_type TEXT DEFAULT 'staging',
  p_delivery_notes TEXT DEFAULT NULL,
  p_target_date DATE DEFAULT NULL,
  p_time_slot TEXT DEFAULT '09:00 AM - 12:00 PM',
  p_surge_fee NUMERIC DEFAULT 0.00,
  p_surge_tier TEXT DEFAULT 'standard'
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
  );

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
    INSERT INTO public.subscriptions (uid, stripe_subscription_id, total_totes, tote_rate, recurring_storage, logistics_type, valet_fee, first_month_total, status, current_period_end)
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
      now() + interval '30 days'
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

  -- Generate inventory items
  FOR i IN 0..(v_total_totes - 1) LOOP
    INSERT INTO public.inventory (uid, tote_code, label, status, facility_id)
    VALUES (
      v_uid,
      'CV-' || (1000 + i),
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
BEGIN
  v_uid := auth.uid();
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Unauthenticated';
  END IF;

  SELECT role INTO v_user_role FROM public.users WHERE id = v_uid;
  IF v_user_role NOT IN ('warehouse_worker', 'warehouse_manager', 'executive') THEN
    RAISE EXCEPTION 'Access Denied: Staff clearance required';
  END IF;

  SELECT id, tote_code, uid, status, facility_id, activated INTO v_item 
  FROM public.inventory 
  WHERE tote_code = p_tote_code LIMIT 1;

  IF v_item IS NULL THEN
    RAISE EXCEPTION 'Fail-Fast Error: Tote code % not found in system', p_tote_code;
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
  p_target_location TEXT DEFAULT 'STAGE-BAY-A1'
) RETURNS JSONB SECURITY DEFINER AS $$
DECLARE
  v_uid UUID;
  v_user_role public.user_role;
  v_updated_count INT := 0;
BEGIN
  v_uid := auth.uid();
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Unauthenticated';
  END IF;

  SELECT role INTO v_user_role FROM public.users WHERE id = v_uid;
  IF v_user_role NOT IN ('warehouse_worker', 'warehouse_manager', 'executive') THEN
    RAISE EXCEPTION 'Access Denied: Staff clearance required';
  END IF;

  -- Update all pending totes for this customer
  UPDATE public.inventory
  SET status = CASE WHEN status = 'pending-dispatch' THEN 'out-for-delivery'::public.inventory_status ELSE 'staged'::public.inventory_status END,
      location_code = p_target_location,
      location_type = CASE WHEN status = 'pending-dispatch' THEN 'dispatch' ELSE 'staging' END,
      activated = true,
      last_scanned_at = now(),
      last_scanned_by = v_uid
  WHERE uid = p_customer_uid
    AND status IN ('pending-stage', 'pending-dispatch', 'stored');

  GET DIAGNOSTICS v_updated_count = ROW_COUNT;

  -- Update access requests for this customer
  UPDATE public.access_requests
  SET status = 'staged'
  WHERE uid = p_customer_uid AND status = 'pending';

  RETURN jsonb_build_object(
    'success', true,
    'customerUid', p_customer_uid,
    'totesUpdated', v_updated_count,
    'targetLocation', p_target_location
  );
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
  p_expected_status TEXT DEFAULT NULL
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

  SELECT id, status, uid, activated, location_code, location_type INTO v_item 
  FROM public.inventory 
  WHERE tote_code = p_tote_code LIMIT 1;

  IF v_item IS NULL THEN
    RAISE EXCEPTION 'Fail-Fast Error: Tote code % not found in system', p_tote_code;
  END IF;

  -- Look up fulfillment type from active access request
  SELECT ar.fulfillment_type INTO v_fulfillment_type
  FROM public.access_requests ar
  WHERE ar.uid = v_item.uid
    AND ar.status = 'pending'
  ORDER BY ar.requested_at DESC
  LIMIT 1;

  IF v_fulfillment_type IS NOT NULL THEN
    v_has_pending_request := TRUE;
  END IF;

  -- Physical Lifecycle State Transitions:
  -- 1. Activation Step: Un-activated tote -> Lands in Intake Processing Zone (NOT vault!)
  IF v_item.activated = false THEN
    v_next_status := 'pending-stage'::public.inventory_status;
    v_next_location_code := 'INTAKE-PROCESSING';
    v_next_location_type := 'intake';

  -- 2. Vault Slotting or Staging Pull Step
  ELSIF v_item.status = 'pending-stage' THEN
    v_next_status := 'staged'::public.inventory_status;
    v_next_location_code := 'STAGE-BAY-A1';
    v_next_location_type := 'staging';

  ELSIF v_item.status = 'stored' THEN
    IF v_has_pending_request AND v_fulfillment_type = 'valet_delivery' THEN
      v_next_status := 'pending-dispatch'::public.inventory_status;
      v_next_location_code := 'DISPATCH-BAY-1';
      v_next_location_type := 'dispatch';
    ELSE
      v_next_status := 'pending-stage'::public.inventory_status;
      v_next_location_code := 'INTAKE-PULL';
      v_next_location_type := 'intake';
    END IF;

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
    v_next_location_code := COALESCE(v_item.location_code, 'V-A01-S01');
    v_next_location_type := 'vault';

  -- Stored tote requested by customer
  ELSIF v_item.status = 'stored' THEN
    IF v_has_pending_request AND v_fulfillment_type = 'valet_delivery' THEN
      v_next_status := 'pending-dispatch'::public.inventory_status;
      v_next_location_code := 'DISPATCH-BAY-1';
      v_next_location_type := 'dispatch';
    ELSIF v_has_pending_request THEN
      v_next_status := 'pending-stage'::public.inventory_status;
      v_next_location_code := 'VAULT-PULL-BAY';
      v_next_location_type := 'vault';
    ELSE
      v_next_status := 'stored'::public.inventory_status;
      v_next_location_code := COALESCE(v_item.location_code, 'V-A01-S01');
      v_next_location_type := 'vault';
    END IF;

  ELSE
    v_next_status := 'stored'::public.inventory_status;
    v_next_location_code := 'V-A01-S01';
    v_next_location_type := 'vault';
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
BEGIN
  v_uid := auth.uid();
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Unauthenticated';
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
    uid, request_type, fulfillment_type, pin, pin_expires_at, target_date, status
  ) VALUES (
    v_uid, 'cancellation_tote_return', p_fulfillment_type, v_pin, v_expires_at, v_target_date, 'pending'
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
    SELECT zone_type, COALESCE(capacity, 1), identifier
    INTO v_new_zone_type, v_capacity, v_new_identifier
    FROM public.warehouse_locations
    WHERE id = p_new_location_id;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'Target location with ID % not found', p_new_location_id;
    END IF;

    -- Count active totes assigned to target location (excluding current tote if re-slotting)
    SELECT COUNT(*) INTO v_current_count 
    FROM public.inventory 
    WHERE location_id = p_new_location_id AND id != p_tote_id;

    -- Fail-Fast Logic: Check if at or above capacity limit
    IF v_current_count >= v_capacity THEN
      RAISE EXCEPTION 'Location % is already at maximum capacity (%/% totes)', v_new_identifier, v_current_count, v_capacity;
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
    SET is_occupied = (v_old_count >= COALESCE(capacity, 1))
    WHERE id = v_old_location_id;
  END IF;

  -- Recalculate occupation status for new location
  IF p_new_location_id IS NOT NULL THEN
    SELECT COUNT(*) INTO v_current_count FROM public.inventory WHERE location_id = v_new_location_id;
    UPDATE public.warehouse_locations
    SET is_occupied = (v_current_count >= COALESCE(capacity, 1))
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
