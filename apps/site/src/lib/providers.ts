// Provider facts for the site, from @relayrunner/providers (the same list the API and dashboard
// use), plus the logo tiles in public/providers/.
import {
  BASE_BOOK,
  listRate,
  PRICES_CHECKED,
  PROVIDER_IDS,
  PROVIDERS,
  rateText,
  type ProviderId,
} from "@relayrunner/providers";

export { isProviderId } from "@relayrunner/providers";
export { PROVIDERS, type ProviderId };

/** The providers a job can be sent to, in the package's order ("other" is a catch-all, not one). */
export const KNOWN_PROVIDERS = PROVIDER_IDS.filter((id) => id !== "other");

// "November 2026": when the list prices were last checked.
const pricesMonth = new Date(`${PRICES_CHECKED}T00:00:00Z`).toLocaleDateString("en-US", {
  month: "long",
  year: "numeric",
  timeZone: "UTC",
});

/** "As of November 2026", shown on hover where a list price appears. */
export const PRICES_AS_OF = `As of ${pricesMonth}`;

/** The provider's tile in public/providers/, or undefined for "other", which has none. */
export const logoOf = (id: ProviderId) => (id === "other" ? undefined : `/providers/${id}.svg`);

/** List price for a minute on the provider's example runner, e.g. "$0.008/min", or "—". */
export function examplePrice(id: ProviderId): string {
  const example = PROVIDERS[id].example;
  return rateText(example ? listRate(BASE_BOOK, id, example.toLowerCase()) : null);
}

export type ProviderFact =
  | { term: string; code: string }
  | { term: string; text: string; title?: string }
  | { term: string; links: { label: string; href: string }[] };

/** The rows <Provider /> shows, shared with its Markdown version. */
export function providerFacts(id: ProviderId): ProviderFact[] {
  const { labels, example, docsUrl, dashboardUrl } = PROVIDERS[id];
  const price = examplePrice(id);
  const links = [
    docsUrl ? { label: "Docs", href: docsUrl } : undefined,
    dashboardUrl ? { label: "Dashboard", href: dashboardUrl } : undefined,
  ].filter((link) => link !== undefined);
  const facts: (ProviderFact | undefined)[] = [
    { term: "Labels", code: labels },
    example ? { term: "Example", code: `runs-on: ${example}` } : undefined,
    price === "—" ? undefined : { term: "List price", text: price, title: PRICES_AS_OF },
    links.length > 0 ? { term: "Links", links } : undefined,
  ];
  return facts.filter((fact) => fact !== undefined);
}

/** <Provider id="…" /> as Markdown, for the docs' .md and .txt versions. */
export function providerMarkdown(id: ProviderId): string {
  const { name, summary } = PROVIDERS[id];
  const rows = providerFacts(id).map((fact) => {
    const value =
      "code" in fact
        ? `\`${fact.code}\``
        : "text" in fact
          ? fact.title
            ? `${fact.text} (as of ${pricesMonth})`
            : fact.text
          : fact.links.map((link) => `[${link.label}](${link.href})`).join(", ");
    return `- ${fact.term}: ${value}`;
  });
  return [`**${name}**: ${summary}`, "", ...rows].join("\n");
}

/** <ProviderTable /> as Markdown. */
export function providerTableMarkdown(): string {
  const rows = KNOWN_PROVIDERS.map((id) => {
    const { name, summary, labels } = PROVIDERS[id];
    return `| ${name}: ${summary} | \`${labels}\` | ${examplePrice(id)} |`;
  });
  return [
    "| Provider | Labels | List price |",
    "| --- | --- | --- |",
    ...rows,
    "",
    `List prices for each provider's example runner, as of ${pricesMonth}.`,
  ].join("\n");
}
