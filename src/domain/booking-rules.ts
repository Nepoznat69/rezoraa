import type { AiExtraction, ServiceDefinition } from './schemas.js';

export function computeMissingFields(
  extraction: AiExtraction,
  service: ServiceDefinition | null,
  serviceCount: number,
  tenantPolicy: Record<string, unknown>,
): string[] {
  const missing: string[] = [];
  const requiredByTenant = Array.isArray(tenantPolicy.required_fields)
    ? tenantPolicy.required_fields.filter((value): value is string => typeof value === 'string')
    : ['customer_name'];

  if (requiredByTenant.includes('customer_name') && !extraction.customer_name) {
    missing.push('customer_name');
  }

  if (!service && (serviceCount !== 1 || !extraction.service)) missing.push('service');
  if (!service) return [...new Set(missing)];

  if (service.bookingModel !== 'service_request') {
    if (!extraction.date && !extraction.date_expression) missing.push('date');
  }

  if (service.bookingModel === 'accommodation') {
    if (!extraction.end_date) missing.push('end_date');
    if (service.requiresResource && !extraction.resource && !extraction.room_type) {
      missing.push('room_type');
    }
  } else if (service.bookingModel !== 'service_request') {
    if (!extraction.start_time && !extraction.start_time_expression) missing.push('start_time');
  }

  if (
    ['capacity_slot', 'table_allocation'].includes(service.bookingModel) &&
    extraction.party_size <= 0
  ) {
    missing.push('party_size');
  }

  if (service.requiresEmployee && tenantPolicy.require_employee_selection === true && !extraction.employee) {
    missing.push('employee');
  }

  if (service.requiresResource && tenantPolicy.require_resource_selection === true && !extraction.resource) {
    missing.push('resource');
  }

  return [...new Set(missing)];
}

const fieldQuestions: Record<string, string> = {
  customer_name: 'Na koje ime želite rezervaciju?',
  service: 'Koju uslugu želite rezervisati?',
  date: 'Za koji datum želite rezervaciju?',
  end_date: 'Do kojeg datuma želite rezervaciju?',
  start_time: 'U koliko sati želite termin?',
  party_size: 'Za koliko osoba želite rezervaciju?',
  employee: 'Kojeg zaposlenika ili stručnjaka želite?',
  resource: 'Koji resurs želite rezervisati?',
  room_type: 'Koju vrstu sobe ili smještaja želite?',
  booking_id: 'Možete li poslati broj rezervacije?',
};

export function questionForMissingField(field: string): string {
  return fieldQuestions[field] ?? 'Molim vas navedite podatak koji nedostaje.';
}

