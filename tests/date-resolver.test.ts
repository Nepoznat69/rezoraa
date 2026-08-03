import { describe, expect, it } from 'vitest';
import { resolveBosnianDate, resolveBosnianTime } from '../src/domain/date-resolver.js';

describe('bosanski izrazi datuma i vremena', () => {
  const reference = '2026-07-13T10:00:00.000Z';

  it('razumije sutra u poslovnoj vremenskoj zoni', () => {
    expect(resolveBosnianDate('sutra', '', reference, 'Europe/Sarajevo')).toBe('2026-07-14');
  });

  it('razumije prekosutra', () => {
    expect(resolveBosnianDate('prekosutra', '', reference, 'Europe/Sarajevo')).toBe('2026-07-15');
  });

  it('deterministički bira sljedeći petak', () => {
    expect(resolveBosnianDate('u petak', '', reference, 'Europe/Sarajevo')).toBe('2026-07-17');
  });

  it('normalizuje vrijeme', () => {
    expect(resolveBosnianTime('u 9:30', '')).toBe('09:30');
  });

  // Zivi kvar: kupac je napisao "sutra u 2", AI je ispravno protumacio 14:00,
  // a spajanje izraza i vremena u "2 14:00" vratilo je 02:00 — sat izvan
  // radnog vremena, pa je bot javio da termin nije slobodan iako je bio.
  it('vjeruje AI-jevom tumacenju sata, a ne goloj cifri iz izraza', () => {
    expect(resolveBosnianTime('2', '14:00')).toBe('14:00');
    expect(resolveBosnianTime('u 2', '14:00')).toBe('14:00');
    expect(resolveBosnianTime('oko 5', '17:00')).toBe('17:00');
  });

  it('pada natrag na izraz kad AI nije vratio sat', () => {
    expect(resolveBosnianTime('u 14:30', '')).toBe('14:30');
    expect(resolveBosnianTime('', 'nije vrijeme')).toBeNull();
  });
});
