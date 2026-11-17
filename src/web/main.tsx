import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { GenerateCanvas, GenerateControls } from './features/generate';
import { LibraryCanvas, LibraryRail } from './features/library';
import './styles/tokens.css';
import './styles/base.css';

const container = document.getElementById('root');
if (container === null) throw new Error('The #root element is missing from index.html.');

// Each feature screen reads the studio context instead of taking props, so the frame
// stays unaware of them and each feature owns its own state.
const slots = {
  rail: <LibraryRail />,
  canvas: <GenerateCanvas />,
  controls: <GenerateControls />,
  library: <LibraryCanvas />,
};

createRoot(container).render(
  <StrictMode>
    <App slots={slots} />
  </StrictMode>,
);
