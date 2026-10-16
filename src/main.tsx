import './disableReactDevPerfTrack';
import React from 'react';
import ReactDOM from 'react-dom/client';
import { DeviceWorkspace } from './components/DeviceWorkspace';
import './styles/app.css';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <DeviceWorkspace />
  </React.StrictMode>,
);
