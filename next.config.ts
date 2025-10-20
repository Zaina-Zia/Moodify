import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  images: {
    remotePatterns: [
      {
        protocol: "https",
        hostname: "picsum.photos",
      },
      {
        protocol: "https",
        hostname: "i.scdn.co",
      },
    ],
  },

  eslint: {
    // ✅ Prevent ESLint errors from breaking the build
    ignoreDuringBuilds: true,
  },
};

export default nextConfig;
