/**
 * Testovi za src/modules/core-kontekst/kontekst.ts
 *
 * Ovdje se provjerava JEDINO mjesto na kojem Coreov kontekst postaje ono što
 * AI sloj vidi. Ako mapiranje odluta, asistent priča o uslugama kojih nema ili
 * traži zaposlenika koji ne postoji — a to se u razgovoru ne primijeti odmah.
 *
 * Core klijent je mockan: ovi testovi ne smiju dirati mrežu.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const dohvatiKontekstMock = vi.hoisted(() => vi.fn());

vi.mock('../src/modules/core-api/core-klijent.js', () => ({
  dohvatiKontekst: dohvatiKontekstMock,
}));

import type { Kontekst } from '../src/modules/core-api/core-klijent.js';
import {
  PODRAZUMIJEVANA_PRAVILA,
  TRAJANJE_KESA_MS,
  kontekstZaBiznis,
  mapirajKontekst,
  ocistiKesKonteksta,
} from '../src/modules/core-kontekst/kontekst.js';

const BIZNIS = '11111111-1111-4111-8111-111111111111';
const USLUGA = '22222222-2222-4222-8222-222222222222';
const ZAPOSLENIK = '33333333-3333-4333-8333-333333333333';

function coreKontekst(izmjene: Partial<Kontekst> = {}): Kontekst {
  return {
    firma: {
      id: BIZNIS,
      naziv: 'Salon Ana',
      vertikala: 'hair_salon',
      vremenskaZona: 'Europe/Sarajevo',
    },
    usluge: [
      { id: USLUGA, naziv: 'Šišanje', trajanjeMinuta: 45, cijenaCenti: 2500, aktivna: true },
    ],
    zaposlenici: [{ id: ZAPOSLENIK, punoIme: 'Ana', titula: 'Frizer', aktivan: true }],
    radnoVrijeme: [
      { staffMemberId: ZAPOSLENIK, danUSedmici: 1, pocetak: '09:00', kraj: '17:00' },
    ],
    znanje: [],
    ...izmjene,
  };
}

beforeEach(() => {
  dohvatiKontekstMock.mockReset();
  ocistiKesKonteksta();
});

afterEach(() => {
  ocistiKesKonteksta();
});

describe('mapirajKontekst', () => {
  it('prevodi firmu, usluge i osoblje u oblik koji očekuje AI sloj', () => {
    const kontekst = mapirajKontekst(coreKontekst());

    expect(kontekst.tenantId).toBe(BIZNIS);
    expect(kontekst.businessName).toBe('Salon Ana');
    expect(kontekst.businessType).toBe('hair_salon');
    expect(kontekst.timezone).toBe('Europe/Sarajevo');
    expect(kontekst.language).toBe('bs');
    expect(kontekst.employees).toEqual([{ id: ZAPOSLENIK, name: 'Ana' }]);
    expect(kontekst.services).toHaveLength(1);
    expect(kontekst.services[0]).toMatchObject({
      id: USLUGA,
      name: 'Šišanje',
      defaultDurationMinutes: 45,
      configuration: { price_cents: 2500 },
    });
  });

  it('svaku Coreovu uslugu vodi kao termin bez kapaciteta', () => {
    const kontekst = mapirajKontekst(
      coreKontekst({
        usluge: [
          { id: USLUGA, naziv: 'Šišanje', trajanjeMinuta: 45, cijenaCenti: 2500, aktivna: true },
          { id: BIZNIS, naziv: 'Farbanje', trajanjeMinuta: 90, cijenaCenti: 6000, aktivna: true },
        ],
      }),
    );

    for (const usluga of kontekst.services) {
      expect(usluga.bookingModel).toBe('appointment');
      expect(usluga.capacityMode).toBe('none');
      expect(usluga.requiresResource).toBe(false);
      expect(usluga.bufferBeforeMinutes).toBe(0);
      expect(usluga.bufferAfterMinutes).toBe(0);
    }
  });

  it('traži zaposlenika samo kada biznis uopšte ima osoblje', () => {
    const saOsobljem = mapirajKontekst(coreKontekst());
    expect(saOsobljem.services[0].requiresEmployee).toBe(true);

    const bezOsoblja = mapirajKontekst(coreKontekst({ zaposlenici: [] }));
    expect(bezOsoblja.services[0].requiresEmployee).toBe(false);
  });

  it('izostavlja neaktivne usluge i neaktivno osoblje', () => {
    const kontekst = mapirajKontekst(
      coreKontekst({
        usluge: [
          { id: USLUGA, naziv: 'Šišanje', trajanjeMinuta: 45, cijenaCenti: 2500, aktivna: true },
          { id: BIZNIS, naziv: 'Ukinuto', trajanjeMinuta: 30, cijenaCenti: 0, aktivna: false },
        ],
        zaposlenici: [
          { id: ZAPOSLENIK, punoIme: 'Ana', titula: 'Frizer', aktivan: true },
          { id: BIZNIS, punoIme: 'Bivši', titula: null, aktivan: false },
        ],
      }),
    );

    expect(kontekst.services.map((usluga) => usluga.name)).toEqual(['Šišanje']);
    expect(kontekst.employees.map((zaposlenik) => zaposlenik.name)).toEqual(['Ana']);
  });

  it('resurse ostavlja prazne jer ih Core nema', () => {
    expect(mapirajKontekst(coreKontekst()).resources).toEqual([]);
  });

  // Bez ovoga asistent nije mogao odgovoriti na "koliko kosta sisanje" ni na
  // "imate li parking" — usluge i radno vrijeme kazu sta salon RADI, a ovo sta
  // ZNA. Prijenos je zato dio ugovora, a ne detalj.
  it('prenosi bazu znanja iz Corea u oblik koji ocekuje AI sloj', () => {
    const kontekst = mapirajKontekst(
      coreKontekst({
        znanje: [
          { pitanje: 'Koliko kosta sisanje?', odgovor: 'Sisanje je 20 KM.' },
          { pitanje: 'Imate li parking?', odgovor: 'Da, ispred salona.' },
        ],
      }),
    );

    expect(kontekst.knowledge).toEqual([
      { question: 'Koliko kosta sisanje?', answer: 'Sisanje je 20 KM.' },
      { question: 'Imate li parking?', answer: 'Da, ispred salona.' },
    ]);
  });

  it('prazna baza znanja je prazan niz, ne greska', () => {
    expect(mapirajKontekst(coreKontekst({ znanje: [] })).knowledge).toEqual([]);
  });

  it('koristi podrazumijevana pravila rezervisanja dok ih Core ne izlaže', () => {
    const kontekst = mapirajKontekst(coreKontekst());

    expect(kontekst.bookingPolicy).toEqual({
      auto_confirm: false,
      hold_minutes: 10,
      min_advance_minutes: 60,
      max_advance_days: 365,
      cancellation_notice_minutes: 1440,
      required_fields: ['customer_name'],
    });
  });

  it('ne dijeli isti objekat pravila između biznisa', () => {
    const prvi = mapirajKontekst(coreKontekst());
    (prvi.bookingPolicy as Record<string, unknown>).auto_confirm = true;

    const drugi = mapirajKontekst(coreKontekst());
    expect(drugi.bookingPolicy.auto_confirm).toBe(false);
    expect(PODRAZUMIJEVANA_PRAVILA.auto_confirm).toBe(false);
  });
});

describe('kontekstZaBiznis', () => {
  it('drugu poruku istog razgovora poslužuje iz keša', async () => {
    dohvatiKontekstMock.mockResolvedValue({ ok: true, kontekst: coreKontekst() });

    const prvi = await kontekstZaBiznis(BIZNIS, 1_000);
    const drugi = await kontekstZaBiznis(BIZNIS, 1_000 + TRAJANJE_KESA_MS - 1);

    expect(dohvatiKontekstMock).toHaveBeenCalledTimes(1);
    expect(prvi.ok && drugi.ok).toBe(true);
  });

  it('poslije isteka keša ponovo pita Core', async () => {
    dohvatiKontekstMock.mockResolvedValue({ ok: true, kontekst: coreKontekst() });

    await kontekstZaBiznis(BIZNIS, 1_000);
    await kontekstZaBiznis(BIZNIS, 1_000 + TRAJANJE_KESA_MS + 1);

    expect(dohvatiKontekstMock).toHaveBeenCalledTimes(2);
  });

  it('keš je po biznisu, nikad zajednički', async () => {
    const drugiBiznis = '55555555-5555-4555-8555-555555555555';
    dohvatiKontekstMock.mockImplementation(async (id: string) => ({
      ok: true,
      kontekst: coreKontekst({
        firma: {
          id,
          naziv: id === BIZNIS ? 'Salon Ana' : 'Salon Beba',
          vertikala: 'hair_salon',
          vremenskaZona: 'Europe/Sarajevo',
        },
      }),
    }));

    const prvi = await kontekstZaBiznis(BIZNIS, 1_000);
    const drugi = await kontekstZaBiznis(drugiBiznis, 1_000);

    expect(dohvatiKontekstMock).toHaveBeenCalledTimes(2);
    expect(prvi.ok && prvi.kontekst.businessName).toBe('Salon Ana');
    expect(drugi.ok && drugi.kontekst.businessName).toBe('Salon Beba');
  });

  it('neuspjeh vraća kakav jeste i ne pamti ga', async () => {
    dohvatiKontekstMock.mockResolvedValueOnce({
      ok: false,
      vrsta: 'mreza',
      poruka: 'Rezora Core nije dostupan.',
      status: null,
      ponoviti: true,
    });
    dohvatiKontekstMock.mockResolvedValueOnce({ ok: true, kontekst: coreKontekst() });

    const neuspjeh = await kontekstZaBiznis(BIZNIS, 1_000);
    expect(neuspjeh.ok).toBe(false);

    const uspjeh = await kontekstZaBiznis(BIZNIS, 1_001);
    expect(uspjeh.ok).toBe(true);
    expect(dohvatiKontekstMock).toHaveBeenCalledTimes(2);
  });
});
