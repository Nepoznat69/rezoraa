import 'dotenv/config';
import { z } from 'zod';

const booleanFromEnv = z
  .enum(['true', 'false'])
  .default('true')
  .transform((value) => value === 'true');

const optionalText = z.preprocess(
  (value) => (typeof value === 'string' && value.trim() === '' ? undefined : value),
  z.string().optional(),
);

const ConfigSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  HOST: z.string().default('0.0.0.0'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
  DATABASE_URL: z
    .string()
    .default('postgresql://rezora:promijeni-lozinku@localhost:5432/rezora'),
  INTERNAL_API_KEY: z.string().default('promijeni-interni-kljuc'),
  ORCHESTRATION_MODE: z.enum(['backend', 'n8n']).default('backend'),
  // Koliko dugo asistent šuti nakon predaje čovjeku ako se niko ne javi.
  // Nula ili manje isključuje povratak i predaja ostaje trajna.
  HANDOFF_POVRATAK_MINUTA: z.coerce.number().int().default(30),
  OPENAI_API_KEY: optionalText,
  OPENAI_MODEL: z.string().default('gpt-4o-mini'),
  OPENAI_ENABLED: booleanFromEnv,
  QR_INBOUND_URL: z
    .string()
    .url()
    .default('http://localhost:3000/api/v1/channels/qr/inbound'),
  QR_AGENT_TOKEN: z.string().default('promijeni-qr-token'),
  QR_TENANT_ID: z.string().uuid().default('00000000-0000-4000-8000-000000000001'),
  QR_CHANNEL_ID: z.string().uuid().default('00000000-0000-4000-8000-000000000101'),
  QR_CLIENT_ID: z.string().default('test-bot'),
  QR_AUTH_PATH: z.string().default('.wwebjs_auth'),
  QR_HEADLESS: booleanFromEnv,
  CHROME_EXECUTABLE_PATH: optionalText,
  META_VERIFY_TOKEN: z.string().default('promijeni-meta-verify-token'),
  META_APP_ID: optionalText,
  META_EMBEDDED_SIGNUP_CONFIG_ID: optionalText,
  META_APP_SECRET: optionalText,
  META_ACCESS_TOKEN: optionalText,
  META_GRAPH_VERSION: optionalText,
  // Kopija svakog POTVRĐENOG Metinog webhooka ide i na ovu adresu. Postoji
  // zato što Metina aplikacija ima tačno jednu callback adresu, pa se drugi
  // sistem na istoj WhatsApp liniji ne može pretplatiti sam.
  // Prazno = ne prosljeđuje se nikome. Vidi channels/meta/prosljedjivanje.ts.
  META_WEBHOOK_FORWARD_URL: optionalText,
  N8N_META_INBOUND_URL: optionalText,
  // Master ključ kojim se šifriraju tajne klijenata u bazi.
  SECRETS_KEY: optionalText,
  // Lozinka za interni dashboard (korisničko ime je uvijek "rezora").
  DASHBOARD_PASSWORD: optionalText,
  // Javna adresa platforme; koristi se da dashboard ispiše tačan webhook URL.
  PUBLIC_BASE_URL: optionalText,
  // Osnovna adresa Rezora Corea (bez završne kose crte). Interni API živi na
  // {CORE_BASE_URL}/api/internal. Opciono u shemi jer gateway mora startati i
  // bez bookinga; core-klijent baca jasnu grešku tek kad ga neko pozove.
  CORE_BASE_URL: optionalText,
  // Zajednička tajna za x-internal-key. Ista vrijednost mora stajati u Coreu.
  CORE_INTERNAL_API_KEY: optionalText,
});

export type AppConfig = z.infer<typeof ConfigSchema>;

export const config: AppConfig = ConfigSchema.parse(process.env);

const razvojneVrijednosti = new Set([
  'promijeni-interni-kljuc',
  'promijeni-qr-token',
  'promijeni-meta-verify-token',
]);

if (
  config.NODE_ENV === 'production' &&
  [config.INTERNAL_API_KEY, config.QR_AGENT_TOKEN, config.META_VERIFY_TOKEN].some((value) =>
    razvojneVrijednosti.has(value),
  )
) {
  throw new Error('Produkcija ne smije koristiti razvojne sigurnosne ključeve.');
}
