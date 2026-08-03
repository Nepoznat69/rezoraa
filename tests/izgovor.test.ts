/**
 * Testovi za src/modules/conversations/izgovor.ts
 *
 * Dvije stvari se ovdje brane:
 *
 *   1. Kupac NIKAD ne ostane bez odgovora. Isključen AI, nema ključa, poziv
 *      pukne, istekne rok ili se vrati prazno — u svakom slučaju ide postojeća
 *      šablonska rečenica, tačno ona koju bi dobio i danas.
 *   2. Modelu ne ide ništa osim činjenica. Telefon i sirovi tekst kupca ne
 *      smiju napustiti backend.
 *
 * OpenAI i konfiguracija su mockani: ovi testovi ne diraju mrežu.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const podesavanja = vi.hoisted(() => ({
  OPENAI_ENABLED: true,
  OPENAI_API_KEY: 'test-kljuc' as string | undefined,
  OPENAI_MODEL: 'model-za-test',
  // Logger dijeli istu konfiguraciju; upozorenja se u testu ne ispisuju.
  LOG_LEVEL: 'error' as const,
}));

vi.mock('../src/config.js', () => ({ config: podesavanja }));

const napraviOdgovor = vi.hoisted(() => vi.fn());

vi.mock('openai', () => ({
  default: class {
    responses = { create: napraviOdgovor };
  },
}));

import type { Cinjenice } from '../src/modules/conversations/cinjenice.js';
import {
  ROK_IZGOVORA_MS,
  SISTEMSKI_PROMPT,
  izgovori,
  sadrziIzmisljeno,
  zaboraviKlijenta,
} from '../src/modules/conversations/izgovor.js';

const REZERVA = 'Slobodno je: 09:00, 10:15 i 13:00. Odgovara li vam neki od tih termina?';

function cinjenice(izmjene: Partial<Cinjenice> = {}): Cinjenice {
  return {
    vrsta: 'ponuda',
    salon: 'Salon Ana',
    dan: 'u srijedu, 05.08.',
    radnoVrijeme: '09:00–17:00',
    usluga: 'Šišanje',
    trajanjeMinuta: 45,
    zadnjiMoguciTermin: '16:15',
    slobodniTermini: ['09:00', '10:15', '13:00'],
    ...izmjene,
  };
}

/** Sadržaj poruka onako kako su poslane modelu. */
function poslanoModelu(): string {
  const poziv: unknown = napraviOdgovor.mock.calls[0]?.[0];
  return JSON.stringify(poziv);
}

beforeEach(() => {
  napraviOdgovor.mockReset();
  zaboraviKlijenta();
  podesavanja.OPENAI_ENABLED = true;
  podesavanja.OPENAI_API_KEY = 'test-kljuc';
});

afterEach(() => {
  vi.useRealTimers();
});

describe('rezerva je uvijek tu', () => {
  it('kad je AI isključen, ponašanje je identično današnjem', async () => {
    podesavanja.OPENAI_ENABLED = false;

    expect(await izgovori(cinjenice(), REZERVA)).toBe(REZERVA);
    expect(napraviOdgovor).not.toHaveBeenCalled();
  });

  it('bez ključa se model ne zove', async () => {
    podesavanja.OPENAI_API_KEY = undefined;

    expect(await izgovori(cinjenice(), REZERVA)).toBe(REZERVA);
    expect(napraviOdgovor).not.toHaveBeenCalled();
  });

  it('kad poziv padne, kupac dobija šablon', async () => {
    napraviOdgovor.mockRejectedValue(new Error('mreža je pukla'));

    expect(await izgovori(cinjenice(), REZERVA)).toBe(REZERVA);
  });

  it('kad istekne rok, kupac dobija šablon', async () => {
    vi.useFakeTimers();
    napraviOdgovor.mockImplementation(() => new Promise(() => undefined));

    const poruka = izgovori(cinjenice(), REZERVA);
    await vi.advanceTimersByTimeAsync(ROK_IZGOVORA_MS + 1);

    expect(await poruka).toBe(REZERVA);
  });

  it('prazan odgovor modela se ne šalje kupcu', async () => {
    napraviOdgovor.mockResolvedValue({ output_text: '   ' });
    expect(await izgovori(cinjenice(), REZERVA)).toBe(REZERVA);

    napraviOdgovor.mockResolvedValue({});
    expect(await izgovori(cinjenice(), REZERVA)).toBe(REZERVA);
  });

  it('uspješan izgovor zamjenjuje šablon', async () => {
    napraviOdgovor.mockResolvedValue({
      output_text: '  Radimo do 17:00, a slobodno je u 09:00, 10:15 i 13:00. Šta vam odgovara?  ',
    });

    const poruka = await izgovori(cinjenice(), REZERVA);

    expect(poruka).toBe('Radimo do 17:00, a slobodno je u 09:00, 10:15 i 13:00. Šta vam odgovara?');
    expect(napraviOdgovor).toHaveBeenCalledTimes(1);
  });
});

describe('model ne smije izmisliti termin', () => {
  it('sat kojeg backend nije dao obara odgovor na šablon', async () => {
    napraviOdgovor.mockResolvedValue({ output_text: 'Možemo vas primiti u 18:30, odgovara li?' });

    expect(await izgovori(cinjenice(), REZERVA)).toBe(REZERVA);
  });

  it('datum kojeg backend nije dao obara odgovor na šablon', async () => {
    napraviOdgovor.mockResolvedValue({ output_text: 'Vidimo se 07.08. u 09:00.' });

    expect(await izgovori(cinjenice(), REZERVA)).toBe(REZERVA);
  });

  it('propušta samo sate i datume iz činjenica', () => {
    const podaci = cinjenice();

    expect(sadrziIzmisljeno('Slobodno je u 9:00 ili 13:00.', podaci)).toBe(false);
    expect(sadrziIzmisljeno('Radimo 09:00–17:00, zadnji termin je u 16:15.', podaci)).toBe(false);
    expect(sadrziIzmisljeno('Nudimo i 11:30.', podaci)).toBe(true);
    expect(sadrziIzmisljeno('Vidimo se u srijedu, 05.08. u 10:15.', podaci)).toBe(false);
    expect(sadrziIzmisljeno('Vidimo se 06.08.', podaci)).toBe(true);
  });

  it('bez slobodnih termina model nema šta ponuditi', async () => {
    const prazno = cinjenice({
      vrsta: 'nema_termina',
      slobodniTermini: [],
      zadnjiMoguciTermin: undefined,
    });
    const sablon = 'Tog dana nemam više slobodnih termina.';

    // Sat kojeg nema ni u ponudi ni u radnom vremenu ne prolazi.
    napraviOdgovor.mockResolvedValue({ output_text: 'Slobodno je u 11:00.' });
    expect(await izgovori(prazno, sablon)).toBe(sablon);

    // Radno vrijeme se smije spomenuti — ono je činjenica koju je backend dao.
    napraviOdgovor.mockResolvedValue({ output_text: 'Tog dana radimo do 17:00, ali sve je popunjeno.' });
    expect(await izgovori(prazno, sablon)).toBe('Tog dana radimo do 17:00, ali sve je popunjeno.');
  });
});

describe('šta uopšte odlazi modelu', () => {
  it('ne šalje telefon, sirovi tekst kupca ni identifikatore', async () => {
    napraviOdgovor.mockResolvedValue({ output_text: 'Slobodno je u 09:00.' });

    // Namjerno „prljav" objekat: čak i da pozivalac dopiše ovakva polja,
    // `izgovori` ih ne smije proslijediti modelu.
    const prljavo = {
      ...cinjenice(),
      telefon: '+38761123456',
      tekstKupca: 'moze li popodne, zovi me na 061 123 456',
      conversationId: '99999999-9999-4999-8999-999999999999',
      businessId: '11111111-1111-4111-8111-111111111111',
    } as unknown as Cinjenice;

    await izgovori(prljavo, REZERVA);

    const poslano = poslanoModelu();
    expect(poslano).not.toContain('38761123456');
    expect(poslano).not.toContain('061 123 456');
    expect(poslano).not.toContain('moze li popodne');
    expect(poslano).not.toContain('99999999-9999-4999-8999-999999999999');
    expect(poslano).not.toContain('11111111-1111-4111-8111-111111111111');
    expect(poslano).not.toContain('telefon');
    expect(poslano).not.toContain('conversationId');
  });

  it('šalje činjenice i sistemski prompt, ništa više', async () => {
    napraviOdgovor.mockResolvedValue({ output_text: 'Slobodno je u 09:00.' });

    await izgovori(cinjenice(), REZERVA);

    const poziv: unknown = napraviOdgovor.mock.calls[0]?.[0];
    expect(poziv).toMatchObject({ model: 'model-za-test' });

    const poslano = poslanoModelu();
    expect(poslano).toContain('Salon Ana');
    expect(poslano).toContain('09:00');
    expect(poslano).toContain('zadnji_termin_koji_stane_u_radno_vrijeme');
  });

  it('sistemski prompt zabranjuje izmišljanje i drži poruku kratkom', () => {
    expect(SISTEMSKI_PROMPT).toContain('bosanskom');
    expect(SISTEMSKI_PROMPT).toContain('Ne izmišljaj');
    expect(SISTEMSKI_PROMPT).toContain('koji ne stoje u činjenicama');
    expect(SISTEMSKI_PROMPT).toContain('2-3 kratke rečenice');
    expect(SISTEMSKI_PROMPT).toContain('"vi"');
    // Prompt je nepromjenjiv tekst: u njemu nema mjesta za podatke kupca.
    expect(SISTEMSKI_PROMPT).not.toContain('${');
  });
});
