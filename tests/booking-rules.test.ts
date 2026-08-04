import { describe, expect, it } from 'vitest';
import { computeMissingFields } from '../src/domain/booking-rules.js';
import { AiExtractionSchema, type ServiceDefinition } from '../src/domain/schemas.js';

const base = AiExtractionSchema.parse({
  intent: 'new_booking',
  customer_name: '',
  customer_phone: '',
  business_id: '',
  location: '',
  service: 'Masaža',
  resource: '',
  employee: '',
  date: '',
  date_expression: '',
  end_date: '',
  start_time: '',
  start_time_expression: '',
  end_time: '',
  duration_minutes: 0,
  party_size: 0,
  participants: [],
  quantity: 0,
  room_type: '',
  notes: '',
  booking_id: '',
  missing_fields: [],
  ready_for_availability_check: false,
  confidence: 1,
  ambiguities: [],
  reply: '',
});

const appointment: ServiceDefinition = {
  id: 'service',
  tenantId: 'tenant',
  locationId: null,
  name: 'Masaža',
  bookingModel: 'appointment',
  defaultDurationMinutes: 60,
  bufferBeforeMinutes: 0,
  bufferAfterMinutes: 0,
  requiresEmployee: false,
  requiresResource: false,
  capacityMode: 'none',
  configuration: {},
};

describe('obavezna polja određuje backend', () => {
  it('ne vjeruje AI ready zastavici', () => {
    const missing = computeMissingFields(
      { ...base, ready_for_availability_check: true },
      appointment,
      1,
      { required_fields: ['customer_name'] },
    );
    expect(missing).toEqual(['customer_name', 'date', 'start_time']);
  });

  it('za smještaj traži datum odlaska', () => {
    const accommodation = { ...appointment, bookingModel: 'accommodation' as const };
    const missing = computeMissingFields(base, accommodation, 1, { required_fields: [] });
    expect(missing).toContain('end_date');
    expect(missing).not.toContain('start_time');
  });
});
