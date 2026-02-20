import Stripe from 'stripe';
import { config } from '../../core/config.js';

export const stripe = config.STRIPE_SECRET_KEY
  ? new Stripe(config.STRIPE_SECRET_KEY, { apiVersion: '2026-01-28.clover' })
  : null;
