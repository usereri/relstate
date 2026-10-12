import { useEffect, useState } from "react";
import { Check, Lock } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import * as chain from "@/lib/chain";
import type { ProfileView } from "@/lib/chain";
import { useKycStatus } from "@/screens/Kyc";
import { useChain } from "@/lib/useChain";
import { cn } from "@/lib/utils";
import { Step, checklist, onboarded, openSteps, rememberOnboarded, wasOnboarded } from "./checklist";

interface Props {
  address: string | null;
  /** lease-mint balance in base units, or null when the wallet has no token account */
  balance: number | null;
  /** the profile the caller already reads; undefined while that read is in flight */
  profile: ProfileView | null | undefined;
}

/**
 * The new tenant's first five steps.
 *
 * A wallet that has already finished the list renders nothing *and reads nothing*: the inner
 * component, which is what polls the chain, is never mounted. That keeps the cost of this card on
 * the people it is for.
 */
export function OnboardingChecklist({ address, balance, profile }: Props) {
  const [finished, setFinished] = useState(() => !!address && wasOnboarded(address));
  useEffect(() => setFinished(!!address && wasOnboarded(address)), [address]);

  if (finished) return null;
  return <Steps address={address} balance={balance} profile={profile} onFinished={() => setFinished(true)} />;
}

function Steps({ address, balance, profile, onFinished }: Props & { onFinished: () => void }) {
  // "has applied" is a question about the chain: an open application, or a lease that came of one
  const applications = useChain(() => (address ? chain.loadApplications({ tenant: address }) : Promise.resolve([])), [address]);
  const leases = useChain(() => (address ? chain.loadLeases(address, "tenant") : Promise.resolve([])), [address]);

  // identity: done once the chain says so, a step to do when the identity service answers, otherwise "soon"
  const kycStatus = useKycStatus(address);
  const identity = kycStatus === undefined ? undefined : kycStatus.verified ? "done" : kycStatus.unavailable ? undefined : "todo";

  const waiting = !!address && (profile === undefined || applications === undefined || leases === undefined);
  const steps = checklist({
    signedIn: !!address,
    balance,
    applied: (applications?.length ?? 0) > 0 || (leases?.length ?? 0) > 0,
    rentPaid: (profile?.paidOnTime ?? 0) + (profile?.paidLate ?? 0) > 0,
    identity,
  });
  const done = onboarded(steps);

  useEffect(() => {
    if (!address || waiting || !done) return;
    rememberOnboarded(address);
    onFinished();
    // onFinished is the parent's setState; re-running this is a no-op
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [address, waiting, done]);

  // half a checklist is worse than none: say nothing until the reads are in
  if (waiting || done) return null;

  return <ChecklistCard steps={steps} />;
}

/** The card itself, given the steps. Presentational, so the preview page can show any state. */
export function ChecklistCard({ steps }: { steps: Step[] }) {
  const actionable = steps.filter((s) => s.state !== "soon");
  const complete = actionable.filter((s) => s.state === "done").length;
  const left = openSteps(steps).length;
  const next = steps.find((s) => s.state === "todo");

  return (
    <Card className="rise flex flex-col gap-4 p-5">
      <div className="flex flex-wrap items-end justify-between gap-2">
        <div>
          <p className="eyebrow">Getting started</p>
          <h2 className="mt-0.5 font-display text-xl font-semibold">
            {left === 1 ? "One step to your first key" : `${left} steps to your first key`}
          </h2>
        </div>
        <span className="font-mono text-xs text-muted-foreground">
          {complete}/{actionable.length} done
        </span>
      </div>
      <Progress value={(complete / actionable.length) * 100} />
      <ol className="flex flex-col gap-1">
        {steps.map((s, i) => (
          <Row key={s.id} step={s} number={i + 1} isNext={s.id === next?.id} />
        ))}
      </ol>
    </Card>
  );
}

function Row({ step, number, isNext }: { step: Step; number: number; isNext: boolean }) {
  return (
    <li className={cn("flex items-start gap-3 rounded-xl p-2.5 transition-colors", isNext && "bg-muted/70")}>
      <span
        className={cn(
          "grid size-6 shrink-0 place-items-center rounded-full text-[11px] font-semibold",
          step.state === "done"
            ? "bg-success-soft text-success"
            : step.state === "soon"
              ? "border border-dashed border-border text-muted-foreground"
              : isNext
                ? "bg-primary text-primary-foreground"
                : "border border-border text-muted-foreground",
        )}
      >
        {step.state === "done" ? <Check className="size-3.5" strokeWidth={3} /> : step.state === "soon" ? <Lock className="size-3" /> : number}
      </span>
      <div className="min-w-0">
        <p className={cn("flex flex-wrap items-center gap-2 text-sm font-medium", step.state === "done" && "text-muted-foreground")}>
          {step.label}
          {step.state === "soon" && <Badge variant="outline">Coming soon</Badge>}
          {isNext && <Badge variant="success">Next</Badge>}
        </p>
        <p className="text-xs text-muted-foreground">{step.detail}</p>
      </div>
    </li>
  );
}
