import { Request, Response } from 'express';
import { DatabaseConfig } from '../../config/db.config';
import { WalletService } from '../wallet/wallet.service';
import { AuditService } from '../../services/AuditService';
import { ResponseHandler } from '../../utils/responseHandler';
import { RingOfFutureEngine } from '../../game/RingOfFutureEngine';
import { SocketServer } from '../../sockets/socket.server';
import crypto from 'crypto';

export class AdminController {
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
          SELECT id, admin_id, action, target, details, created_at
          FROM audit_logs
          ORDER BY created_at DESC
          LIMIT 10
        `)
      ]);

      const totalRoundsPlayed = RingOfFutureEngine.getRoundCount();
      const dbRoundsCountRes = await pool.query('SELECT COUNT(*) FROM game_rounds');
      const totalRoundsInDb = Number(dbRoundsCountRes.rows[0]?.count || 0);

      const data = {
        users: {
          total: Number(usersStats.rows[0].total_users),
          active: Number(usersStats.rows[0].active_users),
          banned: Number(usersStats.rows[0].banned_users),
          new: Number(usersStats.rows[0].new_users)
        },
        financials: {
          totalDepositPaise: Number(walletStats.rows[0].total_deposit),
          totalWinningPaise: Number(walletStats.rows[0].total_winning),
          totalBonusPaise: Number(walletStats.rows[0].total_bonus),
          totalAvailablePaise: Number(walletStats.rows[0].total_available),
          approvedDepositsPaise: Number(depositStats.rows[0].approved_amount),
          pendingDepositsCount: Number(depositStats.rows[0].pending_count),
          pendingDepositsPaise: Number(depositStats.rows[0].pending_amount),
          approvedWithdrawalsPaise: Number(withdrawStats.rows[0].approved_amount),
          pendingWithdrawalsCount: Number(withdrawStats.rows[0].pending_count),
          pendingWithdrawalsPaise: Number(withdrawStats.rows[0].pending_amount)
        },
        games: {
          totalRounds: Math.max(totalRoundsPlayed, totalRoundsInDb),
          engineRounds: totalRoundsPlayed,
          totalBets: Number(betStats.rows[0].total_bets),
          totalWageredPaise: Number(betStats.rows[0].total_wagered),
          totalPayoutsPaise: Number(betStats.rows[0].total_payouts),
          activeGames: 1
        },
        recentActivity: recentActivity.rows.map((r: any) => ({
          ...r,
          details: typeof r.details === 'string' ? JSON.parse(r.details) : (r.details || {})
        }))
      };

      return ResponseHandler.success(res, data, 'Dashboard metrics fetched');
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
          name: u.username,
          phone: u.phone,
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

    try {
      const userRes = await pool.query('SELECT * FROM users WHERE id = $1', [userId]);
      if (userRes.rows.length === 0) {
        return ResponseHandler.error(res, 'User not found', 404);
      }
      const u = userRes.rows[0];

      // Fetch wallet, ledger, deposits, withdrawals, bets, notes, audits
      const [
        walletRes,
        ledgerRes,
        depositsRes,
        withdrawalsRes,
        betsRes,
        notesRes,
        auditsRes
      ] = await Promise.all([
        pool.query('SELECT * FROM wallets WHERE user_id = $1', [userId]),
        pool.query('SELECT * FROM wallet_ledger WHERE user_id = $1 ORDER BY created_at DESC LIMIT 50', [userId]),
        pool.query('SELECT * FROM deposits WHERE user_id = $1 ORDER BY created_at DESC LIMIT 50', [userId]),
        pool.query('SELECT * FROM withdrawals WHERE user_id = $1 ORDER BY created_at DESC LIMIT 50', [userId]),
        pool.query('SELECT * FROM bets WHERE user_id = $1 ORDER BY created_at DESC LIMIT 50', [userId]),
        pool.query('SELECT * FROM admin_notes WHERE user_id = $1 ORDER BY created_at DESC', [userId]),
        pool.query("SELECT * FROM audit_logs WHERE target = $1 OR user_id = $2 ORDER BY created_at DESC LIMIT 50", [`user:${userId}`, userId])
      ]);

      const w = walletRes.rows[0] || {
        deposit_balance: '0',
        winnings_balance: '0',
        rewards_balance: '0',
        available_balance: '0'
      };

      const totalBetsCount = betsRes.rows.length;
      const totalWageredPaise = betsRes.rows.reduce((sum: number, b: any) => sum + Number(b.stake || 0), 0);
      const totalPayoutPaise = betsRes.rows.reduce((sum: number, b: any) => sum + Number(b.win_amount || 0), 0);

      const approvedDeposits = depositsRes.rows.filter((d: any) => d.status === 'APPROVED');
      const totalDepositsPaise = approvedDeposits.reduce((sum: number, d: any) => sum + Number(d.amount || 0), 0);
      const pendingDepositsPaise = depositsRes.rows.filter((d: any) => d.status === 'PENDING').reduce((sum: number, d: any) => sum + Number(d.amount || 0), 0);

      const approvedWithdrawals = withdrawalsRes.rows.filter((w: any) => w.status === 'APPROVED');
      const totalWithdrawalsPaise = approvedWithdrawals.reduce((sum: number, w: any) => sum + Number(w.amount || 0), 0);
      const pendingWithdrawalsPaise = withdrawalsRes.rows.filter((w: any) => w.status === 'PENDING').reduce((sum: number, w: any) => sum + Number(w.amount || 0), 0);

      return ResponseHandler.success(res, {
        overview: {
          id: u.id,
          name: u.username,
          phone: u.phone,
          email: u.email,
          avatarPath: u.avatar_path,
          isBanned: Boolean(u.is_blocked),
          status: u.is_blocked ? 'BANNED' : 'ACTIVE',
          createdAt: u.created_at,
          lastActive: u.last_sign_in_at || u.created_at,
          totalGames: totalBetsCount > 0 ? 1 : 0,
          totalBets: totalBetsCount,
          totalWageredPaise,
          totalPayoutsPaise: totalPayoutPaise
        },
        wallet: {
          depositPaise: Number(w.deposit_balance),
          winningPaise: Number(w.winnings_balance),
          bonusPaise: Number(w.rewards_balance),
          totalPaise: Number(w.available_balance),
          version: Number(w.version || 1),
          updatedAt: w.updated_at
        },
        financialSummary: {
          totalDepositsPaise,
          pendingDepositsPaise,
          totalWithdrawalsPaise,
          pendingWithdrawalsPaise,
          approvedTransactionsCount: approvedDeposits.length + approvedWithdrawals.length,
          rejectedTransactionsCount: depositsRes.rows.filter((d: any) => d.status === 'REJECTED').length + withdrawalsRes.rows.filter((w: any) => w.status === 'REJECTED').length
        },
        transactions: ledgerRes.rows.map((r: any) => ({
          ...r,
          amount: Number(r.amount),
          balance_before: Number(r.balance_before),
          balance_after: Number(r.balance_after),
          metadata: typeof r.metadata === 'string' ? JSON.parse(r.metadata) : (r.metadata || {})
        })),
        deposits: depositsRes.rows.map((d: any) => ({
          ...d,
          amount: Number(d.amount)
        })),
        withdrawals: withdrawalsRes.rows.map((w: any) => ({
          ...w,
          amount: Number(w.amount)
        })),
        gameHistory: betsRes.rows.map((b: any) => ({
          ...b,
          stake: Number(b.stake),
          win_amount: Number(b.win_amount),
          payout_multiplier: Number(b.payout_multiplier)
        })),
        adminNotes: notesRes.rows,
        auditHistory: auditsRes.rows.map((a: any) => ({
          ...a,
          details: typeof a.details === 'string' ? JSON.parse(a.details) : (a.details || {})
        }))
      });
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
    const { type, bucket, amountRupees, reason } = req.body;
    const admin = (req as any).admin || { username: 'ADMIN', role: 'SUPER_ADMIN' };

    if (!type || !bucket || !amountRupees || !reason) {
      return ResponseHandler.error(res, 'type (CREDIT/DEBIT), bucket (deposit/winnings/bonus), amountRupees, and reason are required', 400);
    }

    const amountPaise = Math.round(parseFloat(amountRupees) * 100);
    if (isNaN(amountPaise) || amountPaise <= 0) {
      return ResponseHandler.error(res, 'Invalid adjustment amount', 400);
    }

    const refId = `ADJUST-${Date.now()}`;
    const idempKey = `idemp_adjust_${userId}_${Date.now()}`;

    try {
      let updatedBalance;
      if (type === 'CREDIT') {
        if (bucket === 'winnings') {
          updatedBalance = await WalletService.creditWinnings(userId, amountPaise, refId, `Admin Adjustment: ${reason}`, idempKey, { admin: admin.username, reason });
        } else if (bucket === 'bonus') {
          updatedBalance = await WalletService.creditBonus(userId, amountPaise, refId, `Admin Adjustment: ${reason}`, idempKey);
        } else {
          updatedBalance = await WalletService.creditDeposit(userId, amountPaise, refId, `Admin Adjustment: ${reason}`, idempKey);
        }
      } else {
        // DEBIT
        const debitRes = await WalletService.debitBet(userId, amountPaise, refId, `Admin Debit: ${reason}`, idempKey, { admin: admin.username, reason });
        if (!debitRes.success) {
          return ResponseHandler.error(res, debitRes.message || 'Debit failed due to insufficient funds', 400);
        }
        updatedBalance = debitRes.newBalance;
      }

      await AuditService.log({
        adminId: admin.username || 'ADMIN',
        action: 'WALLET_ADJUSTED',
        target: `user:${userId}`,
        userId,
        details: { type, bucket, amountRupees, amountPaise, reason, refId }
      });

      return ResponseHandler.success(res, { updatedBalance }, `Successfully adjusted wallet by ₹${(amountPaise / 100).toFixed(2)}`);
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

      const games = gamesRes.rows.map((g: any) => ({
        ...g,
        entry_fee: Number(g.entry_fee),
        min_stake: Number(g.min_stake),
        max_stake: Number(g.max_stake),
        config: typeof g.config === 'string' ? JSON.parse(g.config) : (g.config || {}),
        activePlayers: g.id === 'ring_of_future' ? 1 : 0,
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

      // Bets aggregations for this game
      const betsRes = await pool.query(`
        SELECT 
          COUNT(*) as total_bets,
          COALESCE(SUM(stake), 0) as total_wagered,
          COALESCE(SUM(win_amount), 0) as total_payouts
        FROM bets
      `);

      const runtimeStatus = gameId === 'ring_of_future' ? {
        isRunning: true,
        phase: RingOfFutureEngine.getSnapshotForUser('').phase,
        secondsRemaining: RingOfFutureEngine.getSnapshotForUser('').secondsRemaining,
        currentRound: RingOfFutureEngine.getRoundCount(),
        connectedPlayers: SocketServer.getConnectedClientsCount ? SocketServer.getConnectedClientsCount() : 1
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
          totalBets: Number(betsRes.rows[0].total_bets),
          totalWageredPaise: Number(betsRes.rows[0].total_wagered),
          totalPayoutsPaise: Number(betsRes.rows[0].total_payouts)
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
      api: { status: 'ONLINE', uptimeSeconds: Math.floor(process.uptime()) },
      database: { status: isDbHealthy ? 'ONLINE' : 'DEGRADED', provider: 'PostgreSQL' },
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

    if (!username || !password || password.length < 6) {
      return ResponseHandler.error(res, 'Username and password (min 6 chars) are required', 400);
    }

    const id = `adm_${Date.now()}_${Math.floor(Math.random() * 1000)}`;
    const passwordHash = crypto.createHash('sha256').update(password).digest('hex');

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
