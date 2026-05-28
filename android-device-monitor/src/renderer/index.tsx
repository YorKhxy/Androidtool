import { createRoot } from 'react-dom/client';
import SimpleApp from './SimpleApp';

const container = document.getElementById('root');
if (container) {
  const root = createRoot(container);
  root.render(<SimpleApp />);
}