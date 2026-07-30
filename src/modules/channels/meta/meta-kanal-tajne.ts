import { config } from '../../../config.js';
import { query } from '../../../infrastructure/database.js';
import { desifrirajOpcionalno } from '../../../lib/tajne.js';

/**
 * Dohvat tajni pojedinog Meta kanala.
 *
 * Svaki klijent donosi vlastitu Meta aplikaciju, pa app secret, verify token i
 * pristupni token pripadaju kanalu, a ne platformi. Globalne vrijednosti iz
 * okruženja ostaju kao rezerva za Rezorin vlastiti kanal, koji je postojao
 * prije nego je platforma postala višeklijentska.
 */

export interface KanalTajne {
  id: string;
  tenantId: string;
  phoneNumberId: string | null;
  appSecret?: string;
  verifyToken?: string;
  accessToken?: string;
}

interface KanalRed {
  id: string;
  tenant_id: string;
  external_phone_number_id: string | null;
  secret_env_key: string | null;
  app_secret_encrypted: string | null;
  verify_token_encrypted: string | null;
  access_token_encrypted: string | null;
}

const IZBOR = `
  SELECT id, tenant_id, external_phone_number_id, secret_env_key,
         app_secret_encrypted, verify_token_encrypted, access_token_encrypted
    FROM channels
   WHERE type = 'whatsapp_cloud' AND status = 'active'`;

function sastavi(red: KanalRed): KanalTajne {
  const izEnva = red.secret_env_key ? process.env[red.secret_env_key] : undefined;
  return {
    id: red.id,
    tenantId: red.tenant_id,
    phoneNumberId: red.external_phone_number_id,
    // Redoslijed: tajna kanala iz baze → imenovana env varijabla → globalna vrijednost.
    appSecret: desifrirajOpcionalno(red.app_secret_encrypted) ?? config.META_APP_SECRET,
    verifyToken: desifrirajOpcionalno(red.verify_token_encrypted) ?? config.META_VERIFY_TOKEN,
    accessToken: desifrirajOpcionalno(red.access_token_encrypted) ?? izEnva ?? config.META_ACCESS_TOKEN,
  };
}

export async function tajnePoWebhookKljucu(kljuc: string): Promise<KanalTajne | null> {
  const redovi = await query<KanalRed>(`${IZBOR} AND webhook_key = $1`, [kljuc]);
  return redovi[0] ? sastavi(redovi[0]) : null;
}

export async function tajnePoKanalu(channelId: string): Promise<KanalTajne | null> {
  const redovi = await query<KanalRed>(`${IZBOR} AND id = $1`, [channelId]);
  return redovi[0] ? sastavi(redovi[0]) : null;
}
