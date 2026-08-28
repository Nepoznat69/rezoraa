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
  TerminKupca,
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

/**
 * Jedina poruka koju prigušen kontakt dobije — i to najviše jednom u deset
 * minuta.
 *
 * Ne kaže se ni koja je granica ni koliko je ostalo: broj bi bio uputstvo kako
 * da se granica taman izbjegne. Ne nudi se ni alternativa, jer je jedina
 * ispravna radnja sačekati.
 */
export const PORUKA_PREBRZO =
  'Stiglo je puno poruka odjednom, pa ne stižem odgovoriti na svaku. ' +
  'Napišite mi u jednoj poruci šta Vam treba i javljam se čim mognem.';

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
 * Satnice najviše `koliko` termina, bez ponavljanja istog sata.
 *
 * Isti izbor koriste i šablonska rečenica i činjenice koje ide AI sloju
 * (`cinjenice.ts`), da se ne razilaze: AI ne smije dobiti sat koji šablon ne bi
 * ponudio.
 */
export function satnice(
  termini: SlobodanTermin[],
  vremenskaZona: string,
  koliko = 3,
): string[] {
  const izabrane: string[] = [];
  for (const termin of termini) {
    const vrijeme = sat(termin.startAt, vremenskaZona);
    if (vrijeme && !izabrane.includes(vrijeme)) izabrane.push(vrijeme);
    if (izabrane.length >= koliko) break;
  }
  return izabrane;
}

/**
 * Nabraja najviše tri slobodna sata. Više od toga se u WhatsApp poruci ne čita.
 */
export function nabrojTermine(
  termini: SlobodanTermin[],
  vremenskaZona: string,
  koliko = 3,
): string {
  const izabrane = satnice(termini, vremenskaZona, koliko);
  if (izabrane.length === 0) return '';
  if (izabrane.length === 1) return izabrane[0];
  return `${izabrane.slice(0, -1).join(', ')} i ${izabrane[izabrane.length - 1]}`;
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
  /** Doba dana imenovano ljudski, za činjenice koje ide AI sloju. */
  doba?: DobaDana;
  /** Sat koji je kupac izričito naveo, u minutama od ponoći. */
  ciljMinuta?: number;
}

/** Doba dana koje je kupac imenovao, bez konkretnog sata. */
export type DobaDana = 'jutro' | 'popodne' | 'navečer' | 'kasnije';

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
    return { odMinuta: Math.max(0, m - 90), doMinuta: m + 90, ciljMinuta: m };
  }

  const tekst = (izraz ?? '')
    .toLocaleLowerCase('bs')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '');
  if (!tekst) return null;

  if (/kasnij|poslije|nakon/.test(tekst)) return { kasnije: true, doba: 'kasnije' };
  if (/prije podne|prijepodne|ujutro|jutro|rano/.test(tekst)) {
    return { doMinuta: 12 * 60, doba: 'jutro' };
  }
  if (/navece|uvece|vece/.test(tekst)) return { odMinuta: 16 * 60, doba: 'navečer' };
  if (/popodne|poslije podne|poslijepodne/.test(tekst)) {
    return { odMinuta: 12 * 60, doba: 'popodne' };
  }
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

/** Šta se od slobodnih termina zaista nudi kupcu. */
export interface IzborTermina {
  /** Termini koje smijemo ponuditi, u redoslijedu u kojem se izgovaraju. */
  ponudjeni: SlobodanTermin[];
  /** Kupac je tražio doba dana u kojem nema ničega — to mu se mora reći. */
  mimoZelje: boolean;
}

/**
 * Bira koje termine kupac dobija, na osnovu onoga što je tražio.
 *
 * JEDINO mjesto tog izbora. Šablonska rečenica i činjenice za AI sloj zovu istu
 * funkciju, pa AI ne može dobiti sat koji šablon ne bi ponudio.
 */
export function izaberiTermine(
  termini: SlobodanTermin[],
  vremenskaZona: string,
  zelja: ZeljenoVrijeme | null = null,
): IzborTermina {
  if (termini.length === 0) return { ponudjeni: [], mimoZelje: false };

  // „Može li kasnije" — nudi se kraj dana, ne opet početak.
  if (zelja?.kasnije) return { ponudjeni: termini.slice(-3), mimoZelje: false };

  const uzi = uProzoru(termini, vremenskaZona, zelja);
  if (uzi.length > 0) {
    return { ponudjeni: odTrazenogSata(uzi, vremenskaZona, zelja?.ciljMinuta), mimoZelje: false };
  }

  // Tražio je doba dana u kojem ničega nema; nudi se najbliže tom dobu.
  const najblizi = zelja?.odMinuta !== undefined ? termini.slice(-3) : termini.slice(0, 3);
  return { ponudjeni: najblizi, mimoZelje: true };
}

/**
 * Kad je kupac naveo sat, ponuda kreće od prvog termina koji nije prije njega.
 *
 * Prozor oko traženog sata je širok sat i po na obje strane, pa bi puko uzimanje
 * prva tri termina na „12:55" ponudilo 11:30 — sat i po ranije, iako 13:00 stoji
 * slobodno pet minuta kasnije. Kupac to čita kao da ga niko nije slušao.
 *
 * Ako poslije traženog sata nema ničega, nudi se ono najbliže prije njega.
 */
function odTrazenogSata(
  termini: SlobodanTermin[],
  vremenskaZona: string,
  ciljMinuta: number | undefined,
): SlobodanTermin[] {
  if (ciljMinuta === undefined) return termini;
  const prvi = termini.findIndex((t) => {
    const m = minuteTermina(t, vremenskaZona);
    return m !== null && m >= ciljMinuta;
  });
  return prvi === -1 ? termini.slice(-3) : termini.slice(prvi);
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

  const izbor = izaberiTermine(termini, vremenskaZona, zelja);
  const spisak = nabrojTermine(izbor.ponudjeni, vremenskaZona);

  if (izbor.mimoZelje) {
    const zadnjiSat = sat(termini[termini.length - 1].startAt, vremenskaZona);
    return (
      `U to vrijeme nemamo slobodno — zadnji termin tog dana je u ${zadnjiSat}. ` +
      `Slobodno je: ${spisak}. Odgovara li vam neki od tih termina?`
    );
  }

  if (zelja?.kasnije) {
    return `Kasnije tog dana slobodno je: ${spisak}. Odgovara li vam neki od tih termina?`;
  }

  return `Slobodno je: ${spisak}. Odgovara li vam neki od tih termina?`;
}

/**
 * Razlozi kod kojih ponuda drugih termina nema smisla.
 *
 * Kod ovih odbijenica problem nije u satu nego u nečemu što nijedan drugi sat
 * ne mijenja: granica koju je kupac iscrpio, ili vrijeme koje se nije dalo
 * pročitati. Spisak slobodnih termina tu je poziv da kupac pokuša ponovo i
 * ponovo dobije isto.
 *
 * Postoji kao izvezena konstanta, a ne kao uslov na dva mjesta, jer se to već
 * jednom raspalo: šablon je prestao nuditi termine, ali su činjenice AI sloju
 * i dalje išle sa spiskom — pa je kupac dobio ponudu koju šablon nije htio
 * dati, i uz nju izmišljeno objašnjenje o radnom vremenu.
 */
export const RAZLOZI_BEZ_ALTERNATIVA: ReadonlySet<string> = new Set([
  'invalidTime',
  'tooManyBookings',
]);

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
    // Bez ponude alternativa: nijedan drugi sat nece proci, pa bi spisak
    // termina ovdje bio poziv da kupac pokusa ponovo i ponovo dobije isto.
    case 'tooManyBookings':
      return (
        'Već imate zakazano onoliko termina koliko mogu potvrditi putem poruka. ' +
        'Ako želite još jedan, javite se salonu — ili mi recite da neki od ' +
        'postojećih pomjerim ili otkažem.'
      );
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
export function porukaZaPomjerenTermin(
  utcIso: string,
  vremenskaZona: string,
  kod = '',
  gost = '',
): string {
  // U grupi je "Vas termin je pomjeren" premalo: kupac ima dva i ne zna koji
  // se pomjerio. Broj i ime gosta se dopisuju samo kad postoje, pa obican
  // termin za jednu osobu i dalje zvuci kao prije.
  const ciji = gost.trim() ? ` za ${gost.trim()}` : '';
  const oznaka = kod.trim() ? ` (broj ${kod.trim()})` : '';
  return `Termin${ciji}${oznaka} je pomjeren ${opisTermina(utcIso, vremenskaZona)}. Vidimo se!`;
}

/**
 * Kupac vec ima termin tog dana.
 *
 * Ne ide kroz AI nego ostaje sablon: jedina brojka u recenici je sat termina
 * koji kupac vec ima, a provjera izmisljenog u `izgovor.ts` propusta samo
 * satove iz cinjenica. Sablon je ovdje i tacan i dovoljno topao.
 */
export function porukaZaVecZauzetDan(utcIso: string, vremenskaZona: string): string {
  return (
    `Već imate termin ${opisTermina(utcIso, vremenskaZona)}. ` +
    'Mogu ga pomjeriti na drugo vrijeme ili otkazati — recite šta vam odgovara.'
  );
}

/**
 * Kupac je imenovao uslugu koju salon ne radi.
 *
 * Ranije je takav odgovor padao u „fali podatak" i kupac je iznova dobijao
 * „Koju uslugu zelite?" — bez rijeci o tome zasto. Ovdje se kaze i sta ne
 * radimo i sta radimo, pa razgovor ide dalje umjesto u krug.
 *
 * Sablon namjerno: jedina imena u recenici su ona iz Coreovog spiska usluga.
 */
export function porukaZaNepoznatuUslugu(trazena: string, usluge: string[]): string {
  const spisak = usluge.map((naziv) => naziv.toLocaleLowerCase('bs'));
  const nabrojane =
    spisak.length > 1
      ? `${spisak.slice(0, -1).join(', ')} i ${spisak[spisak.length - 1]}`
      : spisak[0];
  return (
    `${trazena.trim()} nažalost ne radimo. ` +
    `Kod nas možete zakazati ${nabrojane}. Šta vam od toga odgovara?`
  );
}

/**
 * Pitanje prije otkazivanja.
 *
 * Otkazivanje se ne poništava, pa kupac mora vidjeti KOJI termin nestaje prije
 * nego što nestane. Broj termina je tu da se dva termina ne pomiješaju.
 *
 * Šablon, ne AI: jedina brojka je sat termina koji stvarno postoji, a rečenica
 * mora biti ista svaki put — na pitanje koje briše podatak ne ide improvizacija.
 */
export function porukaZaPotvrduOtkazivanja(
  kod: string,
  utcIso: string,
  vremenskaZona: string,
  gost = '',
): string {
  const oznaka = kod.trim() ? ` (broj ${kod.trim()})` : '';
  const ciji = gost.trim() ? ` za ${gost.trim()}` : '';
  return (
    `Otkazujem termin${ciji} ${opisTermina(utcIso, vremenskaZona)}${oznaka}. ` +
    'Jeste li sigurni? Odgovorite sa "da" ako želite da ga poništim.'
  );
}

/** Jedan član grupe u potvrdi. */
export interface ClanZaPotvrdu {
  ime: string;
  kod: string;
  pocetak: string;
  usluge: string[];
}

/**
 * Potvrda grupne rezervacije.
 *
 * Šablon, ne AI: svaki član mora dobiti svoj broj termina i svoje vrijeme, a
 * model bi na dužoj listi neminovno nešto izostavio. Kupac ovo čita kad dođe
 * kod frizera, pa mora biti tačno.
 */
export function porukaZaGrupu(
  clanovi: ClanZaPotvrdu[],
  vremenskaZona: string,
): string {
  const redovi = clanovi.map((clan) => {
    const ko = clan.ime.trim() || 'Vi';
    const usluge = clan.usluge.length ? ` — ${clan.usluge.join(' + ').toLocaleLowerCase('bs')}` : '';
    const broj = clan.kod ? ` (broj ${clan.kod})` : '';
    return `• ${ko}: ${sat(clan.pocetak, vremenskaZona)}${usluge}${broj}`;
  });

  const kada = clanovi.length ? opisTermina(clanovi[0].pocetak, vremenskaZona) : '';
  return `Zakazano ${kada}:\n${redovi.join('\n')}\n\nVidimo se!`;
}

/**
 * Pitanje prije otkazivanja VISE termina odjednom.
 *
 * Grupa se zakaze jednom porukom, pa se mora moci i otkazati jednom porukom.
 * Svaki clan se imenuje sa svojim brojem — kupac mora vidjeti sta tacno
 * nestaje prije nego potvrdi.
 */
export function porukaZaPotvrduOtkazivanjaVise(
  clanovi: Array<{ kod: string; ime: string; pocetak: string }>,
  vremenskaZona: string,
): string {
  const redovi = clanovi.map((clan) => {
    const ko = clan.ime.trim() ? `${clan.ime.trim()}: ` : '';
    const broj = clan.kod.trim() ? ` (broj ${clan.kod.trim()})` : '';
    return `• ${ko}${opisTermina(clan.pocetak, vremenskaZona)}${broj}`;
  });
  return (
    `Otkazujem sve vaše termine:\n${redovi.join('\n')}\n\n` +
    'Jeste li sigurni? Odgovorite sa "da" ako želite da ih poništim.'
  );
}

/**
 * Spisak kupčevih budućih termina.
 *
 * ZAŠTO IDE ŠABLONOM, BEZ AI SLOJA
 *   Ovo je čist ispis činjenica: dan, sat, usluga, broj. AI sloj postoji da
 *   rečenica zvuči ljudski, ali ovdje nema šta da se ublaži — a svaki njegov
 *   dodir nosi rizik da neki sat ispadne drugačiji nego što u bazi stoji.
 *   Kupac koji provjerava termine treba tačnost, ne toplinu.
 *
 * ZAŠTO BROJ TERMINA UZ SVAKI
 *   Bez njega kupac nema čime pokazati na koji misli kad zatraži pomjeranje
 *   ili otkazivanje — a opis dva termina istog dana ne razlikuje pouzdano.
 *   Isti razlog zbog kojeg ga ispisuje i `nadjiTerminKupca`.
 *
 * ZAŠTO NAJVIŠE PET
 *   Duža poruka na WhatsAppu se skraćuje i kupac ionako ne čita spisak od
 *   deset stavki. Ko ih ima više, tome se to i kaže.
 */
export function porukaZaMojeTermine(termini: TerminKupca[], vremenskaZona: string): string {
  if (termini.length === 0) {
    return (
      'Na ovaj broj ne vidim nijedan budući termin. ' +
      'Ako želite da vas upišem, recite mi uslugu i kada vam odgovara.'
    );
  }

  const spisak = termini
    .slice(0, 5)
    .map((termin) => {
      const ko = termin.ime.trim() ? `${termin.ime.trim()}: ` : '';
      const usluga = termin.usluga ? ` — ${termin.usluga.toLocaleLowerCase('bs')}` : '';
      const broj = termin.kod ? ` (broj ${termin.kod})` : '';
      return `• ${ko}${opisTermina(termin.pocetak, vremenskaZona)}${usluga}${broj}`;
    })
    .join('\n');

  const uvod = termini.length === 1 ? 'Evo vašeg termina:' : 'Evo vaših termina:';
  const visak =
    termini.length > 5 ? `\n\nImate ih ukupno ${termini.length}; ovo je prvih pet.` : '';

  // "ili dan": broj je pouzdan ali ga niko ne pamti, a dan pamte svi. Otkazivanje
  // i pomjeranje prihvataju oboje, pa se kupcu i nude oboje.
  return `${uvod}\n${spisak}${visak}\n\nAko nešto treba pomjeriti ili otkazati, recite mi broj termina ili dan.`;
}
