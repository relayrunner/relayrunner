import { isProviderId, PROVIDERS } from "@relayrunner/providers";
import { createFileRoute } from "@tanstack/react-router";
import { Trash2Icon } from "lucide-react";
import { type FormEvent, useState } from "react";
import { PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { addPrice, listPrices, removePrice, type AdminRate } from "@/lib/admin";
import { ApiError } from "@/lib/api";
import { rateText } from "@/lib/providers";

// Operator admin, behind Cloudflare Access and an operator session
// (apps/api/src/routes/admin-prices.ts).
export const Route = createFileRoute("/_authed/_workspace/admin/prices")({
  loader: () => listPrices(),
  component: PricesPage,
  errorComponent: ({ error }) => (
    <PageHeader title="Prices">
      Couldn't load prices: {error instanceof Error ? error.message : String(error)}
    </PageHeader>
  ),
});

const providerName = (id: string) => (isProviderId(id) ? PROVIDERS[id].name : id);
const rateKey = (rate: Pick<AdminRate, "provider" | "rate">) => `${rate.provider}:${rate.rate}`;
const perText = (rate: AdminRate) => (rate.per === "vcpu" ? " per vCPU" : "");

const ERRORS: Record<string, string> = {
  price_exists: "That rate already has a price from that day. Remove it first to correct it.",
  invalid_price: "Check the price and date.",
};

function PricesPage() {
  const loaded = Route.useLoaderData();
  const [rates, setRates] = useState(loaded.rates);
  const [notice, setNotice] = useState<string | null>(null);

  async function reload(message: string) {
    setRates((await listPrices()).rates);
    setNotice(message);
  }

  async function remove(rate: AdminRate, id: string, from: string) {
    setNotice(null);
    await removePrice(id);
    await reload(`Removed the ${providerName(rate.provider)} ${rate.rate} price from ${from}.`);
  }

  return (
    <section className="grid max-w-5xl gap-6">
      <PageHeader title="Prices">
        List prices for each provider's runners, by the day they took effect. Jobs are priced at the
        rate on the day they ran, and a price added here applies right away.
      </PageHeader>

      <AddPrice
        rates={rates}
        onAdded={(rate, from) =>
          reload(`Added a ${providerName(rate.provider)} ${rate.rate} price from ${from}.`)
        }
      />

      {notice && (
        <p role="status" className="text-sm text-muted-foreground">
          {notice}
        </p>
      )}

      <div className="overflow-x-auto rounded-xl border bg-card">
        <table className="w-full text-sm">
          <thead className="text-left text-muted-foreground">
            <tr className="border-b">
              <th className="px-4 py-2 font-medium">Provider</th>
              <th className="px-4 py-2 font-medium">Rate</th>
              <th className="px-4 py-2 font-medium">Today</th>
              <th className="px-4 py-2 font-medium">History</th>
            </tr>
          </thead>
          <tbody>
            {rates.map((rate) => (
              <tr key={rateKey(rate)} className="border-b align-top last:border-0">
                <td className="px-4 py-3 font-medium">{providerName(rate.provider)}</td>
                <td className="px-4 py-3 font-mono text-xs">{rate.rate}</td>
                <td className="px-4 py-3 whitespace-nowrap tabular-nums">
                  {rateText(rate.current)}
                  {perText(rate)}
                </td>
                <td className="px-4 py-3">
                  <ul className="grid gap-1">
                    {rate.rows.map((row) => (
                      <li
                        key={row.id ?? `base:${row.from}`}
                        className="flex flex-wrap items-center gap-x-2"
                      >
                        <span className="tabular-nums">
                          {row.from}: {rateText(row.usd)}
                        </span>
                        <span className="text-muted-foreground">
                          {row.id ? `added by ${row.createdBy}` : "in code"}
                        </span>
                        {row.source && (
                          <a
                            href={row.source.startsWith("http") ? row.source : undefined}
                            className="truncate text-muted-foreground underline-offset-2 hover:underline"
                            title={row.source}
                          >
                            source
                          </a>
                        )}
                        {row.id && (
                          <Button
                            size="icon-sm"
                            variant="ghost"
                            aria-label={`Remove the price from ${row.from}`}
                            onClick={() => remove(rate, row.id!, row.from)}
                          >
                            <Trash2Icon aria-hidden />
                          </Button>
                        )}
                      </li>
                    ))}
                  </ul>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

// A new price as the provider lists it: a runner's price a minute and, for per-vCPU rates, how
// many vCPUs that runner has. Stored per vCPU.
function AddPrice({
  rates,
  onAdded,
}: {
  rates: AdminRate[];
  onAdded: (rate: AdminRate, from: string) => Promise<void>;
}) {
  const [key, setKey] = useState("");
  const [price, setPrice] = useState("");
  const [vcpus, setVcpus] = useState("2");
  const [from, setFrom] = useState(() => new Date().toISOString().slice(0, 10));
  const [source, setSource] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const rate = rates.find((r) => rateKey(r) === key);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!rate) return;
    const perRunner = Number(price);
    const size = rate.per === "vcpu" ? Number(vcpus) : 1;
    if (!(perRunner > 0) || !(size > 0)) {
      setError(ERRORS.invalid_price!);
      return;
    }
    setError(null);
    setSaving(true);
    try {
      await addPrice({
        provider: rate.provider,
        rate: rate.rate,
        usd: perRunner / size,
        from,
        source: source.trim() || undefined,
      });
      setPrice("");
      setSource("");
      await onAdded(rate, from);
    } catch (caught) {
      const code = caught instanceof ApiError ? caught.code : undefined;
      setError(
        (code && ERRORS[code]) ?? (caught instanceof Error ? caught.message : String(caught)),
      );
    } finally {
      setSaving(false);
    }
  }

  return (
    <form onSubmit={submit} className="grid gap-3 rounded-xl border bg-card p-4">
      <h2 className="font-medium">Add a price</h2>
      <div className="grid gap-3 sm:grid-cols-[minmax(0,14rem)_8rem_6rem_10rem]">
        <label className="grid gap-1 text-sm">
          Rate
          <Select value={key} onValueChange={setKey}>
            <SelectTrigger>
              <SelectValue placeholder="Choose a rate" />
            </SelectTrigger>
            <SelectContent>
              {rates.map((r) => (
                <SelectItem key={rateKey(r)} value={rateKey(r)}>
                  {providerName(r.provider)} {r.rate}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </label>
        <label className="grid gap-1 text-sm">
          USD a minute
          <Input
            inputMode="decimal"
            placeholder="0.004"
            value={price}
            onChange={(e) => setPrice(e.target.value)}
          />
        </label>
        <label className="grid gap-1 text-sm">
          vCPUs
          <Input
            inputMode="numeric"
            value={rate?.per === "runner" ? "" : vcpus}
            disabled={rate?.per === "runner"}
            onChange={(e) => setVcpus(e.target.value)}
          />
        </label>
        <label className="grid gap-1 text-sm">
          From
          <Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
        </label>
      </div>
      <label className="grid gap-1 text-sm">
        Source
        <Input
          placeholder="Pricing page URL or a note"
          value={source}
          onChange={(e) => setSource(e.target.value)}
        />
      </label>
      {error && <p className="text-sm text-destructive">{error}</p>}
      <div>
        <Button type="submit" disabled={!rate || !price || saving}>
          Add price
        </Button>
      </div>
    </form>
  );
}
