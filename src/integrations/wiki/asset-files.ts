import path from "node:path";

import {trimToUndefined} from "../../lib/strings.js";

const IMAGE_MIME_BY_EXTENSION = new Map<string, string>([
  [".png", "image/png"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".webp", "image/webp"],
  [".gif", "image/gif"],
  [".bmp", "image/bmp"],
  [".tif", "image/tiff"],
  [".tiff", "image/tiff"],
]);

const VIEWABLE_WIKI_ASSET_MIME_BY_EXTENSION = new Map<string, string>([
  ...IMAGE_MIME_BY_EXTENSION.entries(),
  [".pdf", "application/pdf"],
]);

/**
 * Infers the Wiki.js upload MIME type for image files that Panda can also view.
 */
export function inferWikiImageFile(filePath: string): {extension: string; mimeType: string} | null {
  const extension = path.extname(filePath).toLowerCase();
  const mimeType = IMAGE_MIME_BY_EXTENSION.get(extension);
  if (!mimeType) {
    return null;
  }

  return {
    extension,
    mimeType,
  };
}

/**
 * Accepts only Wiki.js assets Panda can hand to view_media after fetching.
 */
export function inferViewableWikiAssetMimeType(
  assetPath: string,
  headerMimeType: string | undefined,
): string | null {
  const normalizedHeaderMimeType = trimToUndefined(headerMimeType)?.toLowerCase();
  if (normalizedHeaderMimeType) {
    if (normalizedHeaderMimeType === "application/pdf" || normalizedHeaderMimeType.startsWith("image/")) {
      return normalizedHeaderMimeType;
    }

    return null;
  }

  return VIEWABLE_WIKI_ASSET_MIME_BY_EXTENSION.get(path.extname(assetPath).toLowerCase()) ?? null;
}

/**
 * Keeps managed image asset filenames stable per page slot.
 */
export function buildWikiImageAssetFilename(slot: string, extension: string): string {
  return `${slot}${extension}`;
}

/**
 * Splits a normalized Wiki.js asset path into its parent folder path and filename.
 */
export function splitWikiAssetPath(assetPath: string): {directoryPath: string; filename: string} {
  const separatorIndex = assetPath.lastIndexOf("/");
  if (separatorIndex < 0) {
    return {
      directoryPath: "",
      filename: assetPath,
    };
  }

  return {
    directoryPath: assetPath.slice(0, separatorIndex),
    filename: assetPath.slice(separatorIndex + 1),
  };
}
