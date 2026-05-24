# Vibe Coding HTML 运行机制说明

本文解释 `app/index.html` 为什么可以加载并渲染 React TSX。

核心一句话：浏览器并不是直接理解 TSX。真正发生的是，`index.html` 里的 bootstrap 脚本在浏览器运行时把 `App.tsx` 编译成普通 JavaScript 模块，然后再动态 `import` 这个模块。

## 相关代码位置

- `app/index.html:8-17`：`importmap`，把 `react`、`react-dom/client` 这类裸模块名映射到 CDN 地址
- `app/index.html:29-30`：加载 Babel Standalone
- `app/index.html:34-42`：把 TSX 编译成 JavaScript
- `app/index.html:44-54`：递归处理相对 import
- `app/index.html:56-67`：加载、编译、缓存模块
- `app/index.html:69-78`：加载入口 `App.tsx` 并渲染
- `src/tools/utility-tools.ts`：`start_preview` 负责把 `app/` 目录作为静态文件服务出去

## 为什么普通 HTML 不能直接跑 TSX

浏览器原生能执行的是 JavaScript，不是 TypeScript，也不是 TSX。

所以这段代码不能被浏览器直接执行：

```tsx
const title: string = "Hello";
return <h1>{title}</h1>;
```

原因有两个：

- `: string` 是 TypeScript 类型语法，浏览器不认识。
- `<h1>{title}</h1>` 是 JSX/TSX 语法，浏览器也不认识。

因此，必须先把 TSX 转成普通 JS。

例如大致会变成：

```js
const title = "Hello";
return React.createElement("h1", null, title);
```

在生产项目里，这一步通常由 Vite、Webpack、Next.js、esbuild 这类构建工具完成。

这个 demo 没有起完整构建链路，而是把编译步骤放到了浏览器里。

## 第一步：用 importmap 解决 React import

`App.tsx` 里会写：

```ts
import React from "react";
import { createRoot } from "react-dom/client";
```

但浏览器默认不知道 `"react"` 指向哪里。

`index.html` 里的 `importmap` 做了这层映射：

```html
<script type="importmap">
  {
    "imports": {
      "react": "https://esm.sh/react@18.3.1",
      "react-dom/client": "https://esm.sh/react-dom@18.3.1/client"
    }
  }
</script>
```

这样浏览器看到 `import React from "react"` 时，就会去加载 `https://esm.sh/react@18.3.1`。

这一步解决的是模块地址问题，不解决 TSX 语法问题。

## 第二步：用 module script 启动 bootstrap

入口脚本是：

```html
<script type="module">
```

`type="module"` 有几个关键作用：

- 可以使用 `import()` 动态加载模块。
- 可以使用 top-level `await`。
- 遵守 ESM 模块作用域，不污染全局变量。

所以这里可以直接写：

```js
const { transform } = await import("https://esm.sh/@babel/standalone@7.25.6");
```

这行代码从 CDN 加载 Babel Standalone。它就是浏览器里的临时编译器。

## 第三步：把 TSX 编译成 JS

核心函数是 `compile`：

```js
function compile(src, filename) {
  return transform(src, {
    presets: [
      ["react", { runtime: "classic" }],
      ["typescript", { allExtensions: true, isTSX: true }],
    ],
    filename,
  }).code;
}
```

这里用了两个 Babel preset：

- `typescript`：去掉 TypeScript 类型语法。
- `react`：把 JSX/TSX 转成 `React.createElement(...)`。

所以 `App.tsx` 不是被浏览器直接执行，而是先经过 Babel 变成普通 JavaScript。

这里有个关键点：`compile()` 只负责编译当前文件的语法，不会把依赖一起打包进去。

也就是说，编译后的 `code` 里通常还会保留 `import`。

例如原始 `App.tsx`：

```tsx
import React from "react";
import { createRoot } from "react-dom/client";
import Button from "./Button.tsx";

function App() {
  return <Button onClick={() => {}}>添加</Button>;
}

createRoot(document.getElementById("root")!).render(<App />);
```

经过 Babel 后，大致会变成：

```js
import React from "react";
import { createRoot } from "react-dom/client";
import Button from "./Button.tsx";

function App() {
  return React.createElement(Button, {
    onClick: () => {},
  }, "添加");
}

createRoot(document.getElementById("root")).render(
  React.createElement(App, null),
);
```

变化发生在这些地方：

- TypeScript 类型被去掉了，比如 `!`、类型注解。
- JSX 被转成 `React.createElement(...)`。
- `import React from "react"` 还在。
- `import Button from "./Button.tsx"` 也还在。

Babel 在这里不是 bundler。它不会自动读取 `Button.tsx`，也不会把 `Button.tsx` 的代码合并进 `App.tsx`。

所以 `compile()` 之后还要继续处理相对 import。

## 第四步：处理相对 import

浏览器不能直接这样加载 TSX：

```ts
import { Button } from "./Button.tsx";
```

原因是 `Button.tsx` 也需要先编译。

所以代码里有 `rewriteRelativeImports`：

```js
const re = /from\s+(['"])(\.\.?\/[^'"]+\.(?:tsx?|jsx?))\1/g;
```

它会找出这类相对 import：

```ts
from "./Button.tsx"
```

然后调用 `loadModule("./Button.tsx")`：

1. `fetch` 读取 `Button.tsx` 源码。
2. 用 Babel 编译成 JS。
3. 再继续处理 `Button.tsx` 里面的相对 import。
4. 编译结果写进 `Blob`。
5. 生成一个 `blob:` URL。

最后把原来的 import 改成：

```js
from "blob:http://localhost/..."
```

浏览器可以直接 import 这个 `blob:` URL，因为它里面已经是普通 JS 了。

## 递归到底递归在哪里

递归发生在这两行之间：

```js
const resolved = await rewriteRelativeImports(compiled, url);
```

和：

```js
const blobUrl = await loadModule(absUrl);
```

流程是：

1. `loadModule(App.tsx)` 读取并编译 `App.tsx`。
2. `rewriteRelativeImports(compiledAppCode, App.tsx)` 发现里面有 `from "./Button.tsx"`。
3. 为了替换这个 import，它调用 `loadModule(Button.tsx)`。
4. `loadModule(Button.tsx)` 又会读取并编译 `Button.tsx`。
5. 如果 `Button.tsx` 里面还有 `from "./Icon.tsx"`，它又会调用 `loadModule(Icon.tsx)`。
6. `Icon.tsx` 编译完成后返回一个 `blob:` URL。
7. `Button.tsx` 把 `from "./Icon.tsx"` 替换成 `from "blob:..."`。
8. `Button.tsx` 自己也生成一个 `blob:` URL。
9. `App.tsx` 再把 `from "./Button.tsx"` 替换成 `from "blob:..."`。
10. 最后 `App.tsx` 自己生成一个 `blob:` URL，被入口 `import(entryBlob)` 执行。

举个完整一点的依赖链：

```txt
App.tsx
  -> Button.tsx
       -> Icon.tsx
```

实际加载顺序是深度优先：

```txt
loadModule(App.tsx)
  compile(App.tsx)
  rewriteRelativeImports(App compiled code)
    loadModule(Button.tsx)
      compile(Button.tsx)
      rewriteRelativeImports(Button compiled code)
        loadModule(Icon.tsx)
          compile(Icon.tsx)
          rewriteRelativeImports(Icon compiled code)
          create Blob URL for Icon
      replace "./Icon.tsx" with "blob:Icon"
      create Blob URL for Button
  replace "./Button.tsx" with "blob:Button"
  create Blob URL for App
import(blob:App)
```

这里的递归不是 React 组件递归，也不是 DOM 递归。

它只是模块依赖递归：一个文件 import 另一个文件，另一个文件可能继续 import 第三个文件。每一层都必须先编译成 JS，再给上一层一个可 import 的 `blob:` 地址。

## 为什么要转成 blob URL

这里容易误解。

`compile(src)` 的结果确实已经是 JS 了。但它只是一个字符串，存在浏览器内存里：

```js
const compiled = compile(src, url);
```

而 `import()` 需要的是一个模块地址，不是一段 JS 源码字符串。

也就是说，不能这样写：

```js
await import(compiled);
```

浏览器会把 `compiled` 当成模块路径解析，而不是当成代码执行。

原始 URL 也不能直接 import：

```js
await import("./App.tsx");
```

因为 `./App.tsx` 这个 URL 返回的还是原始 TSX 文件。服务器没有把它编译成 JS。浏览器拿到后还是会看到 TypeScript 类型和 JSX 语法，然后解析失败。

所以需要给“编译后的 JS 字符串”临时造一个浏览器能 import 的地址：

```js
const blob = new Blob([resolved], { type: "application/javascript" });
const blobUrl = URL.createObjectURL(blob);
await import(blobUrl);
```

`blob:` URL 的作用就是把内存里的 JS 字符串包装成一个临时模块资源。

如果换一种架构，也可以不用 `blob:`。

例如服务器提供一个真实的编译接口：

```txt
/__compiled/App.js
```

这个接口返回已经编译好的 JavaScript，并且 `Content-Type` 是 `application/javascript`。那浏览器就可以直接：

```js
await import("/__compiled/App.js");
```

但当前这个 demo 的设计是“服务器只负责静态文件，编译发生在浏览器”。在这个设计下，编译后的代码没有真实 HTTP 地址，所以用 `blob:` URL 是最轻的做法。

## 第五步：加载入口 App.tsx

入口固定是：

```js
const entryUrl = new URL("./App.tsx", window.location.href).href;
const entryBlob = await loadModule(entryUrl);
const mod = await import(entryBlob);
```

这里的执行链路是：

1. 找到 `./App.tsx`。
2. 编译它。
3. 把编译后的代码变成 `blob:` URL。
4. 用动态 `import()` 执行这个模块。

如果 `App.tsx` 自己写了：

```tsx
createRoot(document.getElementById("root")!).render(<App />);
```

那模块被 import 后就会自己完成渲染。

如果 `App.tsx` 只是默认导出组件：

```tsx
export default App;
```

bootstrap 会兜底处理：

```js
if (typeof mod.default === "function") {
  const React = await import("react");
  const { createRoot } = await import("react-dom/client");
  createRoot(document.getElementById("root")).render(
    React.createElement(mod.default),
  );
}
```

这就是为什么现在两种写法都能渲染。

## start_preview 做了什么

`start_preview` 本质上是一个很小的静态文件服务器。

它把 `app/` 目录暴露成 HTTP 资源：

- `/` -> `app/index.html`
- `/App.tsx` -> `app/App.tsx`
- `/styles.css` -> `app/styles.css`
- `/Button.tsx` -> `app/Button.tsx`

所以浏览器打开 `http://localhost:8080/` 时，先拿到 `index.html`。

之后 bootstrap 再通过 `fetch("./App.tsx")`、`fetch("./Button.tsx")` 继续读取源码。

这里的关键不是服务器会编译 TSX。服务器只是把文件送给浏览器。

编译发生在浏览器里的 Babel Standalone。

## 这个方案适合什么

这个方案适合 demo、教学、Vibe Coding 预览。

它的优点很直接：

- 不需要 Vite 或 Webpack。
- 不需要生成 `dist/`。
- Agent 只要写 `app/App.tsx`、`app/styles.css` 这类文件，刷新页面就能看结果。

但它不是生产方案。

主要限制：

- 依赖 CDN，离线或网络不好会失败。
- 每次打开页面都要在浏览器里编译，性能不如预构建。
- 相对 import 的解析是简化版，只覆盖 `from "./X.tsx"` 这类形式。
- 复杂 npm 包需要继续补 `importmap`。
- Babel Standalone 适合预览，不适合正式发布。

## 一句话总结

`index.html` 能渲染 React TSX，不是因为 HTML 原生支持 TSX，而是因为它内置了一段运行时编译器流程：先 `fetch` TSX 源码，再用 Babel 编译成 JS，再用 `Blob URL + dynamic import` 执行，最后用 React 挂载到 `#root`。
