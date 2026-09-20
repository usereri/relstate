import { useMemo, useState } from "react";
import { Check, ChevronDown, Copy, LogOut, Wallet } from "lucide-react";
import { WalletReadyState } from "@solana/wallet-adapter-base";
import { useWallet } from "@solana/wallet-adapter-react";
import * as chain from "@/lib/chain";
import { Button } from "@/components/ui/button";
import { short, usdc } from "@/lib/utils";

/** The signer for every transaction: null until a wallet is connected. */
export function useMe(): chain.Me | null {
  const { publicKey, signTransaction, signAllTransactions } = useWallet();
  return useMemo(
    () => (publicKey && signTransaction && signAllTransactions ? chain.makeMe({ publicKey, signTransaction, signAllTransactions }) : null),
    [publicKey, signTransaction, signAllTransactions],
  );
}

export function WalletButton({ balances }: { balances?: { sol: number; usdc: number | null } }) {
  const { wallets, select, connecting, publicKey, disconnect, wallet } = useWallet();
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const installed = wallets.filter((w) => w.readyState === WalletReadyState.Installed);

  if (publicKey) {
    const address = publicKey.toBase58();
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
          {wallet?.adapter.icon ? <img src={wallet.adapter.icon} alt="" className="size-5 rounded" /> : <Wallet className="size-4" />}
          <span className="leading-tight">
            <span className="flex items-center gap-1.5 font-mono text-xs font-medium">
              {short(address, 4)} {copied ? <Check className="size-3.5 text-success" /> : <Copy className="size-3.5 text-muted-foreground" />}
            </span>
            <span className="block text-[11px] tabular-nums text-muted-foreground">
              {balances ? `${balances.sol.toFixed(2)} SOL · ${balances.usdc === null ? "no USDC account" : `${usdc(balances.usdc)} USDC`}` : "…"}
            </span>
          </span>
        </button>
        <Button variant="ghost" size="sm" aria-label="Disconnect wallet" title="Disconnect" onClick={() => disconnect()}>
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
        <div className="absolute right-0 z-30 mt-2 w-72 rounded-2xl border bg-card p-2 shadow-lg">
          {installed.length === 0 ? (
            <p className="p-3 text-sm text-muted-foreground">
              No Solana wallet found in this browser. Install{" "}
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
