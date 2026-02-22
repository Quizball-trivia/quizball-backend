import type { Request, Response } from 'express';
import { storeService } from './store.service.js';
import type {
  CreateCheckoutBody,
  PurchaseWithCoinsBody,
  DevGrantSelfBody,
  ListStoreTransactionsQuery,
  ManualAdjustmentBody,
} from './store.schemas.js';

export const storeController = {
  async listProducts(_req: Request, res: Response): Promise<void> {
    const result = await storeService.listProducts();
    res.json(result);
  },

  async createCheckout(req: Request, res: Response): Promise<void> {
    const body = req.validated.body as CreateCheckoutBody;
    const result = await storeService.createCheckoutSession(req.user!.id, body.productSlug);
    res.json(result);
  },

  async purchaseWithCoins(req: Request, res: Response): Promise<void> {
    const body = req.validated.body as PurchaseWithCoinsBody;
    const result = await storeService.purchaseWithCoins(req.user!.id, body.productSlug);
    res.json(result);
  },

  async getWallet(req: Request, res: Response): Promise<void> {
    const wallet = await storeService.getWallet(req.user!.id);
    res.json(wallet);
  },

  async getInventory(req: Request, res: Response): Promise<void> {
    const result = await storeService.getInventory(req.user!.id);
    res.json(result);
  },

  async createManualAdjustment(req: Request, res: Response): Promise<void> {
    const body = req.validated.body as ManualAdjustmentBody;
    const result = await storeService.applyManualAdjustment(req.user!.id, body);
    res.json(result);
  },

  async createDevSelfGrant(req: Request, res: Response): Promise<void> {
    const body = req.validated.body as DevGrantSelfBody;
    const result = await storeService.applyDevSelfGrant(req.user!.id, body);
    res.json(result);
  },

  async listTransactions(req: Request, res: Response): Promise<void> {
    const query = req.validated.query as ListStoreTransactionsQuery;
    const result = await storeService.listTransactions(query);
    res.json(result);
  },
};
