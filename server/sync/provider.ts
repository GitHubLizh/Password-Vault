// SyncProvider is the seam between VaultService and any remote ciphertext store.
// Profiles are addressed exactly as on disk: null is the default profile, a string is a
// subdirectory-named profile. Versions are opaque tokens (WebDAV ETag in production).
export type SyncProfileId = string | null;

export interface SyncProvider {
  listProfiles(): Promise<SyncProfileId[]>;
  remoteVersion(profileId: SyncProfileId): Promise<string | null>;
  download(profileId: SyncProfileId): Promise<string | null>;
  upload(profileId: SyncProfileId, source: string): Promise<string>;
}
