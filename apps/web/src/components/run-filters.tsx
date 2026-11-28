// The filter bar History, Performance and Usage share: a Filter menu with each kind of filter and
// what it can be set to over the range, busiest first, and each filter that's set as a button that
// clears it. Also the mark a run or job from a coding agent gets.
import { agentById, type RunAgent } from "@relayrunner/api-types";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { BotIcon, ListFilterIcon, XIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { useFlag } from "@/lib/flags";
import {
  BOTS,
  FILTER_NAMES,
  filterValueLabel,
  RUN_FILTER_KEYS,
  type RunFilterKey,
  type RunFilterOptions,
  type RunFilters,
} from "@/lib/run-filters";
import { api } from "@/lib/api";
import { pageQuery } from "@/lib/query";
import { reportQuery, type TimeRange } from "@/lib/time-range";
import { cn, count } from "@/lib/utils";

type Choice = { value: string; label: string; runs: number };

/** What each filter can be set to over the range. */
const runFilterOptionsQuery = (range: TimeRange) =>
  pageQuery(["run-filters", range], () =>
    api<RunFilterOptions>(`/runs/filters?${reportQuery(range)}`),
  );

/** Each filter's choices, as the menu lists them. */
function filterChoices(options: RunFilterOptions): Record<RunFilterKey, Choice[]> {
  const choice = (key: RunFilterKey, value: string, runs: number) => ({
    value,
    label: filterValueLabel(key, value),
    runs,
  });
  const bots = options.people
    .filter((person) => person.login.endsWith("[bot]"))
    .reduce((sum, person) => sum + person.runs, 0);
  const total = options.triggers.reduce((sum, trigger) => sum + trigger.runs, 0);
  const agents = options.agents.reduce((sum, agent) => sum + agent.runs, 0);
  return {
    workflow: options.workflows.map((each) => choice("workflow", each.name, each.runs)),
    person: [
      ...(bots ? [choice("person", BOTS, bots)] : []),
      ...options.people.map((each) => choice("person", each.login, each.runs)),
    ],
    branch: options.branches.map((each) => choice("branch", each.name, each.runs)),
    trigger: options.triggers.map((each) => choice("trigger", each.name, each.runs)),
    agent: agents
      ? [
          choice("agent", "any", agents),
          ...options.agents.map((each) => choice("agent", each.id, each.runs)),
          choice("agent", "none", Math.max(0, total - agents)),
        ]
      : [],
  };
}

/**
 * The page's filter bar, for the filters in `keys`. Changing one calls `onChange` with just that
 * filter; undefined clears it.
 */
export function RunFilterBar({
  range,
  value,
  onChange,
  keys = RUN_FILTER_KEYS,
}: {
  range: TimeRange;
  value: RunFilters;
  onChange: (patch: RunFilters) => void;
  keys?: readonly RunFilterKey[];
}) {
  const on = useFlag("run-filters");
  const { data } = useQuery({
    ...runFilterOptionsQuery(range),
    enabled: on,
    placeholderData: keepPreviousData,
  });
  if (!on) return null;
  const choices = data ? filterChoices(data) : null;
  const active = keys.filter((key) => value[key]);
  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="outline" size="sm">
            <ListFilterIcon />
            Filter
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start">
          {keys.map((key) => {
            const items = choices?.[key] ?? [];
            // A filter with one choice and nothing set narrows nothing.
            if (items.length < (value[key] ? 1 : 2)) return null;
            return (
              <DropdownMenuSub key={key}>
                <DropdownMenuSubTrigger>{FILTER_NAMES[key]}</DropdownMenuSubTrigger>
                <DropdownMenuSubContent className="max-h-80 overflow-y-auto">
                  <DropdownMenuRadioGroup
                    value={value[key] ?? ""}
                    onValueChange={(next) =>
                      onChange({ [key]: next === value[key] ? undefined : next })
                    }
                  >
                    {items.map((item) => (
                      <DropdownMenuRadioItem key={item.value} value={item.value}>
                        <span className="max-w-64 truncate">{item.label}</span>
                        <span className="ml-auto pl-6 text-xs text-muted-foreground tabular-nums">
                          {count(item.runs)}
                        </span>
                      </DropdownMenuRadioItem>
                    ))}
                  </DropdownMenuRadioGroup>
                </DropdownMenuSubContent>
              </DropdownMenuSub>
            );
          })}
          {!choices && <p className="px-2 py-1.5 text-sm text-muted-foreground">Loading…</p>}
        </DropdownMenuContent>
      </DropdownMenu>
      {active.map((key) => (
        <Button
          key={key}
          variant="ghost"
          size="sm"
          aria-label={`Clear the ${FILTER_NAMES[key].toLowerCase()} filter`}
          onClick={() => onChange({ [key]: undefined })}
        >
          <span className="text-muted-foreground">{FILTER_NAMES[key]}</span>
          <span className="max-w-48 truncate">{filterValueLabel(key, value[key]!)}</span>
          <XIcon className="text-muted-foreground" />
        </Button>
      ))}
    </>
  );
}

/** A run's or job's coding agent, as a small mark with its name on hover. */
export function AgentMark({ agent, className }: { agent: RunAgent | null; className?: string }) {
  const on = useFlag("run-filters");
  if (!on || !agent) return null;
  const name = agentById(agent.id)?.name ?? agent.id;
  const text = agent.likely ? `Likely ${name}, from its branch name` : `From ${name}`;
  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <BotIcon
            role="img"
            aria-label={text}
            className={cn("size-3.5 shrink-0 text-muted-foreground", className)}
          />
        </TooltipTrigger>
        <TooltipContent>{text}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
