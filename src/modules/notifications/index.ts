export { notificationsRepo, type NotificationRow } from './notifications.repo.js';
export { notificationsService, type NotifyInput } from './notifications.service.js';
export { notificationsController } from './notifications.controller.js';
export { registerNotificationsOpenApi } from './notifications.openapi.js';
export {
  notificationSchema,
  notificationTypeSchema,
  listNotificationsQuerySchema,
  listNotificationsResponseSchema,
  unreadCountResponseSchema,
  notificationIdParamSchema,
  type Notification,
  type NotificationType,
  type ListNotificationsQuery,
  type ListNotificationsResponse,
  type UnreadCountResponse,
  type NotificationIdParam,
} from './notifications.schemas.js';
