import { z } from 'zod';

export const intentValues = [
  'new_booking',
  'check_availability',
  'reschedule_booking',
  'cancel_booking',
  'confirm_booking',
  'human_handoff',
  'general_question',
  'complaint',
  'unknown',
] as const;

export const AiExtractionSchema = z.object({
  intent: z.enum(intentValues),
  customer_name: z.string(),
  customer_phone: z.string(),
  business_id: z.string(),
  location: z.string(),
  service: z.string(),
  resource: z.string(),
  employee: z.string(),
  date: z.string(),
  date_expression: z.string(),
  end_date: z.string(),
  start_time: z.string(),
  start_time_expression: z.string(),
  end_time: z.string(),
  duration_minutes: z.number().int().nonnegative(),
  party_size: z.number().int().nonnegative(),
  quantity: z.number().int().nonnegative(),
  room_type: z.string(),
  notes: z.string(),
  booking_id: z.string(),
  missing_fields: z.array(z.string()),
  ready_for_availability_check: z.boolean(),
  confidence: z.number().min(0).max(1),
  ambiguities: z.array(z.string()),
  reply: z.string(),
});

export type AiExtraction = z.infer<typeof AiExtractionSchema>;

import type { PostavkeAsistenta } from '../modules/core-api/core-klijent.js';
export type { PostavkeAsistenta };

export const NormalizedMessageSchema = z.object({
  event_id: z.string().min(1).max(255),
  /**
   * Identifikator biznisa u Rezora Coreu. Core je sistem evidencije; gateway
   * više nema vlastite tenante, pa ovdje stoji `business_id` iz Corea.
   */
  business_id: z.string().uuid(),
  channel_id: z.string().uuid(),
  channel_type: z.enum(['whatsapp_qr', 'whatsapp_cloud']),
  external_message_id: z.string().min(1).max(255),
  customer_external_id: z.string().min(1).max(255),
  customer_phone: z.string().min(3).max(64),
  message_type: z
    .enum(['text', 'image', 'audio', 'video', 'document', 'interactive', 'location', 'unknown'])
    .default('text'),
  text: z.string().max(10_000).default(''),
  received_at: z.string().datetime(),
  metadata: z.record(z.string(), z.unknown()).default({}),
});

export type NormalizedMessage = z.infer<typeof NormalizedMessageSchema>;

/**
 * Oblik konteksta koji očekuje AI sloj (src/modules/ai/extractor.ts).
 *
 * Naziv je istorijski: gateway više nema tenante, nego biznise iz Rezora Corea.
 * `tenantId` je danas `business_id` iz Corea, a puni ga
 * src/modules/core-kontekst/kontekst.ts. Ime polja je namjerno ostavljeno da se
 * AI sloj ne dira.
 */
export interface TenantContext {
  tenantId: string;
  businessName: string;
  businessType: string;
  timezone: string;
  language: string;
  bookingPolicy: Record<string, unknown>;
  services: Array<{
    id: string;
    name: string;
    bookingModel: BookingModel;
    defaultDurationMinutes: number;
    bufferBeforeMinutes: number;
    bufferAfterMinutes: number;
    requiresEmployee: boolean;
    requiresResource: boolean;
    capacityMode: 'none' | 'exclusive' | 'pooled';
    configuration: Record<string, unknown>;
  }>;
  employees: Array<{ id: string; name: string }>;
  resources: Array<{ id: string; name: string; type: string; capacity: number }>;
  knowledge: Array<{ question: string; answer: string }>;
  /** Kako se asistent ponasa kod ovog klijenta (Postavke -> Asistent). */
  postavke: PostavkeAsistenta;
  /**
   * Radno vrijeme osoblja iz Corea (`working_hours` u internom ugovoru).
   *
   * Bez ovoga asistent ne zna do kada se radi, pa ne može reći ni najobičniju
   * stvar koju kupac pita: "radimo do 17:00, zadnji termin je u 16:40".
   * Vrijeme je lokalno za salon, `weekday` je 0 = nedjelja, kao u ugovoru.
   */
  workingHours: Array<{
    staffMemberId: string;
    weekday: number;
    /** "09:00" u vremenskoj zoni salona. */
    startTime: string;
    /** "17:00" u vremenskoj zoni salona. */
    endTime: string;
  }>;
}

export type BookingModel =
  | 'appointment'
  | 'resource_appointment'
  | 'capacity_slot'
  | 'table_allocation'
  | 'accommodation'
  | 'multi_resource'
  | 'service_request';

export interface ServiceDefinition {
  id: string;
  tenantId: string;
  locationId: string | null;
  name: string;
  bookingModel: BookingModel;
  defaultDurationMinutes: number;
  bufferBeforeMinutes: number;
  bufferAfterMinutes: number;
  requiresEmployee: boolean;
  requiresResource: boolean;
  capacityMode: 'none' | 'exclusive' | 'pooled';
  configuration: Record<string, unknown>;
}
