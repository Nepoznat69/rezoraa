/**
 * ============================================================================
 * Riječi za korisnika
 * ============================================================================
 *
 * Jedino mjesto na kojem se tehnički ishodi pretvaraju u rečenice na bosanskom.
 *
 * Najvažniji dio su odbijanja sa HTTP 409 (`docs/INTERNAL_API_CONTRACT.md`).
 * Core javlja `staffConflict`, `staffUnavailable`, `outsideHours`,
 * `invalidTime` — to su interni pojmovi i korisnik ih ne smije nikada vidjeti.
 * Isto vrijedi za kvar Corea: korisnik dobija ljudsku poruku da pokušamo
 * kasnije, nikad status kod i nikad tišinu.
 *
 * 409 se po ugovoru NE PONAVLJA. Zato uz odbijanje ide ponuda alternativa iz
 * već dohvaćene liste slobodnih termina, a ne novi pokušaj istog termina.
 *
 * Ovdje se ne loguje ništa i ne dodiruje se ni mreža ni baza — sve su funkcije
 * čiste, pa se mogu testirati bez ijednog mocka.
 * ============================================================================
 */

import { DateTime } from 'luxon';
import type {
  NepoznatRazlog,
  RazlogOtkazivanja,
  RazlogTermina,
  SlobodanTermin,
} from '../core-api/core-klijent.js';

/** Core nije odgovorio (mreža, rok, 5xx, neispravna konfiguracija). */
export const PORUKA_CORE_NEDOSTUPAN =
  'Trenutno ne mogu doći do našeg rasporeda. Molim vas pokušajte ponovo za nekoliko minuta.';

/** Nešto je puklo kod nas (baza, AI sloj). Korisnik ne smije ostati bez odgovora. */
export const PORUKA_TEHNICKI_PROBLEM =
  'Izvinite, trenutno imamo tehnički problem. Molim vas pokušajte ponovo za nekoliko minuta.';

/** Razgovor je predat čovjeku. */
export const PORUKA_PREUZEO_COVJEK =
  'Vašu poruku sam proslijedio zaposleniku. Javit će vam se čim bude dostupan.';

/** Poruka koju gateway ne razumije. */
export const PORUKA_NERAZUMIJEVANJE =
  'Nisam potpuno razumio poruku. Možete li je kratko preformulisati ili zatražiti zaposlenika?';

/** Akuzativ, jer se dan uvijek piše iza "u": "u srijedu", "u subotu". */
const DANI = [
  'nedjelju',
  'ponedjeljak',
  'utorak',
  'srijedu',
  'četvrtak',
  'petak',
  'subotu',
] as const;

/** "14:30" u vremenskoj zoni biznisa. Prazan string ako trenutak nije čitljiv. */
export function sat(utcIso: string, vremenskaZona: string): string {
  const trenutak = DateTime.fromISO(utcIso, { zone: vremenskaZona });
  return trenutak.isValid ? trenutak.toFormat('HH:mm') : '';
}

/** "u petak, 05.08. u 14:30" — dan se piše da se termin ne pomiješa sa drugim. */
export function opisTermina(utcIso: string, vremenskaZona: string): string {
  const trenutak = DateTime.fromISO(utcIso, { zone: vremenskaZona });
  if (!trenutak.isValid) return '';
  const dan = DANI[trenutak.weekday % 7];
  return `u ${dan}, ${trenutak.toFormat('dd.MM.')} u ${trenutak.toFormat('HH:mm')}`;
}

/**
 * Nabraja najviše tri slobodna sata. Više od toga se u WhatsApp poruci ne čita.
 */
export function nabrojTermine(
  termini: SlobodanTermin[],
  vremenskaZona: string,
  koliko = 3,
): string {
  const satnice: string[] = [];
  for (const termin of termini) {
    const vrijeme = sat(termin.startAt, vremenskaZona);
    if (vrijeme && !satnice.includes(vrijeme)) satnice.push(vrijeme);
    if (satnice.length >= koliko) break;
  }
  if (satnice.length === 0) return '';
  if (satnice.length === 1) return satnice[0];
  return `${satnice.slice(0, -1).join(', ')} i ${satnice[satnice.length - 1]}`;
}

/**
 * Šta je kupac tražio kad kaže „popodne", „oko 17h" ili „može li kasnije".
 * Minute su od ponoći, u zoni salona.
 */
export interface ZeljenoVrijeme {
  odMinuta?: number;
  doMinuta?: number;
  /** Traži kasnije nego što smo ponudili, bez konkretnog sata. */
  kasnije?: boolean;
}

function minuteTermina(termin: SlobodanTermin, vremenskaZona: string): number | null {
  const d = DateTime.fromISO(termin.startAt, { zone: 'utc' }).setZone(vremenskaZona);
  return d.isValid ? d.hour * 60 + d.minute : null;
}

/**
 * Prevodi ono što je AI izvukao u vremenski prozor.
 *
 * Bez ovoga se kupcu na „može li kasnije" i „imate li u 17h" vraćala ista tri
 * jutarnja termina, pa je djelovalo kao da ga niko ne sluša.
 */
export function zeljeniProzor(startTime: string, izraz: string): ZeljenoVrijeme | null {
  const tacno = /^(\d{1,2}):(\d{2})$/.exec((startTime ?? '').trim());
  if (tacno) {
    const m = Number(tacno[1]) * 60 + Number(tacno[2]);
    // Sat i po oko traženog: dovoljno da ponudi blizu, a ne cijeli dan.
    return { odMinuta: Math.max(0, m - 90), doMinuta: m + 90 };
  }

  const tekst = (izraz ?? '')
    .toLocaleLowerCase('bs')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '');
  if (!tekst) return null;

  if (/kasnij|poslije|nakon/.test(tekst)) return { kasnije: true };
  if (/prije podne|prijepodne|ujutro|jutro|rano/.test(tekst)) return { doMinuta: 12 * 60 };
  if (/navece|uvece|vece/.test(tekst)) return { odMinuta: 16 * 60 };
  if (/popodne|poslije podne|poslijepodne/.test(tekst)) return { odMinuta: 12 * 60 };
  return null;
}

function uProzoru(
  termini: SlobodanTermin[],
  vremenskaZona: string,
  zelja: ZeljenoVrijeme | null,
): SlobodanTermin[] {
  if (!zelja || zelja.kasnije) return termini;
  return termini.filter((t) => {
    const m = minuteTermina(t, vremenskaZona);
    if (m === null) return false;
    if (zelja.odMinuta !== undefined && m < zelja.odMinuta) return false;
    if (zelja.doMinuta !== undefined && m > zelja.doMinuta) return false;
    return true;
  });
}

/**
 * Rečenica sa ponudom termina.
 *
 * Kad je kupac tražio određeno doba dana, nudi se ono što tu stvarno postoji.
 * Ako u tom dijelu dana nema ničega, to se KAŽE i ponudi se najbliže — umjesto
 * da se treći put ponovi ista jutarnja lista.
 */
export function ponudaAlternativa(
  termini: SlobodanTermin[],
  vremenskaZona: string,
  zelja: ZeljenoVrijeme | null = null,
): string {
  if (termini.length === 0) {
    return 'Tog dana nemam više slobodnih termina. Recite mi koji drugi dan bi vam odgovarao.';
  }

  // „Može li kasnije" — nudi se kraj dana, ne opet početak.
  if (zelja?.kasnije) {
    const spisak = nabrojTermine(termini.slice(-3), vremenskaZona);
    return `Kasnije tog dana slobodno je: ${spisak}. Odgovara li vam neki od tih termina?`;
  }

  const uzi = uProzoru(termini, vremenskaZona, zelja);
  if (uzi.length > 0) {
    return `Slobodno je: ${nabrojTermine(uzi, vremenskaZona)}. Odgovara li vam neki od tih termina?`;
  }

  // Tražio je doba dana u kojem ničega nema. Reci to jasno i ponudi najbliže.
  const zadnjiSat = sat(termini[termini.length - 1].startAt, vremenskaZona);
  const najblizi = zelja?.odMinuta !== undefined ? termini.slice(-3) : termini.slice(0, 3);
  const spisak = nabrojTermine(najblizi, vremenskaZona);
  return (
    `U to vrijeme nemamo slobodno — zadnji termin tog dana je u ${zadnjiSat}. ` +
    `Slobodno je: ${spisak}. Odgovara li vam neki od tih termina?`
  );
}

/**
 * Odbijenica Corea (HTTP 409 na kreiranju ili pomjeranju termina) u rečenicu.
 *
 * `alternative` su termini koji su ostali slobodni iz iste, već dohvaćene
 * liste — nigdje se ne šalje novi zahtjev za isti termin.
 */
export function porukaZaOdbijenTermin(
  razlog: RazlogTermina | NepoznatRazlog,
  alternative: SlobodanTermin[],
  vremenskaZona: string,
  zelja: ZeljenoVrijeme | null = null,
): string {
  const ponuda = ponudaAlternativa(alternative, vremenskaZona, zelja);

  switch (razlog) {
    case 'staffConflict':
      return `Taj termin je upravo zauzet. ${ponuda}`;
    case 'outsideHours':
      return `To vrijeme je izvan našeg radnog vremena. ${ponuda}`;
    case 'staffUnavailable':
      return `Radnik tada nije dostupan. ${ponuda}`;
    case 'invalidTime':
      return 'To vrijeme nisam mogao ispravno pročitati. Molim vas napišite dan i sat, na primjer "sutra u 14:30".';
    default:
      return `Taj termin nažalost ne mogu potvrditi. ${ponuda}`;
  }
}

/** Odbijenica Corea na otkazivanju termina. */
export function porukaZaOdbijenoOtkazivanje(
  razlog: RazlogOtkazivanja | NepoznatRazlog,
): string {
  if (razlog === 'alreadyTerminal') {
    return 'Taj termin je već otkazan ili je u međuvremenu završen, pa nema šta da se otkazuje.';
  }
  return 'Otkazivanje trenutno nije prošlo. Proslijedio sam vašu poruku zaposleniku, javit će vam se.';
}

/** Traženi sat nije među slobodnim terminima — nema poziva prema Coreu. */
export function porukaZaZauzetTermin(
  alternative: SlobodanTermin[],
  vremenskaZona: string,
  zelja: ZeljenoVrijeme | null = null,
): string {
  return `Taj termin nije slobodan. ${ponudaAlternativa(alternative, vremenskaZona, zelja)}`;
}

/** Potvrda zakazanog termina. */
export function porukaZaPotvrdjenTermin(
  utcIso: string,
  vremenskaZona: string,
  nazivUsluge: string,
): string {
  const kada = opisTermina(utcIso, vremenskaZona);
  const usluga = nazivUsluge.trim() ? ` (${nazivUsluge.trim()})` : '';
  return `Termin je zakazan ${kada}${usluga}. Vidimo se!`;
}

/** Potvrda pomjerenog termina. */
export function porukaZaPomjerenTermin(utcIso: string, vremenskaZona: string): string {
  return `Termin je pomjeren ${opisTermina(utcIso, vremenskaZona)}. Vidimo se!`;
}
