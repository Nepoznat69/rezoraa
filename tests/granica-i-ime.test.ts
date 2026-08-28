/**
 * Testovi za dvije stvari koje je uživo otkrio prvi pravi razgovor.
 *
 * 1. ODBIJENICA ZBOG GRANICE ne smije nuditi druge termine
 *
 *    Core je uredno vratio `tooManyBookings`, šablon je uredno vratio poruku
 *    bez ponude — a kupac je ipak dobio "nije moguće potvrditi, možemo vas
 *    primiti u 11:15, 11:30 ili 11:45". Slobodni termini su išli AI sloju kroz
 *    činjenice, jer se uslov `razlog === 'invalidTime'` nikad nije proširio na
 *    novi razlog. Šablon i činjenice su se razišli, a kupac je vidio ono što
 *    činjenice kažu.
 *
 *    Zato pravilo sada živi u jednoj izvezenoj konstanti, i ovi testovi je
 *    drže punom.
 *
 * 2. RAZLOG mora reći da je stvar u granici
 *
 *    `ljudskiRazlog` nije imao slučaj za `tooManyBookings`, pa je padao na
 *    "taj termin nije moguće potvrditi" — razlog koji zvuči vremenski. Izgovor
 *    je onda po svom pravilu dodao radno vrijeme, i kupac je dobio izmišljeno
 *    objašnjenje: "radimo od 09:00 do 17:00, a zadnji termin koji staje je
 *    16:30" — za termin u 11:15.
 */

import { describe, expect, it } from 'vitest';
import { RAZLOZI_BEZ_ALTERNATIVA, porukaZaOdbijenTermin } from '../src/modules/conversations/poruke.js';
import { ljudskiRazlog } from '../src/modules/conversations/cinjenice.js';

const ZONA = 'Europe/Sarajevo';

const alternative = [
  { startAt: '2026-09-04T09:30:00.000Z', endAt: '2026-09-04T10:00:00.000Z' },
  { startAt: '2026-09-04T09:45:00.000Z', endAt: '2026-09-04T10:15:00.000Z' },
] as unknown as Parameters<typeof porukaZaOdbijenTermin>[1];

describe('odbijenica zbog iscrpljene granice', () => {
  it('razlog je u spisku onih koji ne nude alternative', () => {
    expect(RAZLOZI_BEZ_ALTERNATIVA.has('tooManyBookings')).toBe(true);
    expect(RAZLOZI_BEZ_ALTERNATIVA.has('invalidTime')).toBe(true);
  });

  it('vremenski razlozi i dalje nude alternative', () => {
    for (const razlog of ['staffConflict', 'outsideHours', 'staffUnavailable']) {
      expect(RAZLOZI_BEZ_ALTERNATIVA.has(razlog)).toBe(false);
    }
  });

  it('poruka ne spominje nijedan ponuđeni termin', () => {
    const tekst = porukaZaOdbijenTermin('tooManyBookings', alternative, ZONA);
    expect(tekst).toContain('Već imate zakazano');
    expect(tekst).not.toMatch(/\d{1,2}:\d{2}/);
    expect(tekst.toLowerCase()).not.toContain('slobodno je');
  });

  it('poruka kaže šta kupac MOŽE umjesto toga', () => {
    const tekst = porukaZaOdbijenTermin('tooManyBookings', alternative, ZONA);
    expect(tekst).toMatch(/javite se salonu|pomjerim|otkažem/i);
  });

  it('razlog govori o granici, ne o vremenu', () => {
    const razlog = ljudskiRazlog('tooManyBookings');
    expect(razlog).toMatch(/termina smije zakazati|iskoristio/i);
    // Ovo je bio izvor izmišljenog objašnjenja o radnom vremenu.
    expect(razlog).not.toMatch(/vrijem|radno/i);
  });

  it('vremenski razlozi i dalje govore o vremenu', () => {
    expect(ljudskiRazlog('outsideHours')).toMatch(/radnog vremena/i);
    expect(ljudskiRazlog('invalidTime')).toMatch(/napisano/i);
  });
});
