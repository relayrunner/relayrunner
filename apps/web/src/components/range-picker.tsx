import { Button } from "@/components/ui/button";
import { plural } from "@/lib/job-times";

/** A row of "N days" buttons for a report's range. */
export function RangePicker({
  ranges,
  days,
  onChange,
}: {
  ranges: readonly number[];
  days: number;
  onChange: (days: number) => void;
}) {
  return (
    <div role="group" aria-label="Range" className="flex gap-1.5">
      {ranges.map((value) => (
        <Button
          key={value}
          size="sm"
          variant={days === value ? "secondary" : "ghost"}
          aria-pressed={days === value}
          onClick={() => value !== days && onChange(value)}
        >
          {plural(value, "day")}
        </Button>
      ))}
    </div>
  );
}
