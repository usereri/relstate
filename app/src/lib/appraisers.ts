// Appraisal company names, app half (docs/contracts/dispute-mediation.md §4, revision 2).
//
// Revision 2 of the contract has no registry: no `Appraiser` account, no admin-maintained
// directory, nothing to look up. A candidate is a company NAME a party types, and the only thing
// the program ever compares is `sha256(canonical(name))`. So this module is no longer a directory
// client — it is the app's MIRROR of the program's own name rules (`display_name`, `is_invisible`
// and `name_hash` in programs/relstate/src/state.rs).
//
// It mirrors, it does not decide. The program re-does every check and refuses what it dislikes
// (`InvalidAppraiserName`). What the mirror buys is two things: somebody typing a company name
// learns why it cannot be used before a transaction is spent finding out, and the app can say
// WHICH candidate the chain's `agreed_name_hash` names without asking a backend for anything.
//
// Free of React, of web3.js and of `chain.ts`, so every rule here is testable on its own.
import { sha256 } from "@noble/hashes/sha2";
import idl from "@target/idl/relstate.json";
import { safeName } from "@/lib/utils";

type IdlArrayType = { array?: [unknown, number] };
type IdlTypeDef = { name: string; type: { kind: string; fields?: { name: string; type: IdlArrayType | string }[] } };

/**
 * A fixed-size array's length, straight off the IDL.
 *
 * `MAX_NAME_LEN` and `MAX_CANDIDATES` are not `#[constant]`, so they never reach `idl.constants` —
 * but the account layout states both: a name is `[u8; MAX_NAME_LEN]` and each side's list is
 * `[Candidate; MAX_CANDIDATES]`. Reading them from there is what makes a program that grew a
 * fourth slot, or a longer name, move the app with it instead of leaving a mirror that quietly
 * disagrees with the chain.
 */
function arrayLen(typeName: string, fieldName: string): number {
  const def = (idl as unknown as { types: IdlTypeDef[] }).types.find((t) => t.name === typeName);
  const field = def?.type.fields?.find((f) => f.name === fieldName);
  const array = typeof field?.type === "object" ? field.type.array : undefined;
  if (!array) throw new Error(`the IDL's ${typeName}.${fieldName} is not a fixed-size array`);
  return array[1];
}

/** Bytes of the normalised display name the program stores. Longer is `InvalidAppraiserName`. */
export const MAX_NAME_LEN = arrayLen("Candidate", "name");

/** How many companies one side may put forward, in its single `propose_appraisers` call. */
export const MAX_CANDIDATES = arrayLen("Dispute", "landlord_candidates");

/**
 * The program's `display_name`: trim, and collapse every run of whitespace to one space.
 *
 * Whitespace is the Unicode `White_Space` property, which is what Rust's `split_whitespace` uses,
 * so a no-break space between two words is the same company as a plain one. `\p{White_Space}` is
 * that exact set; JavaScript's `\s` is NOT (it omits U+0085 and includes U+FEFF), and both of
 * those differences are characters {@link nameProblem} refuses anyway.
 */
export const displayName = (raw: string): string => raw.split(/\p{White_Space}+/u).filter(Boolean).join(" ");

/**
 * Unicode format and bidi-control code points: exactly the ranges the program's `is_invisible`
 * lists, in the same order.
 *
 * They render as nothing, or reorder what is around them, so two rows a person cannot tell apart
 * would carry different hashes — which decides which fee is agreed and which company the
 * invitation is sent to (review G6). Whitespace-class separators (NBSP, U+2028, U+3000) are
 * absent on purpose: {@link displayName} has already collapsed those to a plain space.
 */
const INVISIBLE =
  /[­؀-؅؜۝܏᠎​-‏‪-‮⁠-⁤⁦-⁯﻿￹-￻\u{E0001}\u{E0020}-\u{E007F}]/u;

/** The program measures the name in BYTES of UTF-8, so "Łódź" is eight of the sixty-four. */
export const nameBytes = (s: string): number => new TextEncoder().encode(s).length;

/**
 * Why the program would refuse this name, in words somebody can act on, or null when it would be
 * accepted. Branch for branch, this is `display_name`'s single `require!` (`InvalidAppraiserName`).
 */
export function nameProblem(raw: string): string | null {
  const display = displayName(raw);
  if (!display) return "Type the appraisal company's name.";
  const bytes = nameBytes(display);
  if (bytes > MAX_NAME_LEN)
    return `That name takes ${bytes} characters of storage and the limit is ${MAX_NAME_LEN}. Shorten it — the legal form ("sp. z o.o.") can be left off.`;
  if (/\p{Cc}/u.test(display)) return "That name contains a control character. Retype it rather than pasting it.";
  if (INVISIBLE.test(display))
    return "That name contains an invisible character, so two different companies could look identical on screen. Retype it by hand rather than pasting it.";
  return null;
}

const hex = (bytes: Uint8Array): string => Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");

/**
 * `ascii_lowercase`, never `toLowerCase()`.
 *
 * The program folds ASCII only and normalises nothing, so "Wycena Łódź" and "WYCENA ŁÓDŹ" are two
 * different companies to it. An app that folded Unicode here would show the two rows as one name
 * and then watch the pick fail with `CandidateNotProposed`.
 */
export const canonicalName = (display: string): string => display.replace(/[A-Z]/g, (c) => c.toLowerCase());

/**
 * `sha256(canonical(display_name(raw)))` as lower-case hex: the one value the program compares, and
 * the one the `Dispute` account stores next to each name.
 */
export const nameHashHex = (raw: string): string => hex(sha256(new TextEncoder().encode(canonicalName(displayName(raw)))));

/** Two names are the same company exactly when their hashes match — nothing else is compared. */
export const sameCompany = (a: string, b: string): boolean => nameHashHex(a) === nameHashHex(b);

/**
 * A name read back off the chain, made safe to put next to an amount.
 *
 * The program rejects control and invisible characters, so for every name it accepted this is the
 * identity. It stays because a display string that sits beside money should not depend on a remote
 * program's validation being what this app believes it to be — and the cap is `MAX_NAME_LEN`, not
 * `safeName`'s shorter default, so a name the program accepted is never truncated with an ellipsis
 * on the step where somebody confirms it.
 */
export const companyName = (stored: string): string => safeName(stored, MAX_NAME_LEN);
