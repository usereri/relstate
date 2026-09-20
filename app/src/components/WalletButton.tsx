import { createContext, useContext, useMemo, useState } from "react";
import { Check, ChevronDown, Copy, FlaskConical, LogOut, Wallet } from "lucide-react";
import { WalletReadyState } from "@solana/wallet-adapter-base";
import { useWallet } from "@solana/wallet-adapter-react";
import * as chain from "@/lib/chain";
import { Role } from "@/lib/chain";
import { Button } from "@/components/ui/button";
import { short, usdc } from "@/lib/utils";

// The built-in test wallet (local networks only) is chosen per tab, like the role.
const LOCAL_KEY = (role: Role) => `relstate.localWallet.${role}`;
const storedLocal = (role: Role) => {
  try {
    return chain.LOCAL_WALLETS_AVAILABLE && sessionStorage.getItem(LOCAL_KEY(role)) === "1";
  } catch {
    return false;
  }
};

const LocalContext = createContext<{ role: Role; on: boolean; set: (on: boolean) => void }>({ role: "landlord", on: false, set: () => {} });

export function LocalWalletProvider({ role, children }: { role: Role; children: React.ReactNode }) {
  const [on, setOn] = useState(() => storedLocal(role));
  const set = (v: boolean) => {
    try {
      if (v) sessionStorage.setItem(LOCAL_KEY(role), "1");
      else sessionStorage.removeItem(LOCAL_KEY(role));
    } catch {
      /* private mode: the choice is simply forgotten on reload */
    }
    setOn(v);
  };
  return <LocalContext.Provider value={{ role, on, set }}>{children}</LocalContext.Provider>;
}

/** The signer for every transaction: null until a wallet is connected. */
export function useMe(): chain.Me | null {
  const local = useContext(LocalContext);
  const { publicKey, signTransaction, signAllTransactions } = useWallet();
  return useMemo(() => {
    if (local.on) return chain.makeMe(chain.localWallet(local.role));
    return publicKey && signTransaction && signAllTransactions ? chain.makeMe({ publicKey, signTransaction, signAllTransactions }) : null;
  }, [local.on, local.role, publicKey, signTransaction, signAllTransactions]);
}

export function WalletButton({ balances }: { balances?: { sol: number; usdc: number | null } }) {
  const { wallets, select, connecting, publicKey, disconnect, wallet } = useWallet();
  const local = useContext(LocalContext);
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const installed = wallets.filter((w) => w.readyState === WalletReadyState.Installed);

  const address = local.on ? chain.localKeypair(local.role).publicKey.toBase58() : publicKey?.toBase58();
  if (address) {
    return (
      <div className="flex items-center gap-2">
        <button
          title="Copy full address"
          onClick={() => {
            navigator.clipboard?.writeText(address);
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          }}
          className="flex h-11 items-center gap-2.5 rounded-xl border bg-card px-3 text-left transition-colors hover:bg-secondary/60"
        >
          {local.on ? (
            <FlaskConical className="size-4" />
          ) : wallet?.adapter.icon ? (
            <img src={wallet.adapter.icon} alt="" className="size-5 rounded" />
          ) : (
            <Wallet className="size-4" />
          )}
          <span className="leading-tight">
            <span className="flex items-center gap-1.5 font-mono text-xs font-medium">
              {short(address, 4)} {copied ? <Check className="size-3.5 text-success" /> : <Copy className="size-3.5 text-muted-foreground" />}
              {local.on && <span className="font-sans text-[10px] font-semibold uppercase tracking-wider text-accent">test wallet</span>}
            </span>
            <span className="block text-[11px] tabular-nums text-muted-foreground">
              {balances ? `${balances.sol.toFixed(2)} SOL · ${balances.usdc === null ? "no USDC account" : `${usdc(balances.usdc)} USDC`}` : "…"}
            </span>
          </span>
        </button>
        <Button
          variant="ghost"
          size="sm"
          aria-label="Disconnect wallet"
          title="Disconnect"
          onClick={() => (local.on ? local.set(false) : disconnect())}
        >
          <LogOut />
        </Button>
      </div>
    );
  }

  return (
    <div className="relative">
      <Button onClick={() => setOpen((o) => !o)} disabled={connecting}>
        <Wallet /> {connecting ? "Connecting…" : "Connect wallet"} <ChevronDown />
      </Button>
      {open && (
        <div className="absolute right-0 z-30 mt-2 w-80 rounded-2xl border bg-card p-2 shadow-lg">
          {chain.LOCAL_WALLETS_AVAILABLE && (
            <button
              onClick={() => {
                local.set(true);
                setOpen(false);
              }}
              className="flex min-h-11 w-full items-start gap-3 rounded-xl px-3 py-2 text-left hover:bg-secondary/60"
            >
              <FlaskConical className="mt-0.5 size-5 shrink-0 text-accent" />
              <span className="text-sm">
                <span className="block font-medium">Test wallet ({local.role})</span>
                <span className="block text-xs text-muted-foreground">
                  Built into this local network: no extension, and each tab or role is a different person.
                </span>
              </span>
            </button>
          )}
          {installed.length === 0 ? (
            <p className="p-3 text-sm text-muted-foreground">
              No Solana wallet extension found in this browser. Install{" "}
              <a className="text-accent underline" href="https://phantom.com/download" target="_blank" rel="noreferrer">
                Phantom
              </a>{" "}
              or Solflare, then reload.
            </p>
          ) : (
            installed.map((w) => (
              <button
                key={w.adapter.name}
                onClick={() => {
                  select(w.adapter.name);
                  setOpen(false);
                }}
                className="flex min-h-11 w-full items-center gap-3 rounded-xl px-3 text-sm font-medium hover:bg-secondary/60"
              >
                <img src={w.adapter.icon} alt="" className="size-6 rounded" /> {w.adapter.name}
              </button>
            ))
          )}
        </div>
      )}
    </div>
  );
}
