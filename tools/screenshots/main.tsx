// The harness entry: the app's own component, its own stylesheet, nothing else
// changed. Everything the app would ask a Tauri command for is answered by
// `backend.ts`, which serves the sample story in `fixture.json`.

import React from 'react';
import ReactDOM from 'react-dom/client';

import App from '../../src/App';
import '../../src/styles.css';

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
