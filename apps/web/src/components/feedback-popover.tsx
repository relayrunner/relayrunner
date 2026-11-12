import { FEEDBACK_LIMITS } from "@relayrunner/activity";
import { useRouter } from "@tanstack/react-router";
import { CheckIcon } from "lucide-react";
import { type ComponentProps, type FormEvent, type ReactNode, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverDescription,
  PopoverHeader,
  PopoverTitle,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Textarea } from "@/components/ui/textarea";
import { errorText } from "@/lib/api";
import { FEEDBACK_EMAIL, sendFeedback } from "@/lib/feedback";

const ERRORS = {
  rate_limited: "You've sent a lot of feedback today. Try again later, or email us.",
};

/**
 * A short form for feedback, opened from `children` (the trigger). Other props go to the trigger, so
 * a tooltip can wrap it.
 */
export function FeedbackPopover({
  children,
  side,
  align,
  ...triggerProps
}: ComponentProps<typeof PopoverTrigger> & {
  children: ReactNode;
  side?: "top" | "right" | "bottom" | "left";
  align?: "start" | "center" | "end";
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [message, setMessage] = useState("");
  const [status, setStatus] = useState<"idle" | "sending" | "sent">("idle");
  const [error, setError] = useState<string | null>(null);

  const onOpenChange = (next: boolean) => {
    setOpen(next);
    // Start fresh after a sent message; keep an unsent draft.
    if (!next && status === "sent") setStatus("idle");
  };

  const canSend = message.trim() !== "" && status !== "sending";

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!canSend) return;
    setStatus("sending");
    setError(null);
    try {
      await sendFeedback(message, router.state.location.pathname);
      setMessage("");
      setStatus("sent");
    } catch (caught) {
      setError(errorText(caught, ERRORS));
      setStatus("idle");
    }
  };

  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverTrigger asChild {...triggerProps}>
        {children}
      </PopoverTrigger>
      <PopoverContent side={side} align={align} className="w-80">
        {status === "sent" ? (
          <div className="grid gap-3 text-sm">
            <p className="flex items-center gap-2 font-medium">
              <CheckIcon aria-hidden className="size-4 text-primary" />
              Thanks for the feedback
            </p>
            <p className="text-muted-foreground">
              We read every message, and we may email you back.
            </p>
            <Button
              variant="outline"
              size="sm"
              className="justify-self-start"
              onClick={() => setOpen(false)}
            >
              Close
            </Button>
          </div>
        ) : (
          <form onSubmit={submit} className="grid gap-3">
            <PopoverHeader>
              <PopoverTitle>Send feedback</PopoverTitle>
              <PopoverDescription>
                What's working, what isn't, or what you'd like to see.
              </PopoverDescription>
            </PopoverHeader>
            <Textarea
              // oxlint-disable-next-line jsx-a11y/no-autofocus -- the popover opens to write in.
              autoFocus
              aria-label="Feedback"
              rows={5}
              maxLength={FEEDBACK_LIMITS.details}
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && (e.metaKey || e.ctrlKey))
                  e.currentTarget.form?.requestSubmit();
              }}
              className="resize-y"
            />
            {error && (
              <p role="alert" className="text-sm text-destructive">
                {error}
              </p>
            )}
            <div className="flex items-center justify-between gap-3">
              <p className="text-xs text-muted-foreground">
                Or email{" "}
                <a
                  href={`mailto:${FEEDBACK_EMAIL}`}
                  className="underline underline-offset-2 hover:text-foreground"
                >
                  {FEEDBACK_EMAIL}
                </a>
              </p>
              <Button type="submit" size="sm" disabled={!canSend}>
                {status === "sending" ? "Sending…" : "Send"}
              </Button>
            </div>
          </form>
        )}
      </PopoverContent>
    </Popover>
  );
}
