import '../../http/openapi/zod-init.js';
import { OpenAPIRegistry } from '@asteasolutions/zod-to-openapi';
import { errorResponseSchema } from '../../http/openapi/common-schemas.js';
import { registerEndpoint } from '../../http/openapi/register-endpoint.js';
import { submitFeedbackBodySchema, submitFeedbackResponseSchema } from './feedback.schemas.js';
import { season3MatchSchema,season3ResponseSchema } from './season3.schemas.js';
import { z } from 'zod';

export function registerFeedbackOpenApi(registry: OpenAPIRegistry): void {
  for(const operation of ['claim','dismiss','submit'] as const) {
    registerEndpoint(registry,{
      method:'post',path:`/api/v1/feedback/season3${operation==='submit'?'':`/${operation}`}`,
      summary:`Season 3 survey ${operation} (authenticated)`,tags:['Feedback'],
      body:operation==='submit'?season3ResponseSchema:season3MatchSchema,
      responses:{200:{description:'Survey operation completed',schema:operation==='claim'?z.object({kind:z.enum(['vote','idea']).nullable(),saved:z.boolean()}):submitFeedbackResponseSchema},
      400:{description:'Invalid or expired survey',schema:errorResponseSchema},401:{description:'Authentication required',schema:errorResponseSchema},429:{description:'Too many requests',schema:errorResponseSchema}},
    });
  }
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
