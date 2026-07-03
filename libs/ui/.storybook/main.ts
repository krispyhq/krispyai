import type { StorybookConfig } from "@storybook/react-vite";

const config: StorybookConfig = {
  stories: ["../src/**/*.stories.@(ts|tsx)"],
  addons: ["@storybook/addon-a11y"],
  framework: {
    name: "@storybook/react-vite",
    options: {},
  },
  // Serve the Buttr expression PNGs at /brand so the mascot stories can reference
  // them. The lib owns its own story assets now (the landing app moved to the
  // krispy-site repo), so these live in libs/ui/public/brand.
  staticDirs: [{ from: "../public/brand", to: "/brand" }],
};

export default config;
