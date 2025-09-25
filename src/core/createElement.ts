// createElement.ts
// 构建虚拟 DOM（VNode）
// 步骤1：根据 type 判断是标签还是组件，生成统一格式的 VNode
// 详见流程图 B->C->D
import type { VNode } from './types';

export function createElement(type: string | Function, props: Record<string, any> = {}, ...children: any[]): VNode {
  // 生成虚拟节点对象，包含类型、属性、子节点等
  return {
    type, // 标签名或组件函数
    props: props || {}, // 属性
    children: children.flat(), // 子节点
    key: props?.key, // diff 用的 key
    dom: null, // 挂载后保存真实 DOM
  };
}
