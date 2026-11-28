// The filter bar History, Performance and Usage share: a Filter menu with each kind of filter and
// what it can be set to over the range, busiest first, and each filter that's set as a button that
// clears it. Also the mark a run or job from a coding agent gets.
import {
  agentById,
  BOTS,
  isBotLogin,
  RUN_FILTER_KEYS,
  type RunAgent,
  type RunFilterChoice,
  type RunFilterKey,
  type RunFilterOptions,
  type RunFilters,
} from "@relayrunner/api-types";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { BotIcon, ListFilterIcon, XIcon } from "lucide-react";
import { useState } from "react";
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
import { api } from "@/lib/api";
import { pageQuery } from "@/lib/query";
import { triggerName } from "@/lib/signals";
import { reportQuery, type TimeRange } from "@/lib/time-range";
import { cn, count } from "@/lib/utils";

const FILTER_NAMES: Record<RunFilterKey, string> = {
  workflow: "Workflow",
  person: "Person",
  branch: "Branch",
  trigger: "Trigger",
  agent: "Agent",
};

/** What a filter's value reads as: `pull_request` is "Pull request", `bots` is "Bots". */
function valueLabel(key: RunFilterKey, value: string) {
  if (key === "trigger") return triggerName(value);
  if (key === "person" && value === BOTS) return "Bots";
  if (key === "agent" && value === "any") return "Any agent";
  if (key === "agent" && value === "none") return "No agent";
  if (key === "agent") return agentById(value)?.name ?? value;
  return value;
}

/** What each filter can be set to over the range. */
const runFilterOptionsQuery = (range: TimeRange) =>
  pageQuery(["run-filters", range], () =>
    api<RunFilterOptions>(`/runs/filters?${reportQuery(range)}`),
  );

const sum = (choices: RunFilterChoice[]) => choices.reduce((total, each) => total + each.runs, 0);

/** Each filter's choices as the menu lists them: Bots first among people, any and no agent around the agents. */
function withGroups(options: RunFilterOptions): RunFilterOptions {
  const bots = sum(options.person.filter((each) => isBotLogin(each.value)));
  const agents = sum(options.agent);
  return {
    ...options,
    person: bots ? [{ value: BOTS, runs: bots }, ...options.person] : options.person,
    agent: agents
      ? [
          { value: "any", runs: agents },
          ...options.agent,
          { value: "none", runs: Math.max(0, sum(options.trigger) - agents) },
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
  // Read once the menu first opens, since most visits never open it.
  const [opened, setOpened] = useState(false);
  const { data } = useQuery({
    ...runFilterOptionsQuery(range),
    enabled: opened,
    placeholderData: keepPreviousData,
  });
  const choices = data ? withGroups(data) : null;
  const active = keys.filter((key) => value[key]);
  return (
    <>
      <DropdownMenu onOpenChange={(open) => open && setOpened(true)}>
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
                        <span className="max-w-64 truncate">{valueLabel(key, item.value)}</span>
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
          <span className="max-w-48 truncate">{valueLabel(key, value[key]!)}</span>
          <XIcon className="text-muted-foreground" />
        </Button>
      ))}
    </>
  );
}

/** A run's or job's coding agent, as a small mark with its name on hover. */
export function AgentMark({ agent, className }: { agent: RunAgent | null; className?: string }) {
  if (!agent) return null;
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
