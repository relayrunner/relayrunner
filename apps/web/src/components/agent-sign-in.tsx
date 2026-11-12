import type { ReactNode } from "react";
import { Brand } from "@/components/brand";
import { Card, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

// The brand above one centered card: the agent sign-in pages (routes/agents.*.tsx) and /agree.
export function BrandedPage({ children }: { children: ReactNode }) {
  return (
    <main className="grid min-h-screen place-items-center p-4">
      <div className="flex w-full max-w-sm flex-col items-center gap-6">
        <Brand />
        {children}
      </div>
    </main>
  );
}

// The session ended partway through. The signed request expires with the flow, so the way back is
// to start over from the agent.
export function SignedOut() {
  return (
    <Card className="w-full">
      <CardHeader>
        <CardTitle>Signed out</CardTitle>
        <CardDescription>
          Your session ended before the agent was connected. Start the connection again from your
          agent.
        </CardDescription>
      </CardHeader>
    </Card>
  );
}
