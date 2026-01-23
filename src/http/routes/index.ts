import { Router } from 'express';
import { healthRoutes } from './health.routes.js';
import { authRoutes } from './auth.routes.js';
import { usersRoutes } from './users.routes.js';
import { categoriesRoutes } from './categories.routes.js';
import { questionsRoutes } from './questions.routes.js';
import { swaggerRoutes } from '../openapi/index.js';

const router = Router();

// Health check (not versioned)
router.use(healthRoutes);

// API documentation
router.use(swaggerRoutes);

// API v1 routes
router.use('/api/v1/auth', authRoutes);
router.use('/api/v1/users', usersRoutes);
router.use('/api/v1/categories', categoriesRoutes);
router.use('/api/v1/questions', questionsRoutes);

export const routes = router;
