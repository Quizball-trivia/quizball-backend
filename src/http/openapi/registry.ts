/**
 * OpenAPI coordinator.
 *
 * Each module (auth, users, stats, …) hand-writes a `*.openapi.ts` file that
 * exports a `registerXxxOpenApi(registry)` function. This file imports each
 * registrar, wires them into a single `OpenAPIRegistry`, and generates the
 * final OpenAPI 3.0 document via `generateOpenApiDocument()`.
 *
 * To add or change an endpoint:
 *   1. Edit the relevant `src/modules/<feature>/<feature>.openapi.ts`
 *   2. The `tests/openapi/spec-snapshot.test.ts` snapshot guard catches drift.
 *      Intentional changes: regenerate the baseline with
 *      `npx tsx scripts/export-openapi.ts > tests/openapi/__fixtures__/openapi.baseline.json`
 *      and commit it alongside.
 *   3. Frontend types regenerate with `cd ../frontend-web-next && npm run api:sync:local`.
 *
 * The post-generation `$ref` fix-ups at the bottom of this file are
 * workarounds for zod-to-openapi composition limits — they ensure
 * `QuestionResponse.payload`, `UserResponse.progression`, and
 * `PublicProfileResponse.{progression,ranked,stats,headToHead}` link to
 * their named schemas instead of inlining duplicated definitions.
 */
import {
  OpenAPIRegistry,
  OpenApiGeneratorV3,
  extendZodWithOpenApi,
} from '@asteasolutions/zod-to-openapi';
import { z } from 'zod';
import { config } from '../../core/config.js';
import { registerCommonSchemas } from './common-schemas.js';
import { registerAuthOpenApi } from '../../modules/auth/auth.openapi.js';
import { registerCategoriesOpenApi } from '../../modules/categories/categories.openapi.js';
import { registerDailyChallengesOpenApi } from '../../modules/daily-challenges/daily-challenges.openapi.js';
import { registerFeaturedCategoriesOpenApi } from '../../modules/featured-categories/featured-categories.openapi.js';
import { registerFriendsOpenApi } from '../../modules/friends/friends.openapi.js';
import { registerLobbiesOpenApi } from '../../modules/lobbies/lobbies.openapi.js';
import { registerObjectivesOpenApi } from '../../modules/objectives/objectives.openapi.js';
import { registerQuestionsOpenApi } from '../../modules/questions/questions.openapi.js';
import { registerRankedOpenApi } from '../../modules/ranked/ranked.openapi.js';
import { registerStatsOpenApi } from '../../modules/stats/stats.openapi.js';
import { registerStoreOpenApi } from '../../modules/store/store.openapi.js';
import { registerUsersOpenApi } from '../../modules/users/users.openapi.js';
import { registerNotificationsOpenApi } from '../../modules/notifications/notifications.openapi.js';
import { registerAnnouncementsOpenApi } from '../../modules/announcements/announcements.openapi.js';
import { registerFeedbackOpenApi } from '../../modules/feedback/feedback.openapi.js';

extendZodWithOpenApi(z);

export const registry = new OpenAPIRegistry();

// Module registration order matches the original registry.ts so the resulting
// `components.schemas` object has a stable order. (The snapshot test
// canonicalizes order before comparing, so this is for human-diff comfort.)
registerCommonSchemas(registry);
registerAuthOpenApi(registry);
registerStatsOpenApi(registry);
registerLobbiesOpenApi(registry);
registerRankedOpenApi(registry);
registerStoreOpenApi(registry);
registerUsersOpenApi(registry);
registerFriendsOpenApi(registry);
registerObjectivesOpenApi(registry);
registerCategoriesOpenApi(registry);
registerFeaturedCategoriesOpenApi(registry);
registerQuestionsOpenApi(registry);
registerDailyChallengesOpenApi(registry);
registerNotificationsOpenApi(registry);
registerAnnouncementsOpenApi(registry);
registerFeedbackOpenApi(registry);

function buildOpenApiServers(): Array<{ url: string; description: string }> {
  const servers: Array<{ url: string; description: string }> = [];

  if (config.API_BASE_URL) {
    const envDescriptions: Record<string, string> = {
      local: 'Development Server',
      staging: 'Staging Server',
      prod: 'Production Server',
    };
    servers.push({
      url: config.API_BASE_URL,
      description: envDescriptions[config.NODE_ENV] || 'API Server',
    });
  }

  servers.push({
    url: `http://localhost:${config.PORT}`,
    description: 'Local development',
  });

  return servers;
}

export function generateOpenApiDocument() {
  const generator = new OpenApiGeneratorV3(registry.definitions);
  const document = generator.generateDocument({
    openapi: '3.0.0',
    info: {
      title: 'QuizBall API',
      version: '1.0.0',
      description: 'QuizBall Backend API',
    },
    servers: buildOpenApiServers(),
  });

  // ── Post-generation $ref fix-ups ──
  // zod-to-openapi inlines union members and extended schemas instead of
  // emitting $refs, even when both sides are registered. Patch the
  // composed properties manually so the spec stays normalized.

  const questionResponse = document.components?.schemas?.QuestionResponse as
    | { properties?: { payload?: unknown } }
    | undefined;
  if (questionResponse?.properties) {
    questionResponse.properties.payload = {
      allOf: [{ $ref: '#/components/schemas/QuestionPayload' }],
      nullable: true,
    };
  }

  const userResponse = document.components?.schemas?.UserResponse as
    | { properties?: { progression?: unknown } }
    | undefined;
  if (userResponse?.properties) {
    userResponse.properties.progression = {
      $ref: '#/components/schemas/ProgressionResponse',
    };
  }

  const publicProfileResponse = document.components?.schemas?.PublicProfileResponse as
    | {
        properties?: {
          progression?: unknown;
          ranked?: unknown;
          stats?: unknown;
          headToHead?: unknown;
        };
      }
    | undefined;
  if (publicProfileResponse?.properties) {
    publicProfileResponse.properties.progression = {
      $ref: '#/components/schemas/ProgressionResponse',
    };
    publicProfileResponse.properties.ranked = {
      allOf: [{ $ref: '#/components/schemas/RankedProfileResponse' }],
      nullable: true,
    };
    publicProfileResponse.properties.stats = {
      $ref: '#/components/schemas/StatsSummaryResponse',
    };
    publicProfileResponse.properties.headToHead = {
      allOf: [{ $ref: '#/components/schemas/HeadToHeadResponse' }],
      nullable: true,
    };
  }

  return document;
}
