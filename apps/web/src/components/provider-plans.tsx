import { dayMs, type ProviderPlan, providerPlans } from "@relayrunner/providers";

const dayText = (day: string) =>
  new Date(dayMs(day)).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  });

/** "$0.004/min", with as many digits as the price needs; "—" when unknown. */
export const perMinuteText = (usd: number | null) =>
  usd === null ? "—" : `$${Number(usd.toPrecision(3))}/min`;

const feeText = ({ feeUsd }: ProviderPlan) =>
  feeUsd === null ? "Contact sales" : feeUsd ? `$${feeUsd.toLocaleString("en-US")}` : "No fee";

/** Every plan a provider sells for GitHub Actions, for its page. Nothing when it has none. */
export function ProviderPlans({ provider }: { provider: string }) {
  const info = providerPlans(provider);
  if (!info) return null;
  const { plans, limitsLabel, note, source, checked } = info;
  const fees = plans.some((plan) => plan.feeUsd !== undefined);
  return (
    <div className="grid max-w-3xl gap-3">
      <div className="grid gap-0.5">
        <h2 className="font-semibold">Plans</h2>
        {note && <p className="text-sm text-muted-foreground">{note}</p>}
      </div>
      <div className="overflow-x-auto rounded-xl border bg-card">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b text-left text-xs text-muted-foreground">
              <th className="px-4 py-2.5 font-medium">Plan</th>
              {fees && <th className="px-4 py-2.5 text-right font-medium">Monthly</th>}
              <th className="px-4 py-2.5 font-medium">Included</th>
              {limitsLabel && <th className="px-4 py-2.5 font-medium">{limitsLabel}</th>}
            </tr>
          </thead>
          <tbody>
            {plans.map((plan) => (
              <tr key={plan.name} className="border-b last:border-0">
                <td className="px-4 py-2.5 font-medium whitespace-nowrap">{plan.name}</td>
                {fees && (
                  <td className="px-4 py-2.5 text-right whitespace-nowrap tabular-nums">
                    {feeText(plan)}
                  </td>
                )}
                <td className="px-4 py-2.5 whitespace-nowrap text-ink-2">{plan.included}</td>
                {limitsLabel && (
                  <td className="px-4 py-2.5 whitespace-nowrap text-ink-2 tabular-nums">
                    {plan.limits ?? "—"}
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="text-xs text-muted-foreground">
        From{" "}
        <a href={source} target="_blank" rel="noreferrer" className="underline">
          the provider's pricing
        </a>
        , checked {dayText(checked)}.
      </p>
    </div>
  );
}
