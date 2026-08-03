/**
 * Testovi za src/modules/core-baza/core-repozitorij.ts
 *
 * Gateway na Core bazu ide service role konekcijom koja ZAOBILAZI RLS, pa je
 * `where business_id = $1` jedina zaštita između dva biznisa. Ovi testovi zato
 * ne provjeravaju samo rezultate nego i TEKST svakog upita koji modul pošalje.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  azurirajStatusPoruke,
  businessIdZaBroj,
  historijaRazgovora,
  nadjiIliNapraviRazgovor,
  postaviCoreIzvrsilac,
  preuzeoCovjek,
  stanjeRazgovora,
  vratiBotaAkoNikoNijeOdgovorio,
  zapisiDolaznuPoruku,
  zapisiOdlaznuPoruku,
  type IzvrsilacUpita,
} from '../src/modules/core-baza/core-repozitorij.js';

const BIZNIS = '11111111-1111-4111-8111-111111111111';
const DRUGI_BIZNIS = '99999999-9999-4999-8999-999999999999';
const RAZGOVOR = '22222222-2222-4222-8222-222222222222';
const KONTAKT = '+387 61 123 456';
const KONTAKT_CIFRE = '38761123456';
const VANJSKI_ID = 'wamid.TEST123';
const TAJNI_TEKST = 'Tekst poruke koji nikad ne smije ući u SQL string';

interface Zabiljezen {
  tekst: string;
  vrijednosti: unknown[];
}

let upiti: Zabiljezen[] = [];
let odgovori: Array<Array<Record<string, unknown>>> = [];

/** Upiti koji smiju postojati bez `business_id = $1` — samo razrješavanje broja. */
function jeRazrjesavanjeBroja(tekst: string): boolean {
  return tekst.includes('public.integrations') && tekst.includes("config->>'phone_number_id'");
}

function upitiSaFilterom(): Zabiljezen[] {
  return upiti.filter((u) => !jeRazrjesavanjeBroja(u.tekst));
}

beforeEach(() => {
  upiti = [];
  odgovori = [];
  const mock: IzvrsilacUpita = async (tekst, vrijednosti) => {
    upiti.push({ tekst, vrijednosti });
    return (odgovori.shift() ?? []) as never;
  };
  postaviCoreIzvrsilac(mock);
});

afterEach(() => {
  postaviCoreIzvrsilac(null);
});

describe('businessIdZaBroj — jedini upit koji smije bez business_id filtera', () => {
  it('traži isključivo whatsapp integraciju sa tačnim phone_number_id', async () => {
    odgovori = [[{ business_id: BIZNIS }]];
    await expect(businessIdZaBroj('123456789')).resolves.toBe(BIZNIS);

    expect(upiti).toHaveLength(1);
    expect(upiti[0].tekst).toContain("i.provider = 'whatsapp'");
    expect(upiti[0].tekst).toContain("i.config->>'phone_number_id' = $1");
    expect(upiti[0].vrijednosti).toEqual(['123456789']);
    // Vraća se samo business_id, nikakav sadržaj tuđeg biznisa.
    expect(upiti[0].tekst).not.toMatch(/from\s+public\.messages/i);
  });

  it('vraća null kada broj nije vezan ni za jedan biznis', async () => {
    odgovori = [[]];
    await expect(businessIdZaBroj('nepoznat')).resolves.toBeNull();
  });

  it('odbija dvosmislen broj umjesto da izabere prvi biznis', async () => {
    odgovori = [[{ business_id: BIZNIS }, { business_id: DRUGI_BIZNIS }]];
    await expect(businessIdZaBroj('123456789')).resolves.toBeNull();
  });

  it('ne ide u bazu za prazan phone_number_id', async () => {
    await expect(businessIdZaBroj('   ')).resolves.toBeNull();
    expect(upiti).toHaveLength(0);
  });
});

describe('nadjiIliNapraviRazgovor', () => {
  it('upisuje sa business_id kao $1 i koristi UNIQUE (business_id, channel, external_contact)', async () => {
    odgovori = [[{ id: RAZGOVOR }]];
    await expect(nadjiIliNapraviRazgovor(BIZNIS, KONTAKT, 'Amra')).resolves.toBe(RAZGOVOR);

    const upit = upiti[0];
    expect(upit.tekst).toContain('ON CONFLICT (business_id, channel, external_contact)');
    expect(upit.tekst).toContain('conversations.business_id = $1');
    expect(upit.vrijednosti[0]).toBe(BIZNIS);
    expect(upit.vrijednosti[1]).toBe(KONTAKT_CIFRE);
    expect(upit.vrijednosti[2]).toBe('Amra');
  });

  it('rezervni SELECT je takođe ograđen business_id-em', async () => {
    odgovori = [[], [{ id: RAZGOVOR }]];
    await expect(nadjiIliNapraviRazgovor(BIZNIS, KONTAKT)).resolves.toBe(RAZGOVOR);

    expect(upiti).toHaveLength(2);
    expect(upiti[1].tekst).toContain('WHERE business_id = $1');
    expect(upiti[1].vrijednosti[0]).toBe(BIZNIS);
  });

  it('odbija prazan i neispravan business_id bez ijednog upita', async () => {
    await expect(nadjiIliNapraviRazgovor('', KONTAKT)).rejects.toThrow(/business_id/i);
    await expect(nadjiIliNapraviRazgovor('nije-uuid', KONTAKT)).rejects.toThrow(/business_id/i);
    expect(upiti).toHaveLength(0);
  });
});

describe('zapisiDolaznuPoruku', () => {
  it('veže poruku na razgovor kroz business_id, ne na goli conversation_id', async () => {
    odgovori = [[{ id: 'poruka-1' }], []];
    const rezultat = await zapisiDolaznuPoruku({
      businessId: BIZNIS,
      conversationId: RAZGOVOR,
      externalMessageId: VANJSKI_ID,
      tekst: TAJNI_TEKST,
      tipPoruke: 'text',
    });

    expect(rezultat).toEqual({ id: 'poruka-1', duplikat: false });
    expect(upiti[0].tekst).toContain('FROM public.conversations r');
    expect(upiti[0].tekst).toContain('r.business_id = $1');
    expect(upiti[0].tekst).toContain('ON CONFLICT (business_id, external_message_id)');
    expect(upiti[0].vrijednosti[0]).toBe(BIZNIS);
    expect(upiti[0].vrijednosti[2]).toBe('inbound');
    // Osvježavanje last_message_at je takođe ograđeno.
    expect(upiti[1].tekst).toContain('WHERE business_id = $1');
    expect(upiti[1].vrijednosti[0]).toBe(BIZNIS);
  });

  it('ponovljeni webhook vraća duplikat umjesto greške', async () => {
    odgovori = [[], [{ id: 'poruka-1' }]];
    const rezultat = await zapisiDolaznuPoruku({
      businessId: BIZNIS,
      conversationId: RAZGOVOR,
      externalMessageId: VANJSKI_ID,
      tekst: TAJNI_TEKST,
    });

    expect(rezultat).toEqual({ id: 'poruka-1', duplikat: true });
    expect(upiti[1].tekst).toContain('WHERE business_id = $1');
    expect(upiti[1].vrijednosti).toEqual([BIZNIS, VANJSKI_ID]);
  });

  it('odbija razgovor koji ne pripada biznisu', async () => {
    odgovori = [[], []];
    await expect(
      zapisiDolaznuPoruku({
        businessId: BIZNIS,
        conversationId: RAZGOVOR,
        externalMessageId: VANJSKI_ID,
        tekst: TAJNI_TEKST,
      }),
    ).rejects.toThrow(/ne pripada/i);
  });

  it('ne dira bazu bez business_id-a', async () => {
    await expect(
      zapisiDolaznuPoruku({
        businessId: '',
        conversationId: RAZGOVOR,
        externalMessageId: VANJSKI_ID,
        tekst: TAJNI_TEKST,
      }),
    ).rejects.toThrow(/business_id/i);
    expect(upiti).toHaveLength(0);
  });
});

describe('zapisiOdlaznuPoruku', () => {
  it('upisuje odlaznu poruku sa business_id-em kao $1', async () => {
    odgovori = [[{ id: 'poruka-2' }], []];
    const rezultat = await zapisiOdlaznuPoruku({
      businessId: BIZNIS,
      conversationId: RAZGOVOR,
      tekst: TAJNI_TEKST,
      externalMessageId: VANJSKI_ID,
    });

    expect(rezultat).toEqual({ id: 'poruka-2', duplikat: false });
    expect(upiti[0].vrijednosti[0]).toBe(BIZNIS);
    expect(upiti[0].vrijednosti[2]).toBe('outbound');
    expect(upiti[0].vrijednosti[3]).toBe(VANJSKI_ID);
    expect(upiti[0].vrijednosti[6]).toBe('sent');
  });

  it('bez vanjskog id-a poruka ide u status queued', async () => {
    odgovori = [[{ id: 'poruka-3' }], []];
    await zapisiOdlaznuPoruku({ businessId: BIZNIS, conversationId: RAZGOVOR, tekst: 'zdravo' });

    expect(upiti[0].vrijednosti[3]).toBeNull();
    expect(upiti[0].vrijednosti[6]).toBe('queued');
  });

  it('odbija neispravan business_id', async () => {
    await expect(
      zapisiOdlaznuPoruku({ businessId: 'x', conversationId: RAZGOVOR, tekst: 'zdravo' }),
    ).rejects.toThrow(/business_id/i);
    expect(upiti).toHaveLength(0);
  });
});

describe('azurirajStatusPoruke', () => {
  it('ažurira samo poruku tog biznisa', async () => {
    odgovori = [[{ id: 'poruka-1' }]];
    await expect(azurirajStatusPoruke(BIZNIS, VANJSKI_ID, 'delivered')).resolves.toBe(true);

    expect(upiti[0].tekst).toContain('UPDATE public.messages');
    expect(upiti[0].tekst).toContain('WHERE business_id = $1');
    expect(upiti[0].tekst).toContain('AND external_message_id = $2');
    expect(upiti[0].vrijednosti).toEqual([BIZNIS, VANJSKI_ID, 'delivered']);
  });

  it('vraća false kada nijedan red nije pogođen', async () => {
    odgovori = [[]];
    await expect(azurirajStatusPoruke(BIZNIS, VANJSKI_ID, 'read')).resolves.toBe(false);
  });

  it('odbija status koji Meta ne šalje i ne izvršava upit', async () => {
    await expect(azurirajStatusPoruke(BIZNIS, VANJSKI_ID, 'obrisano')).rejects.toThrow(/status/i);
    expect(upiti).toHaveLength(0);
  });

  it('odbija upit bez business_id-a', async () => {
    await expect(azurirajStatusPoruke('', VANJSKI_ID, 'sent')).rejects.toThrow(/business_id/i);
    expect(upiti).toHaveLength(0);
  });
});

describe('preuzeoCovjek', () => {
  it('postavlja status human samo unutar svog biznisa', async () => {
    odgovori = [[{ id: RAZGOVOR }]];
    await expect(preuzeoCovjek(BIZNIS, RAZGOVOR)).resolves.toBe(true);

    expect(upiti[0].tekst).toContain('UPDATE public.conversations');
    expect(upiti[0].tekst).toContain("SET status = 'human'");
    expect(upiti[0].tekst).toContain('WHERE business_id = $1');
    expect(upiti[0].vrijednosti).toEqual([BIZNIS, RAZGOVOR]);
  });

  it('odbija neispravan conversation_id', async () => {
    await expect(preuzeoCovjek(BIZNIS, 'nije-uuid')).rejects.toThrow(/conversationId/i);
    expect(upiti).toHaveLength(0);
  });
});

describe('vratiBotaAkoNikoNijeOdgovorio', () => {
  it('vraća status bot samo unutar svog biznisa i tek nakon isteka roka', async () => {
    odgovori = [[{ id: RAZGOVOR }]];
    await expect(vratiBotaAkoNikoNijeOdgovorio(BIZNIS, RAZGOVOR, 30)).resolves.toBe(true);

    expect(upiti[0].tekst).toContain("SET status = 'bot'");
    expect(upiti[0].tekst).toContain('c.business_id = $1');
    expect(upiti[0].tekst).toContain("c.status = 'human'");
    expect(upiti[0].tekst).toContain("($3 || ' minutes')::interval");
    expect(upiti[0].vrijednosti).toEqual([BIZNIS, RAZGOVOR, '30']);
  });

  // Ovo je srž pravila: razgovor u kojem je zaposlenik stvarno odgovorio ostaje
  // njegov zauvijek. Bez ovog uslova bi mu asistent upao u riječ.
  it('preskače razgovore u kojima je čovjek već odgovorio', async () => {
    odgovori = [[{ id: RAZGOVOR }]];
    await vratiBotaAkoNikoNijeOdgovorio(BIZNIS, RAZGOVOR, 30);

    expect(upiti[0].tekst).toContain('NOT EXISTS');
    expect(upiti[0].tekst).toContain('m.sent_by IS NOT NULL');
    expect(upiti[0].tekst).toContain("m.direction = 'outbound'");
    expect(upiti[0].tekst).toContain('m.created_at >= c.updated_at');
  });

  it('ne dira bazu kad je povratak isključen', async () => {
    await expect(vratiBotaAkoNikoNijeOdgovorio(BIZNIS, RAZGOVOR, 0)).resolves.toBe(false);
    await expect(vratiBotaAkoNikoNijeOdgovorio(BIZNIS, RAZGOVOR, -5)).resolves.toBe(false);
    expect(upiti).toHaveLength(0);
  });

  it('odbija neispravan conversation_id', async () => {
    await expect(vratiBotaAkoNikoNijeOdgovorio(BIZNIS, 'nije-uuid', 30)).rejects.toThrow(
      /conversationId/i,
    );
    expect(upiti).toHaveLength(0);
  });
});

describe('stanjeRazgovora', () => {
  it('čita razgovor isključivo unutar svog biznisa', async () => {
    odgovori = [
      [{ id: RAZGOVOR, status: 'bot', contact_name: 'Amra', client_id: null }],
    ];
    await expect(stanjeRazgovora(BIZNIS, RAZGOVOR)).resolves.toEqual({
      id: RAZGOVOR,
      status: 'bot',
      contactName: 'Amra',
      clientId: null,
    });

    expect(upiti).toHaveLength(1);
    expect(upiti[0].tekst).toContain('FROM public.conversations');
    expect(upiti[0].tekst).toContain('WHERE business_id = $1');
    expect(upiti[0].tekst).toContain('AND id = $2');
    expect(upiti[0].vrijednosti).toEqual([BIZNIS, RAZGOVOR]);
  });

  it('prepoznaje da je čovjek preuzeo razgovor', async () => {
    odgovori = [[{ id: RAZGOVOR, status: 'human', contact_name: null, client_id: null }]];
    const stanje = await stanjeRazgovora(BIZNIS, RAZGOVOR);
    expect(stanje?.status).toBe('human');
  });

  it('prepoznaje zatvoren razgovor', async () => {
    odgovori = [[{ id: RAZGOVOR, status: 'closed', contact_name: null, client_id: null }]];
    const stanje = await stanjeRazgovora(BIZNIS, RAZGOVOR);
    expect(stanje?.status).toBe('closed');
  });

  it('nepoznat status svodi na bot, da asistent ne zanijemi bez razloga', async () => {
    odgovori = [[{ id: RAZGOVOR, status: 'nesto-novo', contact_name: null, client_id: null }]];
    const stanje = await stanjeRazgovora(BIZNIS, RAZGOVOR);
    expect(stanje?.status).toBe('bot');
  });

  it('vraća null kada razgovor ne pripada tom biznisu', async () => {
    odgovori = [[]];
    await expect(stanjeRazgovora(BIZNIS, RAZGOVOR)).resolves.toBeNull();
  });

  it('ne ide u bazu bez ispravnog business_id-a ni conversation_id-a', async () => {
    await expect(stanjeRazgovora('', RAZGOVOR)).rejects.toThrow(/business_id/i);
    await expect(stanjeRazgovora(BIZNIS, 'nije-uuid')).rejects.toThrow(/conversationId/i);
    expect(upiti).toHaveLength(0);
  });
});

describe('historijaRazgovora', () => {
  it('čita poruke samo tog biznisa i tog razgovora', async () => {
    odgovori = [[{ direction: 'inbound', body: TAJNI_TEKST }]];
    await historijaRazgovora(BIZNIS, RAZGOVOR, 10);

    expect(upiti[0].tekst).toContain('FROM public.messages');
    expect(upiti[0].tekst).toContain('WHERE business_id = $1');
    expect(upiti[0].tekst).toContain('AND conversation_id = $2');
    expect(upiti[0].vrijednosti).toEqual([BIZNIS, RAZGOVOR, 10]);
  });

  it('vraća poruke od najstarije prema najnovijoj', async () => {
    // Upit ide DESC (zadnjih N), pa modul mora okrenuti redoslijed.
    odgovori = [
      [
        { direction: 'inbound', body: 'treca' },
        { direction: 'outbound', body: 'druga' },
        { direction: 'inbound', body: 'prva' },
      ],
    ];
    await expect(historijaRazgovora(BIZNIS, RAZGOVOR)).resolves.toEqual([
      { direction: 'inbound', body: 'prva' },
      { direction: 'outbound', body: 'druga' },
      { direction: 'inbound', body: 'treca' },
    ]);
  });

  it('ograničenje ide kao parametar $3, nikad spojeno u SQL', async () => {
    odgovori = [[]];
    await historijaRazgovora(BIZNIS, RAZGOVOR, 7);

    expect(upiti[0].tekst).toContain('LIMIT $3');
    expect(upiti[0].tekst).not.toMatch(/LIMIT\s+\d/);
    expect(upiti[0].vrijednosti[2]).toBe(7);
  });

  it('svodi besmislen limit u razuman raspon umjesto da povuče cijelu tabelu', async () => {
    odgovori = [[], [], []];
    await historijaRazgovora(BIZNIS, RAZGOVOR, 0);
    await historijaRazgovora(BIZNIS, RAZGOVOR, 5000);
    await historijaRazgovora(BIZNIS, RAZGOVOR, 4.7);

    expect(upiti[0].vrijednosti[2]).toBe(1);
    expect(upiti[1].vrijednosti[2]).toBe(50);
    expect(upiti[2].vrijednosti[2]).toBe(4);
  });

  it('nepoznat smjer čita kao dolazni, a prazan sadržaj kao prazan string', async () => {
    odgovori = [[{ direction: 'nesto', body: null }]];
    await expect(historijaRazgovora(BIZNIS, RAZGOVOR)).resolves.toEqual([
      { direction: 'inbound', body: '' },
    ]);
  });

  it('prazan razgovor je prazna istorija, ne greška', async () => {
    odgovori = [[]];
    await expect(historijaRazgovora(BIZNIS, RAZGOVOR)).resolves.toEqual([]);
  });

  it('ne ide u bazu bez ispravnog business_id-a ni conversation_id-a', async () => {
    await expect(historijaRazgovora('', RAZGOVOR)).rejects.toThrow(/business_id/i);
    await expect(historijaRazgovora(BIZNIS, 'nije-uuid')).rejects.toThrow(/conversationId/i);
    expect(upiti).toHaveLength(0);
  });
});

describe('disciplina business_id-a kroz cijeli modul', () => {
  async function pokreniSve(): Promise<void> {
    odgovori = [
      [{ business_id: BIZNIS }], // businessIdZaBroj
      [{ id: RAZGOVOR }], // nadjiIliNapraviRazgovor (upsert)
      [{ id: 'poruka-1' }], // dolazna poruka (insert)
      [], // dolazna poruka (last_message_at)
      [{ id: 'poruka-2' }], // odlazna poruka (insert)
      [], // odlazna poruka (last_message_at)
      [{ id: 'poruka-2' }], // azurirajStatusPoruke
      [{ id: RAZGOVOR }], // preuzeoCovjek
      [{ id: RAZGOVOR, status: 'human', contact_name: 'Amra', client_id: null }], // stanjeRazgovora
      [{ direction: 'inbound', body: TAJNI_TEKST }], // historijaRazgovora
    ];
    await businessIdZaBroj('123456789');
    await nadjiIliNapraviRazgovor(BIZNIS, KONTAKT, 'Amra');
    await zapisiDolaznuPoruku({
      businessId: BIZNIS,
      conversationId: RAZGOVOR,
      externalMessageId: VANJSKI_ID,
      tekst: TAJNI_TEKST,
    });
    await zapisiOdlaznuPoruku({
      businessId: BIZNIS,
      conversationId: RAZGOVOR,
      tekst: TAJNI_TEKST,
      externalMessageId: VANJSKI_ID,
    });
    await azurirajStatusPoruke(BIZNIS, VANJSKI_ID, 'delivered');
    await preuzeoCovjek(BIZNIS, RAZGOVOR);
    await stanjeRazgovora(BIZNIS, RAZGOVOR);
    await historijaRazgovora(BIZNIS, RAZGOVOR, 11);
  }

  it('svaki upit osim razrješavanja broja ima business_id filter na $1', async () => {
    await pokreniSve();
    expect(upitiSaFilterom().length).toBeGreaterThan(5);

    for (const { tekst, vrijednosti } of upitiSaFilterom()) {
      expect(tekst).toMatch(/business_id = \$1/);
      expect(vrijednosti[0]).toBe(BIZNIS);
    }
  });

  it('postoji tačno jedan upit bez business_id filtera i to je prevod broja', async () => {
    await pokreniSve();
    const bezFiltera = upiti.filter((u) => !/business_id = \$1/.test(u.tekst));
    expect(bezFiltera).toHaveLength(1);
    expect(jeRazrjesavanjeBroja(bezFiltera[0].tekst)).toBe(true);
  });

  it('nijedan upit ne dira conversations ili messages bez business_id-a', async () => {
    await pokreniSve();
    for (const { tekst } of upiti) {
      if (/public\.(conversations|messages)/.test(tekst)) {
        expect(tekst).toMatch(/business_id = \$1/);
      }
    }
  });

  it('vrijednosti se prenose kao parametri, nikad spojene u SQL tekst', async () => {
    await pokreniSve();
    for (const { tekst } of upiti) {
      expect(tekst).not.toContain(TAJNI_TEKST);
      expect(tekst).not.toContain(KONTAKT_CIFRE);
      expect(tekst).not.toContain(VANJSKI_ID);
      expect(tekst).not.toContain(BIZNIS);
      expect(tekst).not.toContain('${');
    }
  });
});
