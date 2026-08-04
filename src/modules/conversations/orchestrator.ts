/**
 * ============================================================================
 * Orkestrator razgovora
 * ============================================================================
 *
 * Gateway je KANAL, a ne sistem evidencije. Sve što je poslovni podatak —
 * termini, usluge, osoblje, razgovori i poruke — živi u Rezora Coreu:
 *
 *   * kontekst biznisa:      src/modules/core-kontekst/kontekst.ts
 *   * termini:               src/modules/core-api/core-klijent.ts (interni API)
 *   * razgovori i poruke:    src/modules/core-baza/core-repozitorij.ts
 *
 * U lokalnoj bazi ostaju samo `inbound_events` (red čekanja) i `channels`
 * (WhatsApp pristupi samog gatewaya). Zaključavanje razgovora i dalje ide preko
 * lokalnog Postgresa, jer je i ono osobina reda čekanja, a ne poslovni podatak.
 *
 * PRAVILA
 *   1. `business_id` je izričit u svakom pozivu prema Coreu.
 *   2. HTTP 409 se NIKAD ne ponavlja; pretvara se u ljudsku rečenicu i, gdje
 *      ima smisla, u ponudu drugih termina iz VEĆ dohvaćene liste.
 *   3. Ako Core (API ili baza) nije dostupan, korisnik dobija ljudsku poruku da
 *      pokušamo kasnije. Nikad tehnička greška i nikad tišina.
 *   4. U logove ne ide telefon, sadržaj poruke ni ključ — samo identifikatori.
 * ============================================================================
 */

import { DateTime } from 'luxon';
import { computeMissingFields, questionForMissingField } from '../../domain/booking-rules.js';
import { resolveBookingInterval, resolveBosnianDate } from '../../domain/date-resolver.js';
import {
  type AiExtraction,
  type NormalizedMessage,
  type ServiceDefinition,
  type TenantContext,
} from '../../domain/schemas.js';
import { config } from '../../config.js';
import { withConversationLock } from '../../infrastructure/database.js';
import { logger } from '../../lib/logger.js';
import { AiExtractor } from '../ai/extractor.js';
import {
  napraviGrupu,
  napraviTermin,
  otkaziTermin,
  pomjeriTermin,
  nadolazeciTermini,
  slobodniTermini,
  type SlobodanTermin,
} from '../core-api/core-klijent.js';
import {
  cekanaRadnja,
  zapamtiCekanuRadnju,
  type CekanaRadnja,
  historijaRazgovora,
  nadjiIliNapraviRazgovor,
  preuzeoCovjek,
  stanjeRazgovora,
  vratiBotaAkoNikoNijeOdgovorio,
  zapisiDolaznuPoruku,
  zapisiOdlaznuPoruku,
} from '../core-baza/core-repozitorij.js';
import { kontekstZaBiznis } from '../core-kontekst/kontekst.js';
import { ljudskiRazlog, sastaviCinjenice, type UlazCinjenica } from './cinjenice.js';
import { izgovori } from './izgovor.js';
import {
  PORUKA_CORE_NEDOSTUPAN,
  PORUKA_NERAZUMIJEVANJE,
  PORUKA_PREUZEO_COVJEK,
  PORUKA_TEHNICKI_PROBLEM,
  opisTermina,
  ponudaAlternativa,
  zeljeniProzor,
  type ZeljenoVrijeme,
  porukaZaGrupu,
  type ClanZaPotvrdu,
  porukaZaOdbijenTermin,
  porukaZaOdbijenoOtkazivanje,
  porukaZaPomjerenTermin,
  porukaZaNepoznatuUslugu,
  porukaZaPotvrduOtkazivanja,
  porukaZaPotvrdjenTermin,
  porukaZaVecZauzetDan,
  porukaZaZauzetTermin,
} from './poruke.js';

export interface OrchestrationResult {
  reply: string;
  duplicate: boolean;
  handoff: boolean;
  intent: AiExtraction['intent'];
  extraction?: AiExtraction;
  booking?: {
    /** UUID termina u Coreu. */
    appointmentId?: string;
    /** false = isti `idempotency_key` je već bio obrađen. */
    created?: boolean;
    /** Ishod provjere dostupnosti. */
    available?: boolean;
  };
}

const UUID_OBLIK = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Trajanje termina kad usluga nije prepoznata (npr. golo pomjeranje termina). */
const PODRAZUMIJEVANO_TRAJANJE = 30;

function jeUuid(vrijednost: string | undefined): vrijednost is string {
  return typeof vrijednost === 'string' && UUID_OBLIK.test(vrijednost.trim());
}

function opisGreske(greska: unknown): string {
  return greska instanceof Error ? greska.message : String(greska);
}

function normalize(value: string): string {
  return value
    .toLocaleLowerCase('bs')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim();
}

function selectService(
  context: TenantContext,
  requested: string,
): TenantContext['services'][number] | null {
  if (!requested && context.services.length === 1) return context.services[0];
  const wanted = normalize(requested);
  if (!wanted) return null;
  return (
    context.services.find((service) => normalize(service.name) === wanted) ??
    context.services.find(
      (service) =>
        normalize(service.name).includes(wanted) || wanted.includes(normalize(service.name)),
    ) ??
    null
  );
}

/**
 * Coreova usluga u oblik koji traže `booking-rules` i `date-resolver`.
 * `locationId` ne postoji u internom ugovoru, pa je uvijek `null`.
 */
function mapService(
  tenant: TenantContext,
  service: TenantContext['services'][number],
): ServiceDefinition {
  return {
    id: service.id,
    tenantId: tenant.tenantId,
    locationId: null,
    name: service.name,
    bookingModel: service.bookingModel,
    defaultDurationMinutes: service.defaultDurationMinutes,
    bufferBeforeMinutes: service.bufferBeforeMinutes,
    bufferAfterMinutes: service.bufferAfterMinutes,
    requiresEmployee: service.requiresEmployee,
    requiresResource: service.requiresResource,
    capacityMode: service.capacityMode,
    configuration: service.configuration,
  };
}

/** Zamjenska usluga kad je poznato samo vrijeme (pomjeranje bez naziva usluge). */
function zamjenskaUsluga(tenant: TenantContext): ServiceDefinition {
  return {
    id: '',
    tenantId: tenant.tenantId,
    locationId: null,
    name: '',
    bookingModel: 'appointment',
    defaultDurationMinutes: PODRAZUMIJEVANO_TRAJANJE,
    bufferBeforeMinutes: 0,
    bufferAfterMinutes: 0,
    requiresEmployee: false,
    requiresResource: false,
    capacityMode: 'none',
    configuration: {},
  };
}

/** Zaposlenik kojeg je korisnik imenovao, ako ga uopšte ima u Coreu. */
function selectEmployee(tenant: TenantContext, requested: string): string | undefined {
  const wanted = normalize(requested);
  if (!wanted) return undefined;
  const employee =
    tenant.employees.find((kandidat) => normalize(kandidat.name) === wanted) ??
    tenant.employees.find((kandidat) => normalize(kandidat.name).includes(wanted));
  return employee?.id;
}

interface Okvir {
  businessId: string;
  conversationId: string;
  tenant: TenantContext;
  message: NormalizedMessage;
  extraction: AiExtraction;
}

/**
 * Je li kupac potvrdio ono što je asistent pitao.
 *
 * Namjerno kratka i doslovna lista. Ovo je pitanje na koje odgovor briše
 * termin, pa se ne pogađa: sve što nije jasno "da" tretira se kao nova poruka,
 * a ne kao pristanak.
 */
function jePotvrda(tekst: string): boolean {
  const t = tekst
    .toLocaleLowerCase('bs')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z ]/g, ' ')
    .trim();
  return /^(da|da da|dada|tako je|potvrdujem|potvrda|moze|ok|okej|u redu|jeste|naravno|slazem se|jesam siguran|siguran sam)$/.test(
    t,
  );
}

/**
 * Broj termina koji je kupac napisao, ako odgovara nekom njegovom terminu.
 *
 * Uporedjuje se samo sa terminima TOG kupca, pa pogodak ne moze pokazati na
 * tudji termin ni kad neko pogodi ili prepise tudji kod.
 *
 * Bez kvacica i bez razlike u velicini slova: ljudi kod prepisuju kako stignu.
 */
function kodIzPoruke<T extends { kod: string }>(tekst: string, termini: T[]): T | null {
  const gore = tekst.toUpperCase();
  return (
    termini.find((termin) => {
      const kod = termin.kod.trim().toUpperCase();
      // Kod je najmanje cetiri znaka; kraci bi se slucajno nasao u obicnoj rijeci.
      return kod.length >= 4 && gore.includes(kod);
    }) ?? null
  );
}

/** Je li kupac odustao od onoga što je asistent pitao. */
function jeOdustajanje(tekst: string): boolean {
  const t = tekst
    .toLocaleLowerCase('bs')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z ]/g, ' ')
    .trim();
  return /^(ne|nemoj|odustajem|ipak ne|ne hvala|nista|pusti|otkazi to)$/.test(t);
}

/** Koji termin kupac misli: nađen, treba pitati, ili Core ne odgovara. */
type NadjenTermin =
  | { vrsta: 'nadjen'; appointmentId: string; kod: string; pocetak: string }
  | { vrsta: 'pitanje'; tekst: string }
  | { vrsta: 'nedostupno' };

/**
 * Doba dana koje je kupac tražio, za ponudu alternativa.
 *
 * Uz ono što je AI izdvojio gleda se i sirova poruka: AI popunjava
 * `start_time_expression` samo kad ima konkretan sat, pa bi „može li kasnije"
 * i „a popodne" inače prošli kao da vrijeme nije ni spomenuto — i kupac bi na
 * svako pitanje dobio ista tri jutarnja termina.
 */
function zeljaKupca(okvir: Okvir): ZeljenoVrijeme | null {
  return zeljeniProzor(
    okvir.extraction.start_time,
    okvir.extraction.start_time_expression || okvir.message.text,
  );
}

/**
 * Broj termina se dopisuje na kraj, a ne prepušta AI sloju.
 *
 * Kupac ga mora dobiti svaki put — po njemu poslije otkazuje i pomjera. Da je
 * dio rečenice koju sastavlja model, model bi ga povremeno izostavio, a kupac
 * bez broja nema šta ni pročitati kad se javi.
 */
function saBrojemTermina(tekst: string, kod: string): string {
  const ocisceno = kod.trim();
  if (!ocisceno) return tekst;
  return `${tekst}

Broj vašeg termina: ${ocisceno}`;
}

/**
 * Je li kupac tražio nešto što jedan običan termin ne pokriva.
 *
 * Dva slučaja: dolazi još neko, ili jedna osoba hoće više usluga. Sve ostalo
 * ide starim putem — a to je i dalje ogromna većina poruka, pa se najčešći tok
 * ne dira.
 */
function jeGrupnaPosjeta(extraction: AiExtraction): boolean {
  const ucesnici = extraction.participants ?? [];
  if (ucesnici.length > 1) return true;
  return ucesnici.length === 1 && ucesnici[0].services.length > 1;
}

/** Naziv i trajanje usluge za činjenice; bez usluge se o njoj ne govori. */
function uslugaZaCinjenice(
  usluga: { name: string; defaultDurationMinutes: number } | null | undefined,
): { naziv: string; trajanjeMinuta: number } | null {
  if (!usluga || !usluga.name.trim()) return null;
  return { naziv: usluga.name.trim(), trajanjeMinuta: usluga.defaultDurationMinutes };
}

/**
 * Šablonska rečenica se izgovori ljudski.
 *
 * Šablon se i dalje računa i ostaje rezerva: kad je AI isključen ili padne,
 * kupac dobija tačno ono što bi dobio i danas.
 */
async function ljudski(
  okvir: Okvir,
  sablon: string,
  ulaz: Omit<UlazCinjenica, 'tenant'>,
): Promise<string> {
  // Ton, oslovljavanje i vlastita pravila tog salona idu uz činjenice.
  return izgovori(
    sastaviCinjenice({ ...ulaz, tenant: okvir.tenant }),
    sablon,
    okvir.tenant.postavke,
  );
}

function tiho(intent: AiExtraction['intent'] = 'unknown'): OrchestrationResult {
  return { reply: '', duplicate: false, handoff: false, intent };
}

function odgovor(
  okvir: Okvir,
  reply: string,
  dodatno: Partial<OrchestrationResult> = {},
): OrchestrationResult {
  return {
    reply,
    duplicate: false,
    handoff: false,
    intent: okvir.extraction.intent,
    extraction: okvir.extraction,
    ...dodatno,
  };
}

export class ConversationOrchestrator {
  constructor(private readonly ai = new AiExtractor()) {}

  async process(message: NormalizedMessage): Promise<OrchestrationResult> {
    const businessId = typeof message.business_id === 'string' ? message.business_id.trim() : '';

    // Broj koji nije vezan ni za jedan biznis u Coreu: nema kome odgovoriti i
    // nema gdje zapisati razgovor. Zabilježi i šuti — nikakav odgovor prema
    // nepoznatom broju nije bolji od pogrešnog.
    if (!jeUuid(businessId)) {
      logger.warn('Poruka je stigla bez poznatog biznisa u Coreu — odgovor se ne šalje.', {
        channel_id: message.channel_id,
        channel_type: message.channel_type,
      });
      return tiho();
    }

    const lockKey = `${businessId}:${message.channel_id}:${message.customer_external_id}`;
    return withConversationLock(lockKey, async () => this.uZakljucanomRazgovoru(businessId, message));
  }

  private async uZakljucanomRazgovoru(
    businessId: string,
    message: NormalizedMessage,
  ): Promise<OrchestrationResult> {
    let conversationId: string;
    try {
      const contactName = message.metadata.contact_name;
      conversationId = await nadjiIliNapraviRazgovor(
        businessId,
        message.customer_phone,
        typeof contactName === 'string' ? contactName : undefined,
      );
      const zapis = await zapisiDolaznuPoruku({
        businessId,
        conversationId,
        externalMessageId: message.external_message_id,
        tekst: message.text,
        tipPoruke: message.message_type,
      });
      // Meta ponavlja webhookove; na ponovljenu poruku se ne odgovara drugi put.
      if (zapis.duplikat) return { reply: '', duplicate: true, handoff: false, intent: 'unknown' };

      // Ako je razgovor predan čovjeku, a niko se nije javio u roku, asistent
      // ga preuzima nazad. Bez ovoga jedno pogrešno prepoznato pitanje ušutka
      // asistenta zauvijek.
      //
      // Rok bira vlasnik u Postavkama. Kontekst je keširan, pa ovo ne pravi
      // dodatni poziv prema Coreu; ako ga nema, vrijedi vrijednost iz .env.
      const kesiran = await kontekstZaBiznis(businessId).catch(() => null);
      const povratakMinuta =
        kesiran?.ok === true
          ? kesiran.kontekst.postavke.povratakMinuta
          : config.HANDOFF_POVRATAK_MINUTA;

      await vratiBotaAkoNikoNijeOdgovorio(
        businessId,
        conversationId,
        povratakMinuta,
      ).catch((greska: unknown) => {
        logger.warn('Povratak asistenta nije provjeren.', {
          business_id: businessId,
          conversation_id: conversationId,
          greska: opisGreske(greska),
        });
      });

      // Kad je razgovor preuzeo čovjek, asistent mora šutjeti. Poruka je već
      // zapisana, pa je zaposlenik vidi u Inboxu.
      const stanje = await stanjeRazgovora(businessId, conversationId);
      if (stanje && stanje.status !== 'bot') {
        return { reply: '', duplicate: false, handoff: true, intent: 'human_handoff' };
      }
    } catch (greska) {
      logger.error('Razgovor nije zapisan u Core bazu.', {
        business_id: businessId,
        greska: opisGreske(greska),
      });
      return { ...tiho(), reply: PORUKA_TEHNICKI_PROBLEM };
    }

    // Ako je asistent nešto pitao, ova poruka je prvo odgovor na TO pitanje.
    // Bez ovoga bi "da" bilo protumačeno kao nova rezervacija.
    const naCekanju = await cekanaRadnja(businessId, conversationId).catch(() => null);
    const rezultat = naCekanju
      ? await this.odgovorNaPotvrdu(businessId, conversationId, message, naCekanju)
      : await this.odgovoriNaPoruku(businessId, conversationId, message);

    if (rezultat.reply) {
      await zapisiOdlaznuPoruku({ businessId, conversationId, tekst: rezultat.reply }).catch(
        (greska: unknown) => {
          // Odgovor je ipak poslan korisniku; propali zapis se samo prijavi.
          logger.error('Odlazna poruka nije zapisana u Core bazu.', {
            business_id: businessId,
            conversation_id: conversationId,
            greska: opisGreske(greska),
          });
        },
      );
    }
    return rezultat;
  }

  private async odgovoriNaPoruku(
    businessId: string,
    conversationId: string,
    message: NormalizedMessage,
  ): Promise<OrchestrationResult> {
    const kontekst = await kontekstZaBiznis(businessId);
    if (!kontekst.ok) {
      logger.warn('Kontekst biznisa nije dohvaćen iz Corea.', {
        business_id: businessId,
        vrsta: kontekst.vrsta,
        status: kontekst.status,
      });
      return { ...tiho(), reply: PORUKA_CORE_NEDOSTUPAN };
    }
    const tenant = kontekst.kontekst;

    // Bez istorije bi svaka poruka izgledala kao prva, pa bi asistent iznova
    // pitao ono što je kupac već rekao. Zadnja poruka je upravo zapisana, pa se
    // izostavlja — AI je dobija zasebno kao trenutni unos.
    let history: Array<{ direction: 'inbound' | 'outbound'; body: string }> = [];
    try {
      history = (await historijaRazgovora(businessId, conversationId, 11)).slice(0, -1);
    } catch (greska) {
      logger.warn('Istorija razgovora nije dohvaćena; nastavljam bez nje.', {
        business_id: businessId,
        conversation_id: conversationId,
        greska: opisGreske(greska),
      });
    }

    let extraction: AiExtraction;
    try {
      extraction = await this.ai.extract({
        message: message.text,
        phone: message.customer_phone,
        receivedAt: message.received_at,
        tenant,
        history,
        knownSlots: {},
      });
    } catch (greska) {
      logger.error('AI sloj nije vratio razumijevanje poruke.', {
        business_id: businessId,
        greska: opisGreske(greska),
      });
      return { ...tiho(), reply: PORUKA_TEHNICKI_PROBLEM };
    }

    const okvir: Okvir = { businessId, conversationId, tenant, message, extraction };

    // Šta ovaj salon dozvoljava svom asistentu (Postavke → Asistent).
    //
    // Isključen prekidač NE znači da asistent ćuti nego da posao preda čovjeku.
    // Kupac koji traži otkazivanje mora dobiti odgovor; koji odgovor, odlučuje
    // vlasnik.
    const smije = okvir.tenant.postavke;

    switch (extraction.intent) {
      case 'human_handoff':
        return this.predajCovjeku(okvir);

      case 'complaint':
        // Žalba ide čovjeku samo ako je vlasnik tako tražio; inače je to
        // običan razgovor i asistent na njega odgovara.
        return smije.predaja === 'zahtjev_i_zalbe'
          ? this.predajCovjeku(okvir)
          : odgovor(okvir, extraction.reply || PORUKA_NERAZUMIJEVANJE);

      case 'general_question':
        return odgovor(
          okvir,
          extraction.reply || 'Molim vas napišite šta vas zanima o našim uslugama.',
        );

      case 'cancel_booking':
        return smije.smijeOtkazati ? this.otkazi(okvir) : this.predajCovjeku(okvir);

      case 'check_availability':
        return this.provjeriDostupnost(okvir);

      case 'reschedule_booking':
        return smije.smijePomjeriti ? this.pomjeri(okvir) : this.predajCovjeku(okvir);

      case 'new_booking':
      // Core ne poznaje odvojenu "potvrdu": termin ili postoji ili ne postoji.
      // Potvrda sa konkretnim danom i satom je zato obično kreiranje termina, a
      // ako podaci nedostaju, ista grana ih zatraži.
      case 'confirm_booking':
        return smije.smijeZakazati ? this.zakazi(okvir) : this.predajCovjeku(okvir);

      case 'unknown':
      default:
        return { ...odgovor(okvir, PORUKA_NERAZUMIJEVANJE), intent: 'unknown' };
    }
  }

  /**
   * Kupac odgovara na pitanje "jeste li sigurni".
   *
   * Tri ishoda: potvrdio je i radnja se izvršava; odustao je i zapis se briše;
   * ili je napisao nešto treće — tada zapis pada i poruka se obrađuje normalno,
   * jer je kupac očito prešao na drugu temu.
   */
  private async odgovorNaPotvrdu(
    businessId: string,
    conversationId: string,
    message: NormalizedMessage,
    radnja: CekanaRadnja,
  ): Promise<OrchestrationResult> {
    const zaboravi = (): Promise<void> =>
      zapamtiCekanuRadnju(businessId, conversationId, null).catch(() => undefined);

    if (jeOdustajanje(message.text)) {
      await zaboravi();
      return {
        reply: 'U redu, termin ostaje kako jeste.',
        duplicate: false,
        handoff: false,
        intent: 'confirm_booking',
      };
    }

    if (!jePotvrda(message.text)) {
      // Nije ni da ni ne — kupac je prešao na drugo. Pitanje se poništava da
      // kasnije "da" ne bi obrisalo termin za koji kupac više i ne misli.
      await zaboravi();
      return this.odgovoriNaPoruku(businessId, conversationId, message);
    }

    await zaboravi();

    if (radnja.vrsta === 'otkazivanje') {
      const ishod = await otkaziTermin({
        businessId,
        appointmentId: radnja.appointmentId,
        razlog: 'customer',
      });
      if (ishod.ok) {
        return {
          reply: `Termin ${radnja.kod} je otkazan. Javite se kad vam bude odgovaralo novo vrijeme.`,
          duplicate: false,
          handoff: false,
          intent: 'cancel_booking',
          booking: { appointmentId: radnja.appointmentId },
        };
      }
      return {
        reply:
          ishod.vrsta === 'odbijeno'
            ? porukaZaOdbijenoOtkazivanje(ishod.razlog)
            : PORUKA_CORE_NEDOSTUPAN,
        duplicate: false,
        handoff: false,
        intent: 'cancel_booking',
      };
    }

    // Pomjeranje: novo vrijeme je već provjereno prije pitanja.
    const ishod = await pomjeriTermin({
      businessId,
      appointmentId: radnja.appointmentId,
      startAt: radnja.novoVrijeme ?? '',
      endAt: '',
    });
    return {
      reply: ishod.ok
        ? `Termin ${radnja.kod} je pomjeren.`
        : PORUKA_CORE_NEDOSTUPAN,
      duplicate: false,
      handoff: false,
      intent: 'reschedule_booking',
      booking: { appointmentId: radnja.appointmentId },
    };
  }

  // -------------------------------------------------------------------------
  // Čovjek preuzima razgovor
  // -------------------------------------------------------------------------

  private async predajCovjeku(okvir: Okvir): Promise<OrchestrationResult> {
    // Biznis koji nema kome proslijediti ne smije ostaviti kupca u tišini.
    if (okvir.tenant.postavke.predaja === 'nikad') {
      return odgovor(
        okvir,
        'To ne mogu sam riješiti. Javite nam se telefonom pa ćemo se dogovoriti.',
      );
    }

    try {
      await preuzeoCovjek(okvir.businessId, okvir.conversationId);
    } catch (greska) {
      logger.error('Preuzimanje razgovora nije zapisano u Core bazu.', {
        business_id: okvir.businessId,
        conversation_id: okvir.conversationId,
        greska: opisGreske(greska),
      });
    }
    return odgovor(okvir, PORUKA_PREUZEO_COVJEK, { handoff: true });
  }

  // -------------------------------------------------------------------------
  // Otkazivanje
  // -------------------------------------------------------------------------

  private async otkazi(okvir: Okvir): Promise<OrchestrationResult> {
    const nadjen = await this.nadjiTerminKupca(okvir);
    if (nadjen.vrsta === 'nedostupno') return odgovor(okvir, PORUKA_CORE_NEDOSTUPAN);
    if (nadjen.vrsta === 'pitanje') return odgovor(okvir, nadjen.tekst);
    const appointmentId = nadjen.appointmentId;

    // Otkazivanje se ne izvrsava na prvu rijec. Asistent kaze KOJI termin
    // otkazuje, sa njegovim brojem, i ceka potvrdu. Kupac koji je pogresno
    // shvacen tako ima gdje reci "ne" prije nego termin nestane.
    await zapamtiCekanuRadnju(okvir.businessId, okvir.conversationId, {
      vrsta: 'otkazivanje',
      appointmentId,
      kod: nadjen.kod,
      pitanoU: new Date().toISOString(),
    }).catch((greska: unknown) => {
      logger.warn('Cekana potvrda nije zapisana.', {
        business_id: okvir.businessId,
        conversation_id: okvir.conversationId,
        greska: opisGreske(greska),
      });
    });

    return odgovor(
      okvir,
      porukaZaPotvrduOtkazivanja(nadjen.kod, nadjen.pocetak, okvir.tenant.timezone),
      { booking: { appointmentId } },
    );
  }

  // -------------------------------------------------------------------------
  // Provjera dostupnosti
  // -------------------------------------------------------------------------

  private async provjeriDostupnost(okvir: Okvir): Promise<OrchestrationResult> {
    const { tenant, extraction, message } = okvir;
    if (tenant.services.length === 0) return this.bezUsluga(okvir);

    const datum = resolveBosnianDate(
      extraction.date_expression,
      extraction.date,
      message.received_at,
      tenant.timezone,
    );
    if (!datum) return odgovor(okvir, questionForMissingField('date'));

    const usluga = selectService(tenant, extraction.service || extraction.room_type);
    const slobodni = await this.slobodniZaDan(okvir, datum, usluga?.id);
    if (!slobodni) return odgovor(okvir, PORUKA_CORE_NEDOSTUPAN);

    // Ono što je kupac tražio („popodne", „oko 17h", „može li kasnije") mora
    // odlučiti šta mu se nudi. Inače dobija ista tri jutarnja termina koliko
    // god puta pitao, pa djeluje kao da ga niko ne sluša.
    //
    // Uz izraz se gleda i sirova poruka: AI popunjava `start_time_expression`
    // samo kad ima konkretan sat, pa bi "može li kasnije" i "a popodne" inače
    // prošli kao da vrijeme nije ni spomenuto.
    const zelja = zeljaKupca(okvir);
    const sablon = ponudaAlternativa(slobodni, tenant.timezone, zelja);

    // Šablon zna nabrojati sate, ali ne zna reći „radimo do 17:00, zadnji
    // termin je u 16:40". Zato ista lista ide i kao činjenice.
    const tekst = await ljudski(okvir, sablon, {
      vrsta: slobodni.length > 0 ? 'ponuda' : 'nema_termina',
      datum,
      usluga: uslugaZaCinjenice(usluga),
      slobodni,
      zelja,
      trazeniSat: extraction.start_time,
      staffMemberId: selectEmployee(tenant, extraction.employee),
    });

    return odgovor(okvir, tekst, {
      booking: { available: slobodni.length > 0 },
    });
  }

  // -------------------------------------------------------------------------
  // Novi termin
  // -------------------------------------------------------------------------

  private async zakazi(okvir: Okvir): Promise<OrchestrationResult> {
    const { tenant, extraction, message } = okvir;
    if (tenant.services.length === 0) return this.bezUsluga(okvir);

    // Više ljudi ili više usluga ne stane u jedan termin — ide drugim putem.
    if (jeGrupnaPosjeta(extraction)) return this.zakaziGrupu(okvir);

    const trazenaUsluga = (extraction.service || extraction.room_type).trim();
    const sazetak = selectService(tenant, trazenaUsluga);
    const usluga = sazetak ? mapService(tenant, sazetak) : null;

    // Kupac je rekao sta hoce, ali to ne radimo. Bez ove grane bi dobio
    // „Koju uslugu zelite?" iznova, kao da ga niko nije ni cuo.
    if (!usluga && trazenaUsluga) {
      return odgovor(
        okvir,
        porukaZaNepoznatuUslugu(
          trazenaUsluga,
          tenant.services.map((stavka) => stavka.name),
        ),
      );
    }

    const nedostaje = computeMissingFields(
      extraction,
      usluga,
      tenant.services.length,
      tenant.bookingPolicy,
    );
    extraction.missing_fields = nedostaje;
    extraction.ready_for_availability_check = nedostaje.length === 0;
    if (nedostaje.length > 0 || !usluga) {
      const polje = nedostaje[0] ?? 'service';
      const tekst = await ljudski(okvir, questionForMissingField(polje), {
        vrsta: 'trazi_podatak',
        usluga: uslugaZaCinjenice(sazetak),
        faliPolje: polje,
      });
      return odgovor(okvir, tekst);
    }

    const interval = resolveBookingInterval(extraction, usluga, message.received_at, tenant.timezone);
    if (!interval) {
      return odgovor(
        okvir,
        'Nisam mogao pouzdano odrediti datum i vrijeme. Molim vas napišite tačan dan i sat.',
      );
    }

    const trazeni = interval.startsAt.toISOString();

    // Kupac koji vec ima termin tog dana ne zakazuje ponovo.
    //
    // Bez ovoga je "Ok" poslije potvrde ponovo pokretalo zakazivanje: sat je u
    // medjuvremenu zauzeo njegov VLASTITI termin, pa mu je asistent javio da
    // nije slobodno ono sto mu je minut ranije potvrdio.
    const vecIma = tenant.postavke.jednaRezervacijaDnevno
      ? await this.terminTogDana(okvir, interval.localDate)
      : null;
    if (vecIma) {
      const tekst =
        vecIma.pocetak === trazeni
          ? porukaZaPotvrdjenTermin(vecIma.pocetak, tenant.timezone, vecIma.usluga)
          : porukaZaVecZauzetDan(vecIma.pocetak, tenant.timezone);
      return odgovor(okvir, tekst, {
        booking: { appointmentId: vecIma.appointmentId, created: false },
      });
    }

    const slobodni = await this.slobodniZaDan(okvir, interval.localDate, usluga.id);
    if (!slobodni) return odgovor(okvir, PORUKA_CORE_NEDOSTUPAN);

    const termin = slobodni.find((slot) => slot.startAt === trazeni);
    if (!termin) {
      const zelja = zeljaKupca(okvir);
      const tekst = await ljudski(
        okvir,
        porukaZaZauzetTermin(slobodni, tenant.timezone, zelja),
        {
          vrsta: 'odbijeno',
          datum: interval.localDate,
          usluga: uslugaZaCinjenice(usluga),
          slobodni,
          zelja,
          trazeniSat: extraction.start_time,
          razlog: 'taj termin nije slobodan',
          staffMemberId: selectEmployee(tenant, extraction.employee),
        },
      );
      return odgovor(okvir, tekst, { booking: { available: false } });
    }

    const ishod = await napraviTermin({
      businessId: okvir.businessId,
      startAt: termin.startAt,
      endAt: termin.endAt,
      serviceId: usluga.id,
      staffMemberId: termin.staffMemberId,
      klijent: { ime: extraction.customer_name, telefon: message.customer_phone },
      biljeska: extraction.notes || 'Zakazano preko WhatsAppa.',
      // Meta ponavlja webhookove; bez ovoga bi ponovljena isporuka napravila
      // drugi termin.
      idempotencyKey: message.event_id,
    });

    if (ishod.ok) {
      extraction.booking_id = ishod.appointmentId;
      const kodTermina = ishod.kod;
      const tekst = await ljudski(
        okvir,
        porukaZaPotvrdjenTermin(termin.startAt, tenant.timezone, usluga.name),
        {
          vrsta: 'zakazano',
          datum: interval.localDate,
          usluga: uslugaZaCinjenice(usluga),
          terminUtc: termin.startAt,
          staffMemberId: termin.staffMemberId,
        },
      );
      return odgovor(okvir, saBrojemTermina(tekst, kodTermina), {
        booking: { appointmentId: ishod.appointmentId, created: ishod.created, available: true },
      });
    }
    if (ishod.vrsta === 'odbijeno') {
      // Kupac vec ima termin tog dana. To nije odbijenica nego skretnica: ono
      // sto zeli je promjena postojeceg termina, pa mu se kaze kada je i sta
      // sve moze s njim.
      if (ishod.razlog === 'alreadyBookedThatDay' && ishod.postojeci) {
        return odgovor(
          okvir,
          porukaZaVecZauzetDan(ishod.postojeci.pocetak, tenant.timezone),
          { booking: { appointmentId: ishod.postojeci.appointmentId, available: false } },
        );
      }

      // 409 se ne ponavlja: nudi se ono što je ostalo iz iste liste.
      const ostalo = slobodni.filter((slot) => slot.startAt !== termin.startAt);
      const zelja = zeljaKupca(okvir);
      const tekst = await ljudski(
        okvir,
        porukaZaOdbijenTermin(ishod.razlog, ostalo, tenant.timezone, zelja),
        {
          vrsta: 'odbijeno',
          datum: interval.localDate,
          usluga: uslugaZaCinjenice(usluga),
          // Kod nečitljivog vremena šablon namjerno ne nudi termine; činjenice
          // ih zato ni ne dobijaju, da ih AI ne bi ponudio umjesto pitanja.
          slobodni: ishod.razlog === 'invalidTime' ? [] : ostalo,
          zelja,
          trazeniSat: extraction.start_time,
          razlog: ljudskiRazlog(ishod.razlog),
          staffMemberId: selectEmployee(tenant, extraction.employee),
        },
      );
      return odgovor(okvir, tekst, { booking: { available: false } });
    }
    return odgovor(okvir, PORUKA_CORE_NEDOSTUPAN);
  }

  // -------------------------------------------------------------------------
  // Pomjeranje termina
  // -------------------------------------------------------------------------

  private async pomjeri(okvir: Okvir): Promise<OrchestrationResult> {
    const { tenant, extraction, message } = okvir;

    const nadjen = await this.nadjiTerminKupca(okvir);
    if (nadjen.vrsta === 'nedostupno') return odgovor(okvir, PORUKA_CORE_NEDOSTUPAN);
    if (nadjen.vrsta === 'pitanje') return odgovor(okvir, nadjen.tekst);
    const appointmentId = nadjen.appointmentId;

    const sazetak = selectService(tenant, extraction.service || extraction.room_type);
    const usluga = sazetak ? mapService(tenant, sazetak) : zamjenskaUsluga(tenant);

    const interval = resolveBookingInterval(extraction, usluga, message.received_at, tenant.timezone);
    if (!interval) {
      return odgovor(
        okvir,
        'Recite mi na koji dan i sat da pomjerim termin, na primjer "sutra u 14:30".',
      );
    }

    const slobodni = await this.slobodniZaDan(okvir, interval.localDate, usluga.id || undefined);
    if (!slobodni) return odgovor(okvir, PORUKA_CORE_NEDOSTUPAN);

    const trazeni = interval.startsAt.toISOString();
    const termin = slobodni.find((slot) => slot.startAt === trazeni);
    if (!termin) {
      const zelja = zeljaKupca(okvir);
      const tekst = await ljudski(
        okvir,
        porukaZaZauzetTermin(slobodni, tenant.timezone, zelja),
        {
          vrsta: 'odbijeno',
          datum: interval.localDate,
          usluga: uslugaZaCinjenice(usluga),
          slobodni,
          zelja,
          trazeniSat: extraction.start_time,
          razlog: 'taj termin nije slobodan',
          staffMemberId: selectEmployee(tenant, extraction.employee),
        },
      );
      return odgovor(okvir, tekst, { booking: { appointmentId, available: false } });
    }

    const ishod = await pomjeriTermin({
      businessId: okvir.businessId,
      appointmentId,
      startAt: termin.startAt,
      endAt: termin.endAt,
    });

    if (ishod.ok) {
      const tekst = await ljudski(
        okvir,
        porukaZaPomjerenTermin(termin.startAt, tenant.timezone),
        {
          vrsta: 'pomjereno',
          datum: interval.localDate,
          usluga: uslugaZaCinjenice(usluga),
          terminUtc: termin.startAt,
          staffMemberId: termin.staffMemberId,
        },
      );
      return odgovor(okvir, tekst, {
        booking: { appointmentId: ishod.appointmentId, available: true },
      });
    }
    if (ishod.vrsta === 'odbijeno') {
      const ostalo = slobodni.filter((slot) => slot.startAt !== termin.startAt);
      const zelja = zeljaKupca(okvir);
      const tekst = await ljudski(
        okvir,
        porukaZaOdbijenTermin(ishod.razlog, ostalo, tenant.timezone, zelja),
        {
          vrsta: 'odbijeno',
          datum: interval.localDate,
          usluga: uslugaZaCinjenice(usluga),
          slobodni: ishod.razlog === 'invalidTime' ? [] : ostalo,
          zelja,
          trazeniSat: extraction.start_time,
          razlog: ljudskiRazlog(ishod.razlog),
          staffMemberId: selectEmployee(tenant, extraction.employee),
        },
      );
      return odgovor(okvir, tekst, { booking: { appointmentId, available: false } });
    }
    return odgovor(okvir, PORUKA_CORE_NEDOSTUPAN);
  }

  // -------------------------------------------------------------------------
  // Zajedničko
  // -------------------------------------------------------------------------

  /**
   * Zakazivanje posjete koja ima više usluga ili više ljudi.
   *
   * Raspored i trajanja odlučuje Core: on zna koliko koja usluga traje i ko je
   * kad slobodan. Ovdje se samo prevode nazivi usluga koje je kupac izgovorio
   * u prave usluge tog salona, i javi ako neku ne radimo.
   */
  private async zakaziGrupu(okvir: Okvir): Promise<OrchestrationResult> {
    const { tenant, extraction, message } = okvir;
    if (tenant.services.length === 0) return this.bezUsluga(okvir);

    const interval = resolveBookingInterval(
      extraction,
      zamjenskaUsluga(tenant),
      message.received_at,
      tenant.timezone,
    );
    if (!interval) {
      return odgovor(
        okvir,
        'Recite mi na koji dan i sat da vas upišem, na primjer "sutra u 14:30".',
      );
    }

    // Naziv koji je kupac rekao mora postojati u ovom salonu. Nepoznatu uslugu
    // ne preskačemo tiho nego kažemo šta radimo.
    const ucesnici: Array<{ ime: string; serviceIds: string[]; naziviUsluga: string[] }> = [];
    for (const ucesnik of extraction.participants ?? []) {
      const serviceIds: string[] = [];
      const nazivi: string[] = [];
      for (const trazena of ucesnik.services) {
        const nadjena = selectService(tenant, trazena);
        if (!nadjena) {
          return odgovor(
            okvir,
            porukaZaNepoznatuUslugu(
              trazena,
              tenant.services.map((stavka) => stavka.name),
            ),
          );
        }
        serviceIds.push(nadjena.id);
        nazivi.push(nadjena.name);
      }
      if (serviceIds.length === 0) continue;
      ucesnici.push({ ime: ucesnik.name.trim(), serviceIds, naziviUsluga: nazivi });
    }

    if (ucesnici.length === 0) {
      return odgovor(okvir, questionForMissingField('service'));
    }
    if (!extraction.customer_name && tenant.postavke.traziIme) {
      return odgovor(okvir, questionForMissingField('customer_name'));
    }

    const ishod = await napraviGrupu({
      businessId: okvir.businessId,
      startAt: interval.startsAt.toISOString(),
      klijent: { ime: extraction.customer_name, telefon: message.customer_phone },
      ucesnici: ucesnici.map((u) => ({ ime: u.ime, serviceIds: u.serviceIds })),
    });

    if (!ishod.ok) {
      if (ishod.vrsta === 'odbijeno') {
        // Djelimična grupa ne postoji: ili svi stanu ili niko. Kupcu se nudi
        // drugi termin umjesto polovične potvrde.
        const slobodni = await this.slobodniZaDan(okvir, interval.localDate);
        return odgovor(
          okvir,
          slobodni && slobodni.length > 0
            ? `U to vrijeme vas ne mogu sve primiti. ${ponudaAlternativa(slobodni, tenant.timezone, zeljaKupca(okvir))}`
            : 'U to vrijeme vas ne mogu sve primiti. Recite mi koji drugi dan bi vam odgovarao.',
          { booking: { available: false } },
        );
      }
      return odgovor(okvir, PORUKA_CORE_NEDOSTUPAN);
    }

    const clanovi: ClanZaPotvrdu[] = ishod.termini.map((termin, i) => ({
      ime: termin.ime,
      kod: termin.kod,
      pocetak: termin.pocetak,
      usluge: ucesnici[i]?.naziviUsluga ?? [],
    }));

    return odgovor(okvir, porukaZaGrupu(clanovi, tenant.timezone), {
      booking: { appointmentId: ishod.termini[0].appointmentId, created: true, available: true },
    });
  }

  /**
   * Koji termin kupac misli kad kaže "pomjeri mi termin".
   *
   * Identifikator termina zna samo Core; kupac ga nikad neće otkucati. Zato se
   * ide na jedino što imamo — broj s kojeg piše. Ranije je svaki takav zahtjev
   * završavao predajom čovjeku, pa u salonu bez dežurnog Inboxa i nigdje.
   *
   * Nagađanja nema: kad kupac ima više budućih termina, asistent pita koji, a
   * kad nema nijedan, to mu i kaže umjesto da ćuti.
   */
  private async nadjiTerminKupca(okvir: Okvir): Promise<NadjenTermin> {
    const izPoruke = okvir.extraction.booking_id.trim();
    if (jeUuid(izPoruke)) return { vrsta: 'nadjen', appointmentId: izPoruke, kod: '', pocetak: '' };

    const ishod = await nadolazeciTermini(okvir.businessId, okvir.message.customer_phone);
    if (!ishod.ok) {
      logger.warn('Termini kupca nisu dohvaćeni iz Corea.', {
        business_id: okvir.businessId,
        conversation_id: okvir.conversationId,
        vrsta: ishod.vrsta,
      });
      return { vrsta: 'nedostupno' };
    }

    const termini = ishod.termini;

    // Kupac je rekao broj termina — to je tacan odgovor i nema se sta pitati.
    // Trazi se u SIROVOJ poruci, ne u onome sto je AI izdvojio: kod je kratak
    // niz slova i cifara i model ga povremeno ne prepozna kao identifikator.
    const izgovoreni = kodIzPoruke(okvir.message.text, termini);
    if (izgovoreni) {
      return {
        vrsta: 'nadjen',
        appointmentId: izgovoreni.appointmentId,
        kod: izgovoreni.kod,
        pocetak: izgovoreni.pocetak,
      };
    }

    if (termini.length === 0) {
      return {
        vrsta: 'pitanje',
        tekst:
          'Na ovaj broj ne vidim nijedan budući termin. Recite mi na koji dan i sat ' +
          'je zakazan, pa ću ga potražiti.',
      };
    }
    if (termini.length === 1) {
      return {
        vrsta: 'nadjen',
        appointmentId: termini[0].appointmentId,
        kod: termini[0].kod,
        pocetak: termini[0].pocetak,
      };
    }

    const zona = okvir.tenant.timezone;
    const spisak = termini
      .slice(0, 5)
      .map((termin) => {
        const usluga = termin.usluga ? ` (${termin.usluga.toLocaleLowerCase('bs')})` : '';
        return `${opisTermina(termin.pocetak, zona)}${usluga}`;
      })
      .join(', ');
    return {
      vrsta: 'pitanje',
      tekst: `Imate više termina: ${spisak}. Koji od njih mislite?`,
    };
  }

  /**
   * Termin koji kupac vec ima na taj dan, ako ga ima.
   *
   * Kad Core ne odgovori vraca se `null` — zakazivanje tada ide dalje i Core
   * ionako ima zadnju rijec preko pravila o jednoj rezervaciji po danu. Bolje
   * je propustiti provjeru nego prekinuti razgovor zbog nje.
   */
  private async terminTogDana(
    okvir: Okvir,
    lokalniDatum: string,
  ): Promise<{ appointmentId: string; pocetak: string; usluga: string } | null> {
    const ishod = await nadolazeciTermini(okvir.businessId, okvir.message.customer_phone);
    if (!ishod.ok) return null;

    const zona = okvir.tenant.timezone;
    const nadjen = ishod.termini.find(
      (termin) => DateTime.fromISO(termin.pocetak, { zone: 'utc' }).setZone(zona).toISODate() === lokalniDatum,
    );
    return nadjen
      ? { appointmentId: nadjen.appointmentId, pocetak: nadjen.pocetak, usluga: nadjen.usluga }
      : null;
  }

  /** Slobodni termini za dan; `null` znači da Core nije odgovorio. */
  private async slobodniZaDan(
    okvir: Okvir,
    datum: string,
    serviceId?: string,
  ): Promise<SlobodanTermin[] | null> {
    const zaposlenik = selectEmployee(okvir.tenant, okvir.extraction.employee);
    const ishod = await slobodniTermini({
      businessId: okvir.businessId,
      datum,
      ...(serviceId ? { serviceId } : {}),
      ...(zaposlenik ? { staffMemberId: zaposlenik } : {}),
    });
    return ishod.ok ? ishod.termini : null;
  }

  /** Biznis u Coreu nema nijednu aktivnu uslugu — asistent nema šta ponuditi. */
  private async bezUsluga(okvir: Okvir): Promise<OrchestrationResult> {
    try {
      await preuzeoCovjek(okvir.businessId, okvir.conversationId);
    } catch (greska) {
      logger.error('Preuzimanje razgovora nije zapisano u Core bazu.', {
        business_id: okvir.businessId,
        conversation_id: okvir.conversationId,
        greska: opisGreske(greska),
      });
    }
    return odgovor(
      okvir,
      'Usluge još nisu unesene u sistem. Proslijedio sam vašu poruku zaposleniku.',
      { handoff: true },
    );
  }
}
