import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /**
   * Dev-only: allow the sandbox preview tunnel host to request /_next dev
   * resources. Without this, Next.js blocks the cross-origin request and HMR
   * plus the dev error overlay stop working when the app is opened through the
   * preview tunnel rather than localhost.
   */
  allowedDevOrigins: ["127.0.0.1", "localhost", "*.modal.host"],

  experimental: {
    /**
     * Inline CSS into the document instead of emitting <link> tags.
     *
     * Required for the sandbox preview panel to render correctly. The preview
     * tunnel authenticates with a cookie marked `SameSite=Lax`, and the panel
     * embeds the tunnel in a cross-site iframe, so the cookie is not attached
     * to subresource requests: every `/_next/static/**` asset returns 401 and
     * the page renders as unstyled HTML. Inlining makes styles ride along with
     * the document, which carries the auth token in its URL and does load.
     *
     * Only takes effect in `next build` (it is a no-op in `next dev`), which is
     * why the sandbox run script builds and serves a production bundle.
     *
     * Tailwind is atomic and this app is small, so the payload cost is minor.
     */
    inlineCss: true,
  },
};

export default nextConfig;
