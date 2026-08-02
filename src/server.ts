import Fastify from 'fastify';
import rawBody from 'fastify-raw-body';
import { z } from 'zod';
import { config } from './config.js';
import { NormalizedMessageSchema } from './domain/schemas.js';
import { pool, query } from './infrastructure/database.js';
import { logger } from './lib/logger.js';
import { safeEqual, sha256, verifyMetaSignature } from './lib/security.js';
import { BookingService } from './modules/booking/booking-service.js';
import { MetaClient } from './modules/channels/meta/meta-client.js';
import {
  completeMetaOnboarding,
  renderMetaOnboardingPage,
} from './modules/channels/meta/meta-onboarding.js';
import { tajnePoKanalu, tajnePoWebhookKljucu } from './modules/channels/meta/meta-kanal-tajne.js';
import { MetaWebhookService } from './modules/channels/meta/meta-webhook.js';
import { ConversationOrchestrator } from './modules/conversations/orchestrator.js';
import { InboundWorker } from './modules/inbound/inbound-worker.js';
import { renderDashboard } from './modules/klijenti/dashboard-stranica.js';
import {
  dodajKlijenta,
  listaKlijenata,
  pretplatiAplikaciju,
  provjeriKlijenta,
  webhookAdresa,
  webhookPodaci,
} from './modules/klijenti/klijenti-servis.js';

const app = Fastify({
  logger: false,
  bodyLimit: 2 * 1024 * 1024,
  requestTimeout: 70_000,
  genReqId: (request) => String(request.headers['x-correlation-id'] || crypto.randomUUID()),
});

await app.register(rawBody, {
  field: 'rawBody',
  global: false,
  encoding: false,
  runFirst: true,
});

const orchestrator = new ConversationOrchestrator();
const webhook = new MetaWebhookService();
const meta = new MetaClient();
const worker = new InboundWorker();
const bookings = new BookingService();

function bearerToken(header: string | undefined): string {
  return header?.startsWith('Bearer ') ? header.slice(7) : '';
}

function internalAuthorized(header: string | string[] | undefined): boolean {
  const value = Array.isArray(header) ? header[0] : header;
  return typeof value === 'string' && safeEqual(value, config.INTERNAL_API_KEY);
}

async function qrAuthorized(tenantId: string, channelId: string, token: string): Promise<boolean> {
  const rows = await query<{ auth_secret_hash: string | null }>(
    `SELECT auth_secret_hash FROM channels
      WHERE tenant_id = $1 AND id = $2 AND type = 'whatsapp_qr' AND status = 'active'`,
    [tenantId, channelId],
  );
  const expected = rows[0]?.auth_secret_hash;
  if (!expected) return safeEqual(token, config.QR_AGENT_TOKEN);
  return safeEqual(sha256(token), expected);
}

app.addHook('onRequest', async (request) => {
  logger.debug('Primljen je HTTP zahtjev.', {
    correlation_id: request.id,
    metoda: request.method,
    putanja: request.url.split('?')[0],
  });
});

app.get('/health/live', async () => ({ status: 'živ', vrijeme: new Date().toISOString() }));

app.get('/health/ready', async (_request, reply) => {
  try {
    await pool.query('SELECT 1');
    return { status: 'spreman', baza: 'dostupna' };
  } catch {
    return reply.code(503).send({ status: 'nije_spreman', baza: 'nedostupna' });
  }
});

app.post('/api/v1/channels/qr/inbound', async (request, reply) => {
  const message = NormalizedMessageSchema.parse(request.body);
  const token = bearerToken(request.headers.authorization);
  if (!(await qrAuthorized(message.tenant_id, message.channel_id, token))) {
    return reply.code(401).send({ message: 'QR Agent nije autorizovan.' });
  }
  const result = await orchestrator.process(message);
  return reply.send(result);
});

app.post('/api/v1/internal/orchestrate', async (request, reply) => {
  if (!internalAuthorized(request.headers['x-internal-api-key'])) {
    return reply.code(401).send({ message: 'Interni poziv nije autorizovan.' });
  }
  const message = NormalizedMessageSchema.parse(request.body);
  return reply.send(await orchestrator.process(message));
});

app.post('/api/v1/internal/jobs/expire-holds', async (request, reply) => {
  if (!internalAuthorized(request.headers['x-internal-api-key'])) {
    return reply.code(401).send({ message: 'Interni poziv nije autorizovan.' });
  }
  const count = await bookings.expireHolds();
  return reply.send({ isteklo_holdova: count });
});

const MetaSendSchema = z.object({
  channel_id: z.string().uuid(),
  to: z.string().min(3),
  text: z.string().min(1).max(4096),
});

app.post('/api/v1/internal/meta/send-text', async (request, reply) => {
  if (!internalAuthorized(request.headers['x-internal-api-key'])) {
    return reply.code(401).send({ message: 'Interni poziv nije autorizovan.' });
  }
  const body = MetaSendSchema.parse(request.body);
  const externalId = await meta.sendText(body.channel_id, body.to, body.text);
  return reply.send({ poslano: true, external_message_id: externalId });
});

const MetaTemplateSchema = z.object({
  channel_id: z.string().uuid(),
  to: z.string().min(3),
  template_name: z.string().min(1),
  language_code: z.string().min(2).default('bs'),
  components: z.array(z.unknown()).default([]),
});

app.post('/api/v1/internal/meta/send-template', async (request, reply) => {
  if (!internalAuthorized(request.headers['x-internal-api-key'])) {
    return reply.code(401).send({ message: 'Interni poziv nije autorizovan.' });
  }
  const body = MetaTemplateSchema.parse(request.body);
  const externalId = await meta.sendTemplate(
    body.channel_id,
    body.to,
    body.template_name,
    body.language_code,
    body.components,
  );
  return reply.send({ poslano: true, external_message_id: externalId });
});

// ---------------------------------------------------------------------------
// Gateway za Rezora Core
//
// Core je sistem evidencije za termine; ovdje se samo šalju poruke. Namjerno se
// adresira preko WhatsApp broja pošiljaoca, a ne preko internog channel_id, da
// Core ne mora poznavati rezorine identifikatore.
// ---------------------------------------------------------------------------

// Pošiljalac se adresira Meta Phone Number ID-jem, jer Core tu vrijednost već
// čuva u konfiguraciji integracije. Broj u međunarodnom obliku je prihvaćen kao
// zamjena, radi lakšeg ručnog testiranja.
const GatewaySendSchema = z.object({
  from_phone_number_id: z.string().regex(/^\d+$/).optional(),
  from: z.string().min(6).max(30).optional(),
  to: z.string().min(6).max(30),
  text: z.string().min(1).max(4096),
});

function samoCifre(broj: string): string {
  return broj.replace(/\D/g, '');
}

app.post('/api/v1/gateway/send', async (request, reply) => {
  if (!internalAuthorized(request.headers['x-internal-api-key'])) {
    return reply.code(401).send({ message: 'Poziv nije autorizovan.' });
  }
  const body = GatewaySendSchema.parse(request.body);
  if (!body.from_phone_number_id && !body.from) {
    return reply.code(400).send({ message: 'Nedostaje from_phone_number_id ili from.' });
  }

  const kanali = body.from_phone_number_id
    ? await query<{ id: string }>(
        `SELECT id FROM channels
          WHERE type = 'whatsapp_cloud' AND status = 'active'
            AND external_phone_number_id = $1`,
        [body.from_phone_number_id],
      )
    : await query<{ id: string }>(
        `SELECT id FROM channels
          WHERE type = 'whatsapp_cloud' AND status = 'active'
            AND regexp_replace(phone_number, '\\D', '', 'g') = $1`,
        [samoCifre(body.from ?? '')],
      );

  const kanal = kanali[0];
  if (!kanal) {
    logger.warn('Gateway: nepoznat pošiljalac.', {
      po_id: Boolean(body.from_phone_number_id),
    });
    return reply.code(404).send({ message: 'Pošiljalac nije poznat ovoj platformi.' });
  }

  try {
    const externalId = await meta.sendText(kanal.id, samoCifre(body.to), body.text);
    logger.info('Gateway je poslao poruku.', { channel_id: kanal.id });
    return reply.send({ poslano: true, external_message_id: externalId });
  } catch (error) {
    const poruka = error instanceof Error ? error.message : String(error);
    logger.error('Gateway slanje nije uspjelo.', { channel_id: kanal.id, greska: poruka });
    return reply.code(502).send({ poslano: false, message: poruka });
  }
});

const MetaOnboardingSchema = z.object({
  state: z.string().min(32).max(128),
  code: z.string().min(20).max(4096),
  waba_id: z.string().regex(/^\d+$/),
  phone_number_id: z.string().regex(/^\d+$/),
});

app.get('/meta/onboarding', async (request, reply) => {
  // ?mode=standard pokreće dijagnostički Embedded Signup bez Coexistencea.
  const mode = (request.query as Record<string, string | undefined>).mode;
  const page = renderMetaOnboardingPage({ coexistence: mode !== 'standard' });
  return reply
    .header(
      'Content-Security-Policy',
      `default-src 'none'; script-src 'nonce-${page.cspNonce}' https://connect.facebook.net; style-src 'nonce-${page.cspNonce}'; connect-src 'self' https://graph.facebook.com; frame-src https://www.facebook.com https://web.facebook.com; img-src data: https://*.facebook.com; base-uri 'none'; form-action 'self'`,
    )
    .header('Referrer-Policy', 'no-referrer')
    .header('X-Content-Type-Options', 'nosniff')
    .header('Cache-Control', 'no-store')
    .type('text/html; charset=utf-8')
    .send(page.html);
});

app.post('/api/v1/meta/onboarding/complete', async (request, reply) => {
  const body = MetaOnboardingSchema.parse(request.body);
  const result = await completeMetaOnboarding(body);
  logger.info('Meta Embedded Signup je završen.', {
    channel_id: result.channel_id,
    waba_id: result.waba_id,
    phone_number_id: result.phone_number_id,
  });
  return reply.send({ povezano: true, ...result });
});

app.get('/api/v1/meta/webhook', async (request, reply) => {
  const query = request.query as Record<string, string | undefined>;
  if (query['hub.mode'] !== 'subscribe' || !safeEqual(query['hub.verify_token'] ?? '', config.META_VERIFY_TOKEN)) {
    return reply.code(403).send('Verifikacija nije uspjela.');
  }
  return reply.type('text/plain').send(query['hub.challenge'] ?? '');
});

app.post(
  '/api/v1/meta/webhook',
  { config: { rawBody: true } },
  async (request, reply) => {
    if (!config.META_APP_SECRET) {
      return reply.code(503).send({ message: 'META_APP_SECRET nije konfigurisan.' });
    }
    const signature = request.headers['x-hub-signature-256'];
    const raw = request.rawBody;
    const rawBuffer = Buffer.isBuffer(raw) ? raw : Buffer.from(raw ?? '', 'utf8');
    if (
      typeof signature !== 'string' ||
      rawBuffer.length === 0 ||
      !verifyMetaSignature(rawBuffer, signature, config.META_APP_SECRET)
    ) {
      return reply.code(401).send({ message: 'Meta webhook potpis nije ispravan.' });
    }
    const accepted = await webhook.accept(request.body);
    logger.info('Meta webhook je prihvaćen.', accepted);
    return reply.code(200).send({ primljeno: true, ...accepted });
  },
);

// Webhook za klijenta sa vlastitom Meta aplikacijom. Ključ u putanji služi da se
// kanal pronađe PRIJE provjere potpisa, jer tek iz kanala saznajemo kojim app
// secretom se potpis provjerava.
app.get('/api/v1/meta/webhook/:kljuc', async (request, reply) => {
  const { kljuc } = request.params as { kljuc: string };
  const upit = request.query as Record<string, string | undefined>;
  const tajne = await tajnePoWebhookKljucu(kljuc);

  if (!tajne?.verifyToken || upit['hub.mode'] !== 'subscribe') {
    return reply.code(403).send('Verifikacija nije uspjela.');
  }
  if (!safeEqual(upit['hub.verify_token'] ?? '', tajne.verifyToken)) {
    logger.warn('Neuspjela verifikacija webhooka klijenta.', { channel_id: tajne.id });
    return reply.code(403).send('Verifikacija nije uspjela.');
  }

  logger.info('Webhook klijenta je verifikovan.', { channel_id: tajne.id });
  return reply.type('text/plain').send(upit['hub.challenge'] ?? '');
});

app.post(
  '/api/v1/meta/webhook/:kljuc',
  { config: { rawBody: true } },
  async (request, reply) => {
    const { kljuc } = request.params as { kljuc: string };
    const tajne = await tajnePoWebhookKljucu(kljuc);
    if (!tajne?.appSecret) {
      // Namjerno isti odgovor kao za neispravan potpis, da se ne otkriva koji
      // ključevi postoje.
      return reply.code(401).send({ message: 'Meta webhook potpis nije ispravan.' });
    }

    const signature = request.headers['x-hub-signature-256'];
    const raw = request.rawBody;
    const rawBuffer = Buffer.isBuffer(raw) ? raw : Buffer.from(raw ?? '', 'utf8');
    if (
      typeof signature !== 'string' ||
      rawBuffer.length === 0 ||
      !verifyMetaSignature(rawBuffer, signature, tajne.appSecret)
    ) {
      logger.warn('Odbijen webhook sa neispravnim potpisom.', { channel_id: tajne.id });
      return reply.code(401).send({ message: 'Meta webhook potpis nije ispravan.' });
    }

    const accepted = await webhook.accept(request.body);
    logger.info('Meta webhook klijenta je prihvaćen.', { channel_id: tajne.id, ...accepted });
    return reply.code(200).send({ primljeno: true, ...accepted });
  },
);

// ---------------------------------------------------------------------------
// Interni dashboard za Rezora tim
// ---------------------------------------------------------------------------

function dashboardOtvoren(): boolean {
  return Boolean(config.DASHBOARD_PASSWORD);
}

/** Basic auth; korisničko ime je uvijek "rezora". */
function dashboardAutorizovan(header: string | undefined): boolean {
  if (!config.DASHBOARD_PASSWORD) return false;
  if (!header?.startsWith('Basic ')) return false;
  const dekodirano = Buffer.from(header.slice(6), 'base64').toString('utf8');
  const razdvoji = dekodirano.indexOf(':');
  if (razdvoji < 0) return false;
  const korisnik = dekodirano.slice(0, razdvoji);
  const lozinka = dekodirano.slice(razdvoji + 1);
  return safeEqual(korisnik, 'rezora') && safeEqual(lozinka, config.DASHBOARD_PASSWORD);
}

app.addHook('onRequest', async (request, reply) => {
  if (!request.url.startsWith('/dashboard')) return;
  if (!dashboardOtvoren()) {
    return reply.code(503).send({ message: 'DASHBOARD_PASSWORD nije postavljen u .env.' });
  }
  if (!dashboardAutorizovan(request.headers.authorization)) {
    return reply
      .code(401)
      .header('WWW-Authenticate', 'Basic realm="Rezora", charset="UTF-8"')
      .send({ message: 'Prijava je obavezna.' });
  }
});

app.get('/dashboard', async (_request, reply) => {
  const stranica = renderDashboard();
  return reply
    .header(
      'Content-Security-Policy',
      `default-src 'none'; script-src 'nonce-${stranica.nonce}'; style-src 'nonce-${stranica.nonce}'; connect-src 'self'; base-uri 'none'; form-action 'none'`,
    )
    .header('Referrer-Policy', 'no-referrer')
    .header('X-Content-Type-Options', 'nosniff')
    .header('Cache-Control', 'no-store')
    .type('text/html; charset=utf-8')
    .send(stranica.html);
});

app.get('/dashboard/api/klijenti', async (_request, reply) => reply.send(await listaKlijenata()));

const NoviKlijentSchema = z.object({
  naziv: z.string().min(1).max(120),
  slug: z.string().regex(/^[a-z0-9-]+$/, 'Oznaka smije imati samo mala slova, brojeve i crtice.').max(60),
  broj: z.string().min(6).max(30),
  waba_id: z.string().regex(/^\d+$/),
  phone_number_id: z.string().regex(/^\d+$/),
  access_token: z.string().min(20),
  app_secret: z.string().min(16),
});

app.post('/dashboard/api/klijenti', async (request, reply) => {
  const ulaz = NoviKlijentSchema.parse(request.body);
  const rezultat = await dodajKlijenta(ulaz);
  return reply.send({
    dodano: true,
    tenant_id: rezultat.tenant_id,
    channel_id: rezultat.channel_id,
    webhook_url: webhookAdresa(rezultat.webhook_key),
    verify_token: rezultat.verify_token,
    pretplata: rezultat.pretplata,
  });
});

app.post('/dashboard/api/klijenti/:channelId/pretplata', async (request, reply) => {
  const { channelId } = request.params as { channelId: string };
  if (!/^[0-9a-f-]{36}$/i.test(channelId)) {
    return reply.code(400).send({ message: 'Neispravan identifikator kanala.' });
  }
  const tajne = await tajnePoKanalu(channelId);
  const redovi = await query<{ external_account_id: string | null }>(
    'SELECT external_account_id FROM channels WHERE id = $1',
    [channelId],
  );
  const wabaId = redovi[0]?.external_account_id;
  if (!tajne?.accessToken || !wabaId) {
    return reply.code(404).send({ message: 'Kanal nema WhatsApp nalog ili token.' });
  }
  return reply.send(await pretplatiAplikaciju(wabaId, tajne.accessToken));
});

app.get('/dashboard/api/klijenti/:channelId/webhook', async (request, reply) => {
  const { channelId } = request.params as { channelId: string };
  if (!/^[0-9a-f-]{36}$/i.test(channelId)) {
    return reply.code(400).send({ message: 'Neispravan identifikator kanala.' });
  }
  const podaci = await webhookPodaci(channelId);
  if (!podaci) {
    return reply.code(404).send({ message: 'Ovaj kanal nema vlastitu webhook adresu.' });
  }
  return reply.send(podaci);
});

app.post('/dashboard/api/klijenti/:channelId/provjera', async (request, reply) => {
  const { channelId } = request.params as { channelId: string };
  if (!/^[0-9a-f-]{36}$/i.test(channelId)) {
    return reply.code(400).send({ message: 'Neispravan identifikator kanala.' });
  }
  return reply.send(await provjeriKlijenta(channelId));
});

app.setErrorHandler((error, request, reply) => {
  const errorMessage = error instanceof Error ? error.message : String(error);
  logger.error('HTTP obrada nije uspjela.', {
    correlation_id: request.id,
    greska: errorMessage,
  });
  const validation = error instanceof z.ZodError;
  return reply.code(validation ? 400 : 500).send({
    message: validation ? 'Zahtjev nema ispravnu strukturu.' : 'Došlo je do interne greške.',
    correlation_id: request.id,
    detalji: config.NODE_ENV === 'development' ? errorMessage : undefined,
  });
});

const holdTimer = setInterval(() => {
  void bookings.expireHolds().catch((error) => {
    logger.error('Automatsko isticanje holdova nije uspjelo.', { greska: String(error) });
  });
}, 60_000);
holdTimer.unref();

async function shutdown(signal: string): Promise<void> {
  logger.info('Platforma se kontrolisano zaustavlja.', { signal });
  worker.stop();
  clearInterval(holdTimer);
  await app.close().catch(() => undefined);
  await pool.end().catch(() => undefined);
  process.exit(0);
}

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));

await app.listen({ host: config.HOST, port: config.PORT });
worker.start();
logger.info('Rezora platforma je pokrenuta.', { host: config.HOST, port: config.PORT });
