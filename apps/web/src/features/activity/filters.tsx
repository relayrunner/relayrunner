// The Activity page's filter bar.
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { type ActivityOptions } from "@/lib/activity";
import {
  type ActivitySearch,
  appliesTo,
  TYPES,
  RANGES,
  RESULTS,
  CLEARED,
  ANY,
} from "@/features/activity/search";

export function Filters({
  search,
  options,
  narrowed,
  onChange,
}: {
  search: ActivitySearch;
  options: ActivityOptions;
  narrowed: boolean;
  onChange: (patch: ActivitySearch) => void;
}) {
  const applies = appliesTo(search.type);
  // A repo or machine from a shared link still shows, even if this workspace's lists lack it.
  const repositories =
    search.repo && !options.repositories.includes(search.repo)
      ? [search.repo, ...options.repositories]
      : options.repositories;
  const machines =
    search.machine && !options.machines.some((machine) => machine.id === search.machine)
      ? [{ id: search.machine, name: "Unknown machine" }, ...options.machines]
      : options.machines;

  return (
    <div className="grid gap-2">
      <div role="group" aria-label="Show" className="flex flex-wrap gap-1.5">
        {TYPES.map(({ value, label }) => (
          <Button
            key={label}
            size="sm"
            variant={search.type === value ? "secondary" : "ghost"}
            aria-pressed={search.type === value}
            onClick={() => value !== search.type && onChange({ type: value })}
          >
            {label}
          </Button>
        ))}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <FilterSelect
          label="Date"
          value={search.days?.toString()}
          any="Any time"
          options={RANGES.map((range) => ({ value: String(range.days), label: range.label }))}
          onChange={(value) => onChange({ days: value ? Number(value) : undefined })}
        />
        {applies.repo && repositories.length > 0 && (
          <FilterSelect
            label="Repo"
            value={search.repo}
            any="All repos"
            options={repositories.map((name) => ({ value: name, label: name }))}
            onChange={(repo) => onChange({ repo })}
          />
        )}
        {applies.result && (
          <FilterSelect
            label="Result"
            value={search.result}
            any="Any result"
            options={RESULTS}
            onChange={(result) => onChange({ result })}
          />
        )}
        {applies.machine && machines.length > 0 && (
          <FilterSelect
            label="Machine"
            value={search.machine}
            any="All machines"
            options={machines.map((machine) => ({ value: machine.id, label: machine.name }))}
            onChange={(machine) => onChange({ machine })}
          />
        )}
        {narrowed && (
          <Button size="sm" variant="ghost" onClick={() => onChange(CLEARED)}>
            Clear
          </Button>
        )}
      </div>
    </div>
  );
}

function FilterSelect<T extends string>({
  label,
  value,
  any,
  options,
  onChange,
}: {
  label: string;
  value: T | undefined;
  any: string;
  options: { value: T; label: string }[];
  onChange: (value: T | undefined) => void;
}) {
  return (
    <Select
      value={value ?? ANY}
      onValueChange={(next) => onChange(next === ANY ? undefined : (next as T))}
    >
      <SelectTrigger size="sm" aria-label={label} className="max-w-72">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={ANY}>{any}</SelectItem>
        {options.map((option) => (
          <SelectItem key={option.value} value={option.value}>
            {option.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
