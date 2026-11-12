import type { CatalogProvider } from "@relayrunner/providers/catalog";
import { createFileRoute, Link } from "@tanstack/react-router";
import { PencilIcon, PlusIcon, RotateCcwIcon, Trash2Icon } from "lucide-react";
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
import { timeAgo } from "@/lib/activity";
import {
  addProvider,
  listProviders,
  type ProviderFields,
  removeProvider,
  saveProvider,
} from "@/lib/admin";
import { errorText } from "@/lib/api";
import { setProviderCatalog } from "@/lib/provider-catalog";

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

const ERRORS: Record<string, string> = {
  invalid_provider: "Fill in a name, summary and labels, and use https:// links.",
  invalid_id: "Use lowercase letters, numbers and dashes for the id.",
  provider_exists: "There's already a provider with that id.",
  invalid_prefixes: "Add at least one label prefix, three or more characters each.",
  prefix_taken: "Another provider, or GitHub's own runners, already use labels like that.",
};

// Who's editing what: a provider, or a new one.
type Editing = CatalogProvider | "new" | null;

function ProvidersAdminPage() {
  const [providers, setProviders] = useState(Route.useLoaderData().providers);
  const [editing, setEditing] = useState<Editing>(null);
  const [notice, setNotice] = useState<string | null>(null);

  async function reload(message: string) {
    const { providers } = await listProviders();
    setProviders(providers);
    setProviderCatalog(providers);
    setNotice(message);
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
        How the dashboard names and links each provider. Changes show up right away. A provider you
        add counts jobs by its label prefixes, but routing to it still needs code.
      </PageHeader>

      <div className="flex flex-wrap items-center justify-between gap-3">
        {notice ? (
          <p role="status" className="text-sm text-muted-foreground">
            {notice}
          </p>
        ) : (
          <span />
        )}
        <Button onClick={() => setEditing("new")}>
          <PlusIcon aria-hidden />
          Add provider
        </Button>
      </div>

      <ProviderActions value={{ edit: setEditing, remove }}>
        <DataTable columns={columns} data={providers} getRowId={(provider) => provider.id} />
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
  column.accessor("summary", {
    header: "Summary",
    sortFn: "text",
    meta: { className: "py-3 align-top text-muted-foreground" },
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
});

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

  async function submit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    setSaving(true);
    const body = {
      ...fields,
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
      setError(errorText(caught, ERRORS));
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
        <textarea
          rows={2}
          value={fields.setup}
          onChange={(e) => set("setup")(e.target.value)}
          className="w-full rounded-md border border-input bg-transparent px-3 py-2 text-base shadow-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 md:text-sm"
        />
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

      {error && <p className="text-sm text-destructive">{error}</p>}
      <DialogFooter>
        <Button type="submit" disabled={saving}>
          {isNew ? "Add provider" : "Save"}
        </Button>
      </DialogFooter>
    </form>
  );
}
