import { Router, Request, Response } from 'express';
import { AdminController } from './admin.controller';
import { authenticateAdmin, requirePermission } from '../../middleware/rbac.middleware';
import { DepositController } from '../payments/deposit.controller';
import { WithdrawController } from '../payments/withdraw.controller';

export const adminRoutes = Router();

// Apply admin authentication to all routes in this router
adminRoutes.use(authenticateAdmin);

// ==========================================
// DASHBOARD & ANALYTICS
// ==========================================
adminRoutes.get('/dashboard/stats', requirePermission('reports.read'), AdminController.getDashboardStats);
adminRoutes.get('/dashboard/pending-counts', requirePermission('reports.read'), AdminController.getPendingCounts);
adminRoutes.get('/analytics', requirePermission('reports.read'), AdminController.getDashboardStats);

// ==========================================
// USERS MANAGEMENT
// ==========================================
adminRoutes.get('/users', requirePermission('users.read'), AdminController.listUsers);
adminRoutes.get('/users/:id', requirePermission('users.read'), AdminController.getUserDetails);
adminRoutes.patch('/users/:id', requirePermission('users.manage'), AdminController.updateUser);
adminRoutes.post('/users/:id/ban', requirePermission('users.manage'), AdminController.toggleUserBan);
adminRoutes.post('/users/:id/notes', requirePermission('users.manage'), AdminController.addUserNote);
adminRoutes.post('/users/:id/adjust-wallet', requirePermission('wallet.adjust'), AdminController.adjustUserWallet);

// ==========================================
// GAMES MANAGEMENT
// ==========================================
adminRoutes.get('/games', requirePermission('games.read'), AdminController.listGames);
adminRoutes.get('/games/:id', requirePermission('games.read'), AdminController.getGameDetails);
adminRoutes.patch('/games/:id/status', requirePermission('games.manage'), AdminController.updateGameStatus);
adminRoutes.patch('/games/:id/config', requirePermission('games.manage'), AdminController.updateGameConfig);

// ==========================================
// TRANSACTIONS, LEDGER & PAYMENTS
// ==========================================
adminRoutes.get('/ledger/overview', requirePermission('wallet.read'), AdminController.getLedgerOverview);
adminRoutes.get('/ledger/transactions', requirePermission('wallet.read'), AdminController.queryLedger);

// Deposits
adminRoutes.get('/deposits', requirePermission('payments.read'), DepositController.getDeposits);
adminRoutes.get('/deposits/pending', requirePermission('payments.read'), (req: Request, res: Response) => {
  // Pass through to DepositController.getDeposits, filtered on client or return all
  return DepositController.getDeposits(req, res);
});
adminRoutes.post('/deposits/approve', requirePermission('payments.approve'), DepositController.approve);
adminRoutes.post('/deposits/reject', requirePermission('payments.approve'), DepositController.reject);
adminRoutes.post('/deposits/action', requirePermission('payments.approve'), async (req: Request, res: Response) => {
  const { action } = req.body;
  if (action === 'APPROVE') return DepositController.approve(req, res);
  if (action === 'REJECT') return DepositController.reject(req, res);
  return res.status(400).json({ success: false, message: 'Invalid action (must be APPROVE or REJECT)' });
});

// Withdrawals
adminRoutes.get('/withdrawals', requirePermission('payments.read'), WithdrawController.getWithdrawals);
adminRoutes.get('/withdrawals/pending', requirePermission('payments.read'), (req: Request, res: Response) => {
  return WithdrawController.getWithdrawals(req, res);
});
adminRoutes.post('/withdrawals/process', requirePermission('payments.approve'), WithdrawController.process);
adminRoutes.post('/withdrawals/approve', requirePermission('payments.approve'), WithdrawController.approve);
adminRoutes.post('/withdrawals/reject', requirePermission('payments.approve'), WithdrawController.reject);
adminRoutes.post('/withdrawals/action', requirePermission('payments.approve'), async (req: Request, res: Response) => {
  const { action } = req.body;
  if (action === 'PROCESS') return WithdrawController.process(req, res);
  if (action === 'APPROVE') return WithdrawController.approve(req, res);
  if (action === 'REJECT') return WithdrawController.reject(req, res);
  return res.status(400).json({ success: false, message: 'Invalid action (must be PROCESS, APPROVE or REJECT)' });
});

// ==========================================
// SYSTEM HEALTH, SETTINGS & ANNOUNCEMENTS
// ==========================================
adminRoutes.get('/system/health', requirePermission('system.manage'), AdminController.getSystemHealth);
adminRoutes.get('/system/settings', requirePermission('system.manage'), AdminController.getSystemSettings);
adminRoutes.patch('/system/settings/:key', requirePermission('system.manage'), AdminController.updateSystemSetting);
adminRoutes.get('/system/announcements', requirePermission('system.manage'), AdminController.getAnnouncements);
adminRoutes.post('/system/announcements', requirePermission('system.manage'), AdminController.createAnnouncement);
adminRoutes.patch('/system/announcements/:id/status', requirePermission('system.manage'), AdminController.toggleAnnouncementStatus);

// ==========================================
// SECURITY & ADMINS
// ==========================================
adminRoutes.get('/admins', requirePermission('admins.manage'), AdminController.listAdmins);
adminRoutes.post('/admins', requirePermission('admins.manage'), AdminController.createAdmin);
adminRoutes.patch('/admins/:id/status', requirePermission('admins.manage'), AdminController.toggleAdminActive);
adminRoutes.get('/audit-logs', requirePermission('audit.read'), AdminController.getAuditLogs);
