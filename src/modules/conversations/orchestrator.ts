import { computeMissingFields, questionForMissingField } from '../../domain/booking-rules.js';
import { resolveBookingInterval } from '../../domain/date-resolver.js';
import {
  type AiExtraction,
  type NormalizedMessage,
  type ServiceDefinition,
  type TenantContext,
} from '../../domain/schemas.js';
import { withConversationLock } from '../../infrastructure/database.js';
import { AiExtractor } from '../ai/extractor.js';
import { BookingService, type BookingOperationResult } from '../booking/booking-service.js';
import { TenantRepository } from '../tenants/tenant-repository.js';
import { ConversationRepository } from './conversation-repository.js';

export interface OrchestrationResult {
  reply: string;
  duplicate: boolean;
  handoff: boolean;
  intent: AiExtraction['intent'];
  extraction?: AiExtraction;
  booking?: {
    code?: string;
    status?: string;
    available?: boolean;
  };
}

const textSlotKeys: Array<keyof AiExtraction> = [
  'customer_name',
  'location',
  'service',
  'resource',
  'employee',
  'date',
  'date_expression',
  'end_date',
  'start_time',
  'start_time_expression',
  'end_time',
  'room_type',
  'notes',
  'booking_id',
];

const numberSlotKeys: Array<keyof AiExtraction> = [
  'duration_minutes',
  'party_size',
  'quantity',
];

function mergeKnownSlots(extraction: AiExtraction, slots: Record<string, unknown>): AiExtraction {
  const merged = { ...extraction };
  for (const key of textSlotKeys) {
    if (typeof merged[key] === 'string' && merged[key] === '' && typeof slots[key] === 'string') {
      (merged as Record<string, unknown>)[key] = slots[key];
    }
  }
  for (const key of numberSlotKeys) {
    if (typeof merged[key] === 'number' && merged[key] === 0 && typeof slots[key] === 'number') {
      (merged as Record<string, unknown>)[key] = slots[key];
    }
  }
  return merged;
}

function persistentSlots(extraction: AiExtraction): Record<string, unknown> {
  const slots: Record<string, unknown> = {};
  for (const key of [...textSlotKeys, ...numberSlotKeys]) {
    const value = extraction[key];
    if ((typeof value === 'string' && value) || (typeof value === 'number' && value > 0)) {
      slots[key] = value;
    }
  }
  return slots;
}

function normalize(value: string): string {
  return value
    .toLocaleLowerCase('bs')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim();
}

function selectService(context: TenantContext, requested: string): TenantContext['services'][number] | null {
  if (!requested && context.services.length === 1) return context.services[0];
  const wanted = normalize(requested);
  if (!wanted) return null;
  return (
    context.services.find((service) => normalize(service.name) === wanted) ??
    context.services.find((service) => normalize(service.name).includes(wanted) || wanted.includes(normalize(service.name))) ??
    null
  );
}

function mapService(tenantId: string, service: TenantContext['services'][number], locationId: string | null): ServiceDefinition {
  return {
    id: service.id,
    tenantId,
    locationId,
    name: service.name,
    bookingModel: service.bookingModel,
    defaultDurationMinutes: service.defaultDurationMinutes,
    bufferBeforeMinutes: service.bufferBeforeMinutes,
    bufferAfterMinutes: service.bufferAfterMinutes,
    requiresEmployee: service.requiresEmployee,
    requiresResource: service.requiresResource,
    capacityMode: service.capacityMode,
    configuration: service.configuration,
  };
}

function bookingShape(result: BookingOperationResult): OrchestrationResult['booking'] {
  return {
    code: result.bookingCode,
    status: result.status,
    available: result.available,
  };
}

export class ConversationOrchestrator {
  constructor(
    private readonly tenants = new TenantRepository(),
    private readonly conversations = new ConversationRepository(),
    private readonly ai = new AiExtractor(),
    private readonly bookings = new BookingService(),
  ) {}

  async process(message: NormalizedMessage): Promise<OrchestrationResult> {
    const lockKey = `${message.tenant_id}:${message.channel_id}:${message.customer_external_id}`;
    return withConversationLock(lockKey, async () => {
      const prepared = await this.conversations.prepareInbound(message);
      if (prepared.duplicate) {
        return { reply: '', duplicate: true, handoff: false, intent: 'unknown' };
      }
      if (prepared.status === 'human') {
        return { reply: '', duplicate: false, handoff: true, intent: 'human_handoff' };
      }

      const tenant = await this.tenants.getContext(message.tenant_id);
      let extraction = await this.ai.extract({
        message: message.text,
        phone: message.customer_phone,
        receivedAt: message.received_at,
        tenant,
        history: prepared.history.slice(0, -1),
        knownSlots: prepared.slots,
      });
      extraction = mergeKnownSlots(extraction, prepared.slots);
      await this.conversations.updateCustomerName(message.tenant_id, prepared.customerId, extraction.customer_name);

      let serviceSummary = selectService(tenant, extraction.service || extraction.room_type);
      let service: ServiceDefinition | null = null;
      if (serviceSummary) service = await this.tenants.getService(tenant.tenantId, serviceSummary.id);

      if (extraction.intent === 'reschedule_booking' && !service) {
        const active = await this.bookings.lookupActiveBooking(
          tenant.tenantId,
          prepared.customerId,
          extraction.booking_id,
        );
        if (active) {
          service = await this.tenants.getService(tenant.tenantId, active.serviceId);
          serviceSummary = tenant.services.find((item) => item.id === active.serviceId) ?? null;
          extraction.service = service.name;
          extraction.booking_id = extraction.booking_id || active.bookingCode;
        }
      }

      let result: OrchestrationResult;
      switch (extraction.intent) {
        case 'human_handoff':
        case 'complaint': {
          await this.conversations.openHandoff(
            tenant.tenantId,
            prepared.conversationId,
            extraction.intent === 'complaint' ? 'Žalba korisnika' : 'Korisnik je zatražio zaposlenika',
          );
          result = {
            reply: 'Vašu poruku sam proslijedio zaposleniku. Javit će vam se čim bude dostupan.',
            duplicate: false,
            handoff: true,
            intent: extraction.intent,
            extraction,
          };
          break;
        }
        case 'general_question': {
          result = {
            reply: extraction.reply || 'Molim vas napišite šta vas zanima o našim uslugama.',
            duplicate: false,
            handoff: false,
            intent: extraction.intent,
            extraction,
          };
          break;
        }
        case 'cancel_booking': {
          const operation = await this.bookings.cancelBooking(
            tenant,
            prepared.customerId,
            extraction.booking_id,
            message.event_id,
          );
          const needsHandoff = operation.reply.includes('zaposlenikom');
          if (needsHandoff) {
            await this.conversations.openHandoff(tenant.tenantId, prepared.conversationId, 'Kasno otkazivanje');
          }
          result = {
            reply: operation.reply,
            duplicate: false,
            handoff: needsHandoff,
            intent: extraction.intent,
            extraction,
            booking: bookingShape(operation),
          };
          break;
        }
        case 'confirm_booking': {
          const operation = await this.bookings.confirmBooking(
            tenant,
            prepared.customerId,
            extraction.booking_id,
            message.event_id,
          );
          result = {
            reply: operation.reply,
            duplicate: false,
            handoff: false,
            intent: extraction.intent,
            extraction,
            booking: bookingShape(operation),
          };
          break;
        }
        case 'new_booking':
        case 'check_availability':
        case 'reschedule_booking': {
          if (tenant.services.length === 0) {
            await this.conversations.openHandoff(tenant.tenantId, prepared.conversationId, 'Nema konfigurisanih usluga');
            result = {
              reply: 'Usluge još nisu pravilno konfigurisane. Proslijedio sam poruku zaposleniku.',
              duplicate: false,
              handoff: true,
              intent: extraction.intent,
              extraction,
            };
            break;
          }

          const missing = computeMissingFields(
            extraction,
            service,
            tenant.services.length,
            extraction.intent === 'reschedule_booking'
              ? { ...tenant.bookingPolicy, required_fields: [] }
              : tenant.bookingPolicy,
          );
          extraction.missing_fields = missing;
          extraction.ready_for_availability_check = missing.length === 0;
          if (missing.length > 0 || !service) {
            result = {
              reply: questionForMissingField(missing[0] ?? 'service'),
              duplicate: false,
              handoff: false,
              intent: extraction.intent,
              extraction,
            };
            break;
          }

          if (service.bookingModel === 'service_request') {
            await this.conversations.openHandoff(tenant.tenantId, prepared.conversationId, 'Novi zahtjev za uslugu');
            result = {
              reply: 'Vaš zahtjev je evidentiran i proslijeđen zaposleniku na obradu.',
              duplicate: false,
              handoff: true,
              intent: extraction.intent,
              extraction,
            };
            break;
          }

          const interval = resolveBookingInterval(extraction, service, message.received_at, tenant.timezone);
          if (!interval) {
            result = {
              reply: 'Nisam mogao pouzdano odrediti datum i vrijeme. Molim vas napišite tačan datum i termin.',
              duplicate: false,
              handoff: false,
              intent: extraction.intent,
              extraction,
            };
            break;
          }

          const command = {
            tenant,
            customerId: prepared.customerId,
            service,
            extraction,
            interval,
            idempotencyKey: message.event_id,
          };
          let operation: BookingOperationResult;
          if (extraction.intent === 'check_availability') {
            operation = await this.bookings.checkAvailability(command);
          } else if (extraction.intent === 'reschedule_booking') {
            operation = await this.bookings.rescheduleBooking(command);
          } else {
            operation = await this.bookings.createBooking(command);
          }
          if (operation.bookingCode) extraction.booking_id = operation.bookingCode;
          result = {
            reply: operation.reply,
            duplicate: false,
            handoff: false,
            intent: extraction.intent,
            extraction,
            booking: bookingShape(operation),
          };
          break;
        }
        case 'unknown':
        default: {
          result = {
            reply: 'Nisam potpuno razumio poruku. Možete li je kratko preformulisati ili zatražiti zaposlenika?',
            duplicate: false,
            handoff: false,
            intent: 'unknown',
            extraction,
          };
        }
      }

      const slots = { ...prepared.slots, ...persistentSlots(extraction) };
      await this.conversations.updateState(tenant.tenantId, prepared.conversationId, extraction, slots);
      await this.conversations.recordOutbound(message, prepared.conversationId, result.reply);
      return result;
    });
  }
}

