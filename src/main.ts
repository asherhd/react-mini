// main.ts
// 应用入口，渲染根组件到页面 (Fiber Phase1)
import { render /*, legacyRender */ } from './core/render';

import { App } from './examples/App'; // 已注释，消除未使用变量报错
// import { TodoApp } from './examples/TodoApp';

const root = document.getElementById('root');
render(App(), root!);
// 如需对比旧架构： legacyRender(App(), root!);
