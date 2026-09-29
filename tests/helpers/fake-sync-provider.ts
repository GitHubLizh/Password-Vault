import type { SyncProvider, SyncProfileId } from '../../server/sync/provider.js';

export type FakeSyncMethod = 'listProfiles' | 'remoteVersion' | 'download' | 'upload';

export interface FakeSyncCall {
  method: FakeSyncMethod;
  profileId: SyncProfileId;
  source?: string;
}

// In-memory remote for sync tickets. `intercept` runs before each call's default behaviour,
// so a test can move the remote at an arbitrary point inside a request (ADR 0002 pull/push timing).
export class FakeSyncProvider implements SyncProvider {
  readonly calls: FakeSyncCall[] = [];
  intercept?: (method: FakeSyncMethod, profileId: SyncProfileId) => void | Promise<void>;
  private contents = new Map<SyncProfileId, string>();
  private versions = new Map<SyncProfileId, string>();
  private counter = 0;

  setRemote(profileId: SyncProfileId, source: string): string {
    this.contents.set(profileId, source);
    const version = `rev-${++this.counter}`;
    this.versions.set(profileId, version);
    return version;
  }

  removeRemote(profileId: SyncProfileId): void {
    this.contents.delete(profileId);
    this.versions.delete(profileId);
  }

  private async track<T>(method: FakeSyncMethod, profileId: SyncProfileId, source: string | undefined, read: () => T): Promise<T> {
    await this.intercept?.(method, profileId);
    this.calls.push(source === undefined ? { method, profileId } : { method, profileId, source });
    return read();
  }

  async listProfiles(): Promise<SyncProfileId[]> {
    return this.track('listProfiles', null, undefined, () => [...this.contents.keys()]);
  }

  async remoteVersion(profileId: SyncProfileId): Promise<string | null> {
    return this.track('remoteVersion', profileId, undefined, () => this.versions.get(profileId) ?? null);
  }

  async download(profileId: SyncProfileId): Promise<string | null> {
    return this.track('download', profileId, undefined, () => this.contents.get(profileId) ?? null);
  }

  async upload(profileId: SyncProfileId, source: string): Promise<string> {
    return this.track('upload', profileId, source, () => this.setRemote(profileId, source));
  }
}
