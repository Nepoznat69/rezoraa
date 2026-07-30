import { NormalizedMessageSchema, type NormalizedMessage } from '../../../domain/schemas.js';
import { query } from '../../../infrastructure/database.js';
import { logger } from '../../../lib/logger.js';
import { InboundRepository } from '../../inbound/inbound-repository.js';

interface ChannelRow {
  id: string;
  tenant_id: string;
}

function messageText(message: Record<string, unknown>): string {
  const type = String(message.type ?? 'unknown');
  if (type === 'text') {
    const text = message.text as { body?: string } | undefined;
    return text?.body ?? '';
  }
  if (type === 'interactive') return '[Korisnik je poslao interaktivni odgovor]';
  if (type === 'audio') return '[Korisnik je poslao glasovnu ili audio poruku]';
  if (type === 'image') return '[Korisnik je poslao sliku]';
  if (type === 'document') return '[Korisnik je poslao dokument]';
  if (type === 'video') return '[Korisnik je poslao video]';
  if (type === 'location') return '[Korisnik je poslao lokaciju]';
  return '[Primljena je nepodržana vrsta poruke]';
}

function supportedType(type: string): NormalizedMessage['message_type'] {
  const supported = ['text', 'image', 'audio', 'video', 'document', 'interactive', 'location'];
  return supported.includes(type) ? (type as NormalizedMessage['message_type']) : 'unknown';
}

export class MetaWebhookService {
  constructor(private readonly inbox = new InboundRepository()) {}

  async accept(payload: unknown): Promise<{ messages: number; statuses: number }> {
    if (!payload || typeof payload !== 'object') return { messages: 0, statuses: 0 };
    const root = payload as { object?: string; entry?: unknown[] };
    if (root.object !== 'whatsapp_business_account' || !Array.isArray(root.entry)) {
      return { messages: 0, statuses: 0 };
    }

    let messageCount = 0;
    let statusCount = 0;
    for (const rawEntry of root.entry) {
      const entry = rawEntry as { changes?: unknown[] };
      for (const rawChange of entry.changes ?? []) {
        const change = rawChange as { value?: Record<string, unknown>; field?: string };
        if (change.field !== 'messages' || !change.value) continue;
        const value = change.value;
        const metadata = value.metadata as { phone_number_id?: string } | undefined;
        if (!metadata?.phone_number_id) continue;
        const channels = await query<ChannelRow>(
          `SELECT id, tenant_id FROM channels
            WHERE type = 'whatsapp_cloud' AND external_phone_number_id = $1 AND status = 'active'`,
          [metadata.phone_number_id],
        );
        const channel = channels[0];
        if (!channel) {
          logger.warn('Meta webhook je stigao za nepoznat Phone Number ID.', {
            phone_number_id: metadata.phone_number_id,
          });
          continue;
        }

        const statuses = Array.isArray(value.statuses) ? value.statuses : [];
        for (const rawStatus of statuses) {
          const status = rawStatus as { id?: string; status?: string; timestamp?: string };
          if (!status.id || !status.status) continue;
          await query(
            `UPDATE messages SET status = $3,
                    metadata = metadata || jsonb_build_object('meta_status_timestamp', $4::text)
              WHERE tenant_id = $1 AND channel_id = $2 AND external_message_id = $5`,
            [channel.tenant_id, channel.id, status.status, status.timestamp ?? '', status.id],
          );
          statusCount += 1;
        }

        const contacts = Array.isArray(value.contacts) ? value.contacts : [];
        const contactName = ((contacts[0] as { profile?: { name?: string } } | undefined)?.profile?.name ?? '').trim();
        const messages = Array.isArray(value.messages) ? value.messages : [];
        for (const rawMessage of messages) {
          const message = rawMessage as Record<string, unknown>;
          const id = String(message.id ?? '');
          const from = String(message.from ?? '');
          if (!id || !from) continue;
          const timestamp = Number(message.timestamp ?? Math.floor(Date.now() / 1000));
          const type = String(message.type ?? 'unknown');
          const normalized = NormalizedMessageSchema.parse({
            event_id: id,
            tenant_id: channel.tenant_id,
            channel_id: channel.id,
            channel_type: 'whatsapp_cloud',
            external_message_id: id,
            customer_external_id: from,
            customer_phone: from,
            message_type: supportedType(type),
            text: messageText(message),
            received_at: new Date(timestamp * 1000).toISOString(),
            metadata: { meta: message, contact_name: contactName },
          });
          if (await this.inbox.enqueue(normalized)) messageCount += 1;
        }
      }
    }
    return { messages: messageCount, statuses: statusCount };
  }
}
