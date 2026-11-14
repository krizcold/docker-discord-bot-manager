import { Client } from '../client';
import { VaultValue, vaultValues } from './api';
import { FieldKey } from './field';

const CACHE_MS = 10_000;

export interface PickerView {
  body: string[];
  highlight?: number;
  keys: string;
}

/**
 * The page's vault dropdown on an env value (toggleEnvVaultDropdown): the entries whose key matches the row's key, or
 * every entry with a value when none does, one per key and value. Only the key and the source are shown, as the page
 * shows them; the value goes into the row when picked.
 */
export class VaultPicker {
  state: 'closed' | 'reading' | 'open' = 'closed';
  entries: VaultValue[] = [];
  pick = 0;
  envKey = '';
  private cache: { values: VaultValue[]; at: number } | null = null;
  private onPick: ((value: string) => void) | null = null;
  private seq = 0;

  constructor(
    private client: Client,
    private changed: () => void,
    private say: (text: string) => void,
    private now: () => number = Date.now,
  ) {}

  get active(): boolean {
    return this.state !== 'closed';
  }

  // getVaultValues: a read the manager answered is kept for 10 s.
  private async values(): Promise<{ values: VaultValue[] } | { error: string }> {
    if (this.cache && this.now() - this.cache.at < CACHE_MS) return { values: this.cache.values };
    const r = await vaultValues(this.client);
    if (r.ok === null) return { error: `can't read the vault: the manager did not answer (${r.text}).` };
    if (r.ok === false) return { error: `can't read the vault: ${r.text}` };
    this.cache = { values: r.value, at: this.now() };
    return { values: r.value };
  }

  async open(envKey: string, onPick: (value: string) => void): Promise<void> {
    const seq = ++this.seq;
    this.envKey = envKey;
    this.onPick = onPick;
    this.state = 'reading';
    this.changed();
    const got = await this.values();
    if (seq !== this.seq || this.state !== 'reading') return;
    if ('error' in got) {
      this.close();
      this.say(got.error);
      return;
    }
    const matching = got.values.filter((v) => v.key.toUpperCase() === envKey.toUpperCase());
    const seen = new Set<string>();
    this.entries = (matching.length > 0 ? matching : got.values.filter((v) => v.value)).filter((v) => {
      const k = `${v.key}=${v.value}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
    if (this.entries.length === 0) {
      this.close();
      this.say('The vault holds no entries to pick from.');
      return;
    }
    this.pick = 0;
    this.state = 'open';
    this.changed();
  }

  close(): void {
    this.seq++;
    this.state = 'closed';
    this.entries = [];
    this.onPick = null;
    this.changed();
  }

  /** A key while the picker is up; every key is taken. */
  key(key: FieldKey): void {
    if (key.escape) {
      this.close();
      return;
    }
    if (this.state !== 'open') return;
    const n = this.entries.length;
    if (key.upArrow) this.pick = (this.pick + n - 1) % n;
    else if (key.downArrow) this.pick = (this.pick + 1) % n;
    else if (key.return) {
      const value = this.entries[this.pick].value;
      const done = this.onPick;
      this.close();
      done?.(value);
      return;
    }
    this.changed();
  }

  view(inner: number, room: number): PickerView {
    const head = `Pick from the vault${this.envKey ? ` for ${this.envKey}` : ''}`;
    if (this.state === 'reading') return { body: [head, '', 'Reading the vault.'], keys: 'Esc Back' };
    const rows = this.entries.map((v, i) => `${i === this.pick ? '>' : ' '} ${v.key.padEnd(28)} ${v.source}`.slice(0, inner));
    const space = Math.max(room - 2, 1);
    const first = Math.max(0, Math.min(this.pick - space + 1, rows.length - space));
    return {
      body: [head, '', ...rows.slice(first, first + space)],
      highlight: this.pick - first + 2,
      keys: 'Enter Pick  Up/Down Move  Esc Back',
    };
  }
}
