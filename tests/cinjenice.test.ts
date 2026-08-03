/**
 * Testovi za src/modules/conversations/cinjenice.ts
 *
 * Činjenice su jedino što AI sloj vidi. Ako se ovdje pojavi sat koji backend
 * nije dao, bot će ga izgovoriti kupcu — zato se ovdje provjerava i ono što
 * činjenice NE smiju sadržavati.
 *
 * Modul je čist: nema mreže, baze ni mockova.
 */

import { describe, expect, it } from 'vitest';
import type { TenantContext } from '../src/domain/schemas.js';
import {
  RAZLOZI_TERMINA,
  type SlobodanTermin,
} from '../src/modules/core-api/core-klijent.js';
import {
  danUSedmici,
  ljudskiNazivPodatka,
  ljudskiRazlog,
  opisRadnogVremena,
  radnoVrijemeZaDan,
  sastaviCinjenice,
  uMinute,
  uSat,
  zadnjiMoguciTermin,
} from '../src/modules/conversations/cinjenice.js';

const ZONA = 'Europe/Sarajevo';
const ANA = '33333333-3333-4333-8333-333333333333';
const BEBA = '44444444-4444-4444-8444-444444444444';
/** Srijeda. */
const DATUM = '2026-08-05';
const SRIJEDA = 3;

function salon(izmjene: Partial<TenantContext> = {}): TenantContext {
  return {
    tenantId: '11111111-1111-4111-8111-111111111111',
    businessName: 'Salon Ana',
    businessType: 'hair_salon',
    timezone: ZONA,
    language: 'bs',
    bookingPolicy: {},
    services: [],
    employees: [{ id: ANA, name: 'Ana' }],
    resources: [],
    knowledge: [],
    workingHours: [
      { staffMemberId: ANA, weekday: SRIJEDA, startTime: '09:00', endTime: '17:00' },
    ],
    ...izmjene,
  };
}

function termin(startAt: string, endAt: string, staffMemberId = ANA): SlobodanTermin {
  return { startAt, endAt, staffMemberId };
}

/** 09:00, 10:15 i 13:00 po vremenu salona. */
const SLOBODNI: SlobodanTermin[] = [
  termin('2026-08-05T07:00:00.000Z', '2026-08-05T07:45:00.000Z'),
  termin('2026-08-05T08:15:00.000Z', '2026-08-05T09:00:00.000Z'),
  termin('2026-08-05T11:00:00.000Z', '2026-08-05T11:45:00.000Z'),
];

const SISANJE = { naziv: 'Šišanje', trajanjeMinuta: 45 };

describe('sati i minute', () => {
  it('čita i vraća sat u istom obliku', () => {
    expect(uMinute('09:30')).toBe(570);
    expect(uMinute('09:30:00')).toBe(570);
    expect(uSat(570)).toBe('09:30');
    expect(uSat(0)).toBe('00:00');
  });

  it('ne prihvata nešto što nije sat', () => {
    expect(uMinute('devet')).toBeNull();
    expect(uMinute('')).toBeNull();
    expect(uMinute('25:00')).toBeNull();
    expect(uMinute('09:75')).toBeNull();
  });
});

describe('zadnjiMoguciTermin', () => {
  const RADNO = { pocetak: '09:00', kraj: '17:00' };

  it('računa kad počinje zadnji termin koji još stane u dan', () => {
    expect(zadnjiMoguciTermin(RADNO, 20)).toBe('16:40');
    expect(zadnjiMoguciTermin(RADNO, 45)).toBe('16:15');
    expect(zadnjiMoguciTermin(RADNO, 60)).toBe('16:00');
    expect(zadnjiMoguciTermin(RADNO, 90)).toBe('15:30');
  });

  it('radi i za druga radna vremena', () => {
    expect(zadnjiMoguciTermin({ pocetak: '08:30', kraj: '16:00' }, 90)).toBe('14:30');
    expect(zadnjiMoguciTermin({ pocetak: '12:00', kraj: '20:00' }, 30)).toBe('19:30');
    expect(zadnjiMoguciTermin({ pocetak: '07:15', kraj: '15:45' }, 25)).toBe('15:20');
  });

  it('usluga koja tačno popuni dan počinje na otvaranju', () => {
    expect(zadnjiMoguciTermin(RADNO, 480)).toBe('09:00');
  });

  it('usluga koja ne stane u radno vrijeme nema zadnji termin', () => {
    expect(zadnjiMoguciTermin(RADNO, 481)).toBeNull();
    expect(zadnjiMoguciTermin(RADNO, 600)).toBeNull();
    expect(zadnjiMoguciTermin({ pocetak: '09:00', kraj: '09:30' }, 45)).toBeNull();
  });

  it('besmislen ulaz ne izmišlja sat', () => {
    expect(zadnjiMoguciTermin(RADNO, 0)).toBeNull();
    expect(zadnjiMoguciTermin(RADNO, -30)).toBeNull();
    expect(zadnjiMoguciTermin(RADNO, Number.NaN)).toBeNull();
    expect(zadnjiMoguciTermin({ pocetak: 'ujutro', kraj: '17:00' }, 30)).toBeNull();
    expect(zadnjiMoguciTermin({ pocetak: '17:00', kraj: '09:00' }, 30)).toBeNull();
  });
});

describe('radno vrijeme dana', () => {
  it('spaja smjene svih koji tog dana rade', () => {
    const radno = radnoVrijemeZaDan(
      [
        { staffMemberId: ANA, weekday: SRIJEDA, startTime: '09:00', endTime: '15:00' },
        { staffMemberId: BEBA, weekday: SRIJEDA, startTime: '12:00', endTime: '20:00' },
        { staffMemberId: BEBA, weekday: 4, startTime: '06:00', endTime: '22:00' },
      ],
      SRIJEDA,
    );

    expect(radno).toEqual({ pocetak: '09:00', kraj: '20:00' });
    expect(radno && opisRadnogVremena(radno)).toBe('09:00–20:00');
  });

  it('za imenovanog zaposlenika gleda samo njegovu smjenu', () => {
    const radno = radnoVrijemeZaDan(
      [
        { staffMemberId: ANA, weekday: SRIJEDA, startTime: '09:00', endTime: '15:00' },
        { staffMemberId: BEBA, weekday: SRIJEDA, startTime: '12:00', endTime: '20:00' },
      ],
      SRIJEDA,
      ANA,
    );

    expect(radno).toEqual({ pocetak: '09:00', kraj: '15:00' });
  });

  it('dan u kojem niko ne radi nema radno vrijeme', () => {
    expect(radnoVrijemeZaDan([], SRIJEDA)).toBeNull();
    expect(
      radnoVrijemeZaDan(
        [{ staffMemberId: ANA, weekday: 0, startTime: '09:00', endTime: '17:00' }],
        SRIJEDA,
      ),
    ).toBeNull();
  });

  it('neispravan red iz Corea se preskače, ne izmišlja', () => {
    expect(
      radnoVrijemeZaDan(
        [
          { staffMemberId: ANA, weekday: SRIJEDA, startTime: 'x', endTime: '17:00' },
          { staffMemberId: BEBA, weekday: SRIJEDA, startTime: '17:00', endTime: '09:00' },
        ],
        SRIJEDA,
      ),
    ).toBeNull();
  });

  it('datum prevodi u dan u sedmici po ugovoru (0 = nedjelja)', () => {
    expect(danUSedmici('2026-08-05', ZONA)).toBe(3);
    expect(danUSedmici('2026-08-09', ZONA)).toBe(0);
    expect(danUSedmici('nije-datum', ZONA)).toBeNull();
  });
});

describe('tehnički pojmovi ne izlaze iz Corea', () => {
  it('svaki razlog 409 postaje ljudska rečenica', () => {
    for (const razlog of [...RAZLOZI_TERMINA, 'nepoznato'] as const) {
      const ljudski = ljudskiRazlog(razlog);
      expect(ljudski.length).toBeGreaterThan(10);
      for (const tehnicki of RAZLOZI_TERMINA) {
        expect(ljudski).not.toContain(tehnicki);
      }
    }
  });

  it('polja koja fale imenuje riječima kupca', () => {
    expect(ljudskiNazivPodatka('start_time')).toBe('sat');
    expect(ljudskiNazivPodatka('customer_name')).not.toContain('customer');
    expect(ljudskiNazivPodatka('nepostojece_polje')).not.toContain('_');
  });
});

describe('sastaviCinjenice', () => {
  it('ponuda nosi dan, radno vrijeme, uslugu i zadnji mogući termin', () => {
    const cinjenice = sastaviCinjenice({
      vrsta: 'ponuda',
      tenant: salon(),
      datum: DATUM,
      usluga: SISANJE,
      slobodni: SLOBODNI,
    });

    expect(cinjenice.vrsta).toBe('ponuda');
    expect(cinjenice.salon).toBe('Salon Ana');
    expect(cinjenice.dan).toBe('u srijedu, 05.08.');
    expect(cinjenice.radnoVrijeme).toBe('09:00–17:00');
    expect(cinjenice.usluga).toBe('Šišanje');
    expect(cinjenice.trajanjeMinuta).toBe(45);
    // Radi se do 17:00, a šišanje traje 45 minuta.
    expect(cinjenice.zadnjiMoguciTermin).toBe('16:15');
    expect(cinjenice.slobodniTermini).toEqual(['09:00', '10:15', '13:00']);
  });

  it('bez slobodnih termina ne nudi nijedan sat', () => {
    const cinjenice = sastaviCinjenice({
      vrsta: 'nema_termina',
      tenant: salon(),
      datum: DATUM,
      usluga: SISANJE,
      slobodni: [],
    });

    expect(cinjenice.slobodniTermini).toEqual([]);
    expect(cinjenice.zadnjiMoguciTermin).toBe('16:15');
  });

  it('kad kupac traži popodne, a ima samo ujutro, to se kaže', () => {
    const cinjenice = sastaviCinjenice({
      vrsta: 'ponuda',
      tenant: salon(),
      datum: DATUM,
      usluga: SISANJE,
      slobodni: [SLOBODNI[0], SLOBODNI[1]],
      zelja: { odMinuta: 12 * 60, doba: 'popodne' },
    });

    expect(cinjenice.trazenoNijeSlobodno).toBe(true);
    expect(cinjenice.trazio?.dobaDana).toBe('popodne');
    expect(cinjenice.slobodniTermini).toEqual(['09:00', '10:15']);
  });

  it('nudi samo termine iz onoga što je Core vratio', () => {
    const cinjenice = sastaviCinjenice({
      vrsta: 'ponuda',
      tenant: salon(),
      datum: DATUM,
      usluga: SISANJE,
      slobodni: [SLOBODNI[2]],
      zelja: { kasnije: true, doba: 'kasnije' },
    });

    expect(cinjenice.slobodniTermini).toEqual(['13:00']);
  });

  it('salon koji tog dana ne radi nema ni radno vrijeme ni zadnji termin', () => {
    const cinjenice = sastaviCinjenice({
      vrsta: 'ponuda',
      tenant: salon({ workingHours: [] }),
      datum: DATUM,
      usluga: SISANJE,
      slobodni: SLOBODNI,
    });

    expect(cinjenice.radnoVrijeme).toBeUndefined();
    expect(cinjenice.zadnjiMoguciTermin).toBeUndefined();
  });

  it('potvrđen termin nosi tačno vrijeme koje je Core prihvatio', () => {
    const cinjenice = sastaviCinjenice({
      vrsta: 'zakazano',
      tenant: salon(),
      datum: DATUM,
      usluga: SISANJE,
      terminUtc: '2026-08-05T07:00:00.000Z',
    });

    expect(cinjenice.termin).toBe('u srijedu, 05.08. u 09:00');
    expect(cinjenice.slobodniTermini).toEqual([]);
  });

  it('podatak koji fali imenuje ljudski', () => {
    const cinjenice = sastaviCinjenice({
      vrsta: 'trazi_podatak',
      tenant: salon(),
      faliPolje: 'customer_name',
    });

    expect(cinjenice.faliPodatak).toBe('ime na koje ide rezervacija');
    expect(cinjenice.dan).toBeUndefined();
    expect(cinjenice.radnoVrijeme).toBeUndefined();
  });

  it('nečitljiv datum ne postaje izmišljen dan', () => {
    const cinjenice = sastaviCinjenice({
      vrsta: 'ponuda',
      tenant: salon(),
      datum: 'sutra',
      usluga: SISANJE,
      slobodni: SLOBODNI,
    });

    expect(cinjenice.dan).toBeUndefined();
    expect(cinjenice.radnoVrijeme).toBeUndefined();
  });
});
