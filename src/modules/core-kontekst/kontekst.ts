/**
 * ============================================================================
 * Kontekst biznisa iz Rezora Corea
 * ============================================================================
 *
 * Core je jedini sistem evidencije za usluge, osoblje i radno vrijeme. Gateway
 * ih više nema u svojoj bazi, pa se cijeli kontekst razgovora dohvata sa
 * `GET /api/internal/context` (vidi docs/INTERNAL_API_CONTRACT.md).
 *
 * Ovaj modul radi tačno dvije stvari:
 *
 *   1. prevodi Coreov `Kontekst` u `TenantContext`, oblik koji AI sloj već
 *      očekuje (src/domain/schemas.ts). AI sloj se zbog Corea ne dira.
 *   2. drži kratkotrajni keš, da svaka poruka u razgovoru ne udara mrežu.
 *
 * Ono što Core (još) nema, ovdje se ne izmišlja nego se jasno označi:
 *   - `resources` i `knowledge_items` ne postoje u ugovoru → prazni nizovi.
 *   - `booking_policies` ne postoje u ugovoru → podrazumijevane vrijednosti
 *     ispod, iste one koje je gateway do sada upisivao novom klijentu.
 *
 * business_id je izričit argument; ništa se ne izvodi iz sesije jer je nema.
 * ============================================================================
 */

import type { TenantContext } from '../../domain/schemas.js';
import {
  dohvatiKontekst,
  type Kontekst,
  type TehnickiNeuspjeh,
} from '../core-api/core-klijent.js';

/** Koliko dugo se jednom dohvaćen kontekst smije koristiti bez novog poziva. */
export const TRAJANJE_KESA_MS = 60_000;

/**
 * Pravila rezervisanja koja Core još ne izlaže kroz interni API.
 *
 * Vrijednosti su iste one koje je gateway do sada upisivao u lokalnu tabelu
 * `booking_policies` pri dodavanju klijenta, pa se ponašanje asistenta ovim
 * prelaskom ne mijenja. ČIM Core dobije podesiva pravila po biznisu, ova
 * konstanta se briše i polje `bookingPolicy` se puni iz odgovora Corea —
 * gateway ne smije ostati mjesto gdje se pravila jednog salona mogu podesiti.
 */
export const PODRAZUMIJEVANA_PRAVILA: Record<string, unknown> = {
  auto_confirm: false,
  hold_minutes: 10,
  min_advance_minutes: 60,
  max_advance_days: 365,
  cancellation_notice_minutes: 1440,
  required_fields: ['customer_name'],
};

/** Jezik asistenta. Core ga ne izlaže; sav sadržaj gatewaya je na bosanskom. */
const JEZIK = 'bs';

/**
 * Prevodi Coreov kontekst u oblik koji razumije AI sloj.
 *
 * Sve Coreove usluge su termini kod zaposlenika: ugovor poznaje samo
 * `duration_minutes` i osoblje, pa je `booking_model` uvijek `appointment`, a
 * `capacity_mode` uvijek `none`. Soba, stolova i grupnih termina u Coreu nema,
 * pa se ni ovdje ne prave.
 */
export function mapirajKontekst(kontekst: Kontekst): TenantContext {
  const zaposlenici = kontekst.zaposlenici
    .filter((zaposlenik) => zaposlenik.aktivan)
    .map((zaposlenik) => ({ id: zaposlenik.id, name: zaposlenik.punoIme }));

  // Ako biznis uopšte nema osoblja, termin se ne može vezati za zaposlenika i
  // traženje zaposlenika bi zauvijek blokiralo rezervaciju.
  const trebaZaposlenika = zaposlenici.length > 0;

  return {
    tenantId: kontekst.firma.id,
    businessName: kontekst.firma.naziv,
    businessType: kontekst.firma.vertikala,
    timezone: kontekst.firma.vremenskaZona,
    language: JEZIK,
    // Vise nije jedna konstanta za sve klijente: sta se trazi prije
    // rezervacije i koliko unaprijed odlucuje vlasnik u Postavkama.
    bookingPolicy: {
      ...PODRAZUMIJEVANA_PRAVILA,
      min_advance_minutes: kontekst.postavke.najranijeMinuta,
      required_fields: kontekst.postavke.traziIme ? ['customer_name'] : [],
    },
    postavke: kontekst.postavke,
    services: kontekst.usluge
      .filter((usluga) => usluga.aktivna)
      .map((usluga) => ({
        id: usluga.id,
        name: usluga.naziv,
        bookingModel: 'appointment' as const,
        defaultDurationMinutes: usluga.trajanjeMinuta,
        bufferBeforeMinutes: 0,
        bufferAfterMinutes: 0,
        requiresEmployee: trebaZaposlenika,
        requiresResource: false,
        capacityMode: 'none' as const,
        configuration: { price_cents: usluga.cijenaCenti },
      })),
    employees: zaposlenici,
    // Core nema resurse — prazno je tačan odgovor, ne propust.
    resources: [],
    // Ono što salon ZNA: cijene, parking, rade li djecu. Usluge i radno vrijeme
    // opisuju šta salon radi; ovo odgovara na pitanja koja kupci stvarno šalju.
    knowledge: kontekst.znanje.map((stavka) => ({
      question: stavka.pitanje,
      answer: stavka.odgovor,
    })),
    // Radno vrijeme se do sada odbacivalo, pa asistent nije znao do kada se
    // radi ni kada je zadnji termin koji još stane u dan.
    workingHours: kontekst.radnoVrijeme.map((red) => ({
      staffMemberId: red.staffMemberId,
      weekday: red.danUSedmici,
      startTime: red.pocetak,
      endTime: red.kraj,
    })),
  };
}

// ---------------------------------------------------------------------------
// Keš
//
// Razgovor je niz poruka u kratkom razmaku; bez keša bi svaka poruka značila
// jedan HTTP poziv prema Coreu za isti nepromijenjeni katalog usluga.
// Keširaju se SAMO uspješni odgovori: neuspjeh se nikad ne pamti, da se kvar
// Corea ne produži za punu minutu nakon što se Core oporavi.
// ---------------------------------------------------------------------------

interface Zapis {
  kontekst: TenantContext;
  istice: number;
}

const kes = new Map<string, Zapis>();

/** Prazni keš. Služi testovima i ručnom osvježavanju nakon izmjene u Coreu. */
export function ocistiKesKonteksta(businessId?: string): void {
  if (businessId) kes.delete(businessId.trim());
  else kes.clear();
}

export type IshodKonteksta = { ok: true; kontekst: TenantContext } | TehnickiNeuspjeh;

/**
 * Vraća kontekst biznisa iz Corea, sa kešom od najviše `TRAJANJE_KESA_MS`.
 *
 * Neuspjeh se vraća kao vrijednost, ne kao izuzetak: pozivalac na osnovu njega
 * bira ljudsku poruku za korisnika. Ovdje se ništa ne ponavlja.
 */
export async function kontekstZaBiznis(
  businessId: string,
  sada: number = Date.now(),
): Promise<IshodKonteksta> {
  const kljuc = typeof businessId === 'string' ? businessId.trim() : '';

  const zapamceno = kes.get(kljuc);
  if (zapamceno && zapamceno.istice > sada) {
    return { ok: true, kontekst: zapamceno.kontekst };
  }
  if (zapamceno) kes.delete(kljuc);

  const odgovor = await dohvatiKontekst(kljuc);
  if (!odgovor.ok) return odgovor;

  const kontekst = mapirajKontekst(odgovor.kontekst);
  kes.set(kljuc, { kontekst, istice: sada + TRAJANJE_KESA_MS });
  return { ok: true, kontekst };
}
