import { AuthService } from '../auth/auth.service';
import { WalletService } from '../wallet/wallet.service';

export class UserService {
  public static async getUserOverview(userId: string) {
    const user = AuthService.getUserById(userId);
    const balance = await WalletService.getBalance(userId);
    return {
      user,
      balance
    };
  }

  public static async getAllUsers() {
    const users = AuthService.getAllUsers();
    return await Promise.all(
      users.map(async (u) => ({
        ...u,
        balance: await WalletService.getBalance(u.id)
      }))
    );
  }

  public static toggleBan(userId: string, isBanned: boolean) {
    return AuthService.toggleBanStatus(userId, isBanned);
  }

  public static async adjustWallet(userId: string, type: 'ADD' | 'DEDUCT', amountRupees: number) {
    const amountPaise = Math.round(amountRupees * 100);
    if (type === 'ADD') {
      return await WalletService.creditDeposit(userId, amountPaise, `ADMIN-ADD-${Date.now()}`, 'Admin Wallet Credit');
    } else {
      return await WalletService.debitBet(userId, amountPaise, `ADMIN-DEDUCT-${Date.now()}`, 'Admin Wallet Deduction');
    }
  }
}
