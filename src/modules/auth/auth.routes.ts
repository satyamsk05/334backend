import { Router } from 'express';
import { AuthController } from './auth.controller';
import { authenticateJwt, optionalAuthenticateJwt } from './auth.middleware';

export const authRoutes = Router();

authRoutes.post('/login', AuthController.login);
authRoutes.get('/status', optionalAuthenticateJwt, AuthController.checkStatus);
authRoutes.post('/admin/login', AuthController.adminLogin);
authRoutes.post('/admin/logout', AuthController.adminLogout);
authRoutes.post('/whatsapp/initiate', AuthController.initiateWhatsApp);
authRoutes.post('/whatsapp/verify', AuthController.verifyWhatsApp);
authRoutes.get('/profile', authenticateJwt, AuthController.getProfile);
authRoutes.put('/profile', authenticateJwt, AuthController.updateProfile);
