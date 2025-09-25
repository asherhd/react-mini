// TodoApp.tsx
import { createElement, useState } from '../core';

function TodoList() {
  const [list, setList] = useState(['A', 'B', 'C']);
  return createElement('div', {},
    createElement('ul', {},
      ...list.map((item: string) => createElement('li', { key: item }, item))
    ),
    createElement('button', { onClick: () => setList((prev: any) => prev.reverse()) }, '变更顺序')
  );
}

export function TodoApp() {
  return createElement('div', {},
    createElement(TodoList, {})
  );
}
