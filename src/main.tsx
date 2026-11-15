import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import './styles.css';
import './themes.css';
import './launcher.css';
import './concierge.css';
import './home.css';
import './scanner.css';
import { initializeStorage } from './lib/storage';

function Startup() {
  const [ready, setReady] = React.useState(false);
  const [error, setError] = React.useState('');
  const [attempt, setAttempt] = React.useState(0);
  React.useEffect(() => {
    let active = true;
    setError('');
    void initializeStorage()
      .then(() => {
        if (active) setReady(true);
      })
      .catch((cause: unknown) => {
        if (active)
          setError(
            cause instanceof Error
              ? cause.message
              : 'Could not open saved settings. Please try again.',
          );
      });
    return () => {
      active = false;
    };
  }, [attempt]);
  if (ready) return <App />;
  return (
    <main className="storage-startup" aria-busy={!error}>
      {error ? (
        <>
          <h1>Could not open saved settings</h1>
          <p role="alert">{error}</p>
          <button
            className="primary-button"
            onClick={() => setAttempt((value) => value + 1)}
          >
            Try again
          </button>
        </>
      ) : (
        <p role="status">Opening Hjem…</p>
      )}
    </main>
  );
}

const root = document.getElementById('root');
if (!root) throw new Error('Hjem’s root element is missing.');
ReactDOM.createRoot(root).render(
  <React.StrictMode>
    <Startup />
  </React.StrictMode>,
);
