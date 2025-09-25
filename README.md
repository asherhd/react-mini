# 项目流程图

```mermaid
graph TD
    A[main.ts 应用入口] --> B[render 渲染虚拟DOM]
    B --> C[Fiber beginWork/completeWork]
    C --> D{Fiber 节点类型}
    D -->|HostComponent| E[创建/复用真实DOM]
    D -->|FunctionComponent| F[执行组件函数]
    F --> G[hooks 状态管理]
    G --> H[返回子虚拟DOM]
    E --> I[reconcileChildren 构建子 Fiber]
    H --> I
    I --> J[completeWork 收集副作用]
    J --> K[commit 提交 (Placement/Update/Deletion)]
    G --> L[setState 调度 scheduleRootUpdate]
    L --> B
```

# 运行时流程图

```mermaid
graph TD
    A[页面加载] --> B[main.ts 获取 root]
    B --> C[render(App, root)]
    C --> D[workLoop (beginWork/completeWork)]
    D --> E[effect list 构建]
    E --> F[commitRoot 提交 DOM]
    F --> G[用户交互 setState]
    G --> H[scheduleRootUpdate 重新发起渲染]
    H --> D
```

# react-mini

一个极简版 React 实现，包含虚拟 DOM、diff 算法、hooks、调度器与基础 Fiber 架构。当前 Fiber 处于 Phase1（同步工作循环 + 双缓冲 + flags 提交）。

## 项目结构与模块划分

```
react-mini/
├── index.html           # 项目入口 HTML
├── package.json
├── tsconfig.json
├── public/
├── src/
│   ├── main.ts          # 应用入口（走 Fiber 渲染）
│   ├── core/
│   │   ├── createElement.ts
│   │   ├── diff.ts           # 旧递归 diff（legacy 渲染保留）
│   │   ├── fiber.ts          # Fiber Phase1 实现
│   │   ├── hooks.ts
│   │   ├── index.ts
│   │   ├── reconciler.ts     # 预留/兼容层
│   │   ├── render.ts         # 默认走 fiber.renderRoot
│   │   ├── scheduler.ts      # 多优先级时间分片调度
│   │   ├── types.ts
│   ├── examples/
│   │   ├── App.tsx
│   │   ├── FiberCounter.tsx  # 演示虚拟化 + 多优先级
│   │   ├── TodoApp.tsx
```

## Fiber 架构核心概念（Phase1）

- FiberNode 字段

  - tag: HostRoot / HostComponent / FunctionComponent / Text
  - type: 元素标签或函数组件引用
  - stateNode: 真实 DOM 或容器
  - return / child / sibling: 构成单链 + 兄弟链的树结构
  - alternate: 双缓冲指向上一次已提交对应节点
  - pendingProps / memoizedProps: 本次输入 vs 已提交 props
  - flags / subtreeFlags: 副作用标记 (Placement / Update / Deletion)
  - effectNext: effect list 单链（提交阶段线性遍历）

- 渲染阶段 (render phase)

  - workLoopSync: 同步遍历（后续可改为时间切片）
  - beginWork: 根据 tag 生成/复用子 Fiber（FunctionComponent 触发组件函数）
  - completeWork: 创建真实 DOM / 文本节点，向上冒泡收集合并 subtreeFlags

- 提交阶段 (commit phase)

  - 构建的 effect list 顺序遍历：Placement / Deletion / (未来的属性 Update / layout/effect 分阶段)
  - root.current = finishedWork (树交换)

- 双缓冲
  - current(已提交) 与 workInProgress(正在构建) 通过 alternate 互指，提交后角色互换。

## Phase Roadmap

| Phase | 功能                                                           | 状态                                  |
| ----- | -------------------------------------------------------------- | ------------------------------------- |
| 1     | 双缓冲 + flags + 同步 workLoop + 简单子节点调和                | ✅ 已完成                             |
| 2     | 更优 reconcileChildren（key map / 移动复用）+ 属性 Update 提交 | ✅ 子节点 keyed/线性改进 + props 提交 |
| 3     | hooks 融合 Fiber（单次渲染内稳定 hookIndex；effect list 独立） | 待办                                  |
| 4     | 时间切片 + 可中断/恢复（协作调度，结合 scheduler）             | 待办                                  |
| 5     | lanes/优先级合并（多优先级更新合并到 Fiber Root）              | 待办                                  |
| 6     | effect 分阶段 (passive vs layout) + cleanup 时机优化           | 待办                                  |
| 7     | 错误边界 / Suspense 雏形 / Context                             | 待办                                  |

## 当前差异 (legacy diff vs Fiber)

| 项          | legacy diff              | Fiber Phase1                                 |
| ----------- | ------------------------ | -------------------------------------------- |
| 遍历方式    | 递归同步                 | 显式循环 (unit of work)                      |
| 子节点 diff | 索引 + keyed（已实现）   | 线性索引（待增强）                           |
| 更新驱动    | setState -> 直接 diff    | setState -> scheduleRootUpdate 重建 WIP 树   |
| 副作用收集  | 递归中直接 DOM 操作      | render 阶段构建 effect list，commit 集中执行 |
| 多优先级    | scheduler 外挂（组件级） | 后续合并至 lanes                             |
| 中断恢复    | 否                       | 计划中                                       |

## 调度 (scheduler.ts)

- 多队列按优先级 (user-blocking > high > normal > low > idle)
- normal/low 时间片让出；idle 仅在富余执行
- 提交回调 scheduleCommitCallback 支持批量统计输出
- 后续将与 Fiber lanes 合并，使一个 Root 聚合多个优先级更新

## 示例：虚拟化大列表 (FiberCounter)

- 固定行高 + 视口窗口 + overscan
- O(1) offset 更新：通过修改 ol 的 counter-reset 叠加全局偏移
- 高优先级交互（输入、高优按钮）不受低优先级列表刷新阻塞（未来配合可中断渲染更明显）

## 下一步计划（建议优先级）

1. Fiber Phase3: hooks / effect 与 Fiber 深度融合，构建独立 passive & layout effect list。
2. 引入 lanes 将 scheduler 优先级整合到 Fiber Root 上下文，支持多次 setState 合并。
3. 时间切片 workLoop（可中断/恢复），利用 scheduler 的 frame budget；保留同步兜底 flush。
4. effect 分阶段与 cleanup 顺序细化（先 destroy 再 create）。
5. 事件系统：合并委托 + 合并更新批处理（batch update）。
6. 开发工具：Fiber 树 & 提交时长可视化。
7. Context / ErrorBoundary / Suspense 雏形。

## 运行

1. npm install
2. npm run dev
3. 浏览器访问 http://localhost:3000

可通过切换 render.ts 的 render / legacyRender 对比两种实现行为。

---

欢迎继续提出要实现的下一阶段需求。当前建议先推进 Phase2，以提升列表/重排性能。
