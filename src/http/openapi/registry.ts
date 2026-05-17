import {
  OpenAPIRegistry,
  OpenApiGeneratorV3,
  extendZodWithOpenApi,
} from '@asteasolutions/zod-to-openapi';
import { z } from 'zod';
import { config } from '../../core/config.js';

// Extend Zod with OpenAPI support
extendZodWithOpenApi(z);

/**
 * OpenAPI registry for manual route registration.
 */
export const registry = new OpenAPIRegistry();

// =============================================================================
// Common Schemas
// =============================================================================

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
// =============================================================================
// Generate OpenAPI Document
// =============================================================================

/**
 * Build OpenAPI servers array based on environment configuration.
 * Supports multiple environments (local, staging, production).
 */
function buildOpenApiServers(): Array<{ url: string; description: string }> {
  const servers: Array<{ url: string; description: string }> = [];

  // Add environment-specific URL if provided (e.g., staging/production)
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

  // Always include localhost for local development
  // Useful for developers even in staging/prod environments
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

  const questionResponse = document.components?.schemas?.QuestionResponse as
    | {
        properties?: {
          payload?: unknown;
        };
      }
    | undefined;

  if (questionResponse?.properties) {
    questionResponse.properties.payload = {
      allOf: [{ $ref: '#/components/schemas/QuestionPayload' }],
      nullable: true,
    };
  }

  const userResponse = document.components?.schemas?.UserResponse as
    | {
        properties?: {
          progression?: unknown;
        };
      }
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
