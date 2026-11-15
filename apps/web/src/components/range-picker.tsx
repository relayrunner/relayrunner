import { CalendarIcon, CheckIcon, ChevronDownIcon } from "lucide-react";
import { type ReactNode, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  customRange,
  customRangeStart,
  dateText,
  dayPreset,
  isCalendar,
  isCustom,
  presetDays,
  type RangePreset,
  rangeName,
  resolveRange,
  spanCode,
  type TimeRange,
} from "@/lib/time-range";
import { cn } from "@/lib/utils";

/** A row of buttons that picks one option, such as a report's view. */
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

/**
 * Picks a report's time range from a menu: rolling presets (past hour to past 90 days), then
 * calendar ones (today, this week) in two columns, then a custom range of days when the page
 * takes one (`customDays`, so `V` then takes in custom ranges). Each lists how long it spans, so
 * "Today" at 7 PM reads `19h`.
 */
export function TimeRangePicker<V extends TimeRange>({
  value,
  onChange,
  presets,
  customDays,
  className,
}: {
  presets: readonly (V & RangePreset)[];
  customDays?: number;
  value: V;
  onChange: (range: V) => void;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const [custom, setCustom] = useState(false);
  const now = Date.now();
  const rolling = presets.filter((preset) => !isCalendar(preset));
  const calendar = presets.filter(isCalendar);
  const customValue = isCustom(value);
  const choose = (range: V) => {
    setOpen(false);
    if (range !== value) onChange(range);
  };
  const item = (preset: V & RangePreset) => (
    <RangeItem
      key={preset}
      code={spanCode(preset, now)}
      selected={preset === value}
      onSelect={() => choose(preset)}
    >
      {rangeName(preset)}
    </RangeItem>
  );

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) setCustom(false);
      }}
    >
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          // As wide as its label, even in a grid or a column that would stretch it.
          className={cn("w-fit self-start justify-self-start", className)}
        >
          <CalendarIcon aria-hidden className="text-muted-foreground" />
          <span>{rangeName(value)}</span>
          <ChevronDownIcon aria-hidden className="text-muted-foreground" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-auto min-w-60 p-1">
        {custom && customDays ? (
          <CustomForm
            value={value}
            customDays={customDays}
            onApply={(range) => choose(range as V)}
            onBack={() => setCustom(false)}
          />
        ) : (
          <div role="group" aria-label="Range" className="grid gap-1 text-sm">
            {rolling.length > 0 && <div className="grid">{rolling.map(item)}</div>}
            {calendar.length > 0 && (
              <div className={cn("grid grid-cols-2", rolling.length > 0 && "border-t pt-1")}>
                {calendar.map(item)}
              </div>
            )}
            {customDays ? (
              <div className="border-t pt-1">
                <RangeItem
                  code={<CalendarIcon aria-hidden className="size-3.5" />}
                  selected={customValue}
                  onSelect={() => setCustom(true)}
                >
                  {customValue ? rangeName(value) : "Custom range…"}
                </RangeItem>
              </div>
            ) : null}
          </div>
        )}
      </PopoverContent>
    </Popover>
  );
}

function RangeItem({
  code,
  selected,
  onSelect,
  children,
}: {
  code: ReactNode;
  selected: boolean;
  onSelect: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-pressed={selected}
      onClick={onSelect}
      className={cn(
        "grid grid-cols-[2.75rem_minmax(0,1fr)_1rem] items-center gap-2 rounded-sm px-2 py-1.5 text-left outline-none hover:bg-accent focus-visible:bg-accent",
        selected && "font-medium",
      )}
    >
      <span className="flex text-xs text-muted-foreground tabular-nums">{code}</span>
      <span className="truncate">{children}</span>
      {selected && <CheckIcon aria-hidden className="size-4" />}
    </button>
  );
}

// Two days, the earliest `customDays` back, starting from the range that's chosen now.
function CustomForm({
  value,
  customDays,
  onApply,
  onBack,
}: {
  value: TimeRange;
  customDays: number;
  onApply: (range: TimeRange) => void;
  onBack: () => void;
}) {
  const now = Date.now();
  const current = resolveRange(value, now);
  const [from, setFrom] = useState(dateText(current.from));
  const [to, setTo] = useState(dateText(Math.max(current.from, current.to - 1)));
  const min = dateText(customRangeStart(customDays, now));
  const max = dateText(now);
  const valid = Boolean(from && to) && from >= min && to <= max;
  return (
    <form
      className="grid gap-3 p-2"
      onSubmit={(event) => {
        event.preventDefault();
        if (valid) onApply(customRange(from, to));
      }}
    >
      <label className="grid gap-1 text-xs text-muted-foreground">
        From
        <Input
          type="date"
          value={from}
          min={min}
          max={max}
          required
          onChange={(event) => setFrom(event.target.value)}
        />
      </label>
      <label className="grid gap-1 text-xs text-muted-foreground">
        To
        <Input
          type="date"
          value={to}
          min={min}
          max={max}
          required
          onChange={(event) => setTo(event.target.value)}
        />
      </label>
      <div className="flex justify-end gap-2">
        <Button type="button" size="sm" variant="ghost" onClick={onBack}>
          Back
        </Button>
        <Button type="submit" size="sm" disabled={!valid}>
          Apply
        </Button>
      </div>
    </form>
  );
}

/**
 * The time range menu for a report that counts whole days back (`?days=`), offering `ranges` as
 * "Past 24 hours", "Past 7 days" and so on.
 */
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
    <TimeRangePicker
      presets={ranges.map(dayPreset)}
      value={dayPreset(days)}
      onChange={(range) => onChange(presetDays(range))}
    />
  );
}
