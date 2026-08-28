/**
 * Testovi za razlikovanje "novi termin" od "pomjeri postojeci".
 *
 * ZAŠTO POSTOJE
 *   Uživo se desilo ovo: kupac sa dva termina napiše "može termin utorak u 10",
 *   a asistent odgovori „Imate više termina — napišite broj termina na koji
 *   mislite". Poruka je shvaćena kao pomjeranje, jer su prethodni koraci
 *   razgovora bili o postojećem terminu.
 *
 *   Posljedica nije bezazlena: `nadjiTerminKupca` se zove samo iz `otkazi` i
 *   `pomjeri`, pa pogrešna namjera vodi kupca u tok u kojem se termin mijenja
 *   ili briše, umjesto da dobije novi.
 *
 * ŠTA SE OVDJE ZAISTA TESTIRA
 *   Deterministički parser — put kojim gateway ide kad je OpenAI isključen.
 *   AI put vodi uputstvo u `systemPrompt`, koje se ne da provjeriti bez poziva
 *   modelu; njega provjeravamo uživo. Ovi testovi drže rezervni put ispravnim
 *   i zapisuju pravilo koje uputstvo izriče istim riječima.
 */

import { describe, expect, it, vi } from 'vitest';

const lazniKonfig = vi.hoisted(() => ({
  NODE_ENV: 'test',
  LOG_LEVEL: 'error' as 'debug' | 'info' | 'warn' | 'error',
  // Bez ključa i bez uključenog OpenAI-ja `extract` ide u deterministički put.
  OPENAI_ENABLED: false,
  OPENAI_API_KEY: undefined as string | undefined,
  OPENAI_MODEL: 'gpt-4o-mini',
}));

vi.mock('../src/config.js', () => ({ config: lazniKonfig }));

import { AiExtractor } from '../src/modules/ai/extractor.js';

const tenant = {
  id: '11111111-1111-4111-8111-111111111111',
  name: 'Salon',
  timezone: 'Europe/Sarajevo',
  defaultLanguage: 'bs',
  businessModel: 'appointment',
  services: [{ id: '22222222-2222-4222-8222-222222222222', name: 'Šišanje', durationMinutes: 30 }],
  employees: [],
  resources: [],
  locations: [],
} as unknown as Parameters<AiExtractor['extract']>[0]['tenant'];

/** Razgovor koji je uživo naveo model na krivi trag. */
const historijaOPostojecem = [
  { direction: 'inbound' as const, body: 'Zove jos jedan termin sutra u 7?' },
  { direction: 'outbound' as const, body: 'Već imate termin u subotu, 29.08. u 16:15. Mogu ga pomjeriti ili otkazati.' },
  { direction: 'inbound' as const, body: 'Ne treba samo ovo' },
  { direction: 'outbound' as const, body: 'U redu, termin ostaje kako jeste.' },
];

const razumij = (poruka: string, historija: typeof historijaOPostojecem = []) =>
  new AiExtractor().extract({
    message: poruka,
    phone: '38762000000',
    receivedAt: '2026-08-28T19:00:00.000Z',
    tenant,
    history: historija,
    knownSlots: {},
  });

describe('novi termin naspram pomjeranja', () => {
  it('novi dan i sat su nova rezervacija', async () => {
    const r = await razumij('Moze termin utorak u 10');
    expect(r.intent).toBe('new_booking');
  });

  it('novi dan i sat ostaju nova rezervacija i kad se maloprije pričalo o postojećem', async () => {
    // Ovo je slučaj koji je uživo pao.
    const r = await razumij('Moze termin utorak u 10', historijaOPostojecem);
    expect(r.intent).toBe('new_booking');
  });

  it('"jos jedan termin" je nova rezervacija, ne izmjena', async () => {
    const r = await razumij('Jos jedan termin u petak u 12', historijaOPostojecem);
    expect(r.intent).toBe('new_booking');
  });

  it('pomjeranje traži riječ koja pokazuje na postojeći termin', async () => {
    for (const poruka of ['Pomjeri moj termin na utorak u 10', 'Promijeni termin za utorak']) {
      const r = await razumij(poruka, historijaOPostojecem);
      expect(r.intent).toBe('reschedule_booking');
    }
  });

  it('otkazivanje se i dalje prepoznaje', async () => {
    const r = await razumij('Otkazi moj termin', historijaOPostojecem);
    expect(r.intent).toBe('cancel_booking');
  });

  it('iz poruke se čita dan i sat bez obzira na namjeru', async () => {
    // Rezervni parser traži prijedlog uz dan ("u utorak"). Bez njega dan
    // ostaje neprepoznat — golo "termin utorak" ne hvata. To je poznata
    // granica determinističkog puta; AI put čita i takve poruke.
    const r = await razumij('Moze termin u utorak u 10');
    expect(r.intent).toBe('new_booking');
    expect(r.date_expression).toContain('utorak');
    expect(r.start_time_expression).toContain('10');
  });
});
