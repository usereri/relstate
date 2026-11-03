import type { ProfileView } from "@/lib/chain";

export const profile = (over: Partial<ProfileView> = {}): ProfileView => ({
  leasesCompleted: 0,
  paidOnTime: 0,
  paidLate: 0,
  defaults: 0,
  depositsReturnedFull: 0,
  depositsClaimed: 0,
  depositTotal: 0,
  deductedTotal: 0,
  rentPaidTotal: 0,
  ...over,
});
