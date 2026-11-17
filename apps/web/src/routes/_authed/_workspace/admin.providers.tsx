import { type Platform, PLATFORMS, providerPlans } from "@relayrunner/providers";
import {
  type CatalogProvider,
  FIXED_STATUS,
  PROVIDER_STATUSES,
  type ProviderStatus,
} from "@relayrunner/providers/catalog";
import { createFileRoute, Link } from "@tanstack/react-router";
import { PencilIcon, PlusIcon, RotateCcwIcon, StarIcon, Trash2Icon } from "lucide-react";
import { type FormEvent, useState } from "react";
import { PageHeader } from "@/components/page-header";
import { ProviderMark } from "@/components/providers";
import { Button } from "@/components/ui/button";
import { createCellContext, DataTable, dataTableColumns } from "@/components/ui/data-table";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { OptionPicker } from "@/components/range-picker";
import { Textarea } from "@/components/ui/textarea";
import { timeAgo } from "@/lib/activity";
import {
  addProvider,
  listProviders,
  type ProviderFields,
  removeProvider,
  saveProvider,
  setProviderFlags,
} from "@/lib/admin";
import { errorText } from "@/lib/api";
import { setProviderCatalog } from "@/lib/provider-catalog";
import { cn } from "@/lib/utils";

// Operator admin, behind Cloudflare Access and an operator session
// (apps/api/src/routes/admin-providers.ts).
export const Route = createFileRoute("/_authed/_workspace/admin/providers")({
  loader: async () => {
    const data = await listProviders();
    // The rest of the dashboard names providers from the same list, so it sees what's here.
    setProviderCatalog(data.providers);
    return data;
  },
  component: ProvidersAdminPage,
});

// Who's editing what: a provider, or a new one.
type Editing = CatalogProvider | "new" | null;

const STATUS: Record<ProviderStatus, { label: string; hint: string; dot: string }> = {
  live: { label: "Live", hint: "Offered on the Providers page.", dot: "bg-go" },
  hidden: {
    label: "Hidden",
    hint: "Not offered. Jobs on its labels still count as it, and keep working.",
    dot: "bg-run",
  },
  off: {
    label: "Off",
    hint: "Not recognised. Jobs on its labels count as Other.",
    dot: "bg-dormant",
  },
};

type Filter = ProviderStatus | "all";

// Off is only for added providers: code matches its own providers' labels in more places.
const statusesFor = (provider: CatalogProvider | "new") =>
  provider !== "new" && provider.builtIn
    ? PROVIDER_STATUSES.filter((status) => status !== "off")
    : PROVIDER_STATUSES;

function ProvidersAdminPage() {
  const [providers, setProviders] = useState(Route.useLoaderData().providers);
  const [editing, setEditing] = useState<Editing>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [filter, setFilter] = useState<Filter>("all");
  const count = (status: Filter) =>
    status === "all" ? providers.length : providers.filter((p) => p.status === status).length;
  const filters = (["all", ...PROVIDER_STATUSES] as const).map((value) => ({
    value,
    label: `${value === "all" ? "All" : STATUS[value].label} ${count(value)}`,
  }));
  const shown = filter === "all" ? providers : providers.filter((p) => p.status === filter);

  async function reload(message: string) {
    const { providers } = await listProviders();
    setProviders(providers);
    setProviderCatalog(providers);
    setNotice(message);
  }

  async function setFlags(
    provider: CatalogProvider,
    flags: { status?: ProviderStatus; featured?: boolean },
  ) {
    setNotice(null);
    // Show it at once; the reload puts back what the API kept.
    setProviders((list) => list.map((p) => (p.id === provider.id ? { ...p, ...flags } : p)));
    try {
      await setProviderFlags(provider.id, flags);
      await reload(
        flags.status
          ? `${provider.name} is ${STATUS[flags.status].label}.`
          : flags.featured
            ? `Featured ${provider.name}.`
            : `${provider.name} is no longer featured.`,
      );
    } catch (caught) {
      await reload(errorText(caught));
    }
  }

  async function remove(provider: CatalogProvider) {
    setNotice(null);
    await removeProvider(provider.id);
    await reload(
      provider.builtIn ? `Reset ${provider.name} to its code.` : `Removed ${provider.name}.`,
    );
  }

  return (
    <section className="grid max-w-5xl gap-6">
      <PageHeader title="Providers">
        Every provider we know, and which ones users are offered. Live ones are listed on the
        Providers page, and Featured ones come first there. Hidden ones aren't offered, but jobs on
        their labels still count as them. Changes show up right away. A provider you add starts
        Hidden, counts jobs by its label prefixes, and you can give it a price on the{" "}
        <Link to="/admin/prices" className="underline">
          Prices
        </Link>{" "}
        page. Routing to it still needs code.
      </PageHeader>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <OptionPicker label="Status" options={filters} value={filter} onChange={setFilter} />
        <Button onClick={() => setEditing("new")}>
          <PlusIcon aria-hidden />
          Add provider
        </Button>
      </div>
      {notice && (
        <p role="status" className="-mt-3 text-sm text-muted-foreground">
          {notice}
        </p>
      )}

      <ProviderActions value={{ edit: setEditing, remove, setFlags }}>
        <DataTable columns={columns} data={shown} getRowId={(provider) => provider.id} />
      </ProviderActions>

      <ProviderDialog
        editing={editing}
        onClose={() => setEditing(null)}
        onSaved={async (message) => {
          setEditing(null);
          await reload(message);
        }}
      />
    </section>
  );
}

const [ProviderActions, useProviderActions] = createCellContext<{
  edit: (provider: CatalogProvider) => void;
  remove: (provider: CatalogProvider) => Promise<void>;
  setFlags: (
    provider: CatalogProvider,
    flags: { status?: ProviderStatus; featured?: boolean },
  ) => Promise<void>;
}>("Providers");

const TOP = { className: "py-3 align-top" };

const column = dataTableColumns<CatalogProvider>();
const columns = column.columns([
  column.accessor("name", {
    header: "Provider",
    sortFn: "text",
    meta: TOP,
    cell: ({ row }) => (
      <Link
        to="/providers/$provider"
        params={{ provider: row.original.id }}
        className="flex w-fit items-center gap-2.5 font-medium hover:underline"
      >
        <ProviderMark provider={row.original.id} className="size-6 rounded-md" />
        {row.original.name}
      </Link>
    ),
  }),
  column.accessor("status", {
    header: "Status",
    sortFn: (a, b) =>
      PROVIDER_STATUSES.indexOf(a.original.status) - PROVIDER_STATUSES.indexOf(b.original.status),
    meta: { className: "py-2 align-top" },
    cell: ({ row }) => <StatusCell provider={row.original} />,
  }),
  column.accessor("featured", {
    header: () => <span className="sr-only">Featured</span>,
    meta: { className: "py-2 align-top" },
    cell: ({ row }) => <FeaturedCell provider={row.original} />,
  }),
  column.accessor("labels", {
    header: "Labels",
    sortFn: "text",
    meta: { className: "py-3 align-top font-mono text-xs" },
  }),
  column.accessor((provider) => provider.updatedAt ?? undefined, {
    id: "changed",
    header: "Changed",
    sortFn: "text",
    meta: { className: "py-3 align-top text-muted-foreground whitespace-nowrap" },
    cell: ({ row }) => changedText(row.original),
  }),
  column.display({
    id: "actions",
    header: () => <span className="sr-only">Actions</span>,
    meta: { className: "py-2 align-top text-right whitespace-nowrap" },
    cell: ({ row }) => <Actions provider={row.original} />,
  }),
]);

function StatusCell({ provider }: { provider: CatalogProvider }) {
  const { setFlags } = useProviderActions();
  const fixed = FIXED_STATUS.has(provider.id);
  return (
    <Select
      value={provider.status}
      disabled={fixed}
      onValueChange={(status) =>
        status !== provider.status && setFlags(provider, { status: status as ProviderStatus })
      }
    >
      <SelectTrigger
        size="sm"
        aria-label={`Status of ${provider.name}`}
        title={fixed ? "Always Live" : STATUS[provider.status].hint}
        className="w-[7.5rem]"
      >
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {statusesFor(provider).map((status) => (
          <SelectItem key={status} value={status}>
            <span aria-hidden className={cn("size-2 rounded-full", STATUS[status].dot)} />
            {STATUS[status].label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

function FeaturedCell({ provider }: { provider: CatalogProvider }) {
  const { setFlags } = useProviderActions();
  return (
    <Button
      size="icon-sm"
      variant="ghost"
      aria-pressed={provider.featured}
      aria-label={`Feature ${provider.name}`}
      title={provider.featured ? "Featured: listed first" : "Feature it: list it first"}
      onClick={() => setFlags(provider, { featured: !provider.featured })}
    >
      <StarIcon
        aria-hidden
        className={cn(provider.featured ? "fill-run text-run" : "text-muted-foreground/60")}
      />
    </Button>
  );
}

function changedText({ builtIn, updatedBy, updatedAt }: CatalogProvider) {
  if (!updatedBy || !updatedAt) return "As in code";
  return `${builtIn ? "Edited" : "Added"} by ${updatedBy} ${timeAgo(updatedAt)}`;
}

function Actions({ provider }: { provider: CatalogProvider }) {
  const { edit, remove } = useProviderActions();
  const [busy, setBusy] = useState(false);
  const removable = !provider.builtIn || provider.updatedBy;
  return (
    <span className="inline-flex gap-1">
      <Button
        size="icon-sm"
        variant="ghost"
        aria-label={`Edit ${provider.name}`}
        title="Edit"
        onClick={() => edit(provider)}
      >
        <PencilIcon aria-hidden />
      </Button>
      {removable && (
        <Button
          size="icon-sm"
          variant="ghost"
          disabled={busy}
          aria-label={provider.builtIn ? `Reset ${provider.name}` : `Remove ${provider.name}`}
          title={provider.builtIn ? "Reset to code" : "Remove"}
          onClick={() => {
            setBusy(true);
            remove(provider).finally(() => setBusy(false));
          }}
        >
          {provider.builtIn ? <RotateCcwIcon aria-hidden /> : <Trash2Icon aria-hidden />}
        </Button>
      )}
    </span>
  );
}

const EMPTY: ProviderFields = {
  name: "",
  summary: "",
  labels: "",
  prefixes: [],
  example: "",
  setup: "",
  dashboardUrl: "",
  docsUrl: "",
  logoUrl: "",
  status: "hidden",
  featured: false,
  platforms: ["x64"],
  feeUsd: null,
  perMinute: null,
  connectUrl: "",
};

const fieldsOf = (provider: CatalogProvider): ProviderFields => ({
  name: provider.name,
  summary: provider.summary,
  labels: provider.labels,
  prefixes: provider.prefixes,
  example: provider.example ?? "",
  setup: provider.setup ?? "",
  dashboardUrl: provider.dashboardUrl ?? "",
  docsUrl: provider.docsUrl ?? "",
  logoUrl: provider.logoUrl ?? "",
  status: provider.status,
  featured: provider.featured,
  platforms: provider.platforms ?? providerPlans(provider.id)?.platforms.slice() ?? [],
  feeUsd: provider.feeUsd ?? null,
  perMinute: provider.perMinute ?? null,
  connectUrl: provider.connectUrl ?? "",
});

const PLATFORM_NAMES: Record<Platform, string> = {
  x64: "Linux x64",
  arm: "Linux arm",
  mac: "macOS",
  win: "Windows",
};

// A dollar amount typed in a field, or null when it's blank.
const dollars = (value: string) => (value.trim() === "" ? null : Number(value));

const slug = (name: string) =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");

function ProviderDialog({
  editing,
  onClose,
  onSaved,
}: {
  editing: Editing;
  onClose: () => void;
  onSaved: (message: string) => Promise<void>;
}) {
  return (
    <Dialog open={editing !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-xl">
        {editing && (
          <ProviderForm
            key={editing === "new" ? "new" : editing.id}
            editing={editing}
            onSaved={onSaved}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}

function ProviderForm({
  editing,
  onSaved,
}: {
  editing: CatalogProvider | "new";
  onSaved: (message: string) => Promise<void>;
}) {
  const isNew = editing === "new";
  const [fields, setFields] = useState<ProviderFields>(isNew ? EMPTY : fieldsOf(editing));
  const [id, setId] = useState<string | null>(null);
  const [prefixes, setPrefixes] = useState(fields.prefixes.join(", "));
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  // Matched in code, so their prefixes can't change here.
  const codeMatched = !isNew && editing.builtIn;
  const newId = id ?? slug(fields.name);

  const set = (key: keyof ProviderFields) => (value: string) =>
    setFields((current) => ({ ...current, [key]: value }));
  const [fee, setFee] = useState(fields.feeUsd?.toString() ?? "");
  const [perMinute, setPerMinute] = useState(fields.perMinute?.toString() ?? "");
  const fixed = !isNew && FIXED_STATUS.has(editing.id);
  const togglePlatform = (platform: Platform, on: boolean) =>
    setFields((current) => ({
      ...current,
      platforms: PLATFORMS.filter((p) => (p === platform ? on : current.platforms.includes(p))),
    }));

  async function submit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    setSaving(true);
    const body = {
      ...fields,
      feeUsd: dollars(fee),
      perMinute: dollars(perMinute),
      prefixes: prefixes
        .split(",")
        .map((prefix) => prefix.trim())
        .filter(Boolean),
    };
    try {
      if (isNew) await addProvider({ ...body, id: newId });
      else await saveProvider(editing.id, body);
      await onSaved(isNew ? `Added ${fields.name}.` : `Saved ${fields.name}.`);
    } catch (caught) {
      setError(errorText(caught));
    } finally {
      setSaving(false);
    }
  }

  return (
    <form onSubmit={submit} className="grid gap-4">
      <DialogHeader>
        <DialogTitle>{isNew ? "Add a provider" : `Edit ${editing.name}`}</DialogTitle>
        <DialogDescription>
          {isNew
            ? "Jobs with a label that starts with one of its prefixes count as this provider."
            : "Your changes replace the text and links in code until you reset them."}
        </DialogDescription>
      </DialogHeader>

      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Name">
          <Input required value={fields.name} onChange={(e) => set("name")(e.target.value)} />
        </Field>
        {isNew ? (
          <Field label="Id" hint="Its page lives at /providers/<id>.">
            <Input required value={newId} onChange={(e) => setId(e.target.value)} />
          </Field>
        ) : (
          <Field label="Id">
            <Input value={editing.id} disabled />
          </Field>
        )}
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Status" hint={fixed ? "Always Live." : STATUS[fields.status].hint}>
          <Select
            value={fields.status}
            disabled={fixed}
            onValueChange={(status) => set("status")(status)}
          >
            <SelectTrigger className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {statusesFor(editing).map((status) => (
                <SelectItem key={status} value={status}>
                  <span aria-hidden className={cn("size-2 rounded-full", STATUS[status].dot)} />
                  {STATUS[status].label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
        <label className="flex items-start gap-2.5 pt-7 text-sm">
          <input
            type="checkbox"
            className="mt-0.5 size-4 accent-[var(--color-go)]"
            checked={fields.featured}
            onChange={(e) => setFields((current) => ({ ...current, featured: e.target.checked }))}
          />
          <span className="grid gap-0.5">
            <span className="font-medium">Featured</span>
            <span className="text-muted-foreground">Listed first on the Providers page.</span>
          </span>
        </label>
      </div>
      <Field label="Summary" hint="One line, shown under its name.">
        <Input required value={fields.summary} onChange={(e) => set("summary")(e.target.value)} />
      </Field>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Labels" hint="How its labels look, such as acme-*.">
          <Input required value={fields.labels} onChange={(e) => set("labels")(e.target.value)} />
        </Field>
        <Field
          label="Label prefixes"
          hint={codeMatched ? "Matched in code." : "Comma-separated, such as acme-."}
        >
          <Input
            required={!codeMatched}
            disabled={codeMatched}
            className="font-mono"
            value={codeMatched ? fields.prefixes.join(", ") || "—" : prefixes}
            onChange={(e) => setPrefixes(e.target.value)}
          />
        </Field>
      </div>
      <Field label="runs-on example" hint="Shows on its page with the setup steps.">
        <Input
          className="font-mono"
          value={fields.example}
          onChange={(e) => set("example")(e.target.value)}
        />
      </Field>
      <Field label="Setup step" hint="What to do before a job can run there.">
        <Textarea rows={2} value={fields.setup} onChange={(e) => set("setup")(e.target.value)} />
      </Field>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Dashboard link">
          <Input
            type="url"
            placeholder="https://"
            value={fields.dashboardUrl}
            onChange={(e) => set("dashboardUrl")(e.target.value)}
          />
        </Field>
        <Field label="Docs link">
          <Input
            type="url"
            placeholder="https://"
            value={fields.docsUrl}
            onChange={(e) => set("docsUrl")(e.target.value)}
          />
        </Field>
      </div>
      <fieldset className="grid gap-2">
        <legend className="mb-2 text-sm font-medium">Runs on</legend>
        <div className="flex flex-wrap gap-x-5 gap-y-2">
          {PLATFORMS.map((platform) => (
            <label key={platform} className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                className="size-4 accent-[var(--color-go)]"
                checked={fields.platforms.includes(platform)}
                onChange={(e) => togglePlatform(platform, e.target.checked)}
              />
              {PLATFORM_NAMES[platform]}
            </label>
          ))}
        </div>
      </fieldset>
      <div className="grid gap-3 sm:grid-cols-3">
        <Field label="Starts at, $/mo" hint="Its cheapest plan. 0 for none.">
          <Input
            type="number"
            min={0}
            step="any"
            className="font-mono"
            value={fee}
            onChange={(e) => setFee(e.target.value)}
          />
        </Field>
        <Field label="Per minute, $" hint="A 2 vCPU Linux runner.">
          <Input
            type="number"
            min={0}
            step="any"
            className="font-mono"
            value={perMinute}
            onChange={(e) => setPerMinute(e.target.value)}
          />
        </Field>
        <Field label="Connect link" hint="Its signup.">
          <Input
            type="url"
            placeholder="https://"
            value={fields.connectUrl}
            onChange={(e) => set("connectUrl")(e.target.value)}
          />
        </Field>
      </div>
      {!codeMatched && (
        <Field
          label="Logo link"
          hint="A square image, shown on its tile: https, or /provider-logos/<file>. Leave blank for its initial."
        >
          <Input
            placeholder="https://"
            value={fields.logoUrl}
            onChange={(e) => set("logoUrl")(e.target.value)}
          />
        </Field>
      )}

      {error && <p className="text-sm text-destructive">{error}</p>}
      <DialogFooter>
        <Button type="submit" disabled={saving}>
          {isNew ? "Add provider" : "Save"}
        </Button>
      </DialogFooter>
    </form>
  );
}
