import { createRoot } from 'react-dom/client';
import { App } from './ui/App.tsx';
import './styles.css';

const el = document.getElementById('root');
if (!el) throw new Error('找不到 #root 挂载点');
createRoot(el).render(<App />);
