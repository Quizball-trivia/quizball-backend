import { Router } from 'express';
import { healthRoutes } from './health.routes.js';
import { authRoutes } from './auth.routes.js';
import { usersRoutes } from './users.routes.js';
import { categoriesRoutes } from './categories.routes.js';
import { questionsRoutes } from './questions.routes.js';
import { featuredCategoriesRoutes } from './featured-categories.routes.js';
import { statsRoutes } from './stats.routes.js';
import { lobbiesRoutes } from './lobbies.routes.js';
import { swaggerRoutes } from '../openapi/index.js';
import { config } from '../../core/config.js';

const router = Router();

// Health check (not versioned)
router.use(healthRoutes);

// API documentation (controlled by DOCS_ENABLED env var)
if (config.DOCS_ENABLED) {
  router.use(swaggerRoutes);
}

// API v1 routes
router.use('/api/v1/auth', authRoutes);
router.use('/api/v1/users', usersRoutes);
router.use('/api/v1/categories', categoriesRoutes);
router.use('/api/v1/questions', questionsRoutes);
router.use('/api/v1/featured-categories', featuredCategoriesRoutes);
router.use('/api/v1/stats', statsRoutes);
router.use('/api/v1/lobbies', lobbiesRoutes);

export const routes = router;
