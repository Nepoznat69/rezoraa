/**
 * Testovi za pregled vlastitih termina porukom.
 *
 * Kupac pita "koji su moji termini" i dobija spisak. Dvije stvari se ovdje
 * čuvaju:
 *
 *   1. Spisak mora nositi BROJ termina uz svaki. Bez njega kupac nema čime
 *      pokazati na koji misli kad zatraži pomjeranje ili otkazivanje, a opis
 *      dva termina istog dana ne razlikuje pouzdano.
 *
 *   2. Pitanje "šta ja imam" ne smije se pomiješati sa pitanjem "šta je
 *      slobodno". Prvo je my_bookings, drugo check_availability — a obje
 *      rečenice sadrže riječ "termin".
 */

import { describe, expect, it, vi } from 'vitest';
import { porukaZaMojeTermine } from '../src/modules/conversations/poruke.js';

const ZONA = 'Europe/Sarajevo';

const termin = (kod: string, pocetak: string, usluga = 'Šišanje', ime = '') => ({
  appointmentId: `id-${kod}`,
  kod,
  ime,
  pocetak,
  kraj: pocetak,
  usluga,
  zaposlenik: 'Emir',
});

describe('poruka sa pregledom termina', () => {
  it('kaže kad nema nijednog i odmah nudi izlaz', () => {
    const tekst = porukaZaMojeTermine([], ZONA);
    expect(tekst).toContain('ne vidim nijedan budući termin');
    expect(tekst).toMatch(/recite mi uslugu/i);
  });

  it('jedan termin: dan, sat, usluga i broj', () => {
    const tekst = porukaZaMojeTermine([termin('6SHX9A', '2026-08-29T14:15:00.000Z')], ZONA);
    expect(tekst).toContain('Evo vašeg termina');
    expect(tekst).toContain('u subotu, 29.08. u 16:15');
    expect(tekst).toContain('šišanje');
    expect(tekst).toContain('6SHX9A');
  });

  it('više termina se nabraja, svaki sa svojim brojem', () => {
    const tekst = porukaZaMojeTermine(
      [
        termin('6SHX9A', '2026-08-29T14:15:00.000Z'),
        termin('9SBFTY', '2026-08-31T08:00:00.000Z'),
      ],
      ZONA,
    );
    expect(tekst).toContain('Evo vaših termina');
    expect(tekst).toContain('6SHX9A');
    expect(tekst).toContain('9SBFTY');
    expect(tekst.split('\n').filter((r) => r.startsWith('•'))).toHaveLength(2);
  });

  it('kaže za koga je termin kad nije za onoga ko piše', () => {
    const tekst = porukaZaMojeTermine(
      [termin('KPGEGG', '2026-09-03T07:00:00.000Z', 'Šišanje', 'Amina')],
      ZONA,
    );
    expect(tekst).toContain('Amina:');
  });

  it('staje na pet i kaže koliko ih je ukupno', () => {
    const puno = Array.from({ length: 8 }, (_, i) =>
      termin(`KOD${i}`, `2026-09-0${i + 1}T08:00:00.000Z`),
    );
    const tekst = porukaZaMojeTermine(puno, ZONA);
    expect(tekst.split('\n').filter((r) => r.startsWith('•'))).toHaveLength(5);
    expect(tekst).toContain('ukupno 8');
  });

  it('uputi kupca šta dalje može, i to na oba načina', () => {
    const tekst = porukaZaMojeTermine([termin('6SHX9A', '2026-08-29T14:15:00.000Z')], ZONA);
    expect(tekst).toMatch(/pomjeriti ili otkazati/i);
    // Broj je pouzdan ali ga niko ne pamti; dan pamte svi, i oboje prolazi.
    expect(tekst).toContain('broj termina ili dan');
  });
});

// ---------------------------------------------------------------------------
// Prepoznavanje namjere na rezervnom putu
// ---------------------------------------------------------------------------

const lazniKonfig = vi.hoisted(() => ({
  NODE_ENV: 'test',
  LOG_LEVEL: 'error' as 'debug' | 'info' | 'warn' | 'error',
  OPENAI_ENABLED: false,
  OPENAI_API_KEY: undefined as string | undefined,
  OPENAI_MODEL: 'gpt-4o-mini',
}));

vi.mock('../src/config.js', () => ({ config: lazniKonfig }));

const { AiExtractor } = await import('../src/modules/ai/extractor.js');

const tenant = {
  id: '11111111-1111-4111-8111-111111111111',
  name: 'Salon',
  timezone: ZONA,
  defaultLanguage: 'bs',
  businessModel: 'appointment',
  services: [{ id: '22222222-2222-4222-8222-222222222222', name: 'Šišanje', durationMinutes: 30 }],
  employees: [],
  resources: [],
  locations: [],
} as unknown as Parameters<InstanceType<typeof AiExtractor>['extract']>[0]['tenant'];

const razumij = (poruka: string) =>
  new AiExtractor().extract({
    message: poruka,
    phone: '38762000000',
    receivedAt: '2026-08-28T19:00:00.000Z',
    tenant,
    history: [],
    knownSlots: {},
  });

describe('pitanje "šta ja imam" naspram "šta je slobodno"', () => {
  it('prepoznaje pitanje o vlastitim terminima', async () => {
    for (const poruka of [
      'Koji su moji termini',
      'Kad mi je termin',
      'Imam li nesto zakazano',
      'Jesam li narucen',
    ]) {
      const r = await razumij(poruka);
      expect(r.intent, poruka).toBe('my_bookings');
    }
  });

  it('pitanje o slobodnim terminima ostaje provjera dostupnosti', async () => {
    const r = await razumij('Ima li termin u petak');
    expect(r.intent).toBe('check_availability');
  });

  it('zahtjev za otkazivanjem ostaje otkazivanje', async () => {
    const r = await razumij('Otkazi moj termin');
    expect(r.intent).toBe('cancel_booking');
  });
});
