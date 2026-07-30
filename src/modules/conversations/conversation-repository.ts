import type { PoolClient } from 'pg';
import type { AiExtraction, NormalizedMessage } from '../../domain/schemas.js';
import { withTransaction } from '../../infrastructure/database.js';
import { normalizePhone } from '../../lib/security.js';

export interface PreparedConversation {
  duplicate: boolean;
  customerId: string;
  conversationId: string;
  status: 'bot' | 'human' | 'closed';
  history: Array<{ direction: 'inbound' | 'outbound'; body: string }>;
  slots: Record<string, unknown>;
}

async function setTenant(client: PoolClient, tenantId: string): Promise<void> {
  await client.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId]);
}

export class ConversationRepository {
  async prepareInbound(message: NormalizedMessage): Promise<PreparedConversation> {
    return withTransaction(async (client) => {
      await setTenant(client, message.tenant_id);

      const channel = await client.query<{ id: string }>(
        `SELECT id FROM channels
          WHERE id = $1 AND tenant_id = $2 AND type = $3 AND status = 'active'`,
        [message.channel_id, message.tenant_id, message.channel_type],
      );
      if (!channel.rowCount) throw new Error('Kanal ne pripada biznisu ili nije aktivan.');

      const normalizedPhone = normalizePhone(message.customer_phone);
      const customer = await client.query<{ id: string }>(
        `INSERT INTO customers (tenant_id, normalized_phone)
         VALUES ($1, $2)
         ON CONFLICT (tenant_id, normalized_phone)
         DO UPDATE SET updated_at = now()
         RETURNING id`,
        [message.tenant_id, normalizedPhone],
      );
      const customerId = customer.rows[0].id;

      const conversation = await client.query<{
        id: string;
        status: 'bot' | 'human' | 'closed';
      }>(
        `INSERT INTO conversations (
           tenant_id, channel_id, customer_id, external_customer_id, last_message_at
         ) VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (tenant_id, channel_id, external_customer_id)
         DO UPDATE SET last_message_at = EXCLUDED.last_message_at, updated_at = now()
         RETURNING id, status`,
        [
          message.tenant_id,
          message.channel_id,
          customerId,
          message.customer_external_id,
          message.received_at,
        ],
      );
      const conversationRow = conversation.rows[0];

      const inserted = await client.query<{ id: string }>(
        `INSERT INTO messages (
           tenant_id, conversation_id, channel_id, external_message_id, direction,
           message_type, body, status, occurred_at, metadata
         ) VALUES ($1, $2, $3, $4, 'inbound', $5, $6, 'received', $7, $8)
         ON CONFLICT DO NOTHING
         RETURNING id`,
        [
          message.tenant_id,
          conversationRow.id,
          message.channel_id,
          message.external_message_id,
          message.message_type,
          message.text,
          message.received_at,
          message.metadata,
        ],
      );

      await client.query(
        `INSERT INTO conversation_states (conversation_id, tenant_id)
         VALUES ($1, $2) ON CONFLICT (conversation_id) DO NOTHING`,
        [conversationRow.id, message.tenant_id],
      );

      const [history, state] = await Promise.all([
        client.query<{ direction: 'inbound' | 'outbound'; body: string }>(
          `SELECT direction, body FROM (
             SELECT direction, body, occurred_at
               FROM messages
              WHERE tenant_id = $1 AND conversation_id = $2
              ORDER BY occurred_at DESC LIMIT 10
           ) recent ORDER BY occurred_at`,
          [message.tenant_id, conversationRow.id],
        ),
        client.query<{ slots: Record<string, unknown> }>(
          `SELECT slots FROM conversation_states
            WHERE tenant_id = $1 AND conversation_id = $2`,
          [message.tenant_id, conversationRow.id],
        ),
      ]);

      return {
        duplicate: inserted.rowCount === 0,
        customerId,
        conversationId: conversationRow.id,
        status: conversationRow.status,
        history: history.rows,
        slots: state.rows[0]?.slots ?? {},
      };
    });
  }

  async updateCustomerName(tenantId: string, customerId: string, name: string): Promise<void> {
    if (!name.trim()) return;
    await withTransaction(async (client) => {
      await setTenant(client, tenantId);
      await client.query(
        `UPDATE customers SET name = $3, updated_at = now()
          WHERE tenant_id = $1 AND id = $2 AND (name = '' OR name IS NULL)`,
        [tenantId, customerId, name.trim()],
      );
    });
  }

  async updateState(
    tenantId: string,
    conversationId: string,
    extraction: AiExtraction,
    slots: Record<string, unknown>,
  ): Promise<void> {
    await withTransaction(async (client) => {
      await setTenant(client, tenantId);
      await client.query(
        `UPDATE conversation_states
            SET last_intent = $3, slots = $4, version = version + 1, updated_at = now()
          WHERE tenant_id = $1 AND conversation_id = $2`,
        [tenantId, conversationId, extraction.intent, slots],
      );
    });
  }

  async recordOutbound(
    message: NormalizedMessage,
    conversationId: string,
    body: string,
    status = 'planned',
  ): Promise<void> {
    if (!body) return;
    await withTransaction(async (client) => {
      await setTenant(client, message.tenant_id);
      await client.query(
        `INSERT INTO messages (
           tenant_id, conversation_id, channel_id, direction, message_type,
           body, status, occurred_at, metadata
         ) VALUES ($1, $2, $3, 'outbound', 'text', $4, $5, now(), $6)`,
        [message.tenant_id, conversationId, message.channel_id, body, status, { reply_to: message.external_message_id }],
      );
    });
  }

  async openHandoff(tenantId: string, conversationId: string, reason: string): Promise<void> {
    await withTransaction(async (client) => {
      await setTenant(client, tenantId);
      await client.query(
        `UPDATE conversations SET status = 'human', updated_at = now()
          WHERE tenant_id = $1 AND id = $2`,
        [tenantId, conversationId],
      );
      await client.query(
        `INSERT INTO human_handoff_cases (tenant_id, conversation_id, reason)
         SELECT $1, $2, $3
          WHERE NOT EXISTS (
            SELECT 1 FROM human_handoff_cases
             WHERE tenant_id = $1 AND conversation_id = $2 AND status IN ('open', 'assigned')
          )`,
        [tenantId, conversationId, reason],
      );
    });
  }
}

