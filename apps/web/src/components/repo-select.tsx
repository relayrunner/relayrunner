import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

/** The repos some rows belong to, sorted, for a RepoSelect. */
export const repositoriesOf = (rows: { repository: string }[]) =>
  [...new Set(rows.map((row) => row.repository))].sort();

/** A filter to one of `repositories`, or "all" of them. Hidden when there's only one to pick. */
export function RepoSelect({
  value,
  repositories,
  onChange,
}: {
  value: string;
  repositories: string[];
  onChange: (repository: string) => void;
}) {
  if (repositories.length < 2) return null;
  return (
    <Select value={value} onValueChange={onChange}>
      <SelectTrigger size="sm" aria-label="Repo">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="all">All repos</SelectItem>
        {repositories.map((name) => (
          <SelectItem key={name} value={name}>
            {name}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
