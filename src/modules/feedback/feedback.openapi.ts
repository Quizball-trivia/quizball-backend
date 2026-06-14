import '../../http/openapi/zod-init.js';
import { OpenAPIRegistry } from '@asteasolutions/zod-to-openapi';
import { errorResponseSchema } from '../../http/openapi/common-schemas.js';
import { registerEndpoint } from '../../http/openapi/register-endpoint.js';
import { submitFeedbackBodySchema, submitFeedbackResponseSchema } from './feedback.schemas.js';

export function registerFeedbackOpenApi(registry: OpenAPIRegistry): void {
  const response = submitFeedbackResponseSchema.openapi('SubmitFeedbackResponse');
  registry.register('SubmitFeedbackResponse', response);

  registerEndpoint(registry, {
    method: 'post',
    path: '/api/v1/feedback',
    summary: 'Submit contact / bug-report feedback (emailed to support)',
    tags: ['Feedback'],
    body: submitFeedbackBodySchema,
    responses: {
      200: { description: 'Feedback received', schema: response },
      400: { description: 'Invalid input', schema: errorResponseSchema },
      429: { description: 'Too many submissions (rate limited)', schema: errorResponseSchema },
      502: { description: 'Email provider error', schema: errorResponseSchema },
    },
  });
}
