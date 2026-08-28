/**
 * ============================================================================
 * Testovi toka razgovora — src/modules/conversations/orchestrator.ts
 * ============================================================================
 *
 * Ovdje se ne provjerava da li model razumije poruku, nego šta orkestrator sa
 * razumljenom porukom URADI. Izvlačenje je u svakom testu zadano ručno i tačno
 * je; sve što padne, palo je na odluci, ne na razumijevanju.
 *
 * Svaki test odgovara stvarnom razgovoru u kojem je nešto pošlo naopako. Ime
 * testa je ono što je kupac trebao dobiti.
 *
 * Okruženje: tests/pomoc/salon.ts.
 * ============================================================================
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const lazniKonfig = vi.hoisted(() => ({
  NODE_ENV: 'test' as const,
  LOG_LEVEL: 'error' as 'debug' | 'info' | 'warn' | 'error',
  CORE_BASE_URL: 'https://core.example.test' as string | undefined,
  CORE_INTERNAL_API_KEY: 'tajni-interni-kljuc' as string | undefined,
  HANDOFF_POVRATAK_MINUTA: 30,
  OPENAI_API_KEY: 'test' as string | undefined,
  OPENAI_MODEL: 'gpt-4o-mini',
  OPENAI_ENABLED: false,
}));

vi.mock('../src/config.js', () => ({ config: lazniKonfig }));

// Zaključavanje razgovora je osobina reda čekanja, a ne odluka orkestratora, i
// jedino bi otvorilo pravu konekciju prema Postgresu. Ovdje samo propušta.
// `query` ide uz njega: brojac brzine je jedini upit koji orkestrator salje u
// GATEWAY bazu. Bez njega bi `zabiljeziPoruku` pukla, tiho propustila poruku, i
// testovi prigusenja bi prolazili a da se prigusenje nikad ne izvrsi.
vi.mock('../src/infrastructure/database.js', async () => {
  const { memorijskiQuery } = await import('./pomoc/brzina-memorija.js');
  return {
    withConversationLock: async <T>(_kljuc: string, posao: () => Promise<T>): Promise<T> => posao(),
    query: memorijskiQuery,
  };
});

import { resetujBrzinu } from './pomoc/brzina-memorija.js';
import { napraviSalon, SADA, SUTRA, type Salon } from './pomoc/salon.js';

const TELEFON = '38761111111';
/** 13:00 po Sarajevu u augustu = 11:00 UTC. Termini se čuvaju u UTC-u. */
const TRINAEST = '2026-08-11T11:00:00.000Z';

let salon: Salon;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(SADA));
  resetujBrzinu();
  salon = napraviSalon({
    naziv: 'Salon Test',
    usluge: [
      { naziv: 'šišanje', minuta: 30 },
      { naziv: 'brijanje', minuta: 15 },
    ],
    zaposlenici: ['Emir'],
    znanje: [{ pitanje: 'Koliko košta farbanje?', odgovor: 'Farbanje je od 45 KM.' }],
  });
});

afterEach(() => {
  salon.ocisti();
  vi.useRealTimers();
});

// ---------------------------------------------------------------------------

describe('osnovni tok', () => {
  it('pozdrav ne pokreće ništa oko termina', async () => {
    const razgovor = salon.razgovor(TELEFON);

    await razgovor.posalji('Pozdrav', {
      intent: 'general_question',
      reply: 'Dobar dan! Kako Vam mogu pomoći?',
    });

    expect(razgovor.zadnjiOdgovor()).not.toBe('');
    expect(salon.aktivniTermini()).toHaveLength(0);
    expect(salon.zahtjevi().some((z) => z.putanja.startsWith('/appointments'))).toBe(false);
  });

  it('ponovljeni webhook ne dobija drugi odgovor', async () => {
    const razgovor = salon.razgovor(TELEFON);

    await razgovor.posalji('Pozdrav', { intent: 'general_question', reply: 'Dobar dan!' });
    const prije = razgovor.odgovori().length;

    // Isti external_message_id — Meta ponavlja isporuku istog webhooka.
    const ponovo = await salon
      .razgovor(TELEFON)
      .posalji('Pozdrav', { intent: 'general_question', reply: 'Dobar dan!' });

    expect(ponovo.duplicate).toBe(true);
    expect(razgovor.odgovori()).toHaveLength(prije);
  });

  it('puna rezervacija iz jedne poruke zakazuje traženo vrijeme', async () => {
    const razgovor = salon.razgovor(TELEFON);

    await razgovor.posalji('hoću šišanje sutra u 13, ja sam Amina', {
      intent: 'new_booking',
      service: 'šišanje',
      date: SUTRA,
      date_expression: 'sutra',
      start_time: '13:00',
      customer_name: 'Amina',
      ready_for_availability_check: true,
    });

    const termini = salon.aktivniTermini();
    expect(termini).toHaveLength(1);
    expect(termini[0].startAt).toBe(TRINAEST);
    // Kupac mora dobiti broj koji može pročitati naglas (migracija 0016).
    expect(razgovor.zadnjiOdgovor()).toContain(termini[0].reference);
  });
});

// ---------------------------------------------------------------------------

describe('razgovor pamti šta je već utvrđeno', () => {
  it('sat rečen u prvoj poruci vrijedi i kad usluga stigne u drugoj', async () => {
    const razgovor = salon.razgovor(TELEFON);

    await razgovor.posalji('sutra u 13, ja sam Amina', {
      intent: 'new_booking',
      date: SUTRA,
      date_expression: 'sutra',
      start_time: '13:00',
      customer_name: 'Amina',
      ready_for_availability_check: true,
    });

    await razgovor.posalji('brijanje', {
      intent: 'new_booking',
      service: 'brijanje',
      ready_for_availability_check: true,
    });

    // Ko je rekao 13:00 mora i dalje značiti 13:00 — ne 09:00, prvi slobodan.
    const termini = salon.aktivniTermini();
    expect(termini).toHaveLength(1);
    expect(termini[0].startAt).toBe(TRINAEST);
    expect(termini[0].serviceId).toBe(salon.uslugaId('brijanje'));
  });

  it('kontekst stariji od pola sata se ne koristi tiho', async () => {
    const razgovor = salon.razgovor(TELEFON);

    await razgovor.posalji('sutra u 13, ja sam Amina', {
      intent: 'new_booking',
      date: SUTRA,
      date_expression: 'sutra',
      start_time: '13:00',
      customer_name: 'Amina',
      ready_for_availability_check: true,
    });
    expect(razgovor.poznatiPodaci()).not.toBeNull();

    // Kupac se javio tek sat vremena kasnije: „brijanje" tada vjerovatno ne
    // pripada onom istom „sutra u 13".
    razgovor.ostariKontekst(31);

    await razgovor.posalji('brijanje', {
      intent: 'new_booking',
      service: 'brijanje',
      ready_for_availability_check: true,
    });

    expect(salon.aktivniTermini()).toHaveLength(0);
    expect(razgovor.zadnjiOdgovor()).not.toBe('');
  });
});

// ---------------------------------------------------------------------------

describe('više osoba u jednoj rezervaciji', () => {
  it('dvije osobe s različitim uslugama dobiju dva termina koja se ne preklapaju', async () => {
    const razgovor = salon.razgovor(TELEFON);

    await razgovor.posalji('dolazimo ja i sestra, ja šišanje ona brijanje, sutra u 13', {
      intent: 'new_booking',
      date: SUTRA,
      start_time: '13:00',
      customer_name: 'Amina',
      participants: [
        { name: '', services: ['šišanje'] },
        { name: 'sestra', services: ['brijanje'] },
      ],
      ready_for_availability_check: true,
    });

    const termini = salon.aktivniTermini().sort((a, b) => a.startAt.localeCompare(b.startAt));
    expect(termini).toHaveLength(2);
    expect(termini[0].startAt).toBe(TRINAEST);
    // Jedan zaposlenik ne može dvoje istovremeno — drugi ide poslije prvog.
    expect(new Date(termini[1].startAt).getTime()).toBeGreaterThanOrEqual(
      new Date(termini[0].endAt).getTime(),
    );
    expect(termini.map((t) => t.imeGosta)).toContain('sestra');
  });
});

// ---------------------------------------------------------------------------

describe('„da" poslije potvrđene rezervacije', () => {
  it('ne pokreće novu rezervaciju nego ponovi šta je zakazano', async () => {
    const razgovor = salon.razgovor(TELEFON);

    await razgovor.posalji('hoću šišanje sutra u 13, ja sam Amina', {
      intent: 'new_booking',
      service: 'šišanje',
      date: SUTRA,
      start_time: '13:00',
      customer_name: 'Amina',
      ready_for_availability_check: true,
    });
    expect(salon.aktivniTermini()).toHaveLength(1);

    await razgovor.posalji('da', { intent: 'confirm_booking' });

    // Kupac je upravo dobio potvrdu; ne smije čuti „Na koje ime…".
    expect(razgovor.zadnjiOdgovor()).not.toMatch(/na koje ime/i);
    expect(razgovor.zadnjiOdgovor()).toContain('13:00');
    // I nikako drugi termin za istu stvar.
    expect(salon.aktivniTermini()).toHaveLength(1);
  });

  it('„da" bez ijednog termina ne traži ime nego pita šta kupac želi', async () => {
    const razgovor = salon.razgovor(TELEFON);

    await razgovor.posalji('da', { intent: 'confirm_booking' });

    expect(razgovor.zadnjiOdgovor()).not.toMatch(/na koje ime/i);
    expect(razgovor.zadnjiOdgovor()).not.toBe('');
    expect(salon.aktivniTermini()).toHaveLength(0);
  });

  it('potvrda usred rezervacije i dalje zakazuje', async () => {
    const razgovor = salon.razgovor(TELEFON);

    // Rezervacija u toku: dan i sat su zapamćeni, fali samo pristanak.
    await razgovor.posalji('šišanje sutra u 13, ja sam Amina', {
      intent: 'check_availability',
      service: 'šišanje',
      date: SUTRA,
      start_time: '13:00',
      customer_name: 'Amina',
    });

    await razgovor.posalji('može', {
      intent: 'confirm_booking',
      service: 'šišanje',
      date: SUTRA,
      start_time: '13:00',
      customer_name: 'Amina',
      ready_for_availability_check: true,
    });

    const termini = salon.aktivniTermini();
    expect(termini).toHaveLength(1);
    expect(termini[0].startAt).toBe(TRINAEST);
  });
});

// ---------------------------------------------------------------------------

describe('otkazivanje', () => {
  it('pita prije nego obriše, i briše tek na potvrdu', async () => {
    const razgovor = salon.razgovor(TELEFON);
    salon.dodajTermin({
      datum: SUTRA,
      vrijeme: '13:00',
      usluga: 'šišanje',
      telefon: TELEFON,
      imeGosta: 'Amina',
    });

    await razgovor.posalji('otkazujem termin', { intent: 'cancel_booking' });

    // Prvo pitanje: termin je i dalje tu.
    expect(salon.aktivniTermini()).toHaveLength(1);
    const cekana = razgovor.cekanaRadnja() as { vrsta?: string; appointmentIds?: string[] } | null;
    expect(cekana?.vrsta).toBe('otkazivanje');
    expect(cekana?.appointmentIds).toHaveLength(1);

    await razgovor.posalji('da', { intent: 'confirm_booking' });

    expect(salon.aktivniTermini()).toHaveLength(0);
  });

  it('bez potvrde se ne briše ništa', async () => {
    const razgovor = salon.razgovor(TELEFON);
    salon.dodajTermin({ datum: SUTRA, vrijeme: '13:00', telefon: TELEFON, imeGosta: 'Amina' });

    await razgovor.posalji('otkazujem termin', { intent: 'cancel_booking' });
    await razgovor.posalji('ipak ne', { intent: 'general_question', reply: 'U redu.' });

    expect(salon.aktivniTermini()).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------

describe('kad Core odbije ili ne odgovori', () => {
  it('zauzet termin se ne pokušava zakazati drugi put', async () => {
    const razgovor = salon.razgovor(TELEFON);
    salon.odbijSljedeciTermin('staffConflict');

    await razgovor.posalji('šišanje sutra u 13, ja sam Amina', {
      intent: 'new_booking',
      service: 'šišanje',
      date: SUTRA,
      start_time: '13:00',
      customer_name: 'Amina',
      ready_for_availability_check: true,
    });

    const pokusaji = salon
      .zahtjevi()
      .filter((z) => z.putanja === '/appointments' && z.metoda === 'POST');
    expect(pokusaji).toHaveLength(1);
    expect(salon.aktivniTermini()).toHaveLength(0);
    expect(razgovor.zadnjiOdgovor()).not.toBe('');
  });

  it('iscrpljena granica se kaže kao granica, bez nuđenja drugih sati', async () => {
    const razgovor = salon.razgovor(TELEFON);
    salon.odbijSljedeciTermin('tooManyBookings');

    await razgovor.posalji('šišanje sutra u 13, ja sam Amina', {
      intent: 'new_booking',
      service: 'šišanje',
      date: SUTRA,
      start_time: '13:00',
      customer_name: 'Amina',
      ready_for_availability_check: true,
    });

    const odgovor = razgovor.zadnjiOdgovor();
    expect(odgovor).toMatch(/već imate/i);
    // Spisak slobodnih sati bi ovdje bio poziv da pokuša ponovo — a nijedan
    // drugi sat neće proći dok je granica puna.
    expect(odgovor).not.toMatch(/\d{2}:\d{2}/);
    expect(salon.aktivniTermini()).toHaveLength(0);
  });

  it('kad Core ne odgovara, kupac dobija ljudsku poruku, ne tehničku grešku', async () => {
    const razgovor = salon.razgovor(TELEFON);
    salon.oboriCore();

    await razgovor.posalji('hoću termin sutra u 13', {
      intent: 'new_booking',
      date: SUTRA,
      start_time: '13:00',
      service: 'šišanje',
      ready_for_availability_check: true,
    });

    const odgovor = razgovor.zadnjiOdgovor();
    expect(odgovor).not.toBe('');
    expect(odgovor.toLowerCase()).not.toMatch(/error|fetch|http|undefined|null|core/);
  });
});

// ---------------------------------------------------------------------------

describe('predaja čovjeku', () => {
  it('kad čovjek preuzme razgovor, asistent šuti — ali poruka ostaje zapisana', async () => {
    const razgovor = salon.razgovor(TELEFON);
    await razgovor.posalji('Pozdrav', { intent: 'general_question', reply: 'Dobar dan!' });

    razgovor.covjekPreuzima();
    const prije = razgovor.odgovori().length;

    const ishod = await razgovor.posalji('a koliko košta šišanje?', {
      intent: 'general_question',
      reply: 'Šišanje je 20 KM.',
    });

    expect(ishod.handoff).toBe(true);
    expect(razgovor.odgovori()).toHaveLength(prije);
  });
});

// ---------------------------------------------------------------------------

describe('zaštita od pretjerivanja', () => {
  async function posaljiViše(razgovor: ReturnType<Salon['razgovor']>, koliko: number) {
    for (let i = 0; i < koliko; i += 1) {
      await razgovor.posalji(`poruka ${i}`, { intent: 'general_question', reply: 'Dobar dan!' });
    }
  }

  it('normalan razgovor ne dira prigušenje', async () => {
    const razgovor = salon.razgovor(TELEFON);
    await posaljiViše(razgovor, 8);

    // Ljudi pišu u kratkim porukama; osam u minuti je nervoza, ne napad.
    expect(razgovor.odgovori()).toHaveLength(8);
    expect(razgovor.strikeovi()).toBe(0);
  });

  it('preko minutne granice se kaže JEDNOM, pa tišina', async () => {
    const razgovor = salon.razgovor(TELEFON);
    await posaljiViše(razgovor, 20);

    const odgovori = razgovor.odgovori();
    const upozorenja = odgovori.filter((tekst) => /puno poruka odjednom/i.test(tekst));

    // Svaki odgovor je plaćena Meta poruka: prigušenje koje odgovara na svaku
    // poruku košta isto koliko i da ga nema.
    expect(upozorenja).toHaveLength(1);
    expect(odgovori.length).toBeLessThan(20);
  });

  it('upozorenje ne odaje ni granicu ni koliko je ostalo', async () => {
    const razgovor = salon.razgovor(TELEFON);
    await posaljiViše(razgovor, 15);

    const upozorenje = razgovor.odgovori().find((t) => /puno poruka odjednom/i.test(t)) ?? '';
    // Broj bi bio uputstvo kako da se granica taman izbjegne.
    expect(upozorenje).not.toMatch(/\d/);
  });

  it('preko satne granice se pamti i asistent zašuti', async () => {
    const razgovor = salon.razgovor(TELEFON);
    await posaljiViše(razgovor, 70);

    expect(razgovor.strikeovi()).toBeGreaterThan(0);
    expect(razgovor.blokiran()).toBe(true);
  });

  it('blokiranom kontaktu se poruke i dalje ZAPISUJU, samo se ne odgovara', async () => {
    const razgovor = salon.razgovor(TELEFON);
    await posaljiViše(razgovor, 70);
    expect(razgovor.blokiran()).toBe(true);

    const prijeOdgovora = razgovor.odgovori().length;
    const prijePoruka = razgovor.poruke().length;

    await razgovor.posalji('hoću termin sutra u 13', {
      intent: 'new_booking',
      date: SUTRA,
      start_time: '13:00',
      service: 'šišanje',
      customer_name: 'Amina',
      ready_for_availability_check: true,
    });

    // Vlasnik u Inboxu mora vidjeti šta je stiglo — ništa se ne baca.
    expect(razgovor.poruke().length).toBeGreaterThan(prijePoruka);
    expect(razgovor.odgovori()).toHaveLength(prijeOdgovora);
    expect(salon.aktivniTermini()).toHaveLength(0);
  });

  it('blokada jednog kontakta ne dira drugog', async () => {
    const bučni = salon.razgovor(TELEFON);
    await posaljiViše(bučni, 70);
    expect(bučni.blokiran()).toBe(true);

    const uredan = salon.razgovor('38762222222');
    await uredan.posalji('Dobar dan', { intent: 'general_question', reply: 'Dobar dan!' });

    expect(uredan.blokiran()).toBe(false);
    expect(uredan.zadnjiOdgovor()).not.toBe('');
  });
});

/**
 * Otkazivanje po DANU, a ne samo po broju termina.
 *
 * Uživo: kupac sa tri termina napiše "otkazi subotu", a asistent mu dvaput
 * vrati spisak sva tri i traži broj. Broj termina niko ne pamti — dan pamte
 * svi. Pitanje ostaje samo tamo gdje je zaista potrebno: kad na rečeni dan ima
 * više termina, jer ih opis tada ne razlikuje.
 */
describe('kupac pokazuje na termin danom', () => {
  const PREKOSUTRA = '2026-08-12';

  it('otkazuje bez pitanja kad je tog dana samo jedan termin', async () => {
    const razgovor = salon.razgovor(TELEFON);
    salon.dodajTermin({ datum: SUTRA, vrijeme: '13:00', usluga: 'šišanje', telefon: TELEFON });
    salon.dodajTermin({ datum: PREKOSUTRA, vrijeme: '10:00', usluga: 'šišanje', telefon: TELEFON });

    await razgovor.posalji('otkazi sutra', {
      intent: 'cancel_booking',
      date_expression: 'sutra',
    });

    expect(razgovor.zadnjiOdgovor()).not.toContain('Napišite broj termina');
    const cekana = razgovor.cekanaRadnja() as { appointmentIds?: string[] } | null;
    expect(cekana?.appointmentIds).toHaveLength(1);

    await razgovor.posalji('da', { intent: 'confirm_booking' });

    const aktivni = salon.aktivniTermini();
    expect(aktivni).toHaveLength(1);
    expect(aktivni[0].startAt.startsWith(PREKOSUTRA)).toBe(true);
  });

  it('pita za broj kad na taj dan ima više termina, i nabraja samo taj dan', async () => {
    const razgovor = salon.razgovor(TELEFON);
    salon.dodajTermin({ datum: SUTRA, vrijeme: '10:00', usluga: 'šišanje', telefon: TELEFON });
    salon.dodajTermin({ datum: SUTRA, vrijeme: '15:00', usluga: 'šišanje', telefon: TELEFON });
    salon.dodajTermin({ datum: PREKOSUTRA, vrijeme: '11:00', usluga: 'šišanje', telefon: TELEFON });

    await razgovor.posalji('otkazi sutra', {
      intent: 'cancel_booking',
      date_expression: 'sutra',
    });

    const odgovor = razgovor.zadnjiOdgovor();
    expect(odgovor).toContain('Tog dana imate više termina');
    // Dan je već rečen i nije razriješio, pa se ne nudi ponovo — traži se broj.
    expect(odgovor).toContain('Napišite broj termina na koji');
    expect(odgovor).not.toContain('broj termina ili dan');
    expect(odgovor).toContain('10:00');
    expect(odgovor).toContain('15:00');
    // Termin drugog dana se ne spominje: kupac je već rekao koji dan misli.
    expect(odgovor).not.toContain('11:00');
    expect(salon.aktivniTermini()).toHaveLength(3);
  });

  it('kaže kad tog dana nema ničega, umjesto da ponudi spisak kao da nije čuo', async () => {
    const razgovor = salon.razgovor(TELEFON);
    salon.dodajTermin({ datum: SUTRA, vrijeme: '10:00', usluga: 'šišanje', telefon: TELEFON });
    salon.dodajTermin({ datum: PREKOSUTRA, vrijeme: '11:00', usluga: 'šišanje', telefon: TELEFON });

    await razgovor.posalji('otkazi danas', {
      intent: 'cancel_booking',
      date_expression: 'danas',
    });

    expect(razgovor.zadnjiOdgovor()).toContain('ne vidim vaš termin');
    expect(salon.aktivniTermini()).toHaveLength(2);
  });

  it('broj termina i dalje radi kad ga kupac napiše', async () => {
    const razgovor = salon.razgovor(TELEFON);
    const prvi = salon.dodajTermin({
      datum: SUTRA,
      vrijeme: '10:00',
      usluga: 'šišanje',
      telefon: TELEFON,
    });
    salon.dodajTermin({ datum: SUTRA, vrijeme: '15:00', usluga: 'šišanje', telefon: TELEFON });

    await razgovor.posalji(`otkazi broj ${prvi.reference}`, { intent: 'cancel_booking' });
    await razgovor.posalji('da', { intent: 'confirm_booking' });

    const aktivni = salon.aktivniTermini();
    expect(aktivni).toHaveLength(1);
    expect(aktivni[0].reference).not.toBe(prvi.reference);
  });
});
