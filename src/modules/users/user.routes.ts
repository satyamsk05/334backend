import { Router } from 'express';
import { UserController } from './user.controller';
import { authenticateJwt } from '../auth/auth.middleware';

export const userRoutes = Router();

userRoutes.get('/overview', UserController.getOverview);
userRoutes.get('/all', UserController.listAll);
userRoutes.post('/toggle-ban', UserController.toggleBan);
userRoutes.post('/fcm-token', authenticateJwt, UserController.registerFcmToken);
