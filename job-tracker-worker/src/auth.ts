// The Worker holds the Supabase service-role key, which bypasses RLS. That
// makes the Worker itself the security boundary, so every /api route needs a
// shared token. Without this the deployed URL would be an open read/write
// proxy to the whole database.

/** Constant-time string compare, so a wrong token leaks no length or prefix. */
export function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  }
  return diff === 0
}

/** Pulls the presented token from either supported header. */
export function presentedToken(headers: Headers): string | null {
  const bearer = headers.get('authorization')
  if (bearer?.toLowerCase().startsWith('bearer ')) {
    return bearer.slice(7).trim()
  }
  return headers.get('x-api-token')
}

export function isAuthorized(headers: Headers, expected: string | undefined): boolean {
  // An unset token fails closed. A deployment that forgot the secret should
  // refuse every request, not serve the database to the internet.
  if (!expected) return false
  const presented = presentedToken(headers)
  if (!presented) return false
  return safeEqual(presented, expected)
}
