/**
 * Dodaje novog klijenta (tenant) sa Meta Cloud kanalom u jednoj komandi.
 *
 * Pokretanje:
 *   npm run klijent:dodaj -- klijenti/naziv-klijenta.json
 *   npm run klijent:dodaj -- klijenti/naziv-klijenta.json --bez-provjere
 *
 * Prije upisa skript provjerava kod Mete da li phone_number_id stvarno postoji
 * i da li pripada navedenom WABA nalogu. Provjera se preskače sa --bez-provjere.
 *
 * Skript je idempotentan po `slug` i po `external_phone_number_id`: ponovno
 * pokretanje sa istim fajlom neće napraviti duplikat.
 */
import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import { config } from '../config.js';
import { pool, withTransaction } from '../infrastructure/database.js';
import { logger } from '../lib/logger.js';

const BOOKING_MODELS = [
  'appointment',
  'resource_appointment',
  'capacity_slot',
  'table_allocation',
  'accommodation',
  'multi_resource',
  'service_request',
] as const;

const UslugaSchema = z.object({
  naziv: z.string().min(1),
  opis: z.string().default(''),
  booking_model: z.enum(BOOKING_MODELS).default('appointment'),
  trajanje_minuta: z.number().int().positive().default(60),
  treba_zaposlenika: z.boolean().default(false),
  treba_resurs: z.boolean().default(false),
  kapacitet_mod: z.enum(['none', 'exclusive', 'pooled']).default('none'),
});

const KlijentSchema = z.object({
  naziv: z.string().min(1),
  slug: z.string().regex(/^[a-z0-9-]+$/, 'slug smije imati samo mala slova, brojeve i crtice'),
  vrsta_djelatnosti: z.string().default('other'),
  vremenska_zona: z.string().default('Europe/Sarajevo'),
  jezik: z.string().default('bs'),
  pozdravna_poruka: z.string().default('Dobro došli! Kako vam možemo pomoći?'),

  meta: z.object({
    waba_id: z.string().regex(/^\d+$/),
    phone_number_id: z.string().regex(/^\d+$/),
    broj: z.string().min(6),
    secret_env_key: z.string().optional(),
  }),

  lokacija: z
    .object({
      naziv: z.string().default('Glavna lokacija'),
      adresa: z.string().default(''),
    })
    .default({ naziv: 'Glavna lokacija', adresa: '' }),

  radno_vrijeme: z
    .object({
      dani: z.array(z.number().int().min(0).max(6)).default([1, 2, 3, 4, 5]),
      od: z.string().regex(/^\d{2}:\d{2}$/).default('08:00'),
      do: z.string().regex(/^\d{2}:\d{2}$/).default('17:00'),
    })
    .default({ dani: [1, 2, 3, 4, 5], od: '08:00', do: '17:00' }),

  // Napomena: u Zod 4 `.default()` ne prolazi kroz shemu, pa ugniježđene
  // default vrijednosti moraju biti ispisane u cijelosti.
  politika: z
    .object({
      auto_potvrda: z.boolean().default(false),
      hold_minuta: z.number().int().min(1).max(1440).default(10),
      min_najava_minuta: z.number().int().min(0).default(60),
      max_najava_dana: z.number().int().min(1).default(365),
      otkaz_najava_minuta: z.number().int().min(0).default(1440),
      obavezna_polja: z.array(z.string()).default(['customer_name']),
    })
    .default({
      auto_potvrda: false,
      hold_minuta: 10,
      min_najava_minuta: 60,
      max_najava_dana: 365,
      otkaz_najava_minuta: 1440,
      obavezna_polja: ['customer_name'],
    }),

  usluge: z.array(UslugaSchema).min(1),
  zaposlenici: z.array(z.object({ ime: z.string().min(1), uloga: z.string().default('') })).default([]),
  pitanja: z.array(z.object({ pitanje: z.string().min(1), odgovor: z.string().min(1) })).default([]),
});

type Klijent = z.infer<typeof KlijentSchema>;

async function provjeriKodMete(klijent: Klijent): Promise<void> {
  const token = klijent.meta.secret_env_key
    ? process.env[klijent.meta.secret_env_key]
    : config.META_ACCESS_TOKEN;
  if (!token) {
    throw new Error(
      klijent.meta.secret_env_key
        ? `Varijabla ${klijent.meta.secret_env_key} nije postavljena u .env.`
        : 'META_ACCESS_TOKEN nije postavljen u .env.',
    );
  }
  if (!config.META_GRAPH_VERSION) throw new Error('META_GRAPH_VERSION nije postavljen.');

  const url = `https://graph.facebook.com/${config.META_GRAPH_VERSION}/${klijent.meta.phone_number_id}?fields=id,display_phone_number,status`;
  const response = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  const body = (await response.json()) as {
    id?: string;
    display_phone_number?: string;
    status?: string;
    error?: { message?: string };
  };

  if (body.error) throw new Error(`Meta odbija phone_number_id: ${body.error.message ?? 'nepoznata greška'}`);
  if (body.id !== klijent.meta.phone_number_id) {
    throw new Error('Meta je vratila drugi phone_number_id od traženog.');
  }

  logger.info('Meta je potvrdila broj.', {
    phone_number_id: body.id,
    display_phone_number: body.display_phone_number,
    status: body.status,
  });

  if (body.status && body.status !== 'CONNECTED') {
    logger.warn('Broj nije u statusu CONNECTED; poruke možda neće prolaziti.', { status: body.status });
  }
}

async function upisi(klijent: Klijent): Promise<{ tenantId: string; channelId: string; novi: boolean }> {
  return withTransaction(async (client) => {
    const postojeci = await client.query<{ id: string }>('SELECT id FROM tenants WHERE slug = $1', [
      klijent.slug,
    ]);
    if (postojeci.rows[0]) {
      throw new Error(
        `Klijent sa slugom "${klijent.slug}" već postoji (tenant ${postojeci.rows[0].id}). ` +
          'Promijeni slug ili obriši postojećeg klijenta.',
      );
    }

    const zauzetBroj = await client.query<{ id: string; tenant_id: string }>(
      `SELECT id, tenant_id FROM channels
        WHERE type = 'whatsapp_cloud' AND external_phone_number_id = $1`,
      [klijent.meta.phone_number_id],
    );
    if (zauzetBroj.rows[0]) {
      throw new Error(
        `Phone Number ID ${klijent.meta.phone_number_id} je već vezan za kanal ` +
          `${zauzetBroj.rows[0].id} (tenant ${zauzetBroj.rows[0].tenant_id}). ` +
          'Jedan broj može pripadati samo jednom klijentu.',
      );
    }

    const tenant = await client.query<{ id: string }>(
      `INSERT INTO tenants (name, slug, business_type, timezone, default_language, configuration)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb) RETURNING id`,
      [
        klijent.naziv,
        klijent.slug,
        klijent.vrsta_djelatnosti,
        klijent.vremenska_zona,
        klijent.jezik,
        JSON.stringify({ welcome_message: klijent.pozdravna_poruka }),
      ],
    );
    const tenantId = tenant.rows[0].id;

    await client.query(
      `INSERT INTO booking_policies (
         tenant_id, auto_confirm, hold_minutes, min_advance_minutes, max_advance_days,
         cancellation_notice_minutes, required_fields
       ) VALUES ($1, $2, $3, $4, $5, $6, $7::text[])`,
      [
        tenantId,
        klijent.politika.auto_potvrda,
        klijent.politika.hold_minuta,
        klijent.politika.min_najava_minuta,
        klijent.politika.max_najava_dana,
        klijent.politika.otkaz_najava_minuta,
        klijent.politika.obavezna_polja,
      ],
    );

    const lokacija = await client.query<{ id: string }>(
      'INSERT INTO locations (tenant_id, name, address) VALUES ($1, $2, $3) RETURNING id',
      [tenantId, klijent.lokacija.naziv, klijent.lokacija.adresa],
    );
    const locationId = lokacija.rows[0].id;

    for (const dan of klijent.radno_vrijeme.dani) {
      await client.query(
        `INSERT INTO business_hours (tenant_id, location_id, weekday, opens_at, closes_at)
         VALUES ($1, $2, $3, $4::time, $5::time)`,
        [tenantId, locationId, dan, klijent.radno_vrijeme.od, klijent.radno_vrijeme.do],
      );
    }

    const zaposleniciIds: string[] = [];
    for (const zaposlenik of klijent.zaposlenici) {
      const red = await client.query<{ id: string }>(
        'INSERT INTO employees (tenant_id, location_id, name, role_name) VALUES ($1, $2, $3, $4) RETURNING id',
        [tenantId, locationId, zaposlenik.ime, zaposlenik.uloga],
      );
      zaposleniciIds.push(red.rows[0].id);
    }

    for (const usluga of klijent.usluge) {
      const red = await client.query<{ id: string }>(
        `INSERT INTO services (
           tenant_id, location_id, name, description, booking_model,
           default_duration_minutes, requires_employee, requires_resource, capacity_mode
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id`,
        [
          tenantId,
          locationId,
          usluga.naziv,
          usluga.opis,
          usluga.booking_model,
          usluga.trajanje_minuta,
          usluga.treba_zaposlenika,
          usluga.treba_resurs,
          usluga.kapacitet_mod,
        ],
      );
      if (usluga.treba_zaposlenika) {
        for (const employeeId of zaposleniciIds) {
          await client.query(
            'INSERT INTO service_employees (tenant_id, service_id, employee_id) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING',
            [tenantId, red.rows[0].id, employeeId],
          );
        }
      }
    }

    for (const stavka of klijent.pitanja) {
      await client.query('INSERT INTO knowledge_items (tenant_id, question, answer) VALUES ($1, $2, $3)', [
        tenantId,
        stavka.pitanje,
        stavka.odgovor,
      ]);
    }

    const kanal = await client.query<{ id: string }>(
      `INSERT INTO channels (
         tenant_id, type, name, phone_number, external_account_id,
         external_phone_number_id, secret_env_key, primary_outbound, status, configuration
       ) VALUES ($1, 'whatsapp_cloud', $2, $3, $4, $5, $6, true, 'active', $7::jsonb)
       RETURNING id`,
      [
        tenantId,
        `${klijent.naziv} Meta Cloud kanal`,
        klijent.meta.broj.replace(/\s+/g, ''),
        klijent.meta.waba_id,
        klijent.meta.phone_number_id,
        klijent.meta.secret_env_key ?? null,
        JSON.stringify({ onboarding: 'cli', dodano: new Date().toISOString() }),
      ],
    );

    return { tenantId, channelId: kanal.rows[0].id, novi: true };
  });
}

const args = process.argv.slice(2);
const putanja = args.find((arg) => !arg.startsWith('--'));
const bezProvjere = args.includes('--bez-provjere');

if (!putanja) {
  console.error('Upotreba: npm run klijent:dodaj -- <putanja-do-json-fajla> [--bez-provjere]');
  process.exit(1);
}

try {
  const sirovo = JSON.parse(await readFile(putanja, 'utf8'));
  const klijent = KlijentSchema.parse(sirovo);

  if (bezProvjere) {
    logger.warn('Provjera kod Mete je preskočena na zahtjev.');
  } else {
    await provjeriKodMete(klijent);
  }

  const rezultat = await upisi(klijent);

  logger.info('Klijent je dodan.', {
    tenant_id: rezultat.tenantId,
    channel_id: rezultat.channelId,
    slug: klijent.slug,
  });

  console.log('\nGotovo. Za slanje probne poruke koristi:');
  console.log(`  channel_id: ${rezultat.channelId}`);
  console.log('  POST /api/v1/internal/meta/send-text  (zaglavlje x-internal-api-key)');
} catch (error) {
  if (error instanceof z.ZodError) {
    logger.error('Konfiguracija klijenta nije ispravna.', {
      greske: error.issues.map((issue) => `${issue.path.join('.') || '(korijen)'}: ${issue.message}`),
    });
  } else {
    logger.error('Dodavanje klijenta nije uspjelo.', {
      greska: error instanceof Error ? error.message : String(error),
    });
  }
  process.exitCode = 1;
} finally {
  await pool.end();
}
