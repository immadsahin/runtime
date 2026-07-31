import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /**
   * Dev-only: allow the sandbox preview tunnel host to request /_next dev
   * resources. Without this, Next.js blocks the cross-origin request and HMR
   * plus the dev error overlay stop working when the app is opened through the
   * preview tunnel rather than localhost.
   */
  allowedDevOrigins: ["127.0.0.1", "localhost", "*.modal.host"],
};

export default nextConfig;
