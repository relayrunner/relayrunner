import type { APIRoute } from "astro";
import { setupGuide } from "../lib/agent-setup";

// The setup guide for coding agents: paste "Set up relayrunner in this checkout using
// https://relayrunner.dev/setup.md" into an agent and it follows this file.
export const GET: APIRoute = ({ site }) =>
  new Response(setupGuide(site!), {
    headers: { "Content-Type": "text/markdown; charset=utf-8" },
  });
