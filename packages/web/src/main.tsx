import { createRoot } from 'react-dom/client';
import { NonceProvider } from 'react-select';
import { App } from './App.js';
import './styles.css';
const root = document.getElementById('root');
if (!root) throw new Error('Missing application root');
const styleNonce = document.querySelector<HTMLMetaElement>('meta[name="style-nonce"]')?.content;
createRoot(root).render(styleNonce
  ? <NonceProvider nonce={styleNonce} cacheKey="herbie"><App /></NonceProvider>
  : <App />);
