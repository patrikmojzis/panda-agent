import {devices, type BrowserContextOptions} from "playwright-core";

import type {JsonObject} from "../../lib/json.js";
import type {BrowserDeviceProfile} from "./action-types.js";

function cloneViewportSize(value: unknown): {width: number; height: number} | undefined {
  if (
    typeof value === "object"
    && value !== null
    && "width" in value
    && "height" in value
    && typeof (value as {width?: unknown}).width === "number"
    && typeof (value as {height?: unknown}).height === "number"
  ) {
    return {
      width: (value as {width: number}).width,
      height: (value as {height: number}).height,
    };
  }
  return undefined;
}

function stripDeviceDescriptor(name: string): BrowserContextOptions {
  const descriptor = devices[name] as BrowserContextOptions & {defaultBrowserType?: unknown};
  const {defaultBrowserType: _ignored, ...options} = descriptor;
  return options;
}

/** Builds Playwright context options for Panda's supported browser device profiles. */
export function buildBrowserDeviceContextOptions(deviceProfile: BrowserDeviceProfile): BrowserContextOptions {
  switch (deviceProfile) {
    case "desktop":
      return {};
    case "desktop-wide":
      return {
        viewport: {width: 1440, height: 900},
      };
    case "mobile-compact":
      return stripDeviceDescriptor("Galaxy S24");
    case "mobile":
      return stripDeviceDescriptor("Pixel 7");
    case "tablet":
      return stripDeviceDescriptor("iPad (gen 11)");
  }
}

function buildBrowserDeviceDetails(
  deviceProfile: BrowserDeviceProfile,
  contextOptions: BrowserContextOptions,
): JsonObject {
  const viewport = cloneViewportSize(contextOptions.viewport) ?? {width: 1280, height: 720};
  const screen = cloneViewportSize((contextOptions as {screen?: unknown}).screen);
  return {
    profile: deviceProfile,
    viewport,
    ...(screen ? {screen} : {}),
    deviceScaleFactor: typeof contextOptions.deviceScaleFactor === "number" ? contextOptions.deviceScaleFactor : 1,
    isMobile: contextOptions.isMobile === true,
    hasTouch: contextOptions.hasTouch === true,
    ...(typeof contextOptions.userAgent === "string" ? {userAgent: contextOptions.userAgent} : {}),
  };
}

/** Builds the browser context options, including persistent storage state when available. */
export function buildBrowserContextOptions(
  deviceProfile: BrowserDeviceProfile,
  storageStatePath?: string,
): BrowserContextOptions {
  const deviceOptions = buildBrowserDeviceContextOptions(deviceProfile);
  return {
    ...deviceOptions,
    serviceWorkers: "block",
    ...(storageStatePath ? {storageState: storageStatePath} : {}),
  };
}

/** Returns stable JSON details for the selected device profile. */
export function buildBrowserDeviceDetailsForProfile(deviceProfile: BrowserDeviceProfile): JsonObject {
  return buildBrowserDeviceDetails(deviceProfile, buildBrowserDeviceContextOptions(deviceProfile));
}
