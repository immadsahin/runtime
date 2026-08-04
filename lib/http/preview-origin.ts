/**
 * Return Hoplite's externally reachable preview origin when Next.js receives
 * a request through the local preview tunnel. The forwarded host is accepted
 * only for Hoplite preview domains, so it cannot become an arbitrary OAuth
 * redirect target.
 */
export function hoplitePreviewOrigin(request: Request): string | null {
  const host = request.headers.get("x-forwarded-host")?.split(",")[0]?.trim();
  if (!host || !host.endsWith(".preview.usehoplite.com")) return null;

  return `https://${host}`;
}
