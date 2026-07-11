export interface ContentAssetInput {
  category: string;
  entitlementKey: string;
  title: string;
  description?: string;
  /** Raw pasted URL — this module extracts and validates the video ID; the raw URL is never stored. */
  youtubeUrl: string;
  sortOrder?: number;
  createdBy: string;
}

export interface ContentAssetUpdateInput {
  title?: string;
  youtubeUrl?: string;
  description?: string | null;
  sortOrder?: number;
  isActive?: boolean;
}
