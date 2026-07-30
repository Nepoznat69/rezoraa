import { describe, expect, it } from 'vitest';
import { AiExtractionSchema } from '../src/domain/schemas.js';

describe('AI ugovor', () => {
  it('odbija nedozvoljeni intent', () => {
    expect(() =>
      AiExtractionSchema.parse({
        intent: 'upisi_u_bazu',
      }),
    ).toThrow();
  });
});
