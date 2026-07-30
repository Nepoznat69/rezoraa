import { config } from '../../config.js';
import { query, withTransaction } from '../../infrastructure/database.js';
import { logger } from '../../lib/logger.js';
import { desifrirajOpcionalno, noviWebhookKljuc, sifriraj } from '../../lib/tajne.js';
import { tajnePoKanalu } from '../channels/meta/meta-kanal-tajne.js';

/**
 * Onboarding klijenta koji donosi vlastitu Meta aplikaciju.
 *
 * Klijent pravi svoj Business Manager i svoju Meta aplikaciju, pa Rezori
 * predaje četiri podatka: WABA ID, Phone Number ID, pristupni token i app
 * secret. Tako svaki klijent ima vlastite limite poruka i ne ovisi o Rezorinoj
 * verifikaciji poslovnog subjekta.
 */

export interface NoviKlijentUlaz {
  naziv: string;
  slug: string;
  vrsta_djelatnosti?: string;
  vremenska_zona?: string;
  broj: string;
  waba_id: string;
  phone_number_id: string;
  access_token: string;
  app_secret: string;
}

export interface KlijentPregled {
  tenant_id: string;
  channel_id: string;
  naziv: string;
  slug: string;
  broj: string;
  phone_number_id: string | null;
  waba_id: string | null;
  webhook_key: string | null;
  status: string;
  last_check_at: string | null;
  last_check_result: Record<string, unknown>;
}

export interface KorakProvjere {
  korak: string;
  naziv: string;
  uspjeh: boolean;
  detalj: string;
}

function graphVerzija(): string {
  if (!config.META_GRAPH_VERSION || !/^v\d+\.\d+$/.test(config.META_GRAPH_VERSION)) {
    throw new Error('META_GRAPH_VERSION nije ispravno konfigurisan.');
  }
  return config.META_GRAPH_VERSION;
}

async function metaGet(
  putanja: string,
  token: string,
): Promise<{ ok: boolean; status: number; body: Record<string, any> }> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15_000);
  try {
    const response = await fetch(`https://graph.facebook.com/${graphVerzija()}/${putanja}`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: controller.signal,
    });
    const body = (await response.json()) as Record<string, any>;
    return { ok: response.ok && !body.error, status: response.status, body };
  } catch (error) {
    return {
      ok: false,
      status: 0,
      body: { error: { message: error instanceof Error ? error.message : String(error) } },
    };
  } finally {
    clearTimeout(timeout);
  }
}

export function javnaOsnova(): string | undefined {
  return config.PUBLIC_BASE_URL;
}

/**
 * Pretplaćuje klijentovu aplikaciju na njegov WhatsApp nalog.
 *
 * Bez ovoga Meta šalje dolazne poruke nekoj drugoj aplikaciji (kod test brojeva
 * to je Metina vlastita), pa do Rezore nikada ne stignu — a nigdje se ne javlja
 * greška. Zato se radi automatski pri dodavanju klijenta.
 */
export async function pretplatiAplikaciju(
  wabaId: string,
  token: string,
): Promise<{ uspjeh: boolean; detalj: string }> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15_000);
  try {
    const response = await fetch(
      `https://graph.facebook.com/${graphVerzija()}/${encodeURIComponent(wabaId)}/subscribed_apps`,
      { method: 'POST', headers: { Authorization: `Bearer ${token}` }, signal: controller.signal },
    );
    const body = (await response.json()) as { success?: boolean; error?: { message?: string } };
    if (body.error) return { uspjeh: false, detalj: body.error.message ?? 'Meta je odbila pretplatu.' };
    return { uspjeh: Boolean(body.success), detalj: body.success ? 'Pretplaćeno.' : 'Meta nije potvrdila pretplatu.' };
  } catch (error) {
    return { uspjeh: false, detalj: error instanceof Error ? error.message : String(error) };
  } finally {
    clearTimeout(timeout);
  }
}

export function webhookAdresa(webhookKey: string): string {
  const osnova = javnaOsnova();
  const putanja = `/api/v1/meta/webhook/${webhookKey}`;
  return osnova ? `${osnova.replace(/\/+$/, '')}${putanja}` : putanja;
}

export async function dodajKlijenta(ulaz: NoviKlijentUlaz): Promise<{
  tenant_id: string;
  channel_id: string;
  webhook_key: string;
  verify_token: string;
  pretplata: { uspjeh: boolean; detalj: string };
}> {
  return withTransaction(async (client) => {
    const postojeci = await client.query<{ id: string }>('SELECT id FROM tenants WHERE slug = $1', [ulaz.slug]);
    if (postojeci.rows[0]) {
      throw new Error(`Klijent sa oznakom "${ulaz.slug}" već postoji.`);
    }

    const zauzet = await client.query<{ id: string }>(
      `SELECT id FROM channels WHERE type = 'whatsapp_cloud' AND external_phone_number_id = $1`,
      [ulaz.phone_number_id],
    );
    if (zauzet.rows[0]) {
      throw new Error(`Phone Number ID ${ulaz.phone_number_id} je već vezan za drugog klijenta.`);
    }

    const tenant = await client.query<{ id: string }>(
      `INSERT INTO tenants (name, slug, business_type, timezone, configuration)
       VALUES ($1, $2, $3, $4, $5::jsonb) RETURNING id`,
      [
        ulaz.naziv,
        ulaz.slug,
        ulaz.vrsta_djelatnosti ?? 'other',
        ulaz.vremenska_zona ?? 'Europe/Sarajevo',
        JSON.stringify({ welcome_message: 'Dobro došli! Kako vam možemo pomoći?' }),
      ],
    );
    const tenantId = tenant.rows[0].id;

    await client.query(
      `INSERT INTO booking_policies (
         tenant_id, auto_confirm, hold_minutes, min_advance_minutes,
         max_advance_days, cancellation_notice_minutes, required_fields
       ) VALUES ($1, false, 10, 60, 365, 1440, ARRAY['customer_name']::text[])`,
      [tenantId],
    );

    const lokacija = await client.query<{ id: string }>(
      `INSERT INTO locations (tenant_id, name, address) VALUES ($1, 'Glavna lokacija', '') RETURNING id`,
      [tenantId],
    );
    for (const dan of [1, 2, 3, 4, 5]) {
      await client.query(
        `INSERT INTO business_hours (tenant_id, location_id, weekday, opens_at, closes_at)
         VALUES ($1, $2, $3, '08:00'::time, '17:00'::time)`,
        [tenantId, lokacija.rows[0].id, dan],
      );
    }

    // Verify token generiše Rezora; klijent ga samo prepiše u svoju Meta aplikaciju.
    const verifyToken = noviWebhookKljuc();
    const webhookKey = noviWebhookKljuc();

    const kanal = await client.query<{ id: string }>(
      `INSERT INTO channels (
         tenant_id, type, name, phone_number, external_account_id, external_phone_number_id,
         webhook_key, app_secret_encrypted, verify_token_encrypted, access_token_encrypted,
         primary_outbound, status, configuration
       ) VALUES ($1, 'whatsapp_cloud', $2, $3, $4, $5, $6, $7, $8, $9, true, 'active', $10::jsonb)
       RETURNING id`,
      [
        tenantId,
        `${ulaz.naziv} Meta Cloud kanal`,
        ulaz.broj.replace(/\s+/g, ''),
        ulaz.waba_id,
        ulaz.phone_number_id,
        webhookKey,
        sifriraj(ulaz.app_secret),
        sifriraj(verifyToken),
        sifriraj(ulaz.access_token),
        JSON.stringify({ onboarding: 'dashboard', dodano: new Date().toISOString() }),
      ],
    );

    logger.info('Klijent je dodan kroz dashboard.', { tenant_id: tenantId, channel_id: kanal.rows[0].id });
    return { tenant_id: tenantId, channel_id: kanal.rows[0].id, webhook_key: webhookKey, verify_token: verifyToken };
  }).then(async (rezultat) => {
    // Van transakcije: mrežni poziv ne smije držati bazu zaključanu, a neuspjeh
    // ne smije poništiti upis klijenta — pretplata se može ponoviti kasnije.
    const pretplata = await pretplatiAplikaciju(ulaz.waba_id, ulaz.access_token);
    if (pretplata.uspjeh) {
      logger.info('Aplikacija klijenta je pretplaćena na WhatsApp nalog.', { channel_id: rezultat.channel_id });
    } else {
      logger.warn('Automatska pretplata na WhatsApp nalog nije uspjela.', {
        channel_id: rezultat.channel_id,
        razlog: pretplata.detalj,
      });
    }
    return { ...rezultat, pretplata };
  });
}

/**
 * Podaci koje treba prepisati u Meta aplikaciju klijenta. Trebaju iznova nakon
 * svake promjene adrese tunela, pa moraju biti dostupni i poslije onboardinga.
 */
export async function webhookPodaci(
  channelId: string,
): Promise<{ webhook_url: string; verify_token: string } | null> {
  const redovi = await query<{ webhook_key: string | null; verify_token_encrypted: string | null }>(
    `SELECT webhook_key, verify_token_encrypted FROM channels WHERE id = $1 AND type = 'whatsapp_cloud'`,
    [channelId],
  );
  const red = redovi[0];
  if (!red?.webhook_key) return null;

  const verifyToken = desifrirajOpcionalno(red.verify_token_encrypted);
  if (!verifyToken) return null;

  return { webhook_url: webhookAdresa(red.webhook_key), verify_token: verifyToken };
}

export async function listaKlijenata(): Promise<KlijentPregled[]> {
  return query<KlijentPregled>(
    `SELECT t.id AS tenant_id, c.id AS channel_id, t.name AS naziv, t.slug,
            c.phone_number AS broj, c.external_phone_number_id AS phone_number_id,
            c.external_account_id AS waba_id, c.webhook_key, c.status,
            c.last_check_at, c.last_check_result
       FROM channels c
       JOIN tenants t ON t.id = c.tenant_id
      WHERE c.type = 'whatsapp_cloud'
      ORDER BY t.created_at DESC`,
  );
}

/**
 * Provjerava vezu klijenta kod Mete, korak po korak. Svaki korak je nezavisan
 * da bi se u dashboardu vidjelo tačno šta ne valja, a ne samo da "ne radi".
 */
export async function provjeriKlijenta(channelId: string): Promise<KorakProvjere[]> {
  const koraci: KorakProvjere[] = [];
  const tajne = await tajnePoKanalu(channelId);

  if (!tajne) {
    return [{ korak: 'kanal', naziv: 'Kanal u bazi', uspjeh: false, detalj: 'Kanal ne postoji ili nije aktivan.' }];
  }
  koraci.push({ korak: 'kanal', naziv: 'Kanal u bazi', uspjeh: true, detalj: 'Kanal je aktivan.' });

  if (!tajne.accessToken) {
    koraci.push({ korak: 'token', naziv: 'Pristupni token', uspjeh: false, detalj: 'Token nije spremljen.' });
    return koraci;
  }

  const debug = await metaGet(
    `debug_token?input_token=${encodeURIComponent(tajne.accessToken)}`,
    tajne.accessToken,
  );
  const podaci = debug.body?.data;
  if (!debug.ok || !podaci?.is_valid) {
    koraci.push({
      korak: 'token',
      naziv: 'Pristupni token',
      uspjeh: false,
      detalj: debug.body?.error?.message ?? 'Meta je odbila token.',
    });
    return koraci;
  }
  const istice = podaci.expires_at === 0 ? 'ne ističe' : `ističe ${new Date(podaci.expires_at * 1000).toLocaleDateString('bs-BA')}`;
  koraci.push({
    korak: 'token',
    naziv: 'Pristupni token',
    uspjeh: true,
    detalj: `Vrijedi, ${istice}. Tip: ${podaci.type ?? 'nepoznat'}.`,
  });

  const dozvole: string[] = podaci.scopes ?? [];
  const trebaju = ['whatsapp_business_management', 'whatsapp_business_messaging'];
  const nedostaju = trebaju.filter((d) => !dozvole.includes(d));
  koraci.push({
    korak: 'dozvole',
    naziv: 'Dozvole tokena',
    uspjeh: nedostaju.length === 0,
    detalj: nedostaju.length === 0 ? 'Sve potrebne dozvole postoje.' : `Nedostaje: ${nedostaju.join(', ')}.`,
  });

  const broj = await metaGet(
    `${tajne.phoneNumberId}?fields=display_phone_number,status,quality_rating`,
    tajne.accessToken,
  );
  koraci.push({
    korak: 'broj',
    naziv: 'WhatsApp broj',
    uspjeh: broj.ok && broj.body.status === 'CONNECTED',
    detalj: broj.ok
      ? `${broj.body.display_phone_number ?? ''} — status ${broj.body.status ?? 'nepoznat'}, kvalitet ${broj.body.quality_rating ?? 'n/d'}.`
      : (broj.body?.error?.message ?? 'Broj nije dostupan.'),
  });

  const zdravlje = await metaGet(`${tajne.phoneNumberId}?fields=health_status`, tajne.accessToken);
  const stanje = zdravlje.body?.health_status;
  const moze = stanje?.can_send_message;
  const cjeline: any[] = stanje?.entities ?? [];

  // Meta vraća razlog po cjelini (broj, WABA, firma, aplikacija). Bez toga
  // korisnik vidi samo "BLOCKED" i ne zna šta da popravi.
  const zapreke = cjeline
    .filter((c) => c.can_send_message === 'BLOCKED' || c.can_send_message === 'LIMITED')
    .flatMap((c: any) =>
      (c.errors ?? [])
        // Greške o SIP pozivima ne utječu na slanje poruka.
        .filter((g: any) => ![138024, 138025].includes(g.error_code))
        .map((g: any) => `${c.entity_type}: ${g.error_description}`),
    );

  koraci.push({
    korak: 'slanje',
    naziv: 'Može li slati poruke',
    uspjeh: moze === 'AVAILABLE' || moze === 'LIMITED',
    detalj:
      moze === 'AVAILABLE'
        ? 'Bez ograničenja.'
        : moze === 'LIMITED'
          ? `Može slati, uz niže limite. ${zapreke.join(' ')}`.trim()
          : zapreke.length
            ? `Blokirano. ${zapreke.join(' ')}`
            : `Meta javlja: ${moze ?? 'nepoznato'}.`,
  });

  // Meta u dodatnim napomenama javlja ako aplikacija nije pretplaćena na
  // dolazne poruke. Bez toga klijent može slati, ali nikada ništa ne prima.
  const napomene: string[] = cjeline.flatMap((c: any) => c.additional_info ?? []);
  const nijePretplacen = napomene.some((n) => /not subscribed to the message webhook/i.test(n));
  koraci.push({
    korak: 'pretplata',
    naziv: 'Pretplata na dolazne poruke',
    uspjeh: !nijePretplacen,
    detalj: nijePretplacen
      ? 'Aplikacija nije pretplaćena na polje "messages". U Meti: WhatsApp → Configuration → Webhook fields → Subscribe pored "messages".'
      : 'Aplikacija prima dolazne poruke.',
  });

  // Ključna provjera: Meta šalje poruke samo aplikaciji koja je pretplaćena na
  // WhatsApp nalog. Ako je to neka druga aplikacija, poruke tiho odlaze njoj.
  const waba = await query<{ external_account_id: string | null }>(
    'SELECT external_account_id FROM channels WHERE id = $1',
    [channelId],
  );
  const wabaId = waba[0]?.external_account_id;
  if (wabaId) {
    const pretplate = await metaGet(`${wabaId}/subscribed_apps`, tajne.accessToken);
    const aplikacije: any[] = pretplate.body?.data ?? [];
    const nazivi = aplikacije.map((a) => a.whatsapp_business_api_data?.name).filter(Boolean);
    koraci.push({
      korak: 'waba_pretplata',
      naziv: 'Aplikacija spojena na WhatsApp nalog',
      uspjeh: aplikacije.length > 0,
      detalj: aplikacije.length
        ? `Pretplaćeno: ${nazivi.join(', ')}.`
        : 'Nijedna aplikacija nije pretplaćena — dolazne poruke neće stizati.',
    });
  }

  const rezultat = koraci.reduce<Record<string, boolean>>((zbir, korak) => {
    zbir[korak.korak] = korak.uspjeh;
    return zbir;
  }, {});
  await query(
    'UPDATE channels SET last_check_at = now(), last_check_result = $2::jsonb WHERE id = $1',
    [channelId, JSON.stringify(rezultat)],
  );

  return koraci;
}
