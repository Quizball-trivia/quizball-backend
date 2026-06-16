import { Router } from 'express';
import { healthRoutes } from './health.routes.js';
import { authRoutes } from './auth.routes.js';
import { usersRoutes } from './users.routes.js';
import { categoriesRoutes } from './categories.routes.js';
import { questionsRoutes } from './questions.routes.js';
import { featuredCategoriesRoutes } from './featured-categories.routes.js';
import { statsRoutes } from './stats.routes.js';
import { lobbiesRoutes } from './lobbies.routes.js';
import { rankedRoutes } from './ranked.routes.js';
import { storeRoutes } from './store.routes.js';
import { activityRoutes } from './activity.routes.js';
import { dailyChallengesRoutes } from './daily-challenges.routes.js';
import { objectivesRoutes } from './objectives.routes.js';
import { notificationsRoutes } from './notifications.routes.js';
import { announcementsRoutes } from './announcements.routes.js';
import { adminDailyChallengesRoutes } from './admin-daily-challenges.routes.js';
import { adminUsersRoutes } from './admin-users.routes.js';
import { adminAnnouncementsRoutes } from './admin-announcements.routes.js';
import { adminLeaderboardRoutes } from './admin-leaderboard.routes.js';
import { adminStatsRoutes } from './admin-stats.routes.js';
import { friendsRoutes } from './friends.routes.js';
import { translationRoutes } from './translation.routes.js';
import { opsRoutes } from './ops.routes.js';
import { feedbackRoutes } from './feedback.routes.js';
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
router.use('/api/v1/friends', friendsRoutes);
router.use('/api/v1/categories', categoriesRoutes);
router.use('/api/v1/questions', questionsRoutes);
router.use('/api/v1/featured-categories', featuredCategoriesRoutes);
router.use('/api/v1/stats', statsRoutes);
router.use('/api/v1/lobbies', lobbiesRoutes);
router.use('/api/v1/ranked', rankedRoutes);
router.use('/api/v1/store', storeRoutes);
router.use('/api/v1/daily-challenges', dailyChallengesRoutes);
router.use('/api/v1/objectives', objectivesRoutes);
router.use('/api/v1/notifications', notificationsRoutes);
router.use('/api/v1/announcements', announcementsRoutes);
router.use('/api/v1/admin/activity', activityRoutes);
router.use('/api/v1/admin/daily-challenges', adminDailyChallengesRoutes);
router.use('/api/v1/admin/users', adminUsersRoutes);
router.use('/api/v1/admin/announcements', adminAnnouncementsRoutes);
router.use('/api/v1/admin/leaderboard', adminLeaderboardRoutes);
router.use('/api/v1/admin/stats', adminStatsRoutes);
router.use('/api/v1/admin/translation', translationRoutes);
router.use('/api/v1/internal/ops', opsRoutes);
router.use('/api/v1/feedback', feedbackRoutes);

export const routes = router;
