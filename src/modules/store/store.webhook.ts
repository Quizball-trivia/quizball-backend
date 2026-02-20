import express from 'express';
import type Stripe from 'stripe';
import { config } from '../../core/config.js';
import { logger } from '../../core/logger.js';
import { storeService } from './store.service.js';

function getSignatureHeader(header: string | string[] | undefined): string | null {
  if (typeof header === 'string') return header;
  if (Array.isArray(header) && header.length > 0) return header[0];
  return null;
}

export function createStoreWebhookRouter(stripeClient: Stripe) {
  const router = express.Router();

  router.post(
    '/api/v1/store/webhook',
    express.raw({ type: 'application/json' }),
    async (req, res) => {
      const signature = getSignatureHeader(req.headers['stripe-signature']);
      if (!signature) {
        await storeService.logWebhookSignatureInvalid({ message: 'Missing stripe-signature header' });
        res.status(400).send('Missing Stripe signature');
        return;
      }

      let event: Stripe.Event;
      try {
        event = stripeClient.webhooks.constructEvent(
          req.body,
          signature,
          config.STRIPE_WEBHOOK_SECRET!
        );
      } catch (error) {
        await storeService.logWebhookSignatureInvalid({
          message: error instanceof Error ? error.message : 'Webhook signature verification failed',
        });
        res.status(400).send('Invalid Stripe signature');
        return;
      }

      const checkoutId = event.type.startsWith('checkout.session.')
        ? (event.data.object as Stripe.Checkout.Session).id
        : null;

      await storeService.logWebhookReceived({
        stripeCheckoutId: checkoutId,
        eventId: event.id,
        eventType: event.type,
      });

      if (event.type === 'checkout.session.completed') {
        const session = event.data.object as Stripe.Checkout.Session;
        const paymentIntentId = typeof session.payment_intent === 'string'
          ? session.payment_intent
          : null;

        try {
          await storeService.fulfillCheckout(session.id, paymentIntentId);
          res.status(200).json({ received: true });
          return;
        } catch (error) {
          logger.error({ err: error, eventId: event.id, checkoutId: session.id }, 'Store webhook fulfillment failed');
          res.status(500).json({ code: 'WEBHOOK_PROCESSING_FAILED' });
          return;
        }
      }

      res.status(200).json({ received: true });
    }
  );

  return router;
}
