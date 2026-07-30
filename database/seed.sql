BEGIN;

INSERT INTO tenants (id, name, slug, business_type, timezone, default_language, configuration)
VALUES (
  '00000000-0000-4000-8000-000000000001',
  'Demo univerzalni biznis',
  'demo-univerzalni-biznis',
  'professional_services',
  'Europe/Sarajevo',
  'bs',
  '{"welcome_message":"Dobro došli! Kako vam možemo pomoći?"}'::jsonb
)
ON CONFLICT (id) DO NOTHING;

INSERT INTO booking_policies (
  tenant_id, auto_confirm, hold_minutes, min_advance_minutes, max_advance_days,
  cancellation_notice_minutes, required_fields
)
VALUES (
  '00000000-0000-4000-8000-000000000001', false, 10, 60, 365, 1440,
  ARRAY['customer_name']::text[]
)
ON CONFLICT (tenant_id) DO NOTHING;

INSERT INTO locations (id, tenant_id, name, address)
VALUES (
  '00000000-0000-4000-8000-000000000201',
  '00000000-0000-4000-8000-000000000001',
  'Glavna lokacija',
  'Unesite adresu'
)
ON CONFLICT (id) DO NOTHING;

INSERT INTO channels (
  id, tenant_id, type, name, auth_secret_hash, primary_outbound, configuration
)
VALUES (
  '00000000-0000-4000-8000-000000000101',
  '00000000-0000-4000-8000-000000000001',
  'whatsapp_qr',
  'Demo QR kanal',
  encode(digest('promijeni-qr-token', 'sha256'), 'hex'),
  true,
  '{"client_id":"test-bot"}'::jsonb
)
ON CONFLICT (id) DO NOTHING;

INSERT INTO services (
  id, tenant_id, location_id, name, description, booking_model,
  default_duration_minutes, requires_employee, requires_resource, capacity_mode
)
VALUES (
  '00000000-0000-4000-8000-000000000301',
  '00000000-0000-4000-8000-000000000001',
  '00000000-0000-4000-8000-000000000201',
  'Konsultacije',
  'Demo usluga koju možete zamijeniti uslugama svog biznisa.',
  'appointment',
  60,
  true,
  false,
  'none'
)
ON CONFLICT (id) DO NOTHING;

INSERT INTO employees (id, tenant_id, location_id, name, role_name)
VALUES (
  '00000000-0000-4000-8000-000000000401',
  '00000000-0000-4000-8000-000000000001',
  '00000000-0000-4000-8000-000000000201',
  'Demo stručnjak',
  'Konsultant'
)
ON CONFLICT (id) DO NOTHING;

INSERT INTO service_employees (tenant_id, service_id, employee_id)
VALUES (
  '00000000-0000-4000-8000-000000000001',
  '00000000-0000-4000-8000-000000000301',
  '00000000-0000-4000-8000-000000000401'
)
ON CONFLICT DO NOTHING;

INSERT INTO business_hours (tenant_id, location_id, weekday, opens_at, closes_at)
SELECT
  '00000000-0000-4000-8000-000000000001',
  '00000000-0000-4000-8000-000000000201',
  weekday,
  '08:00'::time,
  '17:00'::time
FROM generate_series(1, 5) AS days(weekday)
WHERE NOT EXISTS (
  SELECT 1 FROM business_hours
  WHERE tenant_id = '00000000-0000-4000-8000-000000000001'
    AND location_id = '00000000-0000-4000-8000-000000000201'
    AND business_hours.weekday = days.weekday
);

INSERT INTO knowledge_items (tenant_id, question, answer)
SELECT
  '00000000-0000-4000-8000-000000000001',
  'Koje je radno vrijeme?',
  'Radimo od ponedjeljka do petka od 08:00 do 17:00.'
WHERE NOT EXISTS (
  SELECT 1 FROM knowledge_items
  WHERE tenant_id = '00000000-0000-4000-8000-000000000001'
    AND question = 'Koje je radno vrijeme?'
);

COMMIT;
