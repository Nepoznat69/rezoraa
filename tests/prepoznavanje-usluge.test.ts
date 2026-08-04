/**
 * Testovi za prepoznavanje usluge iz kupčeve riječi.
 *
 * Živi kvar: kupac je napisao "ja sisanje i brijanja", a asistent je odgovorio
 * "brijanja nažalost ne radimo" — iako salon radi brijanje. Poređenje cijelih
 * riječi je promašivalo padež, a u razgovoru se to vidi kao odbijanje usluge
 * koja postoji.
 */

import { describe, expect, it } from 'vitest';
import { selectService } from '../src/modules/conversations/orchestrator.js';
import type { TenantContext } from '../src/domain/schemas.js';

function usluga(name: string) {
  return {
    id: `id-${name}`,
    name,
    bookingModel: 'appointment' as const,
    defaultDurationMinutes: 30,
    bufferBeforeMinutes: 0,
    bufferAfterMinutes: 0,
    requiresEmployee: true,
    requiresResource: false,
    capacityMode: 'none' as const,
    configuration: {},
  };
}

const SALON = {
  services: [usluga('Šišanje'), usluga('Farbanje'), usluga('Brijanje')],
} as unknown as TenantContext;

describe('usluga u padežu', () => {
  const slucajevi: Array<[string, string]> = [
    ['brijanja', 'Brijanje'],
    ['brijanje', 'Brijanje'],
    ['sisanja', 'Šišanje'],
    ['sisanje', 'Šišanje'],
    ['farbanja', 'Farbanje'],
    ['farbanju', 'Farbanje'],
  ];

  for (const [rekao, ocekivano] of slucajevi) {
    it(`"${rekao}" je ${ocekivano}`, () => {
      expect(selectService(SALON, rekao)?.name).toBe(ocekivano);
    });
  }

  it('tačan naziv i dalje ima prednost', () => {
    expect(selectService(SALON, 'Šišanje')?.name).toBe('Šišanje');
  });

  // Usluga koju salon nema mora ostati neprepoznata, inace bi se kupcu
  // potvrdilo nešto što se ne radi.
  it('usluga koju salon ne radi ostaje neprepoznata', () => {
    expect(selectService(SALON, 'feniranje')).toBeNull();
    expect(selectService(SALON, 'manikir')).toBeNull();
  });

  it('kratka riječ ne pogađa uslugu preko korijena', () => {
    expect(selectService(SALON, 'ša')).toBeNull();
  });

  it('bez tražene usluge i sa jednom uslugom bira nju', () => {
    const jedna = { services: [usluga('Šišanje')] } as unknown as TenantContext;
    expect(selectService(jedna, '')?.name).toBe('Šišanje');
  });
});
