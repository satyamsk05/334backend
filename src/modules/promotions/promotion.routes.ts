import { Router } from 'express';
import { PromotionController } from './promotion.controller';

export const promotionRoutes = Router();

// Public / Player App Endpoints
promotionRoutes.get('/', PromotionController.getActivePromotions);
promotionRoutes.get('/active', PromotionController.getActivePromotions);
