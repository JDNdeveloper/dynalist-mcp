import { readFileSync, writeFileSync } from "node:fs";

const pkg = JSON.parse(readFileSync("package.json", "utf-8"));

const manifest = {
  manifest_version: "0.3",
  name: "dynalist",
  version: pkg.version,
  display_name: "Dynalist",
  description:
    "Read, write, search, and organize content in Dynalist documents.",
  author: {
    name: pkg.author,
  },
  server: {
    type: "node",
    entry_point: "index.js",
    mcp_config: {
      command: "node",
      args: ["${__dirname}/index.js"],
      env: {
        DYNALIST_API_TOKEN: "${user_config.api_token}",
      },
    },
  },
  user_config: {
    api_token: {
      type: "string",
      title: "API Token",
      description: "Dynalist API token from https://dynalist.io/developer",
      required: true,
      sensitive: true,
    },
  },
  icons: [
    { src: "icon-512.png", size: "512x512" },
    { src: "icon-256.png", size: "256x256" },
    { src: "icon-128.png", size: "128x128" },
  ],
};

writeFileSync("dist/manifest.json", JSON.stringify(manifest, null, 2) + "\n");
console.log("Generated dist/manifest.json");
