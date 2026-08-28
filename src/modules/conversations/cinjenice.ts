/**
 * ============================================================================
 * Činjenice o ishodu razgovora
 * ============================================================================
 *
 * Backend odlučuje SVE: koji su termini slobodni, da li je nešto zakazano, do
 * kada se radi. Ovaj modul te odluke pakuje u jedan mali, provjeren objekat —
 * `Cinjenice` — koji je jedino što AI sloj (`izgovor.ts`) uopšte vidi.
 *
 * ZAŠTO POSTOJI
 * Zadnja tri popravka bila su isti posao: kupac kaže „kasnije", „popodne",
 * „navečer", a mi dodamo novi regularni izraz u šablon. Šablon ne može pokriti
 * sve načine na koje čovjek pita. Ako AI sastavlja rečenicu iz činjenica, taj
 * posao prestaje.
 *
 * GRANICA
 *   1. Ovdje ne ulazi ništa sirovo: ni telefon, ni tekst kupca, ni tehnički
 *      pojam iz Coreovog ugovora (`staffConflict` i drugi). Sve što uđe smije
 *      se doslovno pojaviti u poruci kupcu.
 *   2. Satnice dolaze isključivo iz liste koju je Core vratio, kroz isti izbor
 *      (`izaberiTermine`) koji koristi i šablonska rečenica.
 *   3. Modul je čist: nema mreže, baze, logova ni vremena „sada".
 * ============================================================================
 */

import { DateTime } from 'luxon';
import type { TenantContext } from '../../domain/schemas.js';
import type {
  NepoznatRazlog,
  RazlogTermina,
  SlobodanTermin,
} from '../core-api/core-klijent.js';
import {
  izaberiTermine,
  opisTermina,
  satnice,
  type DobaDana,
  type ZeljenoVrijeme,
} from './poruke.js';

/** Ishod koji backend saopštava kupcu. */
export type VrstaIshoda =
  | 'ponuda'
  | 'zakazano'
  | 'odbijeno'
  | 'nema_termina'
  | 'trazi_podatak'
  | 'otkazano'
  | 'pomjereno';

/** Radno vrijeme jednog dana, lokalno za salon. */
export interface RadnoVrijemeDana {
  /** "09:00" */
  pocetak: string;
  /** "17:00" */
  kraj: string;
}

/** Šta je kupac tražio — izvedeno, nikad njegov sirovi tekst. */
export interface TrazenoOdKupca {
  /** "u srijedu, 05.08." */
  dan?: string;
  /** "14:30" */
  sat?: string;
  dobaDana?: DobaDana;
}

/**
 * Sve što se smije izgovoriti kupcu. Nijedno polje nije obavezno osim vrste i
 * naziva salona: ako backend nešto ne zna, tog polja nema i o tome se ne priča.
 */
export interface Cinjenice {
  vrsta: VrstaIshoda;
  salon: string;
  /** "u srijedu, 05.08." — dan o kojem se razgovara. */
  dan?: string;
  /** "09:00–17:00" za taj dan. */
  radnoVrijeme?: string;
  usluga?: string;
  trajanjeMinuta?: number;
  /** "16:40" — zadnji termin koji tog dana još stane u radno vrijeme. */
  zadnjiMoguciTermin?: string;
  /** Satnice koje se smiju ponuditi. Ništa izvan ove liste nije termin. */
  slobodniTermini: string[];
  trazio?: TrazenoOdKupca;
  /** Kupac je tražio doba dana u kojem nema ničega. */
  trazenoNijeSlobodno?: boolean;
  /** Razlog u LJUDSKOM obliku. Tehnički pojmovi ovdje ne postoje. */
  razlog?: string;
  /** Podatak koji fali, imenovan ljudski ("ime", "datum", "sat"). */
  faliPodatak?: string;
  /** "u srijedu, 05.08. u 09:00" — potvrđeni ili pomjereni termin. */
  termin?: string;
}

// ---------------------------------------------------------------------------
// Sati i minute
// ---------------------------------------------------------------------------

const SAT_OBLIK = /^(\d{1,2}):(\d{2})(?::\d{2})?$/;

/** "09:30" → 570. `null` kad vrijeme nije čitljivo ili nije stvaran sat. */
export function uMinute(vrijeme: string): number | null {
  const pogodak = SAT_OBLIK.exec((vrijeme ?? '').trim());
  if (!pogodak) return null;
  const sati = Number(pogodak[1]);
  const minute = Number(pogodak[2]);
  if (sati > 23 || minute > 59) return null;
  return sati * 60 + minute;
}

/** 570 → "09:30". */
export function uSat(minute: number): string {
  const sati = Math.floor(minute / 60);
  const ostatak = minute % 60;
  return `${String(sati).padStart(2, '0')}:${String(ostatak).padStart(2, '0')}`;
}

/**
 * Kada počinje ZADNJI termin koji još cijeli stane u radno vrijeme.
 *
 * Ovo je odgovor na najobičnije pitanje koje bot dosad nije umio: „radimo do
 * 17:00, zadnji termin je u 16:40". Usluga koja ne stane ni u cijeli dan vraća
 * `null` — tada se o zadnjem terminu ne govori, umjesto da se izmisli sat.
 */
export function zadnjiMoguciTermin(
  radnoVrijeme: RadnoVrijemeDana,
  trajanjeMinuta: number,
): string | null {
  const pocetak = uMinute(radnoVrijeme?.pocetak ?? '');
  const kraj = uMinute(radnoVrijeme?.kraj ?? '');
  if (pocetak === null || kraj === null) return null;
  if (!Number.isFinite(trajanjeMinuta) || trajanjeMinuta <= 0) return null;
  if (kraj <= pocetak) return null;

  const zadnji = kraj - Math.floor(trajanjeMinuta);
  if (zadnji < pocetak) return null;
  return uSat(zadnji);
}

/** "09:00–17:00". */
export function opisRadnogVremena(radnoVrijeme: RadnoVrijemeDana): string {
  return `${radnoVrijeme.pocetak}–${radnoVrijeme.kraj}`;
}

/**
 * Radno vrijeme salona za jedan dan u sedmici (0 = nedjelja, kao u ugovoru).
 *
 * Kad tog dana radi više ljudi, salon je otvoren od najranijeg početka do
 * najkasnijeg kraja. Uz zadanog zaposlenika gleda se samo njegovo vrijeme.
 * `null` znači da tog dana niko ne radi — tada se o radnom vremenu ne govori.
 */
export function radnoVrijemeZaDan(
  radnoVrijeme: TenantContext['workingHours'],
  danUSedmici: number,
  staffMemberId?: string,
): RadnoVrijemeDana | null {
  let pocetak: number | null = null;
  let kraj: number | null = null;

  for (const red of radnoVrijeme ?? []) {
    if (red.weekday !== danUSedmici) continue;
    if (staffMemberId && red.staffMemberId !== staffMemberId) continue;
    const od = uMinute(red.startTime);
    const do_ = uMinute(red.endTime);
    if (od === null || do_ === null || do_ <= od) continue;
    if (pocetak === null || od < pocetak) pocetak = od;
    if (kraj === null || do_ > kraj) kraj = do_;
  }

  if (pocetak === null || kraj === null) return null;
  return { pocetak: uSat(pocetak), kraj: uSat(kraj) };
}

/** "2026-08-05" → 3 (srijeda), po ugovoru gdje je 0 = nedjelja. */
export function danUSedmici(datum: string, vremenskaZona: string): number | null {
  const dan = DateTime.fromISO((datum ?? '').trim(), { zone: vremenskaZona });
  return dan.isValid ? dan.weekday % 7 : null;
}

/** "u srijedu, 05.08." bez sata — dan o kojem se razgovara. */
function opisDana(datum: string, vremenskaZona: string): string | undefined {
  const dan = DateTime.fromISO((datum ?? '').trim(), { zone: vremenskaZona });
  if (!dan.isValid) return undefined;
  const opis = opisTermina(dan.startOf('day').toUTC().toISO() ?? '', vremenskaZona);
  const bezSata = opis.replace(/\s+u\s+\d{2}:\d{2}$/, '');
  return bezSata || undefined;
}

// ---------------------------------------------------------------------------
// Tehnički pojmovi u ljudski oblik
// ---------------------------------------------------------------------------

/**
 * Coreov `reason` sa HTTP 409 u rečenicu koju kupac smije vidjeti.
 * Interni pojmovi (`staffConflict` i ostali) ovdje se zaustavljaju.
 */
export function ljudskiRazlog(razlog: RazlogTermina | NepoznatRazlog): string {
  switch (razlog) {
    case 'staffConflict':
      return 'taj termin je u međuvremenu neko drugi uzeo';
    case 'outsideHours':
      return 'to vrijeme je izvan radnog vremena salona';
    case 'staffUnavailable':
      return 'radnik tada nije dostupan';
    case 'invalidTime':
      return 'vrijeme nije bilo dovoljno jasno napisano';
    // Razlog mora reći da je stvar u GRANICI, ne u satu. Bez toga izgovor
    // odbijenicu čita kao vremensku i doda objašnjenje o radnom vremenu, koje
    // ovdje nema veze ni sa čim i kupcu zvuči kao izmišljotina.
    case 'tooManyBookings':
      return 'kupac je već iskoristio koliko termina smije zakazati porukama';
    default:
      return 'taj termin nije moguće potvrditi';
  }
}

/** Interni naziv polja u riječ koju kupac razumije. */
export function ljudskiNazivPodatka(polje: string): string {
  const nazivi: Record<string, string> = {
    customer_name: 'ime na koje ide rezervacija',
    service: 'usluga',
    date: 'datum',
    end_date: 'datum odjave',
    start_time: 'sat',
    party_size: 'broj osoba',
    employee: 'zaposlenik',
    resource: 'resurs',
    room_type: 'vrsta smještaja',
    booking_id: 'broj rezervacije',
  };
  return nazivi[polje] ?? 'podatak koji nedostaje';
}

// ---------------------------------------------------------------------------
// Sastavljanje
// ---------------------------------------------------------------------------

export interface UlazCinjenica {
  vrsta: VrstaIshoda;
  tenant: TenantContext;
  /** "YYYY-MM-DD" u zoni salona, ako se razgovara o konkretnom danu. */
  datum?: string;
  usluga?: { naziv: string; trajanjeMinuta: number } | null;
  /** Slobodni termini onako kako ih je Core vratio. */
  slobodni?: SlobodanTermin[];
  /** Šta je kupac tražio, već izvedeno u prozor vremena. */
  zelja?: ZeljenoVrijeme | null;
  /** Sat koji je kupac izričito napisao ("14:30"). */
  trazeniSat?: string;
  /** Razlog odbijanja, već preveden u ljudski oblik. */
  razlog?: string;
  /** Interni naziv polja koje nedostaje. */
  faliPolje?: string;
  /** UTC ISO potvrđenog ili pomjerenog termina. */
  terminUtc?: string;
  /** Kad se gleda radno vrijeme jednog zaposlenika. */
  staffMemberId?: string;
}

/**
 * Pravi činjenice iz onoga što je backend već odlučio.
 *
 * Ništa se ovdje ne dohvata i ništa ne pretpostavlja: ako termina nema u
 * `slobodni`, tog sata nema ni u činjenicama, pa ga AI ne može izgovoriti.
 */
export function sastaviCinjenice(ulaz: UlazCinjenica): Cinjenice {
  const zona = ulaz.tenant.timezone;
  const cinjenice: Cinjenice = {
    vrsta: ulaz.vrsta,
    salon: ulaz.tenant.businessName,
    slobodniTermini: [],
  };

  const dan = ulaz.datum ? opisDana(ulaz.datum, zona) : undefined;
  if (dan) cinjenice.dan = dan;

  if (ulaz.usluga?.naziv) cinjenice.usluga = ulaz.usluga.naziv;
  if (ulaz.usluga && ulaz.usluga.trajanjeMinuta > 0) {
    cinjenice.trajanjeMinuta = ulaz.usluga.trajanjeMinuta;
  }

  const redniDan = ulaz.datum ? danUSedmici(ulaz.datum, zona) : null;
  const radno =
    redniDan === null
      ? null
      : radnoVrijemeZaDan(ulaz.tenant.workingHours, redniDan, ulaz.staffMemberId);
  if (radno) {
    cinjenice.radnoVrijeme = opisRadnogVremena(radno);
    const trajanje = ulaz.usluga?.trajanjeMinuta ?? 0;
    const zadnji = trajanje > 0 ? zadnjiMoguciTermin(radno, trajanje) : null;
    if (zadnji) cinjenice.zadnjiMoguciTermin = zadnji;
  }

  if (ulaz.slobodni && ulaz.slobodni.length > 0) {
    const izbor = izaberiTermine(ulaz.slobodni, zona, ulaz.zelja ?? null);
    cinjenice.slobodniTermini = satnice(izbor.ponudjeni, zona);
    if (izbor.mimoZelje) cinjenice.trazenoNijeSlobodno = true;
  }

  const trazio: TrazenoOdKupca = {};
  if (dan) trazio.dan = dan;
  if (ulaz.trazeniSat && uMinute(ulaz.trazeniSat) !== null) trazio.sat = ulaz.trazeniSat.trim();
  if (ulaz.zelja?.doba) trazio.dobaDana = ulaz.zelja.doba;
  if (Object.keys(trazio).length > 0) cinjenice.trazio = trazio;

  if (ulaz.razlog) cinjenice.razlog = ulaz.razlog;
  if (ulaz.faliPolje) cinjenice.faliPodatak = ljudskiNazivPodatka(ulaz.faliPolje);
  if (ulaz.terminUtc) {
    const opis = opisTermina(ulaz.terminUtc, zona);
    if (opis) cinjenice.termin = opis;
  }

  return cinjenice;
}
