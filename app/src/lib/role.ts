import type { Role } from "@/lib/chain";

// Which role this browser tab is acting as.
//
// The role is the user's choice, kept per tab in sessionStorage (two tabs can be two people) and
// changed from the header's role switch. There is deliberately no cookie: the app is a static site
// with no server to read one, and the backend session is a bearer token the app sends itself
// (docs/env-checklist.md, "Role and session").
//
// `?role=landlord|tenant` is a demo/testing override only. It wins over everything on first load
// so a script or a README step can open two tabs as two people, is adopted as the tab's choice, and
// is dropped from the address bar as soon as the user switches role. Nothing in the UI ever writes
// it into a link.

export const ROLE_KEY = "relstate.role";
export const ROLES_LIST: Role[] = ["tenant", "landlord"];

export const asRole = (v: unknown): Role | null => (v === "landlord" || v === "tenant" ? v : null);

type Store = Pick<Storage, "getItem" | "setItem" | "removeItem">;
const session = (): Store | null => {
  try {
    return globalThis.sessionStorage ?? null;
  } catch {
    return null;
  }
};
const local = (): Store | null => {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
};

/** The demo/testing override, or null. */
export const roleOverride = (search: string): Role | null => asRole(new URLSearchParams(search).get("role"));

/** The role this tab last chose, or null (also when storage is unavailable). */
export function readTabRole(store: Store | null = session()): Role | null {
  try {
    return asRole(store?.getItem(ROLE_KEY));
  } catch {
    return null;
  }
}

export function writeTabRole(r: Role | null, store: Store | null = session()): void {
  try {
    if (r) store?.setItem(ROLE_KEY, r);
    else store?.removeItem(ROLE_KEY);
  } catch {
    /* private mode: the role is simply derived or asked again on reload */
  }
}

/**
 * The role a signed-in browser implies: the one role that still has a wallet session. With none, or
 * with both (one person signed in as both), nothing is implied and the user is asked.
 */
export function derivedRole(store: Store | null = local()): Role | null {
  const has = ROLES_LIST.filter((r) => {
    try {
      return !!store?.getItem(`relstate.wallet.${r}`);
    } catch {
      return false;
    }
  });
  return has.length === 1 ? has[0]! : null;
}

/** Override, then the tab's own choice, then what the signed-in wallet implies. */
export const initialRole = (search: string, tab: Store | null = session(), persisted: Store | null = local()): Role | null =>
  roleOverride(search) ?? readTabRole(tab) ?? derivedRole(persisted);

/** Drops `?role=` from the address bar once the user has chosen for themselves. */
export function dropRoleOverride(): void {
  try {
    const u = new URL(location.href);
    if (!u.searchParams.has("role")) return;
    u.searchParams.delete("role");
    history.replaceState(history.state, "", `${u.pathname}${u.search}${u.hash}`);
  } catch {
    /* no history API: the override stays, harmlessly, until reload */
  }
}
