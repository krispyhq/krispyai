import type { StorybookConfig } from "@storybook/react-vite";

const config: StorybookConfig = {
  stories: ["../src/**/*.stories.@(ts|tsx)"],
  addons: ["@storybook/addon-a11y"],
  framework: {
    name: "@storybook/react-vite",
    options: {},
  },
  // Serve the Buttr expression PNGs (owned by the landing app) at /brand so the
  // mascot stories can reference them without duplicating the assets. Read-only.
  staticDirs: [{ from: "../../../apps/landing/public/brand", to: "/brand" }],
};

export default config;
