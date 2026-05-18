export interface WikiJsClientOptions {
  apiToken: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
}

export interface WikiPage {
  id: number;
  path: string;
  locale: string;
  title: string;
  description: string;
  content: string;
  tags: string[];
  editor: string;
  isPublished: boolean;
  isPrivate: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface WikiPageSearchResult {
  id: string;
  path: string;
  locale: string;
  title: string;
  description: string;
}

export interface WikiPageListItem {
  id: number;
  path: string;
  locale: string;
  title: string;
  updatedAt: string;
}

export interface WikiPageLinkItem {
  id: number;
  path: string;
  title: string;
  links: string[];
}

export interface WikiAssetFolder {
  id: number;
  slug: string;
  name: string;
}

export interface WikiAssetListItem {
  id: number;
  filename: string;
  ext: string;
  kind: string;
  fileSize?: number;
}

export interface WikiPageWriteInput {
  id?: number;
  path: string;
  locale?: string;
  title: string;
  description: string;
  content: string;
  tags?: readonly string[];
  editor?: string;
  isPublished?: boolean;
  isPrivate?: boolean;
}

export interface WikiPageMoveInput {
  id: number;
  destinationPath: string;
  destinationLocale?: string;
}

export interface WikiAssetUploadInput {
  folderId: number | null;
  filename: string;
  bytes: Uint8Array;
  mimeType: string;
}

export interface WikiAssetDownloadResult {
  bytes: Uint8Array;
  mimeType?: string;
  sizeBytes?: number;
}
