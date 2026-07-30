import { DateTime } from 'luxon';
import type { AiExtraction, ServiceDefinition } from './schemas.js';

const weekdays: Record<string, number> = {
  ponedjeljak: 1,
  utorak: 2,
  srijeda: 3,
  sreda: 3,
  cetvrtak: 4,
  petak: 5,
  subota: 6,
  nedjelja: 7,
  nedelja: 7,
};

function normalize(value: string): string {
  return value
    .toLocaleLowerCase('bs')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim();
}

export function resolveBosnianDate(
  expression: string,
  isoCandidate: string,
  referenceIso: string,
  timezone: string,
): string | null {
  const reference = DateTime.fromISO(referenceIso, { zone: timezone });
  if (!reference.isValid) return null;

  const text = normalize(expression);
  if (text.includes('prekosutra')) return reference.plus({ days: 2 }).toISODate();
  if (text.includes('sutra')) return reference.plus({ days: 1 }).toISODate();
  if (text.includes('danas')) return reference.toISODate();

  for (const [name, weekday] of Object.entries(weekdays)) {
    if (!text.includes(name)) continue;
    let days = (weekday - reference.weekday + 7) % 7;
    if (days === 0) days = 7;
    if (text.includes('sljedec') || text.includes('sledec')) days += 7;
    return reference.plus({ days }).toISODate();
  }

  const directIso = text.match(/\b(20\d{2}-\d{2}-\d{2})\b/)?.[1];
  const candidate = directIso || isoCandidate;
  if (!candidate) return null;
  const parsed = DateTime.fromISO(candidate, { zone: timezone });
  return parsed.isValid ? parsed.toISODate() : null;
}

export function resolveBosnianTime(expression: string, candidate: string): string | null {
  const source = `${expression} ${candidate}`.trim();
  const match = source.match(/(?:u\s*)?\b([01]?\d|2[0-3])(?:[:.]([0-5]\d))?\b/i);
  if (!match) return null;
  return `${match[1].padStart(2, '0')}:${(match[2] ?? '00').padStart(2, '0')}`;
}

export interface ResolvedInterval {
  startsAt: Date;
  endsAt: Date;
  localDate: string;
  localStartTime: string;
}

export function resolveBookingInterval(
  extraction: AiExtraction,
  service: ServiceDefinition,
  referenceIso: string,
  timezone: string,
): ResolvedInterval | null {
  const date = resolveBosnianDate(
    extraction.date_expression,
    extraction.date,
    referenceIso,
    timezone,
  );
  if (!date) return null;

  if (service.bookingModel === 'accommodation') {
    const config = service.configuration;
    const checkIn = typeof config.check_in_time === 'string' ? config.check_in_time : '15:00';
    const checkOut = typeof config.check_out_time === 'string' ? config.check_out_time : '11:00';
    const endDate = resolveBosnianDate('', extraction.end_date, referenceIso, timezone);
    if (!endDate) return null;
    const start = DateTime.fromISO(`${date}T${checkIn}`, { zone: timezone });
    const end = DateTime.fromISO(`${endDate}T${checkOut}`, { zone: timezone });
    if (!start.isValid || !end.isValid || end <= start) return null;
    return {
      startsAt: start.toUTC().toJSDate(),
      endsAt: end.toUTC().toJSDate(),
      localDate: date,
      localStartTime: checkIn,
    };
  }

  const startTime = resolveBosnianTime(
    extraction.start_time_expression,
    extraction.start_time,
  );
  if (!startTime) return null;
  const start = DateTime.fromISO(`${date}T${startTime}`, { zone: timezone });
  if (!start.isValid) return null;

  let end: DateTime;
  const explicitEnd = extraction.end_time
    ? DateTime.fromISO(`${date}T${extraction.end_time}`, { zone: timezone })
    : null;
  if (explicitEnd?.isValid && explicitEnd > start) end = explicitEnd;
  else {
    const duration = extraction.duration_minutes || service.defaultDurationMinutes;
    if (duration <= 0) return null;
    end = start.plus({ minutes: duration });
  }

  return {
    startsAt: start.toUTC().toJSDate(),
    endsAt: end.toUTC().toJSDate(),
    localDate: date,
    localStartTime: startTime,
  };
}

