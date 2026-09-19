import { useRef, useState } from "react";
import { CheckCircle2, FileText, Upload, XCircle } from "lucide-react";
import { Doc, hashFile, sampleLease } from "@/lib/hash";
import { cn, short } from "@/lib/utils";

interface Props {
  label: string;
  hint: string;
  doc: Doc | null;
  onDoc: (doc: Doc | null) => void;
  /** tenant side: the fingerprint the landlord put on-chain */
  expectedHex?: string;
}

/** Attach the lease document. Only its SHA-256 goes on-chain; the file never leaves the device. */
export function DocPicker({ label, hint, doc, onDoc, expectedHex }: Props) {
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);

  const pick = async (load: () => Promise<Doc>) => {
    setBusy(true);
    try {
      onDoc(await load());
    } finally {
      setBusy(false);
    }
  };

  const verdict = doc && expectedHex ? (doc.hex === expectedHex ? "match" : "mismatch") : null;

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-baseline justify-between">
        <span className="text-sm font-semibold">{label}</span>
        <button
          type="button"
          onClick={() => pick(sampleLease)}
          className="min-h-11 px-1 text-sm font-medium text-accent underline underline-offset-4"
        >
          Use sample lease
        </button>
      </div>

      <input
        ref={input}
        type="file"
        accept=".pdf,.txt,.doc,.docx,image/*"
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) pick(() => hashFile(f, f.name));
          e.target.value = "";
        }}
      />

      <button
        type="button"
        onClick={() => input.current?.click()}
        className={cn(
          "flex min-h-24 w-full items-center gap-4 rounded-2xl border-2 border-dashed p-4 text-left transition-colors",
          !doc && "border-input bg-card/60 hover:bg-secondary/40",
          verdict === "mismatch" && "border-destructive/50 bg-[#f6e4df]",
          (verdict === "match" || (doc && !expectedHex)) && "border-success/50 bg-[#eef2e4]",
        )}
      >
        <span className="grid size-12 shrink-0 place-items-center rounded-xl bg-secondary text-primary">
          {doc ? <FileText className="size-6" /> : <Upload className="size-6" />}
        </span>
        <span className="min-w-0 flex-1">
          {doc ? (
            <>
              <span className="block truncate font-medium">{doc.name}</span>
              <span className="block text-xs text-muted-foreground">
                {(doc.size / 1024).toFixed(1)} KB · SHA-256 <span className="font-mono">{short(doc.hex, 6)}</span>
              </span>
            </>
          ) : (
            <>
              <span className="block font-medium">{busy ? "Reading…" : "Tap to attach the lease"}</span>
              <span className="block text-xs text-muted-foreground">{hint}</span>
            </>
          )}
        </span>
      </button>

      {verdict === "match" && (
        <p className="flex items-center gap-1.5 text-sm font-medium text-success">
          <CheckCircle2 className="size-4" /> Matches the document the landlord proposed
        </p>
      )}
      {verdict === "mismatch" && (
        <p className="flex items-center gap-1.5 text-sm font-medium text-destructive">
          <XCircle className="size-4" /> This is not the proposed document. Ask the landlord for the right file.
        </p>
      )}
      <p className="text-xs text-muted-foreground">
        The file stays on your device. Only its fingerprint is written on-chain.
      </p>
    </div>
  );
}
