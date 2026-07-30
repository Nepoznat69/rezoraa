import { config } from '../../config.js';
import { NormalizedMessageSchema } from '../../domain/schemas.js';
import { logger, maskPhone } from '../../lib/logger.js';
import { MetaClient } from '../channels/meta/meta-client.js';
import { ConversationOrchestrator, type OrchestrationResult } from '../conversations/orchestrator.js';
import { InboundRepository } from './inbound-repository.js';

export class InboundWorker {
  private stopped = false;
  private running = false;

  constructor(
    private readonly inbox = new InboundRepository(),
    private readonly orchestrator = new ConversationOrchestrator(),
    private readonly meta = new MetaClient(),
  ) {}

  start(): void {
    this.stopped = false;
    void this.loop();
  }

  stop(): void {
    this.stopped = true;
  }

  private async throughN8n(message: ReturnType<typeof NormalizedMessageSchema.parse>): Promise<OrchestrationResult> {
    if (!config.N8N_META_INBOUND_URL) throw new Error('N8N_META_INBOUND_URL nije konfigurisan.');
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 60_000);
    try {
      const response = await fetch(config.N8N_META_INBOUND_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Internal-Api-Key': config.INTERNAL_API_KEY,
        },
        body: JSON.stringify(message),
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(`n8n je vratio HTTP ${response.status}.`);
      return (await response.json()) as OrchestrationResult;
    } finally {
      clearTimeout(timeout);
    }
  }

  private async loop(): Promise<void> {
    if (this.running) return;
    this.running = true;
    while (!this.stopped) {
      const event = await this.inbox.claim().catch((error) => {
        logger.error('Nije moguće preuzeti inbound događaj.', { greska: String(error) });
        return null;
      });
      if (!event) {
        await new Promise((resolve) => setTimeout(resolve, 500));
        continue;
      }

      try {
        const message = NormalizedMessageSchema.parse(event.payload);
        const result = config.ORCHESTRATION_MODE === 'n8n'
          ? await this.throughN8n(message)
          : await this.orchestrator.process(message);
        if (result.reply && message.channel_type === 'whatsapp_cloud') {
          await this.meta.sendText(message.channel_id, message.customer_external_id, result.reply);
        }
        await this.inbox.complete(event.id);
        logger.info('Meta poruka je obrađena.', {
          telefon: maskPhone(message.customer_phone),
          intent: result.intent,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await this.inbox.fail(event.id, event.attempts, message);
        logger.error('Obrada inbound poruke nije uspjela.', { greska: message, pokusaj: event.attempts });
      }
    }
    this.running = false;
  }
}

