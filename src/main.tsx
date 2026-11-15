import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import './styles.css';
import './themes.css';
import './launcher.css';
import './concierge.css';
import './home.css';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
