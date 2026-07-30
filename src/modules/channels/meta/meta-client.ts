import { config } from '../../../config.js';
import { query } from '../../../infrastructure/database.js';
import { desifrirajOpcionalno } from '../../../lib/tajne.js';

interface ChannelRow {
  external_phone_number_id: string;
  secret_env_key: string | null;
  access_token_encrypted: string | null;
}

interface MetaResponse {
  messages?: Array<{ id: string }>;
  error?: { message?: string; code?: number };
}

export class MetaClient {
  private async channel(channelId: string): Promise<ChannelRow> {
    const rows = await query<ChannelRow>(
      `SELECT external_phone_number_id, secret_env_key, access_token_encrypted FROM channels
        WHERE id = $1 AND type = 'whatsapp_cloud' AND status = 'active'`,
      [channelId],
    );
    const channel = rows[0];
    if (!channel?.external_phone_number_id) throw new Error('Meta kanal nema phone_number_id.');
    return channel;
  }

  private token(channel: ChannelRow): string {
    // Klijent sa vlastitom Meta aplikacijom ima token u bazi. Imenovana env
    // varijabla i globalni token ostaju kao rezerva za starije kanale.
    const tokenKanala = desifrirajOpcionalno(channel.access_token_encrypted);
    const tenantToken = channel.secret_env_key ? process.env[channel.secret_env_key] : undefined;
    const token = tokenKanala || tenantToken || config.META_ACCESS_TOKEN;
    if (!token) throw new Error('Meta access token nije konfigurisan.');
    return token;
  }

  private endpoint(phoneNumberId: string): string {
    if (!config.META_GRAPH_VERSION || !/^v\d+\.\d+$/.test(config.META_GRAPH_VERSION)) {
      throw new Error('META_GRAPH_VERSION mora biti eksplicitno postavljen, npr. vXX.X prema aktuelnoj Meta verziji.');
    }
    return `https://graph.facebook.com/${config.META_GRAPH_VERSION}/${phoneNumberId}/messages`;
  }

  private async send(channelId: string, payload: Record<string, unknown>): Promise<string> {
    const channel = await this.channel(channelId);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15_000);
    try {
      const response = await fetch(this.endpoint(channel.external_phone_number_id), {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.token(channel)}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ messaging_product: 'whatsapp', ...payload }),
        signal: controller.signal,
      });
      const body = (await response.json()) as MetaResponse;
      if (!response.ok || body.error) {
        throw new Error(`Meta API greška ${response.status}: ${body.error?.message ?? 'nepoznata greška'}`);
      }
      const id = body.messages?.[0]?.id;
      if (!id) throw new Error('Meta API nije vratio ID poslane poruke.');
      return id;
    } finally {
      clearTimeout(timeout);
    }
  }

  async sendText(channelId: string, to: string, text: string): Promise<string> {
    return this.send(channelId, {
      recipient_type: 'individual',
      to,
      type: 'text',
      text: { preview_url: false, body: text },
    });
  }

  async sendTemplate(
    channelId: string,
    to: string,
    templateName: string,
    languageCode: string,
    components: unknown[] = [],
  ): Promise<string> {
    return this.send(channelId, {
      to,
      type: 'template',
      template: {
        name: templateName,
        language: { code: languageCode },
        components,
      },
    });
  }
}

