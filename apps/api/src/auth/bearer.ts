/** The token in an `Authorization: Bearer …` header, or null. */
export function bearerToken(headers: Headers) {
  return /^Bearer\s+(\S+)$/i.exec(headers.get("authorization") ?? "")?.[1] ?? null;
}
