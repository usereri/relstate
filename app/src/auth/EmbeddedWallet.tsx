// The email-login state machine, shared by the sign-up page and the app shell.
//
// Two things happen when someone signs in with an email: the provider gives us a wallet, and the
// backend gives that wallet a session token (contract 2 — `POST /api/sponsor` is session
// authenticated). The second is what makes a 0-SOL wallet able to transact at all, so it is part of
// signing in rather than something the first transaction discovers.

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { SPONSORED } from "@/lib/sponsor";
import { activeBackend } from "./backends";
import { clearSession, obtainSession, registerSigner } from "./session";
import { looksLikeEmail, type EmbeddedBackend, type EmbeddedStatus, type Role, type WalletProvider } from "./backend";

export interface EmbeddedWalletState {
  /** Null when `VITE_EMBEDDED_WALLET*` configures no provider; `reason` then says why. */
  backend: EmbeddedBackend | null;
  reason: string | null;
  status: EmbeddedStatus;
  email: string | null;
  wallet: WalletProvider | null;
  address: string | null;
  /** A failure the user caused or must act on (bad address, wrong code, provider down). */
  error: string | null;
  /** The wallet is usable but the backend would not issue a session, so sponsored sends will fail. */
  sessionError: string | null;
  /** Begin: emails a code, or goes straight to a wallet, depending on the provider. */
  start(email: string): void;
  /** Finish a login that sent a code. */
  submitCode(code: string): void;
  signOut(): void;
}

const message = (e: unknown): string => (e instanceof Error && e.message ? e.message : "Something went wrong");

/** Keeps "Creating your account…" on screen long enough to read when the work is instant. */
const MIN_VISIBLE_MS = 450;
const atLeast = async <T,>(ms: number, work: Promise<T>): Promise<T> => {
  const [value] = await Promise.all([work, new Promise((r) => setTimeout(r, ms))]);
  return value;
};

const Context = createContext<EmbeddedWalletState | null>(null);

export function EmbeddedWalletProvider({ role, children }: { role: Role; children: React.ReactNode }) {
  const { backend, reason } = useMemo(() => activeBackend(), []);
  const [status, setStatus] = useState<EmbeddedStatus>("idle");
  const [email, setEmail] = useState<string | null>(null);
  const [wallet, setWallet] = useState<WalletProvider | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sessionError, setSessionError] = useState<string | null>(null);

  // Role is per tab and can change under us (the account menu switches role), so ignore anything
  // still in flight for the role we have left.
  const current = useRef(role);
  useEffect(() => {
    current.current = role;
  }, [role]);

  /**
   * Exchanges the wallet for a backend session. A failure here does not undo the login: the wallet
   * is real, reads and the profile work, and `postSponsored` reports the missing session itself —
   * better than refusing to sign in because the backend happens to be down.
   */
  const link = useCallback(async (w: WalletProvider) => {
    if (!SPONSORED) return null;
    try {
      registerSigner(w.publicKey.toBase58(), w.signMessage);
      await obtainSession(w.publicKey.toBase58());
      return null;
    } catch (e) {
      return message(e);
    }
  }, []);

  const adopt = useCallback(
    async (w: WalletProvider, forRole: Role) => {
      setStatus("linking");
      const failed = await link(w);
      if (current.current !== forRole) return;
      setSessionError(failed);
      setWallet(w);
      setStatus("ready");
    },
    [link],
  );

  // Resume a prior sign-in, so a reload or a route change does not ask for the email again.
  useEffect(() => {
    if (!backend) return;
    let live = true;
    const forRole = role;
    setStatus("idle");
    setWallet(null);
    setError(null);
    setSessionError(null);
    backend
      .restore(forRole)
      .then((w) => {
        if (!live || !w) return;
        void adopt(w, forRole);
      })
      .catch(() => {
        /* nothing to resume is the normal case, not an error worth showing */
      });
    return () => {
      live = false;
    };
  }, [backend, role, adopt]);

  const start = useCallback(
    (typed: string) => {
      if (!backend) return;
      const forRole = role;
      setError(null);
      if (!looksLikeEmail(typed)) {
        setError("That does not look like an email address.");
        setStatus("error");
        return;
      }
      setEmail(typed.trim().toLowerCase());
      setStatus(backend.needsCode ? "sending" : "creating");
      atLeast(MIN_VISIBLE_MS, backend.start(typed, forRole))
        .then((w) => {
          if (current.current !== forRole) return;
          if (w) return adopt(w, forRole);
          setStatus("code");
        })
        .catch((e) => {
          if (current.current !== forRole) return;
          setError(message(e));
          setStatus("error");
        });
    },
    [backend, role, adopt],
  );

  const submitCode = useCallback(
    (code: string) => {
      if (!backend) return;
      const forRole = role;
      setError(null);
      setStatus("creating");
      atLeast(MIN_VISIBLE_MS, backend.submitCode(code, forRole))
        .then((w) => {
          if (current.current !== forRole) return;
          return adopt(w, forRole);
        })
        .catch((e) => {
          if (current.current !== forRole) return;
          setError(message(e));
          // Back to the code field: a mistyped code is the common case.
          setStatus("code");
        });
    },
    [backend, role, adopt],
  );

  const signOut = useCallback(() => {
    if (!backend) return;
    const address = wallet?.publicKey.toBase58();
    if (address) clearSession(address);
    setWallet(null);
    setEmail(null);
    setError(null);
    setSessionError(null);
    setStatus("idle");
    backend.signOut(role).catch(() => {
      /* the local state is already gone; a provider that fails to log out is not worth blocking on */
    });
  }, [backend, role, wallet]);

  const value = useMemo<EmbeddedWalletState>(
    () => ({
      backend,
      reason,
      status,
      email,
      wallet,
      address: wallet?.publicKey.toBase58() ?? null,
      error,
      sessionError,
      start,
      submitCode,
      signOut,
    }),
    [backend, reason, status, email, wallet, error, sessionError, start, submitCode, signOut],
  );

  return <Context.Provider value={value}>{children}</Context.Provider>;
}

/** Null outside a provider, so a screen can be rendered without one. */
export const useEmbeddedWallet = (): EmbeddedWalletState | null => useContext(Context);
