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
}
