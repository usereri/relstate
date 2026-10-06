import { createContext, useContext, useEffect, useMemo, useState } from "react";
import { PrivyProvider, usePrivy } from "@privy-io/react-auth";
import { useSignMessage, useWallets } from "@privy-io/react-auth/solana";
import * as anchor from "@anchor-lang/core";
import * as chain from "@/lib/chain";
import { loadSponsor, SPONSOR_URL } from "@/lib/sponsor";

export const PRIVY_APP_ID: string | undefined = import.meta.env.VITE_PRIVY_APP_ID;

interface PrivyState {
  enabled: boolean;
  ready: boolean;
  email?: string;
  login: () => void;
  logout: () => void;
  me: chain.Me | null;
  address?: string;
}

const off: PrivyState = { enabled: false, ready: true, login: () => {}, logout: () => {}, me: null };
const PrivyContext = createContext<PrivyState>(off);
export const usePrivyWallet = () => useContext(PrivyContext);

/** Email login with an embedded Solana wallet. Without VITE_PRIVY_APP_ID it renders nothing extra. */
export function PrivyWalletProvider({ children }: { children: React.ReactNode }) {
  if (!PRIVY_APP_ID) return <>{children}</>;
  return (
    <PrivyProvider
      appId={PRIVY_APP_ID}
      config={{
        loginMethods: ["email"],
        embeddedWallets: { solana: { createOnLogin: "users-without-wallets" } },
      }}
    >
      <Bridge>{children}</Bridge>
    </PrivyProvider>
  );
}

function Bridge({ children }: { children: React.ReactNode }) {
  const { ready, authenticated, login, logout, user } = usePrivy();
  const { wallets } = useWallets();
  const { signMessage } = useSignMessage();
  const [sponsor, setSponsor] = useState<chain.Sponsor>();

  useEffect(() => {
    if (SPONSOR_URL) loadSponsor().then(setSponsor, () => setSponsor(undefined));
  }, []);

  const wallet = authenticated ? wallets.find((w) => w.standardWallet.name === "Privy") : undefined;

  const me = useMemo(() => {
    if (!wallet || (SPONSOR_URL && !sponsor)) return null;
    const publicKey = new anchor.web3.PublicKey(wallet.address);
    // Privy signs the serialized message; the signature slot is filled in without ever exposing a key.
    const sign = async <T extends anchor.web3.Transaction | anchor.web3.VersionedTransaction>(tx: T): Promise<T> => {
      if ("version" in tx) throw new Error("Only legacy transactions are supported");
      const { signature } = await signMessage({ message: tx.serializeMessage(), wallet });
      tx.addSignature(publicKey, Buffer.from(signature));
      return tx;
    };
    return chain.makeMe({ publicKey, signTransaction: sign, signAllTransactions: (txs) => Promise.all(txs.map(sign)) }, sponsor);
  }, [wallet, sponsor, signMessage]);

  const value: PrivyState = { enabled: true, ready, email: user?.email?.address, login, logout, me, address: wallet?.address };
  return <PrivyContext.Provider value={value}>{children}</PrivyContext.Provider>;
}
