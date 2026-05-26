import type { Request, Response } from 'express';
import { translationService } from './translation.service.js';
import type { TranslateRequestBody } from './translation.schemas.js';

export const translationController = {
  /**
   * POST /api/v1/translation/translate
   * Generic admin-only translation endpoint backed by the configured LLM
   * provider. Caller supplies items keyed by id; response preserves order.
   */
  async translate(req: Request, res: Response): Promise<void> {
    const { items, target_locale, source_locale, domain } = req.validated.body as TranslateRequestBody;

    const translations = await translationService.translate({
      items,
      targetLocale: target_locale,
      sourceLocale: source_locale,
      domain,
    });

    res.status(200).json({ translations });
  },
};
