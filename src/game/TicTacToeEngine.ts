import crypto from 'crypto';
import { WalletService } from '../modules/wallet/wallet.service';
import { Logger } from '../utils/logger';

export interface XOTier {
  id: string;
  name: string;
  entryPaise: number;
  firstPrizePaise: number;
  secondPrizePaise: number;
  bonusUsablePaise: number;
  playersCount: number;
}

export const XO_STAKE_TIERS: XOTier[] = [
  {
    id: 'tier_1',
    name: 'Battle ₹1',
    entryPaise: 100, // ₹1
    firstPrizePaise: 150, // ₹1.50 (90-95% RTP + house commission)
    secondPrizePaise: 0,
    bonusUsablePaise: 25, // ₹0.25 from Bonus
    playersCount: 2
  },
  {
    id: 'tier_5',
    name: 'Battle ₹5',
    entryPaise: 500, // ₹5
    firstPrizePaise: 900, // ₹9.00
    secondPrizePaise: 0,
    bonusUsablePaise: 100, // ₹1.00 from Bonus
    playersCount: 2
  },
  {
    id: 'tier_10',
    name: 'Battle ₹10',
    entryPaise: 1000, // ₹10
    firstPrizePaise: 1800, // ₹18.00
    secondPrizePaise: 0,
    bonusUsablePaise: 200, // ₹2.00 from Bonus
    playersCount: 2
  },
  {
    id: 'tier_25',
    name: 'Battle ₹25',
    entryPaise: 2500, // ₹25
    firstPrizePaise: 4500, // ₹45.00
    secondPrizePaise: 0,
    bonusUsablePaise: 500, // ₹5.00 from Bonus
    playersCount: 2
  },
  {
    id: 'tier_50',
    name: 'Battle ₹50',
    entryPaise: 5000, // ₹50
    firstPrizePaise: 9000, // ₹90.00
    secondPrizePaise: 0,
    bonusUsablePaise: 1000, // ₹10.00 from Bonus
    playersCount: 2
  },
  {
    id: 'tier_100',
    name: 'Battle ₹100',
    entryPaise: 10000, // ₹100
    firstPrizePaise: 18000, // ₹180.00
    secondPrizePaise: 0,
    bonusUsablePaise: 2000, // ₹20.00 from Bonus
    playersCount: 2
  }
];

export interface XOPlayer {
  userId: string;
  name: string;
  avatarUrl: string;
  symbol: 'O' | 'X'; // Player 1 = O (Purple), Player 2 = X (White)
  score: number;
  isBot?: boolean;
}

export type XORoomStatus = 'MATCHMAKING' | 'IN_GAME' | 'COMPLETED' | 'CANCELLED';

export interface XORoom {
  roomId: string;
  tierId: string;
  tier: XOTier;
  player1: XOPlayer;
  player2: XOPlayer | null;
  board: (string | null)[]; // 9 cells: 0 to 8
  currentTurnUserId: string;
  status: XORoomStatus;
  turnSecondsRemaining: number;
  totalGameSecondsRemaining: number;
  winnerUserId: string | null;
  isDraw: boolean;
  winningIndices: number[] | null;
  createdAt: number;
  turnTimerHandle?: NodeJS.Timeout | null;
}

export class TicTacToeEngine {
  private static matchmakingQueues = new Map<string, Array<{ userId: string; name: string; avatarUrl: string; joinedAt: number }>>();
  private static activeRooms = new Map<string, XORoom>();
  private static roomChangeCallbacks: Array<(room: XORoom) => void> = [];

  public static onRoomChange(cb: (room: XORoom) => void) {
    this.roomChangeCallbacks.push(cb);
  }

  private static notifyRoom(room: XORoom) {
    this.roomChangeCallbacks.forEach((cb) => {
      try {
        cb(room);
      } catch (err) {
        Logger.error('[XO] Callback error:', err);
      }
    });
  }

  public static getTiers(): XOTier[] {
    return XO_STAKE_TIERS;
  }

  public static getRoom(roomId: string): XORoom | undefined {
    return this.activeRooms.get(roomId);
  }

  public static getRoomForUser(userId: string): XORoom | undefined {
    for (const room of this.activeRooms.values()) {
      if ((room.player1.userId === userId || room.player2?.userId === userId) && room.status !== 'COMPLETED' && room.status !== 'CANCELLED') {
        return room;
      }
    }
    return undefined;
  }

  /**
   * User requests to join a matchmaking queue for a specific tier
   */
  public static async joinQueue(
    userId: string,
    name: string,
    avatarUrl: string,
    tierId: string
  ): Promise<{ success: boolean; message?: string; room?: XORoom }> {
    const tier = XO_STAKE_TIERS.find((t) => t.id === tierId);
    if (!tier) {
      return { success: false, message: 'Invalid stake tier' };
    }

    // Check existing active game
    const existing = this.getRoomForUser(userId);
    if (existing && existing.status === 'IN_GAME') {
      return { success: true, room: existing };
    }

    // Debit stake from user's wallet using ACID WalletService
    const debitRef = `XO-BET-${Date.now()}-${crypto.randomInt(1000, 9999)}`;
    const idempKey = `idemp_${debitRef}`;
    const debitRes = await WalletService.debitBet(
      userId,
      tier.entryPaise,
      debitRef,
      `Entry fee for ${tier.name}`,
      idempKey,
      { tierId, game: 'TIC_TAC_TOE' }
    );

    if (!debitRes.success) {
      return { success: false, message: debitRes.message || 'Insufficient wallet balance' };
    }

    // Queue logic
    let queue = this.matchmakingQueues.get(tierId);
    if (!queue) {
      queue = [];
      this.matchmakingQueues.set(tierId, queue);
    }

    // Remove duplicates
    queue = queue.filter((item) => item.userId !== userId);

    // If queue has an opponent waiting
    if (queue.length > 0) {
      const opponent = queue.shift()!;
      const roomId = `XO-${Date.now()}-${crypto.randomInt(100, 999)}`;

      const room: XORoom = {
        roomId,
        tierId,
        tier,
        player1: {
          userId: opponent.userId,
          name: opponent.name,
          avatarUrl: opponent.avatarUrl,
          symbol: 'O',
          score: 0
        },
        player2: {
          userId,
          name,
          avatarUrl,
          symbol: 'X',
          score: 0
        },
        board: Array(9).fill(null),
        currentTurnUserId: opponent.userId, // Player 1 starts
        status: 'IN_GAME',
        turnSecondsRemaining: 15,
        totalGameSecondsRemaining: 180, // 3 mins total game
        winnerUserId: null,
        isDraw: false,
        winningIndices: null,
        createdAt: Date.now()
      };

      this.activeRooms.set(roomId, room);
      this.startRoomTimer(room);
      this.notifyRoom(room);

      return { success: true, room };
    }

    // Add user to queue
    queue.push({ userId, name, avatarUrl, joinedAt: Date.now() });
    this.matchmakingQueues.set(tierId, queue);

    // Auto Bot Fallback after 4.5 seconds if no human opponent joins
    setTimeout(async () => {
      const currentQueue = this.matchmakingQueues.get(tierId) || [];
      const userInQueue = currentQueue.find((u) => u.userId === userId);
      if (userInQueue) {
        // Remove from queue and spawn AI match
        this.matchmakingQueues.set(
          tierId,
          currentQueue.filter((u) => u.userId !== userId)
        );

        const botNames = ['Anika Donin', 'Vikram S.', 'Rahul_Gamer', 'Pooja Sharma', 'Kunal99'];
        const randomBotName = botNames[crypto.randomInt(0, botNames.length)];
        const roomId = `XO-${Date.now()}-${crypto.randomInt(100, 999)}`;

        const room: XORoom = {
          roomId,
          tierId,
          tier,
          player1: {
            userId,
            name,
            avatarUrl,
            symbol: 'O',
            score: 0
          },
          player2: {
            userId: `BOT-${crypto.randomInt(1000, 9999)}`,
            name: randomBotName,
            avatarUrl: 'https://images.unsplash.com/photo-1544005313-94ddf0286df2?w=150',
            symbol: 'X',
            score: 0,
            isBot: true
          },
          board: Array(9).fill(null),
          currentTurnUserId: userId, // Player starts
          status: 'IN_GAME',
          turnSecondsRemaining: 15,
          totalGameSecondsRemaining: 180,
          winnerUserId: null,
          isDraw: false,
          winningIndices: null,
          createdAt: Date.now()
        };

        this.activeRooms.set(roomId, room);
        this.startRoomTimer(room);
        this.notifyRoom(room);
      }
    }, 4500);

    return { success: true, message: 'Joined matchmaking queue' };
  }

  /**
   * Start 1-second interval room timer
   */
  private static startRoomTimer(room: XORoom) {
    if (room.turnTimerHandle) {
      clearInterval(room.turnTimerHandle);
    }

    room.turnTimerHandle = setInterval(async () => {
      if (room.status !== 'IN_GAME') {
        if (room.turnTimerHandle) clearInterval(room.turnTimerHandle);
        return;
      }

      room.turnSecondsRemaining--;
      room.totalGameSecondsRemaining--;

      // Turn timeout -> Switch turn or trigger Bot move
      if (room.turnSecondsRemaining <= 0) {
        room.turnSecondsRemaining = 15;
        // Switch turn to opponent
        room.currentTurnUserId =
          room.currentTurnUserId === room.player1.userId
            ? room.player2?.userId || room.player1.userId
            : room.player1.userId;

        // If it's now Bot's turn, auto trigger move
        this.checkAndTriggerBotMove(room);
      }

      if (room.totalGameSecondsRemaining <= 0) {
        await this.endGame(room, null, true);
      }

      this.notifyRoom(room);
    }, 1000);
  }

  /**
   * Make a move on board index (0 to 8)
   */
  public static async makeMove(
    userId: string,
    roomId: string,
    cellIndex: number
  ): Promise<{ success: boolean; message?: string; room?: XORoom }> {
    const room = this.activeRooms.get(roomId);
    if (!room || room.status !== 'IN_GAME') {
      return { success: false, message: 'Game room not active' };
    }

    if (cellIndex < 0 || cellIndex > 8) {
      return { success: false, message: 'Invalid board cell' };
    }

    if (room.board[cellIndex] !== null) {
      return { success: false, message: 'Cell already taken' };
    }

    if (room.currentTurnUserId !== userId) {
      return { success: false, message: 'Not your turn' };
    }

    const player = room.player1.userId === userId ? room.player1 : room.player2;
    if (!player) {
      return { success: false, message: 'Player not in room' };
    }

    // Place move
    room.board[cellIndex] = player.symbol;
    room.turnSecondsRemaining = 15;

    // Check Win Condition
    const winResult = this.checkWin(room.board);
    if (winResult) {
      room.winningIndices = winResult.indices;
      await this.endGame(room, userId, false);
      return { success: true, room };
    }

    // Check Draw Condition (All cells filled)
    if (room.board.every((c) => c !== null)) {
      await this.endGame(room, null, true);
      return { success: true, room };
    }

    // Switch Turn
    room.currentTurnUserId =
      userId === room.player1.userId
        ? room.player2?.userId || room.player1.userId
        : room.player1.userId;

    this.notifyRoom(room);

    // Bot move if next player is bot
    this.checkAndTriggerBotMove(room);

    return { success: true, room };
  }

  private static checkAndTriggerBotMove(room: XORoom) {
    if (room.player2?.isBot && room.currentTurnUserId === room.player2.userId && room.status === 'IN_GAME') {
      // Simulate human reaction time between 1.2s - 2.5s
      const delay = crypto.randomInt(1200, 2500);
      setTimeout(async () => {
        if (room.status !== 'IN_GAME' || room.currentTurnUserId !== room.player2?.userId) return;

        const emptyIndices: number[] = [];
        room.board.forEach((val, idx) => {
          if (val === null) emptyIndices.push(idx);
        });

        if (emptyIndices.length > 0) {
          // Smart AI: Find winning move or blocking move, else random
          let chosenIndex = this.findBestBotMove(room.board, 'X', 'O');
          if (chosenIndex === -1 || !emptyIndices.includes(chosenIndex)) {
            chosenIndex = emptyIndices[crypto.randomInt(0, emptyIndices.length)];
          }

          await this.makeMove(room.player2.userId, room.roomId, chosenIndex);
        }
      }, delay);
    }
  }

  private static findBestBotMove(board: (string | null)[], botSymbol: string, playerSymbol: string): number {
    const lines = [
      [0, 1, 2], [3, 4, 5], [6, 7, 8], // Rows
      [0, 3, 6], [1, 4, 7], [2, 5, 8], // Cols
      [0, 4, 8], [2, 4, 6]             // Diagonals
    ];

    // 1. Can Bot win in 1 move?
    for (const [a, b, c] of lines) {
      if (board[a] === botSymbol && board[b] === botSymbol && board[c] === null) return c;
      if (board[a] === botSymbol && board[c] === botSymbol && board[b] === null) return b;
      if (board[b] === botSymbol && board[c] === botSymbol && board[a] === null) return a;
    }

    // 2. Can Bot block Player's win?
    for (const [a, b, c] of lines) {
      if (board[a] === playerSymbol && board[b] === playerSymbol && board[c] === null) return c;
      if (board[a] === playerSymbol && board[c] === playerSymbol && board[b] === null) return b;
      if (board[b] === playerSymbol && board[c] === playerSymbol && board[a] === null) return a;
    }

    // 3. Take Center if available
    if (board[4] === null) return 4;

    return -1;
  }

  private static checkWin(board: (string | null)[]): { winner: string; indices: number[] } | null {
    const lines = [
      [0, 1, 2], [3, 4, 5], [6, 7, 8], // Rows
      [0, 3, 6], [1, 4, 7], [2, 5, 8], // Cols
      [0, 4, 8], [2, 4, 6]             // Diagonals
    ];

    for (const [a, b, c] of lines) {
      if (board[a] && board[a] === board[b] && board[a] === board[c]) {
        return { winner: board[a]!, indices: [a, b, c] };
      }
    }
    return null;
  }

  private static async endGame(room: XORoom, winnerUserId: string | null, isDraw: boolean) {
    room.status = 'COMPLETED';
    room.winnerUserId = winnerUserId;
    room.isDraw = isDraw;

    if (room.turnTimerHandle) {
      clearInterval(room.turnTimerHandle);
      room.turnTimerHandle = null;
    }

    if (winnerUserId && !isDraw) {
      // Credit winning prize to winner
      const winRef = `XO-WIN-${Date.now()}-${crypto.randomInt(1000, 9999)}`;
      const idempKey = `idemp_${winRef}`;
      if (!winnerUserId.startsWith('BOT-')) {
        await WalletService.creditWinnings(
          winnerUserId,
          room.tier.firstPrizePaise,
          winRef,
          `Won 1v1 ${room.tier.name}`,
          idempKey,
          { roomId: room.roomId, tierId: room.tierId }
        );
      }
    } else if (isDraw) {
      // Refund both real players on draw
      if (!room.player1.isBot) {
        const ref1 = `XO-REFUND-${Date.now()}-1`;
        await WalletService.refundEquity(
          room.player1.userId,
          room.tier.entryPaise,
          0,
          0,
          ref1,
          `Draw Refund for ${room.tier.name}`,
          `idemp_${ref1}`
        );
      }
      if (room.player2 && !room.player2.isBot) {
        const ref2 = `XO-REFUND-${Date.now()}-2`;
        await WalletService.refundEquity(
          room.player2.userId,
          room.tier.entryPaise,
          0,
          0,
          ref2,
          `Draw Refund for ${room.tier.name}`,
          `idemp_${ref2}`
        );
      }
    }

    this.notifyRoom(room);
  }
}
