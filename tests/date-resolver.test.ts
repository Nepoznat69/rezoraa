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
});
