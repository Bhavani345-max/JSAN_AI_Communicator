/**
 * Rendering harness for answers - development only, never shipped.
 *
 * `vite build` takes index.html as its only entry, so this page and this module
 * are absent from dist/. It exists because the interesting rendering cases are
 * awkward to reach through the app: a diagram is a model's decision, a
 * half-written one appears for a few hundred milliseconds mid-stream, and both
 * themes have to be checked. Here they are all fixed input.
 *
 *   npm run dev:frontend   then open http://localhost:5173/render-test.html
 *
 * Change SAMPLES rather than hunting for a prompt that provokes the case.
 */
import { createRoot } from 'react-dom/client';
import { Answer } from './main';

const THEME = new URLSearchParams(location.search).get('theme') === 'dark' ? 'dark' : 'light';

const COMPLETE = [
  '## Flowchart, highlighting and maths',
  '',
  'The `auth` middleware runs first.',
  '',
  '```mermaid',
  'flowchart TD',
  '  A[User opens login page] --> B[Enter credentials]',
  '  B --> C{Credentials valid?}',
  '  C -->|Yes| D[Create session]',
  '  C -->|No| E[Show error]',
  '  E --> B',
  '```',
  '',
  '```python',
  'def binary_search(items, target):',
  '    lo, hi = 0, len(items) - 1',
  '    while lo <= hi:',
  '        mid = (lo + hi) // 2      # midpoint',
  '        if items[mid] == target:',
  '            return mid',
  '    return -1',
  '```',
  '',
  '$$T(n) = O(\log n)$$',
  '',
  '| Case | Comparisons |',
  '| --- | --- |',
  '| Best | 1 |',
  '',
  'Costs $10 per month and $20 after that - must stay prose, not maths.',
].join('\n');

// Mid-stream: the fence is still open and the graph is incomplete. Must render
// as source without throwing and without leaving a mermaid error graphic behind.
const PARTIAL = ['## Mid-stream', '```mermaid', 'flowchart TD', '  A[User opens login'].join('\n');

document.documentElement.dataset.theme = THEME;
createRoot(document.getElementById('test')!).render(
  <div className="markdown" style={{maxWidth:730,margin:'24px auto',padding:'0 20px'}}>
    <Answer content={COMPLETE}/>
    <Answer content={PARTIAL} streaming/>
  </div>
);
