import { Button } from "@/components/ui/button";
import { plural } from "@/lib/job-times";

/** A row of buttons that picks one option, such as a report's range or view. */
export function OptionPicker<V extends string | number>({
  label,
  options,
  value,
  onChange,
}: {
  label: string;
  options: readonly { value: V; label: string }[];
  value: V;
  onChange: (value: V) => void;
}) {
  return (
    <div role="group" aria-label={label} className="flex flex-wrap gap-1.5">
      {options.map((option) => (
        <Button
          key={option.value}
          size="sm"
          variant={value === option.value ? "secondary" : "ghost"}
          aria-pressed={value === option.value}
          onClick={() => option.value !== value && onChange(option.value)}
        >
          {option.label}
        </Button>
      ))}
    </div>
  );
}

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
    <OptionPicker
      label="Range"
      options={ranges.map((value) => ({ value, label: plural(value, "day") }))}
      value={days}
      onChange={onChange}
    />
  );
}
