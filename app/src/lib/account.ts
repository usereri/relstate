import { Role } from "@/lib/chain";

/**
 * Off-chain account details (display name, email, city). They live in this browser only and are
 * never written to the chain: the on-chain profile is keyed by the wallet and holds only the record.
 */
export interface Account {
  name: string;
  email: string;
  city: string;
  role: Role;
  createdAt: number;
}

const key = (address: string) => `relstate.account.${address}`;

export const loadAccount = (address: string): Account | null => {
  try {
    const raw = localStorage.getItem(key(address));
    return raw ? (JSON.parse(raw) as Account) : null;
  } catch {
    return null;
  }
};

export const saveAccount = (address: string, a: Account) => {
  try {
    localStorage.setItem(key(address), JSON.stringify(a));
  } catch {
    /* private mode: the name is simply asked again next time */
  }
};

export const initials = (name: string) =>
  name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]!.toUpperCase())
    .join("") || "?";
