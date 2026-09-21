import crypto from 'crypto';
import { WalletLedger } from '../services/WalletLedger';

export enum RingPhase {
  BETTING = 'BETTING',
  LOCKED = 'LOCKED',
  SPINNING = 'SPINNING',
  RESULT_SHOW = 'RESULT_SHOW'
}

export enum MultiplierType {
  GREY_2X = '2x',
  PURPLE_3X = '3x',
  ORANGE_5X = '5x',
  GREEN_30X = '30x'
}

export interface WheelSegmentSpec {
  index: number;
  type: MultiplierType;
  colorHex: string;
  multiplier: number;
}

export interface ActiveUserBets {
  grey2x: number;   // in paise
  purple3x: number; // in paise
  orange5x: number; // in paise
  green30x: number; // in paise
  totalBet: number;
}

export interface RingGameState {
  roundId: string;
  roundNumber: number;
  phase: RingPhase;
  secondsRemaining: number;
  winningSegmentIndex: number;
  winningType: MultiplierType;
  winningMultiplier: number;
  userBets: ActiveUserBets;
  lastWinAmountPaise: number;
  recentResults: MultiplierType[];
}

// 32-Segment Wheel Configuration (~95% RTP Target)
// 15 Grey (2x), 10 Purple (3x), 6 Orange (5x), 1 Green (30x)
export const WHEEL_32_SEGMENTS: WheelSegmentSpec[] = [
  { index: 0, type: MultiplierType.GREEN_30X, colorHex: '#10B981', multiplier: 30.0 },
  { index: 1, type: MultiplierType.GREY_2X, colorHex: '#9CA3AF', multiplier: 2.0 },
  { index: 2, type: MultiplierType.PURPLE_3X, colorHex: '#8B5CF6', multiplier: 3.0 },
  { index: 3, type: MultiplierType.GREY_2X, colorHex: '#9CA3AF', multiplier: 2.0 },
  { index: 4, type: MultiplierType.ORANGE_5X, colorHex: '#F97316', multiplier: 5.0 },
  { index: 5, type: MultiplierType.GREY_2X, colorHex: '#9CA3AF', multiplier: 2.0 },
  { index: 6, type: MultiplierType.PURPLE_3X, colorHex: '#8B5CF6', multiplier: 3.0 },
  { index: 7, type: MultiplierType.GREY_2X, colorHex: '#9CA3AF', multiplier: 2.0 },
  { index: 8, type: MultiplierType.ORANGE_5X, colorHex: '#F97316', multiplier: 5.0 },
  { index: 9, type: MultiplierType.GREY_2X, colorHex: '#9CA3AF', multiplier: 2.0 },
  { index: 10, type: MultiplierType.PURPLE_3X, colorHex: '#8B5CF6', multiplier: 3.0 },
  { index: 11, type: MultiplierType.GREY_2X, colorHex: '#9CA3AF', multiplier: 2.0 },
  { index: 12, type: MultiplierType.PURPLE_3X, colorHex: '#8B5CF6', multiplier: 3.0 },
  { index: 13, type: MultiplierType.GREY_2X, colorHex: '#9CA3AF', multiplier: 2.0 },
  { index: 14, type: MultiplierType.ORANGE_5X, colorHex: '#F97316', multiplier: 5.0 },
  { index: 15, type: MultiplierType.GREY_2X, colorHex: '#9CA3AF', multiplier: 2.0 },
  { index: 16, type: MultiplierType.PURPLE_3X, colorHex: '#8B5CF6', multiplier: 3.0 },
  { index: 17, type: MultiplierType.GREY_2X, colorHex: '#9CA3AF', multiplier: 2.0 },
  { index: 18, type: MultiplierType.PURPLE_3X, colorHex: '#8B5CF6', multiplier: 3.0 },
  { index: 19, type: MultiplierType.GREY_2X, colorHex: '#9CA3AF', multiplier: 2.0 },
  { index: 20, type: MultiplierType.ORANGE_5X, colorHex: '#F97316', multiplier: 5.0 },
  { index: 21, type: MultiplierType.GREY_2X, colorHex: '#9CA3AF', multiplier: 2.0 },
  { index: 22, type: MultiplierType.PURPLE_3X, colorHex: '#8B5CF6', multiplier: 3.0 },
  { index: 23, type: MultiplierType.GREY_2X, colorHex: '#9CA3AF', multiplier: 2.0 },
  { index: 24, type: MultiplierType.ORANGE_5X, colorHex: '#F97316', multiplier: 5.0 },
  { index: 25, type: MultiplierType.GREY_2X, colorHex: '#9CA3AF', multiplier: 2.0 },
  { index: 26, type: MultiplierType.PURPLE_3X, colorHex: '#8B5CF6', multiplier: 3.0 },
  { index: 27, type: MultiplierType.GREY_2X, colorHex: '#9CA3AF', multiplier: 2.0 },
  { index: 28, type: MultiplierType.PURPLE_3X, colorHex: '#8B5CF6', multiplier: 3.0 },
  { index: 29, type: MultiplierType.GREY_2X, colorHex: '#9CA3AF', multiplier: 2.0 },
  { index: 30, type: MultiplierType.ORANGE_5X, colorHex: '#F97316', multiplier: 5.0 },
  { index: 31, type: MultiplierType.PURPLE_3X, colorHex: '#8B5CF6', multiplier: 3.0 }
];

export class RingOfFutureEngine {
  private static roundSequence = 1001;
  private static currentRoundId = `RD-${Date.now()}`;
  private static currentPhase = RingPhase.BETTING;
  private static secondsRemaining = 15;
  private static winningSegmentIndex = 0;
  private static recentResults: MultiplierType[] = [
    MultiplierType.GREY_2X, MultiplierType.PURPLE_3X, MultiplierType.ORANGE_5X,
    MultiplierType.GREY_2X, MultiplierType.GREY_2X, MultiplierType.GREEN_30X,
    MultiplierType.PURPLE_3X, MultiplierType.ORANGE_5X, MultiplierType.GREY_2X, MultiplierType.PURPLE_3X
  ];

  private static activeBetsMap = new Map<string, ActiveUserBets>();
  private static timerJob: NodeJS.Timeout | null = null;
  private static stateListeners: ((state: RingGameState) => void)[] = [];

  public static start(): void {
    if (RingOfFutureEngine.timerJob) return;
    console.log('🎰 Ring of Future Authoritative Game Engine started.');
    RingOfFutureEngine.runLoop();
  }

  public static onStateChange(listener: (state: RingGameState) => void): void {
    RingOfFutureEngine.stateListeners.push(listener);
  }

  private static broadcast(): void {
    const defaultState = RingOfFutureEngine.getSnapshotForUser('USR-304');
    RingOfFutureEngine.stateListeners.forEach((cb) => cb(defaultState));
  }

  private static runLoop(): void {
    RingOfFutureEngine.timerJob = setInterval(async () => {
      RingOfFutureEngine.secondsRemaining--;

      if (RingOfFutureEngine.secondsRemaining <= 0) {
        await RingOfFutureEngine.advancePhase();
      }

      RingOfFutureEngine.broadcast();
    }, 1000);
  }

  private static async advancePhase(): Promise<void> {
    switch (RingOfFutureEngine.currentPhase) {
      case RingPhase.BETTING:
        RingOfFutureEngine.currentPhase = RingPhase.LOCKED;
        RingOfFutureEngine.secondsRemaining = 2;
        // Cryptographically secure RNG draw across 32 segments
        RingOfFutureEngine.winningSegmentIndex = crypto.randomInt(0, 32);
        break;

      case RingPhase.LOCKED:
        RingOfFutureEngine.currentPhase = RingPhase.SPINNING;
        RingOfFutureEngine.secondsRemaining = 5;
        break;

      case RingPhase.SPINNING:
        RingOfFutureEngine.currentPhase = RingPhase.RESULT_SHOW;
        RingOfFutureEngine.secondsRemaining = 4;
        await RingOfFutureEngine.processPayouts();
        break;

      case RingPhase.RESULT_SHOW:
        const winnerSpec = WHEEL_32_SEGMENTS[RingOfFutureEngine.winningSegmentIndex];
        RingOfFutureEngine.recentResults = [winnerSpec.type, ...RingOfFutureEngine.recentResults.slice(0, 9)];
        RingOfFutureEngine.roundSequence++;
        RingOfFutureEngine.currentRoundId = `RD-${Date.now()}`;
        RingOfFutureEngine.activeBetsMap.clear();
        RingOfFutureEngine.currentPhase = RingPhase.BETTING;
        RingOfFutureEngine.secondsRemaining = 15;
        break;
    }
  }

  public static placeBet(userId: string, targetType: MultiplierType, amountPaise: number): { success: boolean; message: string; balance?: any } {
    if (RingOfFutureEngine.currentPhase !== RingPhase.BETTING) {
      return { success: false, message: 'Bets are locked for this round' };
    }

    if (amountPaise <= 0) {
      return { success: false, message: 'Invalid bet amount' };
    }

    const wallet = WalletLedger.getUserBalance(userId);
    if (wallet.totalPaise < amountPaise) {
      return { success: false, message: 'Insufficient balance' };
    }

    // Debit order: deposit -> winning -> bonus
    let remaining = amountPaise;
    let dep = wallet.depositPaise;
    let win = wallet.winningPaise;
    let bon = wallet.bonusPaise;

    if (dep >= remaining) {
      dep -= remaining;
    } else {
      remaining -= dep;
      dep = 0;
      if (win >= remaining) {
        win -= remaining;
      } else {
        remaining -= win;
        win = 0;
        if (bon >= remaining) {
          bon -= remaining;
        } else {
          return { success: false, message: 'Insufficient bucket funds' };
        }
      }
    }

    wallet.depositPaise = dep;
    wallet.winningPaise = win;
    wallet.bonusPaise = bon;
    wallet.totalPaise = dep + win + bon;

    // Track active user bets
    const userBets = RingOfFutureEngine.activeBetsMap.get(userId) || {
      grey2x: 0,
      purple3x: 0,
      orange5x: 0,
      green30x: 0,
      totalBet: 0
    };

    if (targetType === MultiplierType.GREY_2X) userBets.grey2x += amountPaise;
    if (targetType === MultiplierType.PURPLE_3X) userBets.purple3x += amountPaise;
    if (targetType === MultiplierType.ORANGE_5X) userBets.orange5x += amountPaise;
    if (targetType === MultiplierType.GREEN_30X) userBets.green30x += amountPaise;
    userBets.totalBet += amountPaise;

    RingOfFutureEngine.activeBetsMap.set(userId, userBets);

    WalletLedger.recordTransaction(
      userId,
      'BET_PLACED',
      amountPaise,
      wallet.totalPaise,
      `BET-${Date.now()}`,
      `Bet placed on ${targetType}`
    );

    return { success: true, message: `Placed ₹${(amountPaise / 100).toFixed(2)} bet on ${targetType}`, balance: wallet };
  }

  private static async processPayouts(): Promise<void> {
    const winnerSpec = WHEEL_32_SEGMENTS[RingOfFutureEngine.winningSegmentIndex];

    for (const [userId, bets] of RingOfFutureEngine.activeBetsMap.entries()) {
      let betOnWinner = 0;
      if (winnerSpec.type === MultiplierType.GREY_2X) betOnWinner = bets.grey2x;
      if (winnerSpec.type === MultiplierType.PURPLE_3X) betOnWinner = bets.purple3x;
      if (winnerSpec.type === MultiplierType.ORANGE_5X) betOnWinner = bets.orange5x;
      if (winnerSpec.type === MultiplierType.GREEN_30X) betOnWinner = bets.green30x;

      if (betOnWinner > 0) {
        // Contract fee 2%: 98% of trade amount
        const contractPaise = Math.round((betOnWinner * 98) / 100);
        const winPayoutPaise = Math.round(contractPaise * winnerSpec.multiplier);

        const wallet = WalletLedger.getUserBalance(userId);
        wallet.winningPaise += winPayoutPaise;
        wallet.totalPaise = wallet.depositPaise + wallet.winningPaise + wallet.bonusPaise;

        WalletLedger.recordTransaction(
          userId,
          'WIN_PAYOUT',
          winPayoutPaise,
          wallet.totalPaise,
          `WIN-${Date.now()}`,
          `Win Payout (${winnerSpec.type} ${winnerSpec.multiplier}x)`
        );
      }
    }
  }

  public static getSnapshotForUser(userId: string): RingGameState {
    const userBets = RingOfFutureEngine.activeBetsMap.get(userId) || {
      grey2x: 0,
      purple3x: 0,
      orange5x: 0,
      green30x: 0,
      totalBet: 0
    };

    const winnerSpec = WHEEL_32_SEGMENTS[RingOfFutureEngine.winningSegmentIndex];

    let lastWinAmountPaise = 0;
    if (RingOfFutureEngine.currentPhase === RingPhase.RESULT_SHOW) {
      let betOnWinner = 0;
      if (winnerSpec.type === MultiplierType.GREY_2X) betOnWinner = userBets.grey2x;
      if (winnerSpec.type === MultiplierType.PURPLE_3X) betOnWinner = userBets.purple3x;
      if (winnerSpec.type === MultiplierType.ORANGE_5X) betOnWinner = userBets.orange5x;
      if (winnerSpec.type === MultiplierType.GREEN_30X) betOnWinner = userBets.green30x;

      if (betOnWinner > 0) {
        const contractPaise = Math.round((betOnWinner * 98) / 100);
        lastWinAmountPaise = Math.round(contractPaise * winnerSpec.multiplier);
      }
    }

    return {
      roundId: RingOfFutureEngine.currentRoundId,
      roundNumber: RingOfFutureEngine.roundSequence,
      phase: RingOfFutureEngine.currentPhase,
      secondsRemaining: RingOfFutureEngine.secondsRemaining,
      winningSegmentIndex: RingOfFutureEngine.winningSegmentIndex,
      winningType: winnerSpec.type,
      winningMultiplier: winnerSpec.multiplier,
      userBets,
      lastWinAmountPaise,
      recentResults: [...RingOfFutureEngine.recentResults]
    };
  }
}
