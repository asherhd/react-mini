// main.ts
// 应用入口，渲染根组件到页面 (Fiber Phase1)
import { render } from './core/render';
import { App } from './examples/App';
import { createElement } from './core/createElement';

const root = document.getElementById('root');
render(<App />, root!);
