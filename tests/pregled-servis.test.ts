/**
 * Testovi za src/modules/klijenti/pregled-servis.ts
 *
 * Ovaj modul namjerno čita preko svih firmi (operaterski pogled), pa ga ne
 * čuva `business_id` filter nego tri druge stvari: da je čitanje ograničeno
 * (LIMIT na svakom upitu), da period nije proizvoljan string nego prevod u
 * unaprijed napisan SQL uslov, i da telefon nikad ne izađe u punom obliku.
 * Zato testovi gledaju TEKST upita, a ne samo rezultat.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  MAKS_LIMIT,
  jePeriod,
  ogranicenLimit,
  postaviPregledIzvrsilac,
  razgovori,
  rezervacije,
  sazetak,
  type IzvrsilacUpita,
} from '../src/modules/klijenti/pregled-servis.js';

interface Zabiljezen {
  tekst: string;
  vrijednosti: unknown[];
}

let upiti: Zabiljezen[] = [];
let odgovori: Array<Array<Record<string, unknown>>> = [];

beforeEach(() => {
  upiti = [];
  odgovori = [];
  const lazni: IzvrsilacUpita = async (tekst, vrijednosti) => {
    upiti.push({ tekst, vrijednosti });
    return (odgovori.shift() ?? []) as never;
  };
  postaviPregledIzvrsilac(lazni);
});

afterEach(() => {
  postaviPregledIzvrsilac(null);
});

function zadnji(): Zabiljezen {
  const upit = upiti[upiti.length - 1];
  if (!upit) throw new Error('Nijedan upit nije zabilježen.');
  return upit;
}

// ---------------------------------------------------------------------------
// Svaki upit mora biti ograničen
// ---------------------------------------------------------------------------

describe('svaki upit ima LIMIT', () => {
  it('sažetak, rezervacije i razgovori — nijedan upit ne ide bez granice', async () => {
    odgovori = [
      [
        {
          danas: '3',
          nadolazece: '7',
          ukupno_razgovora: '11',
          kod_covjeka: '2',
          aktivnih_klijenata: '4',
        },
      ],
      [],
      [],
    ];

    await sazetak();
    await rezervacije({ period: 'sve' });
    await razgovori({});

    expect(upiti).toHaveLength(3);
    for (const upit of upiti) {
      expect(upit.tekst).toMatch(/\bLIMIT\b/);
    }
  });

  it('sažetak vraća brojeve i kad baza vrati count kao tekst', async () => {
    odgovori = [
      [
        {
          danas: '3',
          nadolazece: '7',
          ukupno_razgovora: '11',
          kod_covjeka: '2',
          aktivnih_klijenata: '4',
        },
      ],
    ];

    await expect(sazetak()).resolves.toEqual({
      danas: 3,
      nadolazece: 7,
      ukupnoRazgovora: 11,
      razgovoriKodCovjeka: 2,
      aktivnihKlijenata: 4,
    });
  });

  it('sažetak na praznoj bazi vraća nule, ne undefined', async () => {
    odgovori = [[]];
    await expect(sazetak()).resolves.toEqual({
      danas: 0,
      nadolazece: 0,
      ukupnoRazgovora: 0,
      razgovoriKodCovjeka: 0,
      aktivnihKlijenata: 0,
    });
  });
});

// ---------------------------------------------------------------------------
// Period → SQL uslov
// ---------------------------------------------------------------------------

describe('period se prevodi u SQL uslov', () => {
  it('danas: jedan dan računat u zoni Europe/Sarajevo', async () => {
    await rezervacije({ period: 'danas' });
    const upit = zadnji();
    expect(upit.tekst).toContain("date_trunc('day', now() AT TIME ZONE 'Europe/Sarajevo')");
    expect(upit.tekst).toContain("interval '1 day'");
    expect(upit.tekst).not.toContain("interval '7 days'");
    expect(upit.tekst).toContain('ORDER BY a.start_at ASC');
  });

  it('sedmica: sedam dana od lokalne ponoći', async () => {
    await rezervacije({ period: 'sedmica' });
    const upit = zadnji();
    expect(upit.tekst).toContain("interval '7 days'");
    expect(upit.tekst).toContain("date_trunc('day', now() AT TIME ZONE 'Europe/Sarajevo')");
    expect(upit.tekst).toContain('ORDER BY a.start_at ASC');
  });

  it('buduce: sve od sada nadalje, bez dnevne granice', async () => {
    await rezervacije({ period: 'buduce' });
    const upit = zadnji();
    expect(upit.tekst).toContain('WHERE a.start_at >= now()');
    expect(upit.tekst).not.toContain('date_trunc');
    expect(upit.tekst).toContain('ORDER BY a.start_at ASC');
  });

  it('sve: bez vremenskog uslova, najnovije prvo', async () => {
    await rezervacije({ period: 'sve' });
    const upit = zadnji();
    expect(upit.tekst).toContain('WHERE TRUE');
    expect(upit.tekst).not.toContain('date_trunc');
    expect(upit.tekst).toContain('ORDER BY a.start_at DESC');
  });

  it('nepoznat period pada nazad na "danas", ne ulazi u SQL', async () => {
    await rezervacije({ period: "sve'; DROP TABLE appointments; --" });
    const upit = zadnji();
    expect(upit.tekst).not.toContain('DROP TABLE');
    expect(upit.tekst).toContain("interval '1 day'");
  });

  it('jePeriod prihvata samo četiri poznate vrijednosti', () => {
    expect(jePeriod('danas')).toBe(true);
    expect(jePeriod('sedmica')).toBe(true);
    expect(jePeriod('buduce')).toBe(true);
    expect(jePeriod('sve')).toBe(true);
    expect(jePeriod('jucer')).toBe(false);
    expect(jePeriod(undefined)).toBe(false);
    expect(jePeriod(5)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Granica broja redova
// ---------------------------------------------------------------------------

describe('limit je tvrdo ograničen', () => {
  it('limit iznad 200 se spušta na 200', async () => {
    await rezervacije({ period: 'sve', limit: 5000 });
    expect(zadnji().vrijednosti).toEqual([MAKS_LIMIT]);

    await razgovori({ limit: 100_000 });
    expect(zadnji().vrijednosti).toEqual([MAKS_LIMIT]);
  });

  it('nula, negativan broj i smeće ne prolaze', () => {
    expect(ogranicenLimit(0)).toBe(1);
    expect(ogranicenLimit(-40)).toBe(1);
    expect(ogranicenLimit(12.9)).toBe(12);
    expect(ogranicenLimit('30')).toBe(30);
    expect(ogranicenLimit('abc')).toBe(50);
    expect(ogranicenLimit(undefined)).toBe(50);
    expect(ogranicenLimit(MAKS_LIMIT + 1)).toBe(MAKS_LIMIT);
  });

  it('limit ide kao parametar $1, nikad ulijepljen u tekst upita', async () => {
    await rezervacije({ period: 'danas', limit: 25 });
    const upit = zadnji();
    expect(upit.tekst).toContain('LIMIT $1');
    expect(upit.tekst).not.toContain('LIMIT 25');
    expect(upit.vrijednosti).toEqual([25]);
  });
});

// ---------------------------------------------------------------------------
// Rezervacije: sadržaj reda
// ---------------------------------------------------------------------------

describe('rezervacije preko svih firmi', () => {
  it('spaja firmu, kupca, uslugu i radnika i prikazuje vrijeme u zoni salona', async () => {
    odgovori = [
      [
        {
          id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
          kod: 'N5RQ2E',
          firma: 'Frizerski salon Ana',
          kupac: 'Emir Hodžić',
          gost: null,
          usluge: 'Šišanje',
          radnik: 'Ana Marić',
          // 10:00 UTC = 12:00 po sarajevskom ljetnom vremenu
          start_at: new Date('2026-08-03T10:00:00.000Z'),
          status: 'confirmed',
        },
      ],
    ];

    const redovi = await rezervacije({ period: 'danas' });
    expect(redovi).toHaveLength(1);
    expect(redovi[0]).toMatchObject({
      kod: 'N5RQ2E',
      firma: 'Frizerski salon Ana',
      kupac: 'Emir Hodžić',
      usluga: 'Šišanje',
      radnik: 'Ana Marić',
      vrijeme: '03.08.2026. 12:00',
      status: 'confirmed',
    });

    const upit = zadnji();
    expect(upit.tekst).toContain('JOIN public.businesses b ON b.id = a.business_id');
    expect(upit.tekst).toContain('LEFT JOIN public.clients k');
    expect(upit.tekst).toContain('public.appointment_services x');
    expect(upit.tekst).toContain('LEFT JOIN public.staff_members r');
  });

  it('prazna polja dobiju čitljivu zamjenu umjesto null', async () => {
    odgovori = [
      [
        {
          id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
          firma: null,
          kupac: null,
          usluga: null,
          radnik: null,
          start_at: null,
          status: null,
        },
      ],
    ];

    const redovi = await rezervacije({ period: 'sve' });
    expect(redovi[0]).toMatchObject({
      firma: 'Nepoznata firma',
      kupac: 'Nepoznat kupac',
      usluga: '—',
      radnik: '—',
      vrijeme: '—',
      pocetak: null,
      status: 'scheduled',
    });
  });
});

// ---------------------------------------------------------------------------
// Razgovori: maskiranje i skraćivanje
// ---------------------------------------------------------------------------

describe('razgovori preko svih firmi', () => {
  it('nikad ne vraća pun telefon, nego maskirani zadnje četiri cifre', async () => {
    odgovori = [
      [
        {
          id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
          firma: 'Salon Ana',
          external_contact: '38761998817',
          contact_name: null,
          status: 'human',
          last_message_at: new Date('2026-08-03T06:30:00.000Z'),
          zadnja_poruka: 'Mogu li doći sutra u 10?',
          zadnji_smjer: 'inbound',
        },
      ],
    ];

    const redovi = await razgovori({ limit: 10 });
    expect(redovi[0].kontakt).toBe('***8817');
    expect(JSON.stringify(redovi)).not.toContain('38761998817');
    expect(redovi[0].vrijeme).toBe('03.08.2026. 08:30');
    expect(redovi[0].status).toBe('human');
    expect(redovi[0].zadnjiSmjer).toBe('inbound');
  });

  it('ime iz profila se prikazuje uz maskirani broj', async () => {
    odgovori = [
      [
        {
          id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
          firma: 'Salon Ana',
          external_contact: '38761998817',
          contact_name: 'Emir',
          status: 'bot',
          last_message_at: null,
          zadnja_poruka: null,
          zadnji_smjer: null,
        },
      ],
    ];

    const redovi = await razgovori({});
    expect(redovi[0].kontakt).toBe('Emir (***8817)');
    expect(redovi[0].zadnjaPoruka).toBe('');
    expect(redovi[0].vrijeme).toBe('—');
    expect(redovi[0].zadnjiSmjer).toBeNull();
  });

  it('duga zadnja poruka se skraćuje da ne razvuče tabelu', async () => {
    const duga = 'a'.repeat(300);
    odgovori = [
      [
        {
          id: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
          firma: 'Salon Ana',
          external_contact: '38761998817',
          contact_name: null,
          status: 'bot',
          last_message_at: new Date('2026-08-03T06:30:00.000Z'),
          zadnja_poruka: duga,
          zadnji_smjer: 'outbound',
        },
      ],
    ];

    const redovi = await razgovori({});
    expect(redovi[0].zadnjaPoruka.length).toBeLessThan(duga.length);
    expect(redovi[0].zadnjaPoruka.endsWith('…')).toBe(true);
  });

  it('zadnja poruka se uzima jednim LATERAL upitom sa LIMIT 1 i sortira po vremenu', async () => {
    await razgovori({});
    const upit = zadnji();
    expect(upit.tekst).toContain('LEFT JOIN LATERAL');
    expect(upit.tekst).toContain('ORDER BY m.created_at DESC');
    expect(upit.tekst).toContain('LIMIT 1');
    expect(upit.tekst).toContain('ORDER BY r.last_message_at DESC NULLS LAST');
  });
});

// ---------------------------------------------------------------------------
// Grupna rezervacija u pregledu.
//
// Dva termina jedne grupe dijele kupca koji ih je napravio, pa su bez imena
// gosta izgledala kao dva termina iste osobe — a jedan je bio za kcerku.
// ---------------------------------------------------------------------------

describe('grupna rezervacija u pregledu', () => {
  it('termin za gosta pise na gosta, uz onoga ko je rezervisao', async () => {
    odgovori = [
      [
        {
          id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
          kod: 'BF5J79',
          firma: 'Rezora Demo',
          kupac: 'Adna',
          gost: 'Hena',
          usluge: 'Šišanje',
          radnik: 'Emir',
          start_at: new Date('2026-08-05T10:00:00.000Z'),
          status: 'scheduled',
        },
      ],
    ];

    const redovi = await rezervacije({ period: 'buduce' });
    expect(redovi[0].kupac).toBe('Hena (rez. Adna)');
  });

  it('vise usluga jedne posjete se prikazuje zajedno', async () => {
    odgovori = [
      [
        {
          id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
          kod: 'SNNVY6',
          firma: 'Rezora Demo',
          kupac: 'Amir',
          gost: null,
          usluge: 'Šišanje + Brijanje',
          radnik: 'Emir',
          start_at: new Date('2026-08-06T08:00:00.000Z'),
          status: 'scheduled',
        },
      ],
    ];

    const redovi = await rezervacije({ period: 'buduce' });
    expect(redovi[0].usluga).toBe('Šišanje + Brijanje');
    expect(redovi[0].kupac).toBe('Amir');
  });
});

describe('gost isti kao onaj ko rezervise', () => {
  // Prvi clan grupe je onaj ko pise, pa mu se ime pojavi i kao gost. Bez ove
  // provjere je pisalo "Adna (rez. Adna)".
  it('ime se ne ponavlja', async () => {
    odgovori = [
      [
        {
          id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
          kod: 'RDM29Q',
          firma: 'Rezora Demo',
          kupac: 'Adna',
          gost: 'Adna',
          usluge: 'Farbanje',
          radnik: 'Emir',
          start_at: new Date('2026-08-05T09:00:00.000Z'),
          status: 'scheduled',
        },
      ],
    ];

    const redovi = await rezervacije({ period: 'buduce' });
    expect(redovi[0].kupac).toBe('Adna');
  });
});
