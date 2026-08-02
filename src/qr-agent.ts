import 'dotenv/config';
import qrcode from 'qrcode-terminal';
import whatsapp from 'whatsapp-web.js';
import { config } from './config.js';
import { NormalizedMessageSchema } from './domain/schemas.js';
import { logger, maskPhone } from './lib/logger.js';
import { normalizePhone } from './lib/security.js';

const { Client, LocalAuth } = whatsapp;

const puppeteer: Record<string, unknown> = {
  headless: config.QR_HEADLESS,
  args: ['--disable-dev-shm-usage', '--disable-gpu'],
  timeout: 60_000,
};
if (config.CHROME_EXECUTABLE_PATH) puppeteer.executablePath = config.CHROME_EXECUTABLE_PATH;

const client = new Client({
  authStrategy: new LocalAuth({
    clientId: config.QR_CLIENT_ID,
    dataPath: config.QR_AUTH_PATH,
  }),
  puppeteer,
});

const conversationChains = new Map<string, Promise<void>>();

async function sendInbound(payload: ReturnType<typeof NormalizedMessageSchema.parse>): Promise<string> {
  let lastError: Error | null = null;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 65_000);
    try {
      const response = await fetch(config.QR_INBOUND_URL, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${config.QR_AGENT_TOKEN}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
      const data = (await response.json()) as { reply?: unknown; duplicate?: boolean; message?: string };
      if (!response.ok) throw new Error(data.message || `Sistem je vratio HTTP ${response.status}.`);
      if (data.duplicate) return '';
      if (typeof data.reply !== 'string') throw new Error('Sistem nije vratio tekstualni odgovor.');
      return data.reply;
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      if (attempt < 3) await new Promise((resolve) => setTimeout(resolve, attempt * 1_000));
    } finally {
      clearTimeout(timeout);
    }
  }
  throw lastError ?? new Error('Slanje poruke nije uspjelo.');
}

client.on('qr', (qr) => {
  console.log('\nSkenirajte QR kod preko WhatsApp Business aplikacije:\n');
  qrcode.generate(qr, { small: true });
});

client.on('ready', () => {
  logger.info('Rezora QR Agent je povezan i spreman.', { client_id: config.QR_CLIENT_ID });
});

client.on('authenticated', () => {
  logger.info('WhatsApp QR autentifikacija je uspješna.');
});

client.on('auth_failure', (message) => {
  logger.error('WhatsApp QR autentifikacija nije uspjela.', { greska: message });
});

client.on('disconnected', (reason) => {
  logger.warn('WhatsApp QR kanal je diskonektovan.', { razlog: String(reason) });
});

client.on('message', (message) => {
  if (message.fromMe || message.from.endsWith('@g.us')) return;
  const key = message.from;
  const previous = conversationChains.get(key) ?? Promise.resolve();
  const current = previous
    .then(async () => {
      const hasMedia = message.hasMedia;
      if (!message.body && !hasMedia) return;
      const messageType = hasMedia ? 'unknown' : 'text';
      const text = message.body || '[Korisnik je poslao medijsku poruku]';
      const externalId = message.id?._serialized || `${message.from}-${message.timestamp}`;
      const payload = NormalizedMessageSchema.parse({
        event_id: externalId,
        // Ime varijable je istorijsko (.env se ne dira); vrijednost mora biti
        // `business_id` biznisa u Rezora Coreu.
        business_id: config.QR_TENANT_ID,
        channel_id: config.QR_CHANNEL_ID,
        channel_type: 'whatsapp_qr',
        external_message_id: externalId,
        customer_external_id: message.from,
        customer_phone: normalizePhone(message.from),
        message_type: messageType,
        text,
        received_at: new Date(message.timestamp * 1_000).toISOString(),
        metadata: { has_media: hasMedia, whatsapp_type: message.type },
      });

      logger.info('Primljena je QR WhatsApp poruka.', {
        telefon: maskPhone(payload.customer_phone),
        tip: payload.message_type,
      });
      const chat = await message.getChat();
      await chat.sendStateTyping();
      const reply = await sendInbound(payload);
      if (reply) await message.reply(reply);
    })
    .catch(async (error) => {
      logger.error('QR poruka nije obrađena.', { greska: error instanceof Error ? error.message : String(error) });
      await message.reply('Izvinite, trenutno imamo tehnički problem. Pokušajte ponovo za nekoliko minuta.').catch(() => undefined);
    })
    .finally(() => {
      if (conversationChains.get(key) === current) conversationChains.delete(key);
    });
  conversationChains.set(key, current);
});

async function shutdown(signal: string): Promise<void> {
  logger.info('QR Agent se kontrolisano zaustavlja.', { signal });
  await client.destroy().catch(() => undefined);
  process.exit(0);
}

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));

await client.initialize();

