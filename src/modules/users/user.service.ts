import { AuthService } from '../auth/auth.service';
import { WalletService } from '../wallet/wallet.service';

export class UserService {
  public static getUserOverview(userId: string) {
    const user = AuthService.getUserById(userId);
    const balance = WalletService.getBalance(userId);
    return {
      user,
      balance
    };
  }

  public static getAllUsers() {
    return AuthService.getAllUsers().map((u) => ({
      ...u,
      balance: WalletService.getBalance(u.id)
    }));
  }

  public static toggleBan(userId: string, isBanned: boolean) {
    return AuthService.toggleBanStatus(userId, isBanned);
  }

  public static adjustWallet(userId: string, type: 'ADD' | 'DEDUCT', amountRupees: number) {
    const amountPaise = Math.round(amountRupees * 100);
    if (type === 'ADD') {
      return WalletService.creditDeposit(userId, amountPaise, `ADMIN-ADD-${Date.now()}`, 'Admin Wallet Credit');
    } else {
      return WalletService.debitBet(userId, amountPaise, `ADMIN-DEDUCT-${Date.now()}`, 'Admin Wallet Deduction');
    }
  }
}
