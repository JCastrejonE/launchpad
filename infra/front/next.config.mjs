/** @type {import('next').NextConfig} */
const nextConfig = {
  // The container runs `next start` behind Traefik, which terminates TLS.
  poweredByHeader: false,
};

export default nextConfig;
