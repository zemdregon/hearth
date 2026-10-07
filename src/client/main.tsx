import React, { Component, type ErrorInfo, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { FamilyProvider } from './store';
import './styles.css';

class AppErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  componentDidCatch(error: Error, info: ErrorInfo) { console.error('Hearth could not display this view.', error, info.componentStack); }
  render() {
    if (this.state.failed) return <main className="fatal-error"><div className="card"><span className="eyebrow">A little pause</span><h1>Let’s find our way home.</h1><p>This view couldn’t load. Your saved information is still safe.</p><button className="button" onClick={() => window.location.reload()}>Reload Hearth</button></div></main>;
    return this.props.children;
  }
}

createRoot(document.getElementById('root')!).render(<React.StrictMode><AppErrorBoundary><FamilyProvider><App /></FamilyProvider></AppErrorBoundary></React.StrictMode>);

// Only the public app shell is cached. Family API data is always fetched from the server.
if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => { navigator.serviceWorker.register('/sw.js').catch(() => { /* Installation is optional; the online app remains available. */ }); });
}
