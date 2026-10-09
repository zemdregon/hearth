import { useSyncExternalStore } from 'react';
import './theme-controls.css';

type Preference = 'system' | 'light' | 'dark';
declare global {
  interface Window {
    __hearthTheme?: {
      getPreference(): Preference;
      subscribe(listener: () => void): () => void;
      setPreference(preference: Preference): void;
    };
  }
}
const subscribe = (listener: () => void) => window.__hearthTheme?.subscribe(listener) ?? (() => undefined);
const snapshot = () => window.__hearthTheme?.getPreference() ?? 'system';

export function ThemeControl() {
  const preference = useSyncExternalStore(subscribe, snapshot);
  return <label className="theme-control"><span>Appearance</span><select className="input" value={preference} onChange={event => window.__hearthTheme?.setPreference(event.target.value as Preference)}>
    <option value="system">System</option><option value="light">Light</option><option value="dark">Dark</option>
  </select></label>;
}
