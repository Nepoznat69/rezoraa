/**
 * Red čekanja dolaznih poruka.
 *
 * `inbound_events` NAMJERNO ostaje u lokalnoj bazi: to je infrastruktura
 * gatewaya (isporuka, ponovni pokušaji, redoslijed po sagovorniku), a ne
 * poslovni podatak. Poslovni podaci su u Rezora Coreu.
 *
 * Kolona se istorijski zove `tenant_id`, ali u njoj od prelaska na Core stoji
 * `business_id` iz Corea. Ime kolone se ne dira jer se lokalne migracije ne
 * mijenjaju; jedino mjesto koje o toj razlici mora znati je ovaj fajl.
 */

import type { NormalizedMessage } from '../../domain/schemas.js';
import { query, withTransaction } from '../../infrastructure/database.js';

interface EventRow {
  id: string;
  payload: NormalizedMessage;
  attempts: number;
}

export class InboundRepository {
  async enqueue(message: NormalizedMessage): Promise<boolean> {
    const rows = await query<{ id: string }>(
      `INSERT INTO inbound_events (
         tenant_id, channel_id, event_id, external_customer_id, payload
       ) VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (tenant_id, channel_id, event_id) DO NOTHING
       RETURNING id`,
      [
        // business_id iz Corea u istoimenu (istorijski nazvanu) kolonu.
        message.business_id,
        message.channel_id,
        message.event_id,
        message.customer_external_id,
        message,
      ],
    );
    return rows.length > 0;
  }

  async claim(): Promise<EventRow | null> {
    return withTransaction(async (client) => {
      const result = await client.query<EventRow>(
        `WITH candidate AS (
           SELECT current.id
             FROM inbound_events current
            WHERE current.status IN ('received', 'failed')
              AND current.available_at <= now()
              AND current.attempts < 8
              AND NOT EXISTS (
                SELECT 1 FROM inbound_events older
                 WHERE older.tenant_id = current.tenant_id
                   AND older.channel_id = current.channel_id
                   AND older.external_customer_id = current.external_customer_id
                   AND older.status IN ('received', 'processing', 'failed')
                   AND (older.received_at, older.id) < (current.received_at, current.id)
              )
            ORDER BY current.received_at, current.id
            FOR UPDATE SKIP LOCKED
            LIMIT 1
         )
         UPDATE inbound_events event
            SET status = 'processing', attempts = attempts + 1, last_error = NULL
           FROM candidate
          WHERE event.id = candidate.id
         RETURNING event.id, event.payload, event.attempts`,
      );
      return result.rows[0] ?? null;
    });
  }

  async complete(id: string): Promise<void> {
    await query(
      `UPDATE inbound_events SET status = 'completed', processed_at = now()
        WHERE id = $1`,
      [id],
    );
  }

  async fail(id: string, attempts: number, error: string): Promise<void> {
    const delaySeconds = Math.min(300, 2 ** Math.min(attempts, 8));
    await query(
      `UPDATE inbound_events
          SET status = 'failed', last_error = $2,
              available_at = now() + make_interval(secs => $3)
        WHERE id = $1`,
      [id, error.slice(0, 2000), delaySeconds],
    );
  }
}

