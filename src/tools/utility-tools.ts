import {
  readFileSync,
  existsSync,
  writeFileSync,
  readdirSync,
  statSync,
} from "node:fs";
import { extname, join, relative, resolve } from "node:path";
import fg from "fast-glob";
import type { ToolDefinition } from "../tool-registry.js";
import { execSync } from "node:child_process";

export const weatherTool: ToolDefinition = {
  name: "get_weather",
  description: "查询指定城市的天气信息",
  parameters: {
    type: "object",
    properties: {
      city: { type: "string", description: '城市名称，如"北京"、"上海"' },
    },
    required: ["city"],
    additionalProperties: false,
  },
  isConcurrencySafe: true,
  isReadOnly: true,
  execute: async ({ city }: { city: string }) => {
    const data: Record<string, string> = {
      北京: "晴，15-25°C，东南风 2 级",
      上海: "多云，18-22°C，西南风 3 级",
      深圳: "阵雨，22-28°C，南风 2 级",
    };
    return data[city] || `${city}：暂无数据`;
  },
};

export const calculatorTool: ToolDefinition = {
  name: "calculator_tool",
  description: "计算数学表达式的结果。当用户提问涉及数学运算时使用",
  parameters: {
    type: "object",
    properties: {
      expression: { type: "string", description: '数学表达式，如 "2 + 3 * 4"' },
    },
    required: ["expression"],
    additionalProperties: false,
  },
  isConcurrencySafe: true,
  isReadOnly: true,
  execute: async ({ expression }: { expression: string }) => {
    try {
      // 生产环境不要用 eval，这里纯粹为了演示
      const result = new Function(`return ${expression}`)();
      return `${expression} = ${result}`;
    } catch {
      return `无法计算: ${expression}`;
    }
  },
};

export const readFileTool: ToolDefinition = {
  name: "read_file",
  description: "读取指定路径的文件内容",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "文件路径" },
    },
    required: ["path"],
    additionalProperties: false,
  },
  isConcurrencySafe: true,
  isReadOnly: true,
  maxResultChars: 500, // 演示用，生产环境通常 50000+
  execute: async ({ path }: { path: string }) => {
    return readFileSync(resolve(path), "utf-8");
  },
};

export const writeFileTool: ToolDefinition = {
  name: "write_file",
  description: "写入内容到指定文件",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "文件路径" },
      content: { type: "string", description: "要写入的内容" },
    },
    required: ["path", "content"],
    additionalProperties: false,
  },
  isConcurrencySafe: false, // 写操作不能并行
  isReadOnly: false,
  execute: async ({ path, content }: { path: string; content: string }) => {
    writeFileSync(resolve(path), content, "utf-8");
    return `已写入 ${content.length} 字符到 ${path}`;
  },
};

export const listDirectoryTool: ToolDefinition = {
  name: "list_directory",
  description: "列出指定目录下的文件和子目录",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "目录路径，默认为当前目录" },
    },
    required: [],
    additionalProperties: false,
  },
  isConcurrencySafe: true,
  isReadOnly: true,
  execute: async ({ path = "." }: { path?: string }) => {
    const resolved = resolve(path);
    return readdirSync(resolved)
      .map((name) => {
        const stat = statSync(join(resolved, name));
        return `${stat.isDirectory() ? "[DIR]" : "[FILE]"} ${name}`;
      })
      .join("\n");
  },
};

export const editFileTool: ToolDefinition = {
  name: "edit_file",
  description:
    "精确替换文件中的指定内容。用 old_string 定位要替换的文本，用 new_string 替换它。不是全量覆写——只改你指定的部分",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "文件路径" },
      old_string: {
        type: "string",
        description: "要被替换的原始文本（必须精确匹配）",
      },
      new_string: { type: "string", description: "替换后的新文本" },
    },
    required: ["path", "old_string", "new_string"],
    additionalProperties: false,
  },
  isConcurrencySafe: false,
  isReadOnly: false,
  execute: async ({ path, old_string, new_string }) => {
    const resolved = resolve(path);
    if (!existsSync(resolved)) return `文件不存在: ${path}`;

    const content = readFileSync(resolved, "utf-8");
    const count = content.split(old_string).length - 1;

    if (count === 0) {
      return `未找到匹配内容。请检查 old_string 是否与文件中的文本完全一致（包括空格和换行）`;
    }
    if (count > 1) {
      return `找到 ${count} 处匹配，请提供更多上下文让 old_string 唯一`;
    }

    const updated = content.replace(old_string, new_string);
    writeFileSync(resolved, updated, "utf-8");
    return `已替换 ${path} 中的内容（${old_string.length} → ${new_string.length} 字符）`;
  },
};

export const globTool: ToolDefinition = {
  name: "glob",
  description:
    '按模式搜索文件。支持 * 和 ** 通配符，如 "src/**/*.ts" 匹配 src 下所有 TypeScript 文件',
  parameters: {
    type: "object",
    properties: {
      pattern: {
        type: "string",
        description: '搜索模式，如 "**/*.ts"、"src/*.json"',
      },
      path: { type: "string", description: "搜索起始目录，默认当前目录" },
    },
    required: ["pattern"],
    additionalProperties: false,
  },
  isConcurrencySafe: true,
  isReadOnly: true,
  execute: async ({ pattern, path = "." }) => {
    // ... 递归遍历目录，匹配模式 ...
    // 自动跳过 node_modules 和 .git
    // 结果上限 100 条，防止大项目撑爆
    const results = await fg(pattern, {
      cwd: resolve(path),
      ignore: ["node_modules/**", ".git/**"],
      dot: false,
      onlyFiles: true,
      followSymbolicLinks: false,
    });
    if (results.length === 0) return `没有找到匹配 "${pattern}" 的文件`;
    return results.sort().join("\n");
  },
};

export const grepTool: ToolDefinition = {
  name: "grep",
  description: "在文件中搜索匹配指定模式的内容。返回匹配的行号和内容",
  parameters: {
    type: "object",
    properties: {
      pattern: { type: "string", description: "搜索模式（正则表达式）" },
      path: {
        type: "string",
        description: "搜索路径（文件或目录），默认当前目录",
      },
    },
    required: ["pattern"],
    additionalProperties: false,
  },
  isConcurrencySafe: true,
  isReadOnly: true,
  maxResultChars: 3000,
  execute: async ({
    pattern,
    path = ".",
  }: {
    pattern: string;
    path?: string;
  }) => {
    const baseDir = resolve(path);
    const regex = new RegExp(pattern, "i");
    const matches: string[] = [];
    const SKIP = new Set(["node_modules", ".git", "dist"]);
    const BIN_EXT = new Set([
      ".png",
      ".jpg",
      ".gif",
      ".woff",
      ".woff2",
      ".ico",
      ".lock",
    ]);

    function searchFile(filePath: string) {
      if (matches.length >= 50) return;
      const ext = filePath.slice(filePath.lastIndexOf("."));
      if (BIN_EXT.has(ext)) return;

      let content: string;
      try {
        content = readFileSync(filePath, "utf-8");
      } catch {
        return;
      }

      const lines = content.split("\n");
      const rel = relative(baseDir, filePath);
      for (let i = 0; i < lines.length; i++) {
        if (regex.test(lines[i])) {
          matches.push(`${rel}:${i + 1}: ${lines[i].trimEnd()}`);
          if (matches.length >= 50) return;
        }
      }
    }

    function walk(dir: string) {
      if (matches.length >= 50) return;
      let entries: string[];
      try {
        entries = readdirSync(dir);
      } catch {
        return;
      }

      for (const name of entries) {
        if (SKIP.has(name)) continue;
        const full = join(dir, name);
        try {
          const stat = statSync(full);
          if (stat.isDirectory()) walk(full);
          else searchFile(full);
        } catch {
          /* skip */
        }
      }
    }

    const stat = statSync(baseDir);
    if (stat.isFile()) {
      searchFile(baseDir);
    } else {
      walk(baseDir);
    }

    if (matches.length === 0) return `没有找到匹配 "${pattern}" 的内容`;
    const suffix =
      matches.length >= 50 ? "\n... (结果已截断，共 50+ 条匹配)" : "";
    return matches.join("\n") + suffix;
  },
};

export const bashTool: ToolDefinition = {
  name: "bash",
  description:
    "执行 shell 命令并返回输出。适合运行脚本、检查环境、执行构建等操作",
  parameters: {
    type: "object",
    properties: {
      command: { type: "string", description: "要执行的 shell 命令" },
    },
    required: ["command"],
    additionalProperties: false,
  },
  isConcurrencySafe: false,
  isReadOnly: false,
  maxResultChars: 3000,
  execute: async ({ command }) => {
    // 先检测环境是否支持 child_process
    try {
      execSync("echo test", { stdio: "ignore" });
    } catch {
      return `[bash 不可用] 当前环境不支持 shell 命令。本地终端运行可使用。`;
    }

    try {
      const output = execSync(command, {
        encoding: "utf-8",
        timeout: 10000, // 10 秒超时
        maxBuffer: 1024 * 1024,
      });
      return output || "(命令执行成功，无输出)";
    } catch (err: any) {
      return `命令执行失败 (exit ${err.status || 1}):\n${err.stderr || err.message}`;
    }
  },
};

const MOCK_PAGES: Record<string, string> = {
  "https://esm.sh": `esm.sh - 一个免费的 ES module CDN...`,
  "https://ai-sdk.dev/docs/ai-sdk-core/tools-and-tool-calling": `AI SDK Core - Tools and Tool Calling
工具是模型可以决定调用的函数。一个工具由三部分组成：
- description：告诉模型何时使用这个工具
- inputSchema：通过 Zod 或 JSON Schema 定义参数
- execute：实际在服务端运行的函数...`,
  // ... 更多预定义页面
};

export const fetchUrlTool: ToolDefinition = {
  name: "fetch_url",
  description: "抓取指定 URL 的网页内容并转换为纯文本（自动剥离 HTML 标签）",
  parameters: {
    type: "object",
    properties: {
      url: {
        type: "string",
        description: "完整 URL，必须以 http:// 或 https:// 开头",
      },
    },
    required: ["url"],
    additionalProperties: false,
  },
  isConcurrencySafe: true, // 只读、可并发——抓多个 URL 时直接并行
  isReadOnly: true,
  maxResultChars: 1500, // 网页通常很长，截断兜底
  execute: async ({ url }: { url: string }) => {
    for (const key of Object.keys(MOCK_PAGES)) {
      if (url.startsWith(key)) return MOCK_PAGES[key];
    }
    try {
      const res = await fetch(url, {
        headers: { "User-Agent": "Mozilla/5.0 SuperAgent" },
        signal: AbortSignal.timeout(10000),
      });
      if (!res.ok) return `请求失败：HTTP ${res.status}`;
      const html = await res.text();
      return (
        html
          .replace(/<script[\s\S]*?<\/script>/gi, "")
          .replace(/<style[\s\S]*?<\/style>/gi, "")
          .replace(/<[^>]+>/g, " ")
          .replace(/\s+/g, " ")
          .trim() || "页面无文本内容"
      );
    } catch (err: any) {
      return `抓取失败：${err.message}`;
    }
  },
};

import { createServer, type Server } from "node:http";

let previewServer: Server | null = null;

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".tsx": "application/javascript; charset=utf-8", // 让浏览器把 .tsx 当 JS 加载
  ".ts": "application/javascript; charset=utf-8",
  // ...
};

export const startPreviewTool: ToolDefinition = {
  name: "start_preview",
  description: "启动 app/ 目录的预览服务器。生成应用文件后必须立即调用此工具",
  parameters: {
    type: "object",
    properties: { port: { type: "number" } },
    required: [],
    additionalProperties: false,
  },
  isConcurrencySafe: false,
  isReadOnly: false,
  execute: async ({ port = 8080 }: { port?: number } = {}) => {
    if (previewServer) return `预览服务器已在运行 → http://localhost:${port}`;
    const root = resolve("app");
    if (!existsSync(root)) return "错误：app/ 目录不存在";

    previewServer = createServer((req, res) => {
      const urlPath = (req.url?.split("?")[0] || "/").replace(
        /\/$/,
        "/index.html",
      );
      const filePath = join(root, urlPath === "/" ? "/index.html" : urlPath);
      if (!filePath.startsWith(root)) {
        res.writeHead(403);
        res.end();
        return;
      }

      let body: Buffer;
      try {
        body = readFileSync(filePath);
      } catch {
        res.writeHead(404);
        res.end("Not Found");
        return;
      }

      res.writeHead(200, {
        "Content-Type":
          MIME[extname(filePath).toLowerCase()] || "application/octet-stream",
        "Cache-Control": "no-cache",
      });
      res.end(body);
    });

    return new Promise<string>((resolve) => {
      previewServer!.listen(port, () => {
        resolve(`✓ 预览服务器已启动 → http://localhost:${port}`);
      });
    });
  },
};

export const allTools: ToolDefinition[] = [
  weatherTool,
  calculatorTool,
  readFileTool,
  writeFileTool,
  listDirectoryTool,
  editFileTool,
  globTool,
  grepTool,
  bashTool,
  fetchUrlTool,
  startPreviewTool,
];
