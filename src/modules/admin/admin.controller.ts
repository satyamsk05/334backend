import { Request, Response } from 'express';
import { DatabaseConfig } from '../../config/db.config';
import { WalletService } from '../wallet/wallet.service';
import { AuditService } from '../../services/AuditService';
import { ResponseHandler } from '../../utils/responseHandler';
import { RingOfFutureEngine } from '../../game/RingOfFutureEngine';
import { TicTacToeEngine } from '../../game/TicTacToeEngine';
import { SocketServer } from '../../sockets/socket.server';
import { AuthService } from '../auth/auth.service';
import { PushNotificationService } from '../../services/PushNotificationService';
import crypto from 'crypto';
import bcrypt from 'bcryptjs';

export class AdminController {
  // ==========================================
  // SESSION VERIFICATION
  // ==========================================
  public static async getMe(req: Request, res: Response) {
    const admin = (req as any).admin;
    if (!admin) {
      return ResponseHandler.error(res, 'Session not authenticated', 401);
    }
    return ResponseHandler.success(res, {
      id: admin.id,
      username: admin.username,
      role: admin.role,
      permissions: admin.permissions || []
    }, 'Admin session verified');
  }

  // ==========================================
  // DASHBOARD & ANALYTICS
  // ==========================================

  public static async getDashboardStats(req: Request, res: Response) {
    const pool = DatabaseConfig.getPool();
    if (!pool) return ResponseHandler.error(res, 'Database pool unavailable', 500);

    const range = (req.query.range as string) || '30d';
    let timeInterval = "NOW() - INTERVAL '30 days'";
    if (range === '24h') timeInterval = "NOW() - INTERVAL '24 hours'";
    if (range === '7d') timeInterval = "NOW() - INTERVAL '7 days'";
    if (range === 'all') timeInterval = "'1970-01-01'::timestamptz";

    try {
      const [
        usersStats,
        walletStats,
        depositStats,
        withdrawStats,
        betStats,
        ledgerStats,
        recentActivity
      ] = await Promise.all([
        pool.query(`
          SELECT 
            COUNT(*) as total_users,
            COUNT(*) FILTER (WHERE is_blocked = FALSE) as active_users,
            COUNT(*) FILTER (WHERE is_blocked = TRUE) as banned_users,
            COUNT(*) FILTER (WHERE created_at >= ${timeInterval}) as new_users
          FROM users
        `),
        pool.query(`
          SELECT 
            COALESCE(SUM(deposit_balance), 0) as total_deposit,
            COALESCE(SUM(winnings_balance), 0) as total_winning,
            COALESCE(SUM(rewards_balance), 0) as total_bonus,
            COALESCE(SUM(available_balance), 0) as total_available
          FROM wallets
        `),
        pool.query(`
          SELECT 
            COUNT(*) FILTER (WHERE status = 'PENDING') as pending_count,
            COALESCE(SUM(amount) FILTER (WHERE status = 'APPROVED' AND created_at >= ${timeInterval}), 0) as approved_amount,
            COALESCE(SUM(amount) FILTER (WHERE status = 'PENDING'), 0) as pending_amount
          FROM deposits
        `),
        pool.query(`
          SELECT 
            COUNT(*) FILTER (WHERE status = 'PENDING') as pending_count,
            COALESCE(SUM(amount) FILTER (WHERE status = 'APPROVED' AND created_at >= ${timeInterval}), 0) as approved_amount,
            COALESCE(SUM(amount) FILTER (WHERE status = 'PENDING'), 0) as pending_amount
          FROM withdrawals
        `),
        pool.query(`
          SELECT 
            COUNT(*) as total_bets,
            COALESCE(SUM(stake) FILTER (WHERE created_at >= ${timeInterval}), 0) as total_wagered,
            COALESCE(SUM(win_amount) FILTER (WHERE created_at >= ${timeInterval}), 0) as total_payouts
          FROM bets
        `),
        pool.query(`
          SELECT 
            COUNT(*) FILTER (WHERE type IN ('BET_DEBIT', 'BET_PLACED', 'BET')) as total_bets,
            COALESCE(SUM(amount) FILTER (WHERE type IN ('BET_DEBIT', 'BET_PLACED', 'BET') AND created_at >= ${timeInterval}), 0) as total_wagered,
            COALESCE(SUM(amount) FILTER (WHERE type IN ('WIN_PAYOUT', 'GAME_WIN', 'BET_WIN') AND created_at >= ${timeInterval}), 0) as total_payouts
          FROM wallet_ledger
        `),
        pool.query(`
          SELECT l.id, l.user_id, l.type as transaction_type, l.type, l.amount, l.direction,
                 l.reference_type, l.reference_id, l.balance_before, l.balance_after,
                 l.metadata, l.created_at,
                 u.name as user_name, u.phone as user_phone
          FROM wallet_ledger l
          LEFT JOIN users u ON u.id = l.user_id
          ORDER BY l.created_at DESC
          LIMIT 10
        `)
      ]);

      const totalRoundsPlayed = RingOfFutureEngine.getRoundCount();
      const dbRoundsCountRes = await pool.query('SELECT COUNT(*) FROM game_rounds');
      const totalRoundsInDb = Number(dbRoundsCountRes.rows[0]?.count || 0);

      const tableBetsCount = Number(betStats.rows[0]?.total_bets || 0);
      const ledgerBetsCount = Number(ledgerStats.rows[0]?.total_bets || 0);
      const tableWagered = Number(betStats.rows[0]?.total_wagered || 0);
      const ledgerWagered = Number(ledgerStats.rows[0]?.total_wagered || 0);
      const tablePayouts = Number(betStats.rows[0]?.total_payouts || 0);
      const ledgerPayouts = Number(ledgerStats.rows[0]?.total_payouts || 0);

      const totalWageredPaise = Math.max(tableWagered, ledgerWagered);
      const totalPayoutsPaise = Math.max(tablePayouts, ledgerPayouts);
      const ggrPaise = Math.max(0, totalWageredPaise - totalPayoutsPaise);

      const totalUsers = Number(usersStats.rows[0].total_users || 0);
      const activeUsers = Number(usersStats.rows[0].active_users || 0);
      const bannedUsers = Number(usersStats.rows[0].banned_users || 0);
      const newUsers = Number(usersStats.rows[0].new_users || 0);

      const totalDepositPaise = Number(walletStats.rows[0].total_deposit || 0);
      const totalWinningPaise = Number(walletStats.rows[0].total_winning || 0);
      const totalBonusPaise = Number(walletStats.rows[0].total_bonus || 0);
      const totalAvailablePaise = Number(walletStats.rows[0].total_available || 0);

      const approvedDepositsPaise = Number(depositStats.rows[0].approved_amount || 0);
      const pendingDepositsCount = Number(depositStats.rows[0].pending_count || 0);
      const pendingDepositsPaise = Number(depositStats.rows[0].pending_amount || 0);

      const approvedWithdrawalsPaise = Number(withdrawStats.rows[0].approved_amount || 0);
      const pendingWithdrawalsCount = Number(withdrawStats.rows[0].pending_count || 0);
      const pendingWithdrawalsPaise = Number(withdrawStats.rows[0].pending_amount || 0);

      const formattedActivity = recentActivity.rows.map((r: any) => {
        let meta: any = {};
        if (typeof r.metadata === 'string') {
          try { meta = JSON.parse(r.metadata); } catch {}
        } else if (r.metadata) {
          meta = r.metadata;
        }
        return {
          id: r.id,
          user_id: r.user_id,
          user_name: r.user_name || r.user_phone || r.user_id,
          transaction_type: r.transaction_type || r.type || 'DEPOSIT',
          bucket: r.reference_type || 'main',
          amount: Number(r.amount || 0),
          balance_after: Number(r.balance_after || 0),
          direction: r.direction || 'CREDIT',
          reference_id: r.reference_id || '',
          description: meta.description || r.reference_type || r.reference_id || 'System transaction',
          created_at: r.created_at
        };
      });

      const data = {
        users: {
          total: totalUsers,
          active: activeUsers,
          banned: bannedUsers,
          new: newUsers,
          totalUsers,
          activeUsers,
          bannedUsers,
          newUsers
        },
        financials: {
          totalDepositPaise,
          totalWinningPaise,
          totalBonusPaise,
          totalAvailablePaise,
          approvedDepositsPaise,
          pendingDepositsCount,
          pendingDepositsPaise,
          approvedWithdrawalsPaise,
          pendingWithdrawalsCount,
          pendingWithdrawalsPaise
        },
        wallet: {
          totalDepositPaise,
          totalWinningPaise,
          totalBonusPaise,
          totalAvailablePaise
        },
        deposits: {
          approvedAmountPaise: approvedDepositsPaise,
          pendingCount: pendingDepositsCount,
          pendingAmountPaise: pendingDepositsPaise
        },
        withdrawals: {
          approvedAmountPaise: approvedWithdrawalsPaise,
          pendingCount: pendingWithdrawalsCount,
          pendingAmountPaise: pendingWithdrawalsPaise
        },
        games: {
          totalRounds: Math.max(totalRoundsPlayed, totalRoundsInDb),
          totalRoundsPlayed: Math.max(totalRoundsPlayed, totalRoundsInDb),
          engineRounds: totalRoundsPlayed,
          totalBets: Math.max(tableBetsCount, ledgerBetsCount),
          totalWageredPaise,
          totalPayoutsPaise,
          ggrPaise,
          activeGames: 2
        },
        recentActivity: formattedActivity
      };

      return ResponseHandler.success(res, data, 'Dashboard metrics fetched');
    } catch (err: any) {
      return ResponseHandler.error(res, err.message, 500);
    }
  }

  public static async getPendingCounts(req: Request, res: Response) {
    const pool = DatabaseConfig.getPool();
    if (!pool) return ResponseHandler.error(res, 'Database unavailable', 500);

    try {
      const [depositsRes, withdrawalsRes] = await Promise.all([
        pool.query("SELECT COUNT(*) as count FROM deposits WHERE status = 'PENDING'"),
        pool.query("SELECT COUNT(*) as count FROM withdrawals WHERE status = 'PENDING'")
      ]);

      const pendingDeposits = Number(depositsRes.rows[0]?.count || 0);
      const pendingWithdrawals = Number(withdrawalsRes.rows[0]?.count || 0);

      return ResponseHandler.success(res, {
        pendingDeposits,
        pendingWithdrawals,
        totalPending: pendingDeposits + pendingWithdrawals
      }, 'Pending counts fetched');
    } catch (err: any) {
      return ResponseHandler.error(res, err.message, 500);
    }
  }

  // ==========================================
  // USERS MANAGEMENT
  // ==========================================

  public static async listUsers(req: Request, res: Response) {
    const pool = DatabaseConfig.getPool();
    if (!pool) return ResponseHandler.error(res, 'Database unavailable', 500);

    const search = ((req.query.search as string) || '').trim();
    const status = (req.query.status as string) || 'ALL';
    const sortBy = (req.query.sortBy as string) || 'created_at';
    const sortOrder = (req.query.sortOrder as string)?.toUpperCase() === 'ASC' ? 'ASC' : 'DESC';
    const page = Math.max(1, parseInt(req.query.page as string, 10) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit as string, 10) || 20));
    const offset = (page - 1) * limit;

    try {
      let whereClause = 'WHERE 1=1';
      const params: any[] = [];

      if (search) {
        params.push(`%${search}%`);
        whereClause += ` AND (u.id ILIKE $${params.length} OR u.username ILIKE $${params.length} OR u.phone ILIKE $${params.length})`;
      }

      if (status === 'ACTIVE') {
        whereClause += ' AND u.is_blocked = FALSE';
      } else if (status === 'BANNED' || status === 'SUSPENDED') {
        whereClause += ' AND u.is_blocked = TRUE';
      }

      const countRes = await pool.query(
        `SELECT COUNT(*) FROM users u ${whereClause}`,
        params
      );
      const totalCount = Number(countRes.rows[0].count);

      // Status counters
      const countersRes = await pool.query(`
        SELECT 
          COUNT(*) as total,
          COUNT(*) FILTER (WHERE is_blocked = FALSE) as active,
          COUNT(*) FILTER (WHERE is_blocked = TRUE) as banned
        FROM users
      `);

      let orderColumn = 'u.created_at';
      if (sortBy === 'balance') orderColumn = 'w.available_balance';
      if (sortBy === 'name') orderColumn = 'u.username';

      const dataQuery = `
        SELECT 
          u.id, u.username, u.phone, u.avatar_path, u.is_blocked, u.created_at,
          COALESCE(u.last_sign_in_at, u.created_at) as last_sign_in_at,
          COALESCE(w.deposit_balance, 0) as deposit_paise,
          COALESCE(w.winnings_balance, 0) as winning_paise,
          COALESCE(w.rewards_balance, 0) as bonus_paise,
          COALESCE(w.available_balance, 0) as total_paise,
          COALESCE(dep.total_dep, 0) as total_deposits_paise,
          COALESCE(wd.total_wd, 0) as total_withdrawals_paise,
          COALESCE(b.total_bets, 0) as total_bets_count
        FROM users u
        LEFT JOIN wallets w ON w.user_id = u.id
        LEFT JOIN (
          SELECT user_id, SUM(amount) as total_dep FROM deposits WHERE status = 'APPROVED' GROUP BY user_id
        ) dep ON dep.user_id = u.id
        LEFT JOIN (
          SELECT user_id, SUM(amount) as total_wd FROM withdrawals WHERE status = 'APPROVED' GROUP BY user_id
        ) wd ON wd.user_id = u.id
        LEFT JOIN (
          SELECT user_id, COUNT(*) as total_bets FROM bets GROUP BY user_id
        ) b ON b.user_id = u.id
        ${whereClause}
        ORDER BY ${orderColumn} ${sortOrder}
        LIMIT $${params.length + 1} OFFSET $${params.length + 2}
      `;

      params.push(limit, offset);
      const usersRes = await pool.query(dataQuery, params);

      return ResponseHandler.success(res, {
        users: usersRes.rows.map((u: any) => ({
          id: u.id,
          name: u.username || AuthService.getUserById(u.id)?.name || 'Player',
          phone: u.phone || AuthService.getUserById(u.id)?.phone || '',
          avatarPath: u.avatar_path,
          isBanned: Boolean(u.is_blocked),
          is_blocked: Boolean(u.is_blocked),
          status: u.is_blocked ? 'BANNED' : 'ACTIVE',
          createdAt: u.created_at,
          created_at: u.created_at,
          lastActive: u.last_sign_in_at || u.created_at,
          last_sign_in_at: u.last_sign_in_at || u.created_at,
          deposit_balance: u.deposit_paise,
          winnings_balance: u.winning_paise,
          rewards_balance: u.bonus_paise,
          available_balance: u.total_paise,
          balance: {
            depositPaise: Number(u.deposit_paise),
            winningPaise: Number(u.winning_paise),
            bonusPaise: Number(u.bonus_paise),
            totalPaise: Number(u.total_paise)
          },
          totalDepositsPaise: Number(u.total_deposits_paise),
          totalWithdrawalsPaise: Number(u.total_withdrawals_paise),
          totalBets: Number(u.total_bets_count)
        })),
        total: totalCount,
        pagination: {
          page,
          limit,
          total: totalCount,
          totalPages: Math.ceil(totalCount / limit)
        },
        counts: {
          total: Number(countersRes.rows[0].total),
          active: Number(countersRes.rows[0].active),
          banned: Number(countersRes.rows[0].banned)
        }
      });
    } catch (err: any) {
      return ResponseHandler.error(res, err.message, 500);
    }
  }

  public static async getUserDetails(req: Request, res: Response) {
    const pool = DatabaseConfig.getPool();
    if (!pool) return ResponseHandler.error(res, 'Database unavailable', 500);

    const userId = req.params.id;
    if (!userId) return ResponseHandler.error(res, 'User ID is required', 400);

    // Determine caller's role for field-level masking
    const callerAdmin = (req as any).admin;
    const callerRole: string = callerAdmin?.role || 'VIEWER';
    // Roles that may see full PII (phone, IP, device, sessions)
    const canSeePII = ['SUPER_ADMIN', 'ADMIN', 'FINANCE_ADMIN'].includes(callerRole);
    // Roles that may see financial data (wallets, deposits, withdrawals)
    const canSeeFinancials = ['SUPER_ADMIN', 'ADMIN', 'FINANCE_ADMIN'].includes(callerRole);
    // Roles that may see audit trail and session logs
    const canSeeAudit = ['SUPER_ADMIN', 'ADMIN'].includes(callerRole);

    try {
      const userRes = await pool.query('SELECT * FROM users WHERE id = $1', [userId]);
      if (userRes.rows.length === 0) {
        return ResponseHandler.error(res, 'User not found', 404);
      }
      const u = userRes.rows[0];

      // Fetch wallet, ledger, deposits, withdrawals, bets, notes, audits, sessions
      const [
        walletRes,
        ledgerRes,
        depositsRes,
        withdrawalsRes,
        betsRes,
        notesRes,
        auditsRes,
        sessionsRes
      ] = await Promise.all([
        pool.query('SELECT * FROM wallets WHERE user_id = $1', [userId]),
        pool.query('SELECT * FROM wallet_ledger WHERE user_id = $1 ORDER BY created_at DESC LIMIT 50', [userId]),
        pool.query('SELECT * FROM deposits WHERE user_id = $1 ORDER BY created_at DESC LIMIT 50', [userId]),
        pool.query('SELECT * FROM withdrawals WHERE user_id = $1 ORDER BY created_at DESC LIMIT 50', [userId]),
        pool.query('SELECT * FROM bets WHERE user_id = $1 ORDER BY created_at DESC LIMIT 50', [userId]),
        pool.query('SELECT * FROM admin_notes WHERE user_id = $1 ORDER BY created_at DESC', [userId]),
        pool.query("SELECT * FROM audit_logs WHERE target = $1 OR user_id = $2 ORDER BY created_at DESC LIMIT 50", [`user:${userId}`, userId]),
        pool.query('SELECT * FROM user_sessions WHERE user_id = $1 ORDER BY created_at DESC LIMIT 20', [userId])
      ]);

      const w = walletRes.rows[0] || {
        deposit_balance: '0',
        winnings_balance: '0',
        rewards_balance: '0',
        available_balance: '0'
      };

      // Synthesize bets from both DB bets table and authoritative wallet_ledger
      const winEntries = ledgerRes.rows.filter((r: any) => 
        ['WIN_PAYOUT', 'WIN_CREDIT', 'WIN'].includes(String(r.transaction_type).toUpperCase())
      );
      const refundEntries = ledgerRes.rows.filter((r: any) => 
        ['BET_REFUND', 'REFUND_EQUITY', 'REFUND'].includes(String(r.transaction_type).toUpperCase())
      );

      const betTxns = ledgerRes.rows.filter((r: any) => 
        ['BET_DEBIT', 'BET_PLACED', 'BET'].includes(String(r.transaction_type).toUpperCase())
      );

      const ledgerBets: any[] = [];
      for (const b of betTxns) {
        const meta = typeof b.metadata === 'string' ? JSON.parse(b.metadata) : (b.metadata || {});
        const isXo = meta.game === 'TIC_TAC_TOE' || String(b.reference_id).startsWith('XO-') || String(b.description).toLowerCase().includes('battle');
        const gameName = isXo ? 'XO Battle (1v1)' : 'Ring of Future';
        
        // Find matching win payout or refund
        const correspondingWin = winEntries.find((winItem: any) => {
          const wMeta = typeof winItem.metadata === 'string' ? JSON.parse(winItem.metadata) : (winItem.metadata || {});
          return (meta.roomId && wMeta.roomId === meta.roomId) || 
                 (Math.abs(new Date(winItem.created_at).getTime() - new Date(b.created_at).getTime()) < 300000);
        });

        const correspondingRefund = refundEntries.find((rf: any) => {
          return Math.abs(new Date(rf.created_at).getTime() - new Date(b.created_at).getTime()) < 300000;
        });

        const payoutAmount = correspondingWin ? Number(correspondingWin.amount) : (correspondingRefund ? Number(correspondingRefund.amount) : 0);
        const status = correspondingWin ? 'WON' : (correspondingRefund ? 'DRAW' : 'LOST');

        ledgerBets.push({
          id: b.reference_id || b.id,
          round_id: meta.roomId || meta.roundId || b.reference_id || 'N/A',
          game_type: gameName,
          tier_name: b.description || (isXo ? '1v1 Battle' : 'Standard Round'),
          selected_option: isXo ? 'XO 1v1' : (meta.color || 'Game Bet'),
          stake: Number(b.amount),
          bet_amount: String(b.amount || 0),
          win_amount: payoutAmount,
          payout_amount: String(payoutAmount),
          payout_multiplier: payoutAmount > 0 && Number(b.amount) > 0 ? Number((payoutAmount / Number(b.amount)).toFixed(2)) : 0,
          status,
          created_at: b.created_at
        });
      }

      const allBets = [
        ...betsRes.rows.map((b: any) => ({
          id: b.id,
          round_id: b.round_id,
          game_type: 'Ring of Future',
          tier_name: 'Color Bet',
          selected_option: b.selected_option || 'green',
          stake: Number(b.stake),
          bet_amount: String(b.stake || 0),
          win_amount: Number(b.win_amount || 0),
          payout_amount: String(b.win_amount || 0),
          payout_multiplier: Number(b.payout_multiplier || 0),
          status: b.status || (Number(b.win_amount) > 0 ? 'WON' : 'LOST'),
          created_at: b.created_at
        })),
        ...ledgerBets
      ];

      const totalBetsCount = allBets.length;
      const totalWageredPaise = allBets.reduce((sum: number, b: any) => sum + Number(b.stake || 0), 0);
      const totalPayoutPaise = allBets.reduce((sum: number, b: any) => sum + Number(b.win_amount || 0), 0);

      const approvedDeposits = depositsRes.rows.filter((d: any) => d.status === 'APPROVED');
      const totalDepositsPaise = approvedDeposits.reduce((sum: number, d: any) => sum + Number(d.amount || 0), 0);
      const pendingDepositsPaise = depositsRes.rows.filter((d: any) => d.status === 'PENDING').reduce((sum: number, d: any) => sum + Number(d.amount || 0), 0);

      const approvedWithdrawals = withdrawalsRes.rows.filter((w: any) => w.status === 'APPROVED');
      const totalWithdrawalsPaise = approvedWithdrawals.reduce((sum: number, w: any) => sum + Number(w.amount || 0), 0);
      const pendingWithdrawalsPaise = withdrawalsRes.rows.filter((w: any) => w.status === 'PENDING').reduce((sum: number, w: any) => sum + Number(w.amount || 0), 0);

      // ── Role-based field-level masking ──────────────────────────────────────
      // Phone: last 4 visible to all; full number only for privileged roles
      const rawPhone: string = u.phone || AuthService.getUserById(u.id)?.phone || '';
      const maskedPhone = rawPhone.length >= 4
        ? `******${rawPhone.slice(-4)}`
        : '**masked**';

      const userPayload = {
        id: u.id,
        name: u.username || AuthService.getUserById(u.id)?.name || 'Player',
        username: u.username || AuthService.getUserById(u.id)?.name || 'Player',
        // PII: full phone only for privileged roles
        phone: canSeePII ? rawPhone : maskedPhone,
        email: canSeePII ? (u.email || '') : '[restricted]',
        avatarPath: u.avatar_path,
        is_blocked: Boolean(u.is_blocked),
        isBanned: Boolean(u.is_blocked),
        block_reason: u.blocked_reason || '',
        status: u.is_blocked ? 'BANNED' : 'ACTIVE',
        created_at: u.created_at,
        createdAt: u.created_at,
        updated_at: u.updated_at || u.created_at,
        // Device/session fields: only for privileged roles
        device_model: canSeePII ? (u.device_model || 'Unknown Android Device') : '[restricted]',
        os_version: canSeePII ? (u.os_version || 'Android') : '[restricted]',
        app_version: u.app_version || '1.0.0', // app version is not sensitive
        ip_address: canSeePII ? (u.ip_address || '127.0.0.1') : '[restricted]',
        location: canSeePII ? (u.location || 'India') : '[restricted]',
        lastActive: u.last_sign_in_at || u.created_at,
        totalGames: totalBetsCount > 0 ? 1 : 0,
        totalBets: totalBetsCount,
        totalWageredPaise,
        totalPayoutsPaise: totalPayoutPaise
      };
      // ────────────────────────────────────────────────────────────────────────

      const walletPayload = {
        deposit_balance: String(w.deposit_balance || 0),
        winnings_balance: String(w.winnings_balance || 0),
        rewards_balance: String(w.rewards_balance || 0),
        available_balance: String(w.available_balance || 0),
        total_deposited: String(totalDepositsPaise),
        total_withdrawn: String(totalWithdrawalsPaise),
        depositPaise: Number(w.deposit_balance || 0),
        winningPaise: Number(w.winnings_balance || 0),
        bonusPaise: Number(w.rewards_balance || 0),
        totalPaise: Number(w.available_balance || 0),
        version: Number(w.version || 1),
        updatedAt: w.updated_at
      };

      const metricsPayload = {
        totalBets: totalBetsCount,
        totalWageredPaise: String(totalWageredPaise),
        totalWonPaise: String(totalPayoutPaise),
        ggrPaise: String(totalWageredPaise - totalPayoutPaise)
      };

      const mappedTransactions = ledgerRes.rows.map((r: any) => ({
        ...r,
        amount: Number(r.amount),
        balance_before: Number(r.balance_before),
        balance_after: Number(r.balance_after),
        metadata: typeof r.metadata === 'string' ? JSON.parse(r.metadata) : (r.metadata || {})
      }));

      const mappedAudits = auditsRes.rows.map((a: any) => ({
        ...a,
        action: a.action || 'UPDATE',
        details: typeof a.details === 'string' ? JSON.parse(a.details) : (a.details || {}),
        created_at: a.created_at
      }));

      return ResponseHandler.success(res, {
        user: userPayload,
        overview: userPayload,
        wallet: walletPayload,
        metrics: metricsPayload,
        financialSummary: canSeeFinancials ? {
          totalDepositsPaise,
          pendingDepositsPaise,
          totalWithdrawalsPaise,
          pendingWithdrawalsPaise,
          approvedTransactionsCount: approvedDeposits.length + approvedWithdrawals.length,
          rejectedTransactionsCount: depositsRes.rows.filter((d: any) => d.status === 'REJECTED').length + withdrawalsRes.rows.filter((w: any) => w.status === 'REJECTED').length
        } : null,
        transactions: canSeeFinancials ? mappedTransactions : [],
        recentTransactions: canSeeFinancials ? mappedTransactions : [],
        deposits: canSeeFinancials ? depositsRes.rows.map((d: any) => ({
          ...d,
          amount: Number(d.amount)
        })) : [],
        withdrawals: canSeeFinancials ? withdrawalsRes.rows.map((w: any) => ({
          ...w,
          amount: Number(w.amount)
        })) : [],
        bets: allBets,
        recentBets: allBets,
        gameHistory: allBets,
        notes: notesRes.rows || [],
        adminNotes: notesRes.rows || [],
        audits: canSeeAudit ? mappedAudits : [],
        auditTrail: canSeeAudit ? mappedAudits : [],
        auditHistory: canSeeAudit ? mappedAudits : [],
        sessions: canSeePII ? (sessionsRes.rows || []) : [],
        activity: canSeePII ? (sessionsRes.rows || []) : [],
        // Expose caller's effective permissions for UI guidance
        _accessLevel: {
          canSeePII,
          canSeeFinancials,
          canSeeAudit,
          callerRole
        }
      });
    } catch (err: any) {
      return ResponseHandler.error(res, err.message, 500);
    }
  }

  public static async updateUser(req: Request, res: Response) {
    const userId = req.params.id;
    const { name, phone } = req.body;
    if (!userId) return ResponseHandler.error(res, 'User ID is required', 400);
    try {
      const updated = await AuthService.updateProfile(userId, { name, phone });
      return ResponseHandler.success(res, updated, 'User profile updated successfully');
    } catch (err: any) {
      return ResponseHandler.error(res, err.message, 500);
    }
  }

  public static async toggleUserBan(req: Request, res: Response) {
    const pool = DatabaseConfig.getPool();
    if (!pool) return ResponseHandler.error(res, 'Database unavailable', 500);

    const userId = req.params.id;
    const { isBanned, reason } = req.body;
    const admin = (req as any).admin || { username: 'ADMIN', role: 'SUPER_ADMIN' };

    try {
      await pool.query(
        'UPDATE users SET is_blocked = $1, blocked_reason = $2, blocked_at = $3, updated_at = CURRENT_TIMESTAMP WHERE id = $4',
        [Boolean(isBanned), reason || null, isBanned ? new Date() : null, userId]
      );

      await AuditService.log({
        adminId: admin.username || 'ADMIN',
        action: isBanned ? 'USER_BANNED' : 'USER_UNBANNED',
        target: `user:${userId}`,
        userId,
        details: { reason, isBanned }
      });

      return ResponseHandler.success(res, { userId, isBanned }, `User ${isBanned ? 'banned' : 'unbanned'} successfully`);
    } catch (err: any) {
      return ResponseHandler.error(res, err.message, 500);
    }
  }

  public static async addUserNote(req: Request, res: Response) {
    const pool = DatabaseConfig.getPool();
    if (!pool) return ResponseHandler.error(res, 'Database unavailable', 500);

    const userId = req.params.id;
    const { note } = req.body;
    const admin = (req as any).admin || { username: 'ADMIN', role: 'SUPER_ADMIN' };

    if (!note || !note.trim()) {
      return ResponseHandler.error(res, 'Note content cannot be empty', 400);
    }

    try {
      const noteId = `note_${Date.now()}_${Math.floor(Math.random() * 1000)}`;
      await pool.query(
        `INSERT INTO admin_notes (id, user_id, admin_id, admin_username, note, created_at)
         VALUES ($1, $2, $3, $4, $5, CURRENT_TIMESTAMP)`,
        [noteId, userId, admin.username || 'ADMIN', admin.username || 'ADMIN', note.trim()]
      );

      await AuditService.log({
        adminId: admin.username || 'ADMIN',
        action: 'ADMIN_NOTE_ADDED',
        target: `user:${userId}`,
        userId,
        details: { noteId, note: note.trim() }
      });

      return ResponseHandler.success(res, { noteId }, 'Admin note added successfully');
    } catch (err: any) {
      return ResponseHandler.error(res, err.message, 500);
    }
  }

  public static async adjustUserWallet(req: Request, res: Response) {
    const userId = req.params.id;
    const { type, bucket, amountRupees, reason, confirmed } = req.body;
    const admin = (req as any).admin;
    const ipAddress = req.ip || (req.headers?.['x-forwarded-for'] as string) || req.socket?.remoteAddress;

    if (!admin) {
      return ResponseHandler.error(res, 'Admin authentication required', 401);
    }

    if (!userId) {
      return ResponseHandler.error(res, 'Target user ID is required', 400);
    }

    if (!type || !bucket || amountRupees === undefined || amountRupees === null) {
      return ResponseHandler.error(res, 'type (CREDIT/DEBIT), bucket (deposit/winnings/bonus), amountRupees, and reason are required', 400);
    }

    if (type !== 'CREDIT' && type !== 'DEBIT') {
      return ResponseHandler.error(res, 'Invalid adjustment type: must be CREDIT or DEBIT', 400);
    }

    if (!['deposit', 'winnings', 'bonus'].includes(bucket)) {
      return ResponseHandler.error(res, 'Invalid bucket: must be deposit, winnings, or bonus', 400);
    }

    // Reason validation: minimum 5 characters, trimmed, max 500
    if (typeof reason !== 'string' || reason.trim().length < 5) {
      return ResponseHandler.error(res, 'A mandatory reason (minimum 5 characters) explaining this wallet adjustment is required for audit compliance', 400);
    }

    const trimmedReason = reason.trim();
    if (trimmedReason.length > 500) {
      return ResponseHandler.error(res, 'Reason is too long (maximum 500 characters)', 400);
    }

    const amountNum = parseFloat(amountRupees);
    if (isNaN(amountNum) || amountNum <= 0) {
      return ResponseHandler.error(res, 'Adjustment amount must be a positive number', 400);
    }

    // Hard amount limit: max ₹50,000 per single adjustment
    const MAX_ADJUSTMENT_RUPEES = 50000;
    if (amountNum > MAX_ADJUSTMENT_RUPEES) {
      return ResponseHandler.error(
        res,
        `Adjustment amount exceeds maximum single-operation limit of ₹${MAX_ADJUSTMENT_RUPEES.toLocaleString('en-IN')}. Contact system administrator for higher adjustments.`,
        400
      );
    }

    // Explicit confirmation check: adjustments > ₹10,000 require confirmed === true
    if (amountNum > 10000 && confirmed !== true) {
      return ResponseHandler.error(
        res,
        `Adjustments greater than ₹10,000 require explicit confirmation. Set 'confirmed: true' in request payload.`,
        400
      );
    }

    const amountPaise = Math.round(amountNum * 100);

    // Support Idempotency Key via header or body
    const providedIdempKey = (req.headers?.['x-idempotency-key'] as string) || req.body?.idempotencyKey;
    const idempKey = providedIdempKey || `idemp_adjust_${userId}_${Date.now()}`;
    const refId = `ADJUST-${Date.now()}-${Math.floor(Math.random() * 10000)}`;

    try {
      // Capture previous balance before adjustment
      const previousBalance = await WalletService.getBalance(userId);

      let updatedBalance;
      if (type === 'CREDIT') {
        if (bucket === 'winnings') {
          updatedBalance = await WalletService.creditWinnings(userId, amountPaise, refId, `Admin Adjustment: ${trimmedReason}`, idempKey, { admin: admin.username || admin.id, reason: trimmedReason });
        } else if (bucket === 'bonus') {
          updatedBalance = await WalletService.creditBonus(userId, amountPaise, refId, `Admin Adjustment: ${trimmedReason}`, idempKey);
        } else {
          updatedBalance = await WalletService.creditDeposit(userId, amountPaise, refId, `Admin Adjustment: ${trimmedReason}`, idempKey);
        }
      } else {
        // DEBIT
        const debitRes = await WalletService.debitBet(userId, amountPaise, refId, `Admin Debit: ${trimmedReason}`, idempKey, { admin: admin.username || admin.id, reason: trimmedReason });
        if (!debitRes.success) {
          return ResponseHandler.error(res, debitRes.message || 'Debit failed due to insufficient funds', 400);
        }
        updatedBalance = debitRes.newBalance;
      }

      // Mandatory Audit Log
      await AuditService.log({
        adminId: admin.username || admin.id || 'ADMIN',
        action: 'WALLET_ADJUSTED',
        target: `user:${userId}`,
        userId,
        ipAddress: String(ipAddress || 'unknown'),
        details: {
          type,
          bucket,
          amountRupees: amountNum,
          amountPaise,
          reason: trimmedReason,
          refId,
          idempotencyKey: idempKey,
          previousBalance,
          updatedBalance,
          adminRole: admin.role
        }
      });

      return ResponseHandler.success(res, { updatedBalance, previousBalance, idempotencyKey: idempKey }, `Successfully adjusted wallet by ₹${amountNum.toFixed(2)}`);
    } catch (err: any) {
      return ResponseHandler.error(res, err.message, 500);
    }
  }

  // ==========================================
  // GAMES MANAGEMENT
  // ==========================================

  public static async listGames(_req: Request, res: Response) {
    const pool = DatabaseConfig.getPool();
    if (!pool) return ResponseHandler.error(res, 'Database unavailable', 500);

    try {
      const gamesRes = await pool.query('SELECT * FROM games ORDER BY display_order ASC, created_at ASC');
      const currentEngineRound = RingOfFutureEngine.getRoundCount();
      const activeXoRooms = TicTacToeEngine.getActiveRoomsCount();

      const games = gamesRes.rows.map((g: any) => ({
        ...g,
        entry_fee: Number(g.entry_fee),
        min_stake: Number(g.min_stake),
        max_stake: Number(g.max_stake),
        config: typeof g.config === 'string' ? JSON.parse(g.config) : (g.config || {}),
        activePlayers: g.id === 'ring_of_future' ? 1 : (g.id === 'xo_battle' || g.id === 'tic_tac_toe' ? activeXoRooms * 2 : 0),
        currentRound: g.id === 'ring_of_future' ? currentEngineRound : 0
      }));

      return ResponseHandler.success(res, games, 'Games fetched successfully');
    } catch (err: any) {
      return ResponseHandler.error(res, err.message, 500);
    }
  }

  public static async getGameDetails(req: Request, res: Response) {
    const pool = DatabaseConfig.getPool();
    if (!pool) return ResponseHandler.error(res, 'Database unavailable', 500);

    const gameId = req.params.id;
    try {
      const gameRes = await pool.query('SELECT * FROM games WHERE id = $1', [gameId]);
      if (gameRes.rows.length === 0) {
        return ResponseHandler.error(res, 'Game not found', 404);
      }
      const game = gameRes.rows[0];

      let totalBets = 0;
      let totalWagered = 0;
      let totalPayouts = 0;

      if (gameId === 'xo_battle' || gameId === 'tic_tac_toe') {
        const xoLedger = await pool.query(`
          SELECT 
            COUNT(*) FILTER (WHERE type IN ('BET_DEBIT', 'BET') AND (reference_id ILIKE 'XO-%' OR metadata::text ILIKE '%xo%')) as total_bets,
            COALESCE(SUM(amount) FILTER (WHERE type IN ('BET_DEBIT', 'BET') AND (reference_id ILIKE 'XO-%' OR metadata::text ILIKE '%xo%')), 0) as total_wagered,
            COALESCE(SUM(amount) FILTER (WHERE type IN ('WIN_PAYOUT', 'GAME_WIN') AND (reference_id ILIKE 'XO-%' OR metadata::text ILIKE '%xo%')), 0) as total_payouts
          FROM wallet_ledger
        `);
        totalBets = Number(xoLedger.rows[0]?.total_bets || 0);
        totalWagered = Number(xoLedger.rows[0]?.total_wagered || 0);
        totalPayouts = Number(xoLedger.rows[0]?.total_payouts || 0);
      } else {
        const [betsRes, ledgerRes] = await Promise.all([
          pool.query(`
            SELECT 
              COUNT(*) as total_bets,
              COALESCE(SUM(stake), 0) as total_wagered,
              COALESCE(SUM(win_amount), 0) as total_payouts
            FROM bets
          `),
          pool.query(`
            SELECT 
              COUNT(*) FILTER (WHERE type IN ('BET_DEBIT', 'BET') AND reference_id NOT ILIKE 'XO-%') as total_bets,
              COALESCE(SUM(amount) FILTER (WHERE type IN ('BET_DEBIT', 'BET') AND reference_id NOT ILIKE 'XO-%'), 0) as total_wagered,
              COALESCE(SUM(amount) FILTER (WHERE type IN ('WIN_PAYOUT', 'GAME_WIN') AND reference_id NOT ILIKE 'XO-%'), 0) as total_payouts
            FROM wallet_ledger
          `)
        ]);
        totalBets = Math.max(Number(betsRes.rows[0]?.total_bets || 0), Number(ledgerRes.rows[0]?.total_bets || 0));
        totalWagered = Math.max(Number(betsRes.rows[0]?.total_wagered || 0), Number(ledgerRes.rows[0]?.total_wagered || 0));
        totalPayouts = Math.max(Number(betsRes.rows[0]?.total_payouts || 0), Number(ledgerRes.rows[0]?.total_payouts || 0));
      }

      const isRing = gameId === 'ring_of_future';
      const isXo = gameId === 'xo_battle' || gameId === 'tic_tac_toe';

      const runtimeStatus = isRing ? {
        isRunning: true,
        phase: RingOfFutureEngine.getSnapshotForUser('').phase,
        secondsRemaining: RingOfFutureEngine.getSnapshotForUser('').secondsRemaining,
        currentRound: RingOfFutureEngine.getRoundCount(),
        connectedPlayers: SocketServer.getConnectedClientsCount ? SocketServer.getConnectedClientsCount() : 1
      } : isXo ? {
        isRunning: true,
        activeRooms: TicTacToeEngine.getActiveRoomsCount(),
        availableTiers: TicTacToeEngine.getTiers().length,
        connectedPlayers: TicTacToeEngine.getActiveRoomsCount() * 2
      } : {
        isRunning: false,
        status: game.status
      };

      return ResponseHandler.success(res, {
        game: {
          ...game,
          config: typeof game.config === 'string' ? JSON.parse(game.config) : (game.config || {})
        },
        stats: {
          totalBets,
          totalWageredPaise: totalWagered,
          totalPayoutsPaise: totalPayouts
        },
        runtimeStatus
      });
    } catch (err: any) {
      return ResponseHandler.error(res, err.message, 500);
    }
  }

  public static async updateGameStatus(req: Request, res: Response) {
    const pool = DatabaseConfig.getPool();
    if (!pool) return ResponseHandler.error(res, 'Database unavailable', 500);

    const gameId = req.params.id;
    const { status } = req.body;
    const admin = (req as any).admin || { username: 'ADMIN' };

    const validStatuses = ['LIVE', 'COMING_SOON', 'DISABLED', 'MAINTENANCE'];
    if (!validStatuses.includes(status)) {
      return ResponseHandler.error(res, `Invalid status. Must be one of: ${validStatuses.join(', ')}`, 400);
    }

    try {
      await pool.query('UPDATE games SET status = $1 WHERE id = $2', [status, gameId]);
      await AuditService.log({
        adminId: admin.username || 'ADMIN',
        action: 'GAME_STATUS_CHANGED',
        target: `game:${gameId}`,
        details: { status }
      });

      return ResponseHandler.success(res, { gameId, status }, `Game status updated to ${status}`);
    } catch (err: any) {
      return ResponseHandler.error(res, err.message, 500);
    }
  }

  public static async updateGameConfig(req: Request, res: Response) {
    const pool = DatabaseConfig.getPool();
    if (!pool) return ResponseHandler.error(res, 'Database unavailable', 500);

    const gameId = req.params.id;
    const { config } = req.body;
    const admin = (req as any).admin || { username: 'ADMIN' };

    if (!config || typeof config !== 'object') {
      return ResponseHandler.error(res, 'Valid config object is required', 400);
    }

    // Explicit server-authoritative safeguard: Reject any attempt to tamper with future RNG or winning outcomes
    if ('futureOutcomes' in config || 'forceWinningIndex' in config || 'rigTarget' in config) {
      return ResponseHandler.error(res, 'Security Violation: Manual outcome manipulation is prohibited.', 403);
    }

    try {
      await pool.query(
        'UPDATE games SET config = $1 WHERE id = $2',
        [JSON.stringify(config), gameId]
      );

      await AuditService.log({
        adminId: admin.username || 'ADMIN',
        action: 'GAME_CONFIG_UPDATED',
        target: `game:${gameId}`,
        details: { config }
      });

      return ResponseHandler.success(res, { gameId, config }, 'Game configuration updated successfully');
    } catch (err: any) {
      return ResponseHandler.error(res, err.message, 500);
    }
  }

  // ==========================================
  // TRANSACTIONS & LEDGER
  // ==========================================

  public static async getLedgerOverview(_req: Request, res: Response) {
    const pool = DatabaseConfig.getPool();
    if (!pool) return ResponseHandler.error(res, 'Database unavailable', 500);

    try {
      const [walletRes, ledgerRes, pendingDep, pendingWd] = await Promise.all([
        pool.query(`
          SELECT 
            COALESCE(SUM(deposit_balance), 0) as total_deposit,
            COALESCE(SUM(winnings_balance), 0) as total_winning,
            COALESCE(SUM(rewards_balance), 0) as total_bonus,
            COALESCE(SUM(available_balance), 0) as total_available
          FROM wallets
        `),
        pool.query('SELECT COUNT(*) as total_entries FROM wallet_ledger'),
        pool.query("SELECT COUNT(*) FROM deposits WHERE status = 'PENDING'"),
        pool.query("SELECT COUNT(*) FROM withdrawals WHERE status = 'PENDING'")
      ]);

      return ResponseHandler.success(res, {
        totalDepositPaise: Number(walletRes.rows[0].total_deposit),
        totalWinningPaise: Number(walletRes.rows[0].total_winning),
        totalBonusPaise: Number(walletRes.rows[0].total_bonus),
        totalAvailablePaise: Number(walletRes.rows[0].total_available),
        totalLedgerEntries: Number(ledgerRes.rows[0].total_entries),
        pendingOperationsCount: Number(pendingDep.rows[0].count) + Number(pendingWd.rows[0].count)
      });
    } catch (err: any) {
      return ResponseHandler.error(res, err.message, 500);
    }
  }

  public static async queryLedger(req: Request, res: Response) {
    const pool = DatabaseConfig.getPool();
    if (!pool) return ResponseHandler.error(res, 'Database unavailable', 500);

    const userId = (req.query.userId as string) || '';
    const type = (req.query.type as string) || '';
    const refId = (req.query.refId as string) || '';
    const page = Math.max(1, parseInt(req.query.page as string, 10) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit as string, 10) || 25));
    const offset = (page - 1) * limit;

    try {
      let whereClause = 'WHERE 1=1';
      const params: any[] = [];

      if (userId) {
        params.push(`%${userId}%`);
        whereClause += ` AND user_id ILIKE $${params.length}`;
      }
      if (type && type !== 'ALL') {
        params.push(type);
        whereClause += ` AND type = $${params.length}`;
      }
      if (refId) {
        params.push(`%${refId}%`);
        whereClause += ` AND reference_id ILIKE $${params.length}`;
      }

      const countRes = await pool.query(`SELECT COUNT(*) FROM wallet_ledger ${whereClause}`, params);
      const total = Number(countRes.rows[0].count);

      const query = `
        SELECT id, user_id, wallet_id, type, amount, direction, reference_type, reference_id,
               balance_before, balance_after, status, idempotency_key, metadata, created_at
        FROM wallet_ledger
        ${whereClause}
        ORDER BY created_at DESC
        LIMIT $${params.length + 1} OFFSET $${params.length + 2}
      `;
      params.push(limit, offset);

      const resList = await pool.query(query, params);

      return ResponseHandler.success(res, {
        items: resList.rows.map((r: any) => ({
          ...r,
          amount: Number(r.amount),
          balance_before: Number(r.balance_before),
          balance_after: Number(r.balance_after),
          metadata: typeof r.metadata === 'string' ? JSON.parse(r.metadata) : (r.metadata || {})
        })),
        pagination: {
          page,
          limit,
          total,
          totalPages: Math.ceil(total / limit)
        }
      });
    } catch (err: any) {
      return ResponseHandler.error(res, err.message, 500);
    }
  }

  // ==========================================
  // SYSTEM HEALTH, SETTINGS & ANNOUNCEMENTS
  // ==========================================

  public static async getSystemHealth(_req: Request, res: Response) {
    const isDbHealthy = await DatabaseConfig.checkHealth();
    const roundCount = RingOfFutureEngine.getRoundCount();
    const wsClients = SocketServer.getConnectedClientsCount ? SocketServer.getConnectedClientsCount() : 1;

    return ResponseHandler.success(res, {
      status: 'ONLINE',
      pid: process.pid,
      database: isDbHealthy ? 'CONNECTED' : 'DISCONNECTED',
      dbLatencyMs: 2,
      uptimeSeconds: Math.floor(process.uptime()),
      activeWsConnections: wsClients,
      nodeVersion: process.version,
      timestamp: new Date().toISOString(),
      memory: {
        heapUsedMb: Math.round(process.memoryUsage().heapUsed / 1024 / 1024),
        rssMb: Math.round(process.memoryUsage().rss / 1024 / 1024)
      },
      api: { status: 'ONLINE', uptimeSeconds: Math.floor(process.uptime()) },
      db: { status: isDbHealthy ? 'ONLINE' : 'DEGRADED', provider: 'PostgreSQL' },
      redis: { status: 'ONLINE', host: '127.0.0.1' },
      websocket: { status: 'ONLINE', activeConnections: wsClients },
      gameEngine: { status: 'ONLINE', name: 'RingOfFutureEngine', roundSequence: roundCount },
      system: {
        nodeVersion: process.version,
        memoryUsageMb: Math.round(process.memoryUsage().heapUsed / 1024 / 1024),
        platform: process.platform
      }
    });
  }

  public static async getSystemSettings(_req: Request, res: Response) {
    const pool = DatabaseConfig.getPool();
    if (!pool) return ResponseHandler.error(res, 'Database unavailable', 500);

    try {
      const resList = await pool.query('SELECT key, value, description, updated_at FROM system_settings');
      const settingsMap: Record<string, any> = {};
      resList.rows.forEach((r: any) => {
        settingsMap[r.key] = typeof r.value === 'string' ? JSON.parse(r.value) : r.value;
      });
      return ResponseHandler.success(res, settingsMap);
    } catch (err: any) {
      return ResponseHandler.error(res, err.message, 500);
    }
  }

  public static async updateSystemSetting(req: Request, res: Response) {
    const pool = DatabaseConfig.getPool();
    if (!pool) return ResponseHandler.error(res, 'Database unavailable', 500);

    const { key, value } = req.body;
    const admin = (req as any).admin || { username: 'ADMIN' };

    if (!key || value === undefined) {
      return ResponseHandler.error(res, 'key and value are required', 400);
    }

    try {
      await pool.query(
        `INSERT INTO system_settings (key, value, updated_by, updated_at)
         VALUES ($1, $2, $3, CURRENT_TIMESTAMP)
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = CURRENT_TIMESTAMP`,
        [key, JSON.stringify(value), admin.username]
      );

      await AuditService.log({
        adminId: admin.username,
        action: 'SETTING_CHANGED',
        target: `setting:${key}`,
        details: { key, value }
      });

      return ResponseHandler.success(res, { key, value }, `Setting ${key} updated successfully`);
    } catch (err: any) {
      return ResponseHandler.error(res, err.message, 500);
    }
  }

  public static async getAnnouncements(_req: Request, res: Response) {
    const pool = DatabaseConfig.getPool();
    if (!pool) return ResponseHandler.error(res, 'Database unavailable', 500);

    try {
      const resList = await pool.query('SELECT * FROM announcements ORDER BY created_at DESC');
      return ResponseHandler.success(res, resList.rows);
    } catch (err: any) {
      return ResponseHandler.error(res, err.message, 500);
    }
  }

  public static async createAnnouncement(req: Request, res: Response) {
    const pool = DatabaseConfig.getPool();
    if (!pool) return ResponseHandler.error(res, 'Database unavailable', 500);

    const { title, message, targetAudience = 'ALL' } = req.body;
    const admin = (req as any).admin || { username: 'ADMIN' };

    if (!title || !message) {
      return ResponseHandler.error(res, 'Title and message are required', 400);
    }

    const id = `ann_${Date.now()}_${Math.floor(Math.random() * 1000)}`;
    try {
      await pool.query(
        `INSERT INTO announcements (id, title, message, status, target_audience, created_by, created_at, updated_at)
         VALUES ($1, $2, $3, 'ACTIVE', $4, $5, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
        [id, title, message, targetAudience, admin.username]
      );

      await AuditService.log({
        adminId: admin.username,
        action: 'ANNOUNCEMENT_CREATED',
        target: `announcement:${id}`,
        details: { title, targetAudience }
      });

      return ResponseHandler.success(res, { id }, 'Announcement created successfully');
    } catch (err: any) {
      return ResponseHandler.error(res, err.message, 500);
    }
  }

  public static async toggleAnnouncementStatus(req: Request, res: Response) {
    const pool = DatabaseConfig.getPool();
    if (!pool) return ResponseHandler.error(res, 'Database unavailable', 500);

    const id = req.params.id;
    const { status } = req.body;
    const admin = (req as any).admin || { username: 'ADMIN' };

    try {
      await pool.query('UPDATE announcements SET status = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2', [status, id]);
      await AuditService.log({
        adminId: admin.username,
        action: 'ANNOUNCEMENT_STATUS_CHANGED',
        target: `announcement:${id}`,
        details: { status }
      });

      return ResponseHandler.success(res, { id, status }, `Announcement status updated to ${status}`);
    } catch (err: any) {
      return ResponseHandler.error(res, err.message, 500);
    }
  }

  public static async sendPushNotification(req: Request, res: Response) {
    const { title, body, message, userId, targetAudience } = req.body;
    const notifTitle = title || 'Game In Play Alert';
    const notifBody = body || message;

    if (!notifBody) {
      return ResponseHandler.error(res, 'Notification message / body is required', 400);
    }

    try {
      const result = await PushNotificationService.sendNotification({
        title: notifTitle,
        body: notifBody,
        userId: userId || (targetAudience === 'ALL' ? undefined : targetAudience)
      });

      return ResponseHandler.success(res, result, 'Push notification broadcast successfully');
    } catch (err: any) {
      return ResponseHandler.error(res, err.message, 500);
    }
  }

  // ==========================================
  // PROMOTIONS & APP HERO CAROUSEL BANNERS
  // ==========================================

  public static async getPromotions(_req: Request, res: Response) {
    const pool = DatabaseConfig.getPool();
    if (!pool) return ResponseHandler.error(res, 'Database unavailable', 500);

    try {
      await pool.query(`
        CREATE TABLE IF NOT EXISTS promotions (
          id VARCHAR(64) PRIMARY KEY,
          title VARCHAR(255) NOT NULL,
          subtitle VARCHAR(255) NOT NULL,
          badge_text VARCHAR(64),
          cta_text VARCHAR(64) DEFAULT 'PLAY NOW',
          target_route VARCHAR(128) DEFAULT '/games',
          gradient_start VARCHAR(32) DEFAULT '#F59E0B',
          gradient_end VARCHAR(32) DEFAULT '#D97706',
          is_active BOOLEAN DEFAULT TRUE,
          display_order INT DEFAULT 1,
          created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
          updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
        );

        ALTER TABLE promotions ADD COLUMN IF NOT EXISTS badge_text VARCHAR(64);
        ALTER TABLE promotions ADD COLUMN IF NOT EXISTS cta_text VARCHAR(64) DEFAULT 'PLAY NOW';
        ALTER TABLE promotions ADD COLUMN IF NOT EXISTS target_route VARCHAR(128) DEFAULT '/games';
        ALTER TABLE promotions ADD COLUMN IF NOT EXISTS gradient_start VARCHAR(32) DEFAULT '#8B5CF6';
        ALTER TABLE promotions ADD COLUMN IF NOT EXISTS gradient_end VARCHAR(32) DEFAULT '#6D28D9';
        ALTER TABLE promotions ADD COLUMN IF NOT EXISTS is_active BOOLEAN DEFAULT TRUE;
        ALTER TABLE promotions ADD COLUMN IF NOT EXISTS display_order INT DEFAULT 1;
      `);

      let promoRes = await pool.query('SELECT * FROM promotions ORDER BY display_order ASC, created_at DESC');

      // Seed initial default banners if empty
      if (promoRes.rows.length === 0) {
        const seedBanners = [
          {
            id: 'promo_welcome_50',
            title: '🎁 ₹50 Welcome Bonus Drop',
            subtitle: 'Instant signup bonus credited on first login',
            badge_text: 'HOT OFFER',
            cta_text: 'CLAIM BONUS',
            target_route: '/wallet',
            gradient_start: '#8B5CF6',
            gradient_end: '#6D28D9',
            display_order: 1
          },
          {
            id: 'promo_xo_battle',
            title: '⚔️ 1v1 XO Multiplayer Battles',
            subtitle: 'Fast 60s matches with instant double cash payout',
            badge_text: 'NEW GAME',
            cta_text: 'BATTLE NOW',
            target_route: '/games/xo',
            gradient_start: '#3B82F6',
            gradient_end: '#1D4ED8',
            display_order: 2
          },
          {
            id: 'promo_ring_jackpot',
            title: '🎡 Ring of Future: 30x Jackpot',
            subtitle: 'Green multiplier triggers huge 30x winnings',
            badge_text: '30X JACKPOT',
            cta_text: 'SPIN NOW',
            target_route: '/games/ring',
            gradient_start: '#10B981',
            gradient_end: '#047857',
            display_order: 3
          }
        ];

        for (const b of seedBanners) {
          await pool.query(
            `INSERT INTO promotions (id, title, subtitle, badge_text, cta_text, target_route, gradient_start, gradient_end, display_order)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
            [b.id, b.title, b.subtitle, b.badge_text, b.cta_text, b.target_route, b.gradient_start, b.gradient_end, b.display_order]
          );
        }

        promoRes = await pool.query('SELECT * FROM promotions ORDER BY display_order ASC, created_at DESC');
      }

      return ResponseHandler.success(res, promoRes.rows);
    } catch (err: any) {
      return ResponseHandler.error(res, err.message, 500);
    }
  }

  public static async createPromotion(req: Request, res: Response) {
    const pool = DatabaseConfig.getPool();
    if (!pool) return ResponseHandler.error(res, 'Database unavailable', 500);

    const {
      title,
      subtitle,
      badgeText = 'SPECIAL',
      ctaText = 'PLAY NOW',
      targetRoute = '/games',
      gradientStart = '#F59E0B',
      gradientEnd = '#D97706',
      displayOrder = 1
    } = req.body;

    const admin = (req as any).admin || { username: 'ADMIN' };

    if (!title || !subtitle) {
      return ResponseHandler.error(res, 'Title and subtitle are required', 400);
    }

    const id = `promo_${Date.now()}_${Math.floor(Math.random() * 1000)}`;

    try {
      await pool.query(
        `INSERT INTO promotions (id, title, subtitle, badge_text, cta_text, target_route, gradient_start, gradient_end, display_order, is_active, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, TRUE, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
        [id, title.trim(), subtitle.trim(), badgeText.trim(), ctaText.trim(), targetRoute.trim(), gradientStart, gradientEnd, displayOrder]
      );

      await AuditService.log({
        adminId: admin.username,
        action: 'PROMOTION_CREATED',
        target: `promo:${id}`,
        details: { title, badgeText, targetRoute }
      });

      return ResponseHandler.success(res, { id }, 'Promotion banner created successfully');
    } catch (err: any) {
      return ResponseHandler.error(res, err.message, 500);
    }
  }

  public static async togglePromotionStatus(req: Request, res: Response) {
    const pool = DatabaseConfig.getPool();
    if (!pool) return ResponseHandler.error(res, 'Database unavailable', 500);

    const id = req.params.id;
    const { isActive } = req.body;
    const admin = (req as any).admin || { username: 'ADMIN' };

    try {
      await pool.query('UPDATE promotions SET is_active = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2', [isActive, id]);

      await AuditService.log({
        adminId: admin.username,
        action: 'PROMOTION_STATUS_CHANGED',
        target: `promo:${id}`,
        details: { isActive }
      });

      return ResponseHandler.success(res, { id, isActive }, `Promotion banner is now ${isActive ? 'ACTIVE' : 'INACTIVE'}`);
    } catch (err: any) {
      return ResponseHandler.error(res, err.message, 500);
    }
  }

  public static async deletePromotion(req: Request, res: Response) {
    const pool = DatabaseConfig.getPool();
    if (!pool) return ResponseHandler.error(res, 'Database unavailable', 500);

    const id = req.params.id;
    const admin = (req as any).admin || { username: 'ADMIN' };

    try {
      await pool.query('DELETE FROM promotions WHERE id = $1', [id]);

      await AuditService.log({
        adminId: admin.username,
        action: 'PROMOTION_DELETED',
        target: `promo:${id}`
      });

      return ResponseHandler.success(res, { id }, 'Promotion banner deleted');
    } catch (err: any) {
      return ResponseHandler.error(res, err.message, 500);
    }
  }

  // ==========================================
  // SECURITY: ADMIN USERS, SESSIONS & AUDIT LOGS
  // ==========================================

  public static async listAdmins(_req: Request, res: Response) {
    const pool = DatabaseConfig.getPool();
    if (!pool) return ResponseHandler.error(res, 'Database unavailable', 500);

    try {
      const resList = await pool.query(`
        SELECT id, username, role, is_active, last_login_at, created_at, updated_at
        FROM admins
        ORDER BY created_at ASC
      `);
      return ResponseHandler.success(res, resList.rows);
    } catch (err: any) {
      return ResponseHandler.error(res, err.message, 500);
    }
  }

  public static async createAdmin(req: Request, res: Response) {
    const pool = DatabaseConfig.getPool();
    if (!pool) return ResponseHandler.error(res, 'Database unavailable', 500);

    const { username, password, role = 'VIEWER' } = req.body;
    const currentAdmin = (req as any).admin || { username: 'ADMIN' };

    if (!username || !password) {
      return ResponseHandler.error(res, 'Username and password are required', 400);
    }

    // Enforce strong password policy
    const passwordErrors: string[] = [];
    if (password.length < 12) passwordErrors.push('at least 12 characters');
    if (!/[A-Z]/.test(password)) passwordErrors.push('at least one uppercase letter');
    if (!/[a-z]/.test(password)) passwordErrors.push('at least one lowercase letter');
    if (!/[0-9]/.test(password)) passwordErrors.push('at least one digit');
    if (!/[!@#$%^&*()_\-+=\[\]{};:'",.<>?/\\|`~]/.test(password)) passwordErrors.push('at least one special character');
    if (passwordErrors.length > 0) {
      return ResponseHandler.error(res,
        `Password must contain: ${passwordErrors.join(', ')}.`,
        400
      );
    }

    const id = `adm_${Date.now()}_${Math.floor(Math.random() * 1000)}`;
    const passwordHash = await bcrypt.hash(password, 10);

    try {
      await pool.query(
        `INSERT INTO admins (id, username, password_hash, role, is_active, created_at, updated_at)
         VALUES ($1, $2, $3, $4, TRUE, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
        [id, username, passwordHash, role]
      );

      await AuditService.log({
        adminId: currentAdmin.username,
        action: 'ADMIN_CREATED',
        target: `admin:${username}`,
        details: { role }
      });

      return ResponseHandler.success(res, { id, username, role }, 'Admin created successfully');
    } catch (err: any) {
      return ResponseHandler.error(res, err.message, 500);
    }
  }

  public static async toggleAdminActive(req: Request, res: Response) {
    const pool = DatabaseConfig.getPool();
    if (!pool) return ResponseHandler.error(res, 'Database unavailable', 500);

    const id = req.params.id;
    const { isActive } = req.body;
    const currentAdmin = (req as any).admin || { username: 'ADMIN' };

    try {
      await pool.query('UPDATE admins SET is_active = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2', [Boolean(isActive), id]);
      await AuditService.log({
        adminId: currentAdmin.username,
        action: isActive ? 'ADMIN_ENABLED' : 'ADMIN_DISABLED',
        target: `admin:${id}`,
        details: { isActive }
      });

      return ResponseHandler.success(res, { id, isActive }, `Admin account ${isActive ? 'enabled' : 'disabled'}`);
    } catch (err: any) {
      return ResponseHandler.error(res, err.message, 500);
    }
  }

  public static async getAuditLogs(req: Request, res: Response) {
    const limit = Math.min(200, parseInt(req.query.limit as string, 10) || 50);
    const action = req.query.action as string;

    try {
      const logs = await AuditService.getLogs(limit, action);
      return ResponseHandler.success(res, logs, 'Audit logs retrieved');
    } catch (err: any) {
      return ResponseHandler.error(res, err.message, 500);
    }
  }
}
