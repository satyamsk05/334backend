export interface User {
  id: string;
  phone: string;
  name: string;
  avatarUrl?: string;
  isBanned: boolean;
  createdAt: number;
  updatedAt: number;
}
