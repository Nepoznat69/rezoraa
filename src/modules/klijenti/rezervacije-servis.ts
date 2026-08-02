import { query } from '../../infrastructure/database.js';

/**
 * Pregled rezervacija za dashboard.
 *
 * Namjerno samo čitanje. Promjene rezervacija idu kroz booking servis koji
 * ponovo provjerava radno vrijeme, preklapanja i kapacitet — dashboard te
 * provjere ne smije zaobići.
 */

export interface Rezervacija {
  id: string;
  booking_code: string;
  status: string;
  starts_at: string;
  ends_at: string;
  party_size: number;
  notes: string;
  hold_expires_at: string | null;
  klijent: string;
  usluga: string;
  kupac: string | null;
  kupac_telefon: string | null;
}

export interface RezervacijeFilter {
  tenantId?: string;
  period?: 'danas' | 'sedmica' | 'buduce' | 'sve';
  status?: string;
  limit?: number;
}

const DOZVOLJENI_STATUSI = new Set([
  'draft', 'held', 'pending', 'pending_approval', 'confirmed',
  'rejected', 'cancelled', 'rescheduled', 'completed', 'no_show', 'expired',
]);

export async function listaRezervacija(filter: RezervacijeFilter = {}): Promise<Rezervacija[]> {
  const uslovi: string[] = [];
  const vrijednosti: unknown[] = [];

  if (filter.tenantId) {
    vrijednosti.push(filter.tenantId);
    uslovi.push(`b.tenant_id = $${vrijednosti.length}`);
  }

  if (filter.status && DOZVOLJENI_STATUSI.has(filter.status)) {
    vrijednosti.push(filter.status);
    uslovi.push(`b.status = $${vrijednosti.length}`);
  }

  // Period se računa u vremenskoj zoni rezervacije, ne servera.
  if (filter.period === 'danas') {
    uslovi.push(`(b.starts_at AT TIME ZONE b.timezone)::date = (now() AT TIME ZONE b.timezone)::date`);
  } else if (filter.period === 'sedmica') {
    uslovi.push(`b.starts_at >= now() - interval '1 day' AND b.starts_at < now() + interval '7 days'`);
  } else if (filter.period === 'buduce') {
    uslovi.push(`b.ends_at >= now()`);
  }

  const gdje = uslovi.length ? `WHERE ${uslovi.join(' AND ')}` : '';
  const limit = Math.min(Math.max(filter.limit ?? 100, 1), 500);

  return query<Rezervacija>(
    `SELECT b.id, b.booking_code, b.status, b.starts_at, b.ends_at,
            b.party_size, b.notes, b.hold_expires_at,
            t.name AS klijent,
            s.name AS usluga,
            c.name AS kupac,
            c.normalized_phone AS kupac_telefon
       FROM bookings b
       JOIN tenants t ON t.id = b.tenant_id
       LEFT JOIN services s ON s.id = b.service_id
       LEFT JOIN customers c ON c.id = b.customer_id
       ${gdje}
      ORDER BY b.starts_at DESC
      LIMIT ${limit}`,
    vrijednosti,
  );
}

export interface Sazetak {
  ukupno: number;
  danas: number;
  potvrdjene: number;
  cekaju_potvrdu: number;
  otkazane: number;
  razgovori_kod_covjeka: number;
}

export async function sazetak(tenantId?: string): Promise<Sazetak> {
  const uslov = tenantId ? 'WHERE tenant_id = $1' : '';
  const vrijednosti = tenantId ? [tenantId] : [];

  const redovi = await query<Record<string, string>>(
    `SELECT
       count(*) FILTER (WHERE status NOT IN ('draft','expired')) AS ukupno,
       count(*) FILTER (WHERE (starts_at AT TIME ZONE timezone)::date = (now() AT TIME ZONE timezone)::date
                          AND status IN ('held','pending','pending_approval','confirmed')) AS danas,
       count(*) FILTER (WHERE status = 'confirmed') AS potvrdjene,
       count(*) FILTER (WHERE status IN ('held','pending','pending_approval')) AS cekaju_potvrdu,
       count(*) FILTER (WHERE status = 'cancelled') AS otkazane
     FROM bookings ${uslov}`,
    vrijednosti,
  );

  const handoff = await query<{ broj: string }>(
    `SELECT count(*) AS broj FROM conversations
      WHERE status = 'human' ${tenantId ? 'AND tenant_id = $1' : ''}`,
    vrijednosti,
  );

  const r = redovi[0] ?? {};
  return {
    ukupno: Number(r.ukupno ?? 0),
    danas: Number(r.danas ?? 0),
    potvrdjene: Number(r.potvrdjene ?? 0),
    cekaju_potvrdu: Number(r.cekaju_potvrdu ?? 0),
    otkazane: Number(r.otkazane ?? 0),
    razgovori_kod_covjeka: Number(handoff[0]?.broj ?? 0),
  };
}

export interface DogadjajRezervacije {
  event_type: string;
  actor_type: string | null;
  created_at: string;
  old_values: Record<string, unknown> | null;
  new_values: Record<string, unknown> | null;
}

/** Historija jedne rezervacije — ko je šta mijenjao i kada. */
export async function historijaRezervacije(bookingId: string): Promise<DogadjajRezervacije[]> {
  return query<DogadjajRezervacije>(
    `SELECT event_type, actor_type, created_at, old_values, new_values
       FROM booking_events
      WHERE booking_id = $1
      ORDER BY created_at ASC`,
    [bookingId],
  );
}
