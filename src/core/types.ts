// types.ts
// 虚拟 DOM 类型定义
// 统一 VNode 数据结构，便于 diff、挂载、状态管理
// 详见流程图 B->C->D
export type VNode = {
  type: string | Function; // 标签名或组件函数
  props: Record<string, any>; // 属性
  children: any[]; // 子节点
  dom?: Node | null; // 挂载后保存真实 DOM
  key?: string | number; // diff 用的 key
  componentInstance?: any; // 组件实例（用于 hooks）
  childVNode?: VNode; // 函数组件的子树
};
