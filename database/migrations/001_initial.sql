BEGIN;

CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS btree_gist;

CREATE TABLE IF NOT EXISTS schema_migrations (
  version text PRIMARY KEY,
  applied_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE tenants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  slug text NOT NULL UNIQUE,
  business_type text NOT NULL DEFAULT 'other',
  timezone text NOT NULL DEFAULT 'Europe/Sarajevo',
  default_language text NOT NULL DEFAULT 'bs',
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended', 'closed')),
  configuration jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE booking_policies (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL UNIQUE REFERENCES tenants(id) ON DELETE CASCADE,
  auto_confirm boolean NOT NULL DEFAULT false,
  hold_minutes integer NOT NULL DEFAULT 10 CHECK (hold_minutes BETWEEN 1 AND 1440),
  min_advance_minutes integer NOT NULL DEFAULT 0 CHECK (min_advance_minutes >= 0),
  max_advance_days integer NOT NULL DEFAULT 365 CHECK (max_advance_days >= 1),
  cancellation_notice_minutes integer NOT NULL DEFAULT 0 CHECK (cancellation_notice_minutes >= 0),
  required_fields text[] NOT NULL DEFAULT ARRAY['customer_name']::text[],
  require_employee_selection boolean NOT NULL DEFAULT false,
  require_resource_selection boolean NOT NULL DEFAULT false,
  configuration jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE locations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name text NOT NULL,
  address text NOT NULL DEFAULT '',
  timezone text,
  active boolean NOT NULL DEFAULT true,
  configuration jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, name)
);

CREATE TABLE channels (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  type text NOT NULL CHECK (type IN ('whatsapp_qr', 'whatsapp_cloud')),
  name text NOT NULL,
  phone_number text NOT NULL DEFAULT '',
  external_account_id text,
  external_phone_number_id text,
  auth_secret_hash text,
  secret_env_key text,
  primary_outbound boolean NOT NULL DEFAULT true,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive', 'disconnected', 'error')),
  configuration jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id)
);

CREATE UNIQUE INDEX channels_meta_phone_unique
  ON channels (external_phone_number_id)
  WHERE type = 'whatsapp_cloud' AND external_phone_number_id IS NOT NULL;

CREATE TABLE services (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  location_id uuid REFERENCES locations(id) ON DELETE SET NULL,
  name text NOT NULL,
  description text NOT NULL DEFAULT '',
  booking_model text NOT NULL CHECK (booking_model IN (
    'appointment', 'resource_appointment', 'capacity_slot', 'table_allocation',
    'accommodation', 'multi_resource', 'service_request'
  )),
  default_duration_minutes integer NOT NULL DEFAULT 60 CHECK (default_duration_minutes > 0),
  buffer_before_minutes integer NOT NULL DEFAULT 0 CHECK (buffer_before_minutes >= 0),
  buffer_after_minutes integer NOT NULL DEFAULT 0 CHECK (buffer_after_minutes >= 0),
  requires_employee boolean NOT NULL DEFAULT false,
  requires_resource boolean NOT NULL DEFAULT false,
  capacity_mode text NOT NULL DEFAULT 'none' CHECK (capacity_mode IN ('none', 'exclusive', 'pooled')),
  price_minor integer CHECK (price_minor IS NULL OR price_minor >= 0),
  currency char(3),
  active boolean NOT NULL DEFAULT true,
  configuration jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, name)
);

CREATE TABLE employees (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  location_id uuid REFERENCES locations(id) ON DELETE SET NULL,
  name text NOT NULL,
  role_name text NOT NULL DEFAULT '',
  active boolean NOT NULL DEFAULT true,
  configuration jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, name)
);

CREATE TABLE resources (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  location_id uuid REFERENCES locations(id) ON DELETE SET NULL,
  name text NOT NULL,
  resource_type text NOT NULL,
  capacity integer NOT NULL DEFAULT 1 CHECK (capacity > 0),
  exclusive boolean NOT NULL DEFAULT true,
  active boolean NOT NULL DEFAULT true,
  configuration jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, name)
);

CREATE TABLE service_employees (
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  service_id uuid NOT NULL REFERENCES services(id) ON DELETE CASCADE,
  employee_id uuid NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  priority integer NOT NULL DEFAULT 100,
  PRIMARY KEY (service_id, employee_id)
);

CREATE TABLE service_resources (
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  service_id uuid NOT NULL REFERENCES services(id) ON DELETE CASCADE,
  resource_id uuid NOT NULL REFERENCES resources(id) ON DELETE CASCADE,
  quantity_required integer NOT NULL DEFAULT 1 CHECK (quantity_required > 0),
  priority integer NOT NULL DEFAULT 100,
  PRIMARY KEY (service_id, resource_id)
);

CREATE TABLE business_hours (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  location_id uuid REFERENCES locations(id) ON DELETE CASCADE,
  employee_id uuid REFERENCES employees(id) ON DELETE CASCADE,
  resource_id uuid REFERENCES resources(id) ON DELETE CASCADE,
  weekday smallint NOT NULL CHECK (weekday BETWEEN 1 AND 7),
  opens_at time NOT NULL,
  closes_at time NOT NULL,
  active boolean NOT NULL DEFAULT true,
  CHECK (opens_at < closes_at)
);

CREATE INDEX business_hours_lookup
  ON business_hours (tenant_id, weekday, location_id, employee_id, resource_id)
  WHERE active;

CREATE TABLE calendar_exceptions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  location_id uuid REFERENCES locations(id) ON DELETE CASCADE,
  employee_id uuid REFERENCES employees(id) ON DELETE CASCADE,
  resource_id uuid REFERENCES resources(id) ON DELETE CASCADE,
  starts_at timestamptz NOT NULL,
  ends_at timestamptz NOT NULL,
  closed boolean NOT NULL DEFAULT true,
  reason text NOT NULL DEFAULT '',
  capacity_override integer,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (starts_at < ends_at)
);

CREATE TABLE customers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name text NOT NULL DEFAULT '',
  normalized_phone text NOT NULL,
  email text,
  language text NOT NULL DEFAULT 'bs',
  notes text NOT NULL DEFAULT '',
  consent jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, normalized_phone)
);

CREATE TABLE conversations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  channel_id uuid NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  customer_id uuid NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  external_customer_id text NOT NULL,
  status text NOT NULL DEFAULT 'bot' CHECK (status IN ('bot', 'human', 'closed')),
  last_message_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, channel_id, external_customer_id)
);

CREATE TABLE conversation_states (
  conversation_id uuid PRIMARY KEY REFERENCES conversations(id) ON DELETE CASCADE,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  last_intent text NOT NULL DEFAULT 'unknown',
  slots jsonb NOT NULL DEFAULT '{}'::jsonb,
  summary text NOT NULL DEFAULT '',
  version integer NOT NULL DEFAULT 1,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  conversation_id uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  channel_id uuid NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  external_message_id text,
  direction text NOT NULL CHECK (direction IN ('inbound', 'outbound')),
  message_type text NOT NULL DEFAULT 'text',
  body text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT 'received',
  occurred_at timestamptz NOT NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX messages_external_unique
  ON messages (tenant_id, channel_id, external_message_id)
  WHERE external_message_id IS NOT NULL;

CREATE INDEX messages_conversation_timeline
  ON messages (tenant_id, conversation_id, occurred_at DESC);

CREATE TABLE inbound_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  channel_id uuid NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  event_id text NOT NULL,
  external_customer_id text NOT NULL,
  payload jsonb NOT NULL,
  status text NOT NULL DEFAULT 'received' CHECK (status IN ('received', 'processing', 'completed', 'failed')),
  attempts integer NOT NULL DEFAULT 0,
  available_at timestamptz NOT NULL DEFAULT now(),
  last_error text,
  received_at timestamptz NOT NULL DEFAULT now(),
  processed_at timestamptz,
  UNIQUE (tenant_id, channel_id, event_id)
);

CREATE INDEX inbound_events_worker
  ON inbound_events (status, available_at, received_at)
  WHERE status IN ('received', 'failed');

CREATE TABLE bookings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  booking_code text NOT NULL,
  customer_id uuid NOT NULL REFERENCES customers(id) ON DELETE RESTRICT,
  service_id uuid NOT NULL REFERENCES services(id) ON DELETE RESTRICT,
  location_id uuid REFERENCES locations(id) ON DELETE SET NULL,
  starts_at timestamptz NOT NULL,
  ends_at timestamptz NOT NULL,
  timezone text NOT NULL,
  status text NOT NULL CHECK (status IN (
    'draft', 'held', 'pending', 'pending_approval', 'confirmed', 'rejected',
    'cancelled', 'rescheduled', 'completed', 'no_show', 'expired'
  )),
  party_size integer NOT NULL DEFAULT 1 CHECK (party_size >= 0),
  quantity integer NOT NULL DEFAULT 1 CHECK (quantity > 0),
  notes text NOT NULL DEFAULT '',
  source text NOT NULL DEFAULT 'whatsapp',
  hold_expires_at timestamptz,
  predecessor_booking_id uuid REFERENCES bookings(id) ON DELETE SET NULL,
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (starts_at < ends_at),
  UNIQUE (tenant_id, booking_code)
);

CREATE INDEX bookings_customer_future
  ON bookings (tenant_id, customer_id, starts_at)
  WHERE status IN ('held', 'pending', 'pending_approval', 'confirmed');

CREATE TABLE booking_allocations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  booking_id uuid NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
  allocatable_type text NOT NULL CHECK (allocatable_type IN ('employee', 'resource')),
  allocatable_id uuid NOT NULL,
  starts_at timestamptz NOT NULL,
  ends_at timestamptz NOT NULL,
  slot tstzrange GENERATED ALWAYS AS (tstzrange(starts_at, ends_at, '[)')) STORED,
  quantity integer NOT NULL DEFAULT 1 CHECK (quantity > 0),
  exclusive boolean NOT NULL DEFAULT true,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (starts_at < ends_at)
);

ALTER TABLE booking_allocations
  ADD CONSTRAINT booking_allocations_no_exclusive_overlap
  EXCLUDE USING gist (
    tenant_id WITH =,
    allocatable_type WITH =,
    allocatable_id WITH =,
    slot WITH &&
  ) WHERE (active AND exclusive);

CREATE INDEX booking_allocations_capacity_lookup
  ON booking_allocations (tenant_id, allocatable_type, allocatable_id, starts_at, ends_at)
  WHERE active;

CREATE TABLE booking_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  booking_id uuid NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
  event_type text NOT NULL,
  actor_type text NOT NULL DEFAULT 'system',
  actor_id text,
  idempotency_key text,
  old_values jsonb NOT NULL DEFAULT '{}'::jsonb,
  new_values jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX booking_events_idempotency
  ON booking_events (tenant_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

CREATE TABLE human_handoff_cases (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  conversation_id uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'assigned', 'resolved', 'closed')),
  reason text NOT NULL DEFAULT '',
  assigned_to text,
  opened_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz
);

CREATE TABLE outbox_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  channel_id uuid NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  conversation_id uuid REFERENCES conversations(id) ON DELETE SET NULL,
  destination text NOT NULL,
  message_type text NOT NULL DEFAULT 'text',
  payload jsonb NOT NULL,
  idempotency_key text NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sending', 'sent', 'failed', 'dead')),
  attempts integer NOT NULL DEFAULT 0,
  available_at timestamptz NOT NULL DEFAULT now(),
  last_error text,
  external_message_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  sent_at timestamptz,
  UNIQUE (tenant_id, idempotency_key)
);

CREATE TABLE knowledge_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  question text NOT NULL,
  answer text NOT NULL,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE audit_logs (
  id bigserial PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  correlation_id text,
  action text NOT NULL,
  entity_type text NOT NULL,
  entity_id text,
  actor_type text NOT NULL DEFAULT 'system',
  actor_id text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE OR REPLACE FUNCTION expire_booking_holds()
RETURNS integer
LANGUAGE plpgsql
AS $$
DECLARE
  affected integer;
BEGIN
  WITH expired AS (
    UPDATE bookings
       SET status = 'expired', updated_at = now(), version = version + 1
     WHERE status = 'held'
       AND hold_expires_at IS NOT NULL
       AND hold_expires_at <= now()
    RETURNING id
  )
  UPDATE booking_allocations allocation
     SET active = false
    FROM expired
   WHERE allocation.booking_id = expired.id;

  GET DIAGNOSTICS affected = ROW_COUNT;
  RETURN affected;
END;
$$;

DO $$
DECLARE
  table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'booking_policies', 'locations', 'channels', 'services', 'employees', 'resources',
    'service_employees', 'service_resources', 'business_hours', 'calendar_exceptions',
    'customers', 'conversations', 'conversation_states', 'messages', 'inbound_events',
    'bookings', 'booking_allocations', 'booking_events', 'human_handoff_cases',
    'outbox_messages', 'knowledge_items', 'audit_logs'
  ]
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I USING (tenant_id = nullif(current_setting(''app.tenant_id'', true), '''')::uuid)',
      table_name
    );
  END LOOP;
END;
$$;

COMMIT;

