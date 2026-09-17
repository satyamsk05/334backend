import { Router } from 'express';
import { UserController } from './user.controller';

export const userRoutes = Router();

userRoutes.get('/overview', UserController.getOverview);
userRoutes.get('/all', UserController.listAll);
userRoutes.post('/toggle-ban', UserController.toggleBan);
userRoutes.post('/adjust-wallet', UserController.adjustWallet);
