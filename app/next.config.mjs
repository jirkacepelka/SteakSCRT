/** @type {import('next').NextConfig} */
const nextConfig = {
  // The app is entirely client-side: every read is a contract query and every write is
  // signed in the user's wallet. A static export can then be served from anywhere,
  // including IPFS, which matters for a protocol whose whole point is that no single
  // party has to be trusted.
  output: "export",
  reactStrictMode: true,
};

export default nextConfig;
