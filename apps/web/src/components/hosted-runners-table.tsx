// The hosted runners table, the same one the site's /integrations page shows: each runner cloud's
// list price for one runner of the picked platform and size, with its cheapest plan, and here a
// Connect button for the ones this workspace hasn't connected yet.
import { providerPlans } from "@relayrunner/providers";
import {
  hourText,
  minuteText,
  RUNNER_TABLE_ROWS,
  rowsFor,
  TABLE_PLATFORMS,
  TABLE_SIZES,
  type TablePlatform,
  type TableSize,
  UNPRICED_TABLE_ROWS,
} from "@relayrunner/providers/runner-table";
import { Link } from "@tanstack/react-router";
import { ArrowUpRightIcon, CheckIcon } from "lucide-react";
import { useState } from "react";
import { ProviderMark } from "@/components/providers";
import { OptionPicker } from "@/components/range-picker";
import { Button } from "@/components/ui/button";
import {
  PHONE_HIDDEN,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { isKnownProvider, providerInfo } from "@/lib/provider-catalog";
import { cn } from "@/lib/utils";

const PLATFORM_OPTIONS = TABLE_PLATFORMS.map((p) => ({ value: p.id, label: p.label }));
const SIZE_OPTIONS = TABLE_SIZES.map((n) => ({ value: n, label: `${n} vCPU` }));
const SORT_OPTIONS = [
  { value: "name", label: "Name" },
  { value: "price", label: "Price" },
] as const;

// An operator can take a provider off the list in the admin.
const listed = (id: string) => isKnownProvider(id) && providerInfo(id).status === "live";

export function HostedRunnersTable({ connected }: { connected: ReadonlySet<string> }) {
  const [platform, setPlatform] = useState<TablePlatform>("linux");
  const [size, setSize] = useState<TableSize>(2);
  const [sort, setSort] = useState<"name" | "price">("name");
  const mac = platform === "macos";
  const rows = rowsFor(
    RUNNER_TABLE_ROWS.filter((row) => listed(row.id)),
    platform,
    size,
    sort,
  );
  const unpriced = UNPRICED_TABLE_ROWS.filter((row) => listed(row.id));

  return (
    <div className="grid gap-3">
      <div className="flex flex-wrap items-center gap-x-6 gap-y-2">
        <OptionPicker
          label="Platform"
          options={PLATFORM_OPTIONS}
          value={platform}
          onChange={setPlatform}
        />
        <OptionPicker
          label="Size"
          options={SIZE_OPTIONS}
          // macOS runners come in one size each, which the label says.
          value={mac ? null : size}
          onChange={setSize}
          disabled={mac}
        />
        <div className="flex items-center gap-2 text-sm text-muted-foreground sm:ml-auto">
          <span>Sort</span>
          <OptionPicker label="Sort" options={SORT_OPTIONS} value={sort} onChange={setSort} />
        </div>
      </div>
      {/* Fixed column widths, so switching platform or size doesn't move the columns. Phones show
          the provider and its per-minute price; its page has the plan and a way to connect. */}
      <Table className="tabular-nums sm:min-w-[960px] sm:table-fixed">
        <colgroup>
          <col className="sm:w-[31%]" />
          <col className="sm:w-[9%]" />
          <col className="sm:w-[9%]" />
          <col className="sm:w-[19%]" />
          <col className="sm:w-[18%]" />
          <col className="sm:w-[14%]" />
        </colgroup>
        <TableHeader>
          <TableRow>
            <TableHead>Provider</TableHead>
            <TableHead className="text-right">Per minute</TableHead>
            <TableHead className={cn("text-right", PHONE_HIDDEN)}>Per hour</TableHead>
            <TableHead className={cn("pl-10", PHONE_HIDDEN)}>Plan</TableHead>
            <TableHead className={PHONE_HIDDEN}>Included</TableHead>
            <TableHead className={PHONE_HIDDEN}>
              <span className="sr-only">Connect</span>
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.length === 0 && (
            <TableRow>
              <TableCell colSpan={6} className="py-6 text-center text-muted-foreground">
                None of the runner clouds sell this runner.
              </TableCell>
            </TableRow>
          )}
          {rows.map(({ row, cell }) => (
            <TableRow key={row.id}>
              <TableCell className="py-3">
                <ProviderName
                  id={row.id}
                  label={mac ? `${cell.label} · ${cell.vcpus} vCPU` : cell.label}
                />
              </TableCell>
              <TableCell className="text-right font-mono text-[13px] whitespace-nowrap">
                {minuteText(cell.usd)}
              </TableCell>
              <TableCell
                className={cn(
                  "text-right font-mono text-[13px] whitespace-nowrap text-ink-2",
                  PHONE_HIDDEN,
                )}
              >
                {hourText(cell.usd)}
              </TableCell>
              <TableCell className={cn("truncate pl-10", PHONE_HIDDEN)}>{row.plan}</TableCell>
              <TableCell className={cn("truncate text-ink-2", PHONE_HIDDEN)}>
                {row.included}
              </TableCell>
              <TableCell className={cn("text-right", PHONE_HIDDEN)}>
                <ConnectCell id={row.id} connected={connected.has(row.id)} />
              </TableCell>
            </TableRow>
          ))}
          {unpriced.map((row) => (
            <TableRow key={row.id}>
              <TableCell className="py-3">
                <ProviderName id={row.id} />
              </TableCell>
              <TableCell colSpan={4} className="text-right text-muted-foreground">
                {row.why}
              </TableCell>
              <TableCell className={cn("text-right", PHONE_HIDDEN)}>
                <ConnectCell id={row.id} connected={connected.has(row.id)} />
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

function ProviderName({ id, label }: { id: string; label?: string }) {
  const { name } = providerInfo(id);
  return (
    <Link
      to="/providers/$provider"
      params={{ provider: id }}
      className="group flex min-w-0 items-center gap-3"
    >
      <ProviderMark provider={id} className="size-7 shrink-0 rounded-md" />
      <span className="grid min-w-0 leading-tight">
        <span className="font-medium group-hover:underline">{name}</span>
        {label && <code className="truncate font-mono text-xs text-muted-foreground">{label}</code>}
      </span>
    </Link>
  );
}

// Connected once the org has installed the cloud's GitHub App or a job ran on it. GitHub's own
// runners need nothing.
function ConnectCell({ id, connected }: { id: string; connected: boolean }) {
  if (connected || id === "github") {
    return (
      <span className="inline-flex items-center gap-1.5 text-sm text-muted-foreground">
        <CheckIcon aria-hidden className="size-4 text-emerald-600 dark:text-emerald-400" />
        Connected
      </span>
    );
  }
  const url = providerPlans(id)?.connectUrl;
  if (!url) return null;
  return (
    <Button asChild size="sm" variant="outline">
      <a href={url} target="_blank" rel="noreferrer">
        Connect
        <ArrowUpRightIcon aria-hidden />
        <span className="sr-only"> {providerInfo(id).name} (opens its site)</span>
      </a>
    </Button>
  );
}
