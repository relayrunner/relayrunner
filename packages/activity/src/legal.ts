// The Terms of Service and Privacy Policy versions people agree to, as each document's date
// (apps/site/src/pages/terms.astro and privacy.astro). Bump one only for a change people should
// agree to again: everyone whose recorded version differs is asked to agree before they can use
// the dashboard (apps/web/src/routes/agree.tsx). A typo fix only changes the page's date.
export const LEGAL_VERSIONS = { terms: "2026-11-09", privacy: "2026-11-13" } as const;

export type LegalDocument = keyof typeof LEGAL_VERSIONS;

/** The documents someone still has to agree to: all of them for someone who never has. */
export function legalToAgree(agreed: {
  termsVersion?: string | null;
  privacyVersion?: string | null;
}): LegalDocument[] {
  const missing: LegalDocument[] = [];
  if (agreed.termsVersion !== LEGAL_VERSIONS.terms) missing.push("terms");
  if (agreed.privacyVersion !== LEGAL_VERSIONS.privacy) missing.push("privacy");
  return missing;
}
