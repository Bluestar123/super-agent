// 只导入类型：ToolRegistry 是全局工具注册中心，ToolDefinition 是单个工具的结构。
import type { ToolRegistry, ToolDefinition } from '../tools/registry.js';
// 只导入类型：PluginDefinition 是插件定义，PluginConfig 是插件配置，PluginApi 是传给插件使用的 API。
import type { PluginDefinition, PluginConfig, PluginApi } from './types.js';

// 这个文件是“插件管理器”。
//
// 它不实现具体插件能力，比如搜索、浏览器、数据库等。
// 它负责的是插件生命周期：
// 1. load(): 启动插件，并让插件把工具注册到 ToolRegistry。
// 2. unload(): 停止插件，并把插件注册过的工具从 ToolRegistry 移除。
// 3. unloadAll(): 一次性卸载所有插件。
// 4. get()/list(): 查询当前加载了哪些插件。
//
// 大致流程：
// PluginManager.load(plugin)
//   -> 创建一个 api 对象
//   -> 调用 plugin.activate(api)
//   -> 插件在 activate 里调用 api.registerTools([...])
//   -> PluginManager 给工具名加插件名前缀
//   -> ToolRegistry 保存这些工具
//   -> agent 后续才能调用这些工具

// PluginManager 内部保存的“已加载插件”信息。
interface LoadedPlugin {
    // 插件原始定义，里面有 name/version/description/activate/destroy 等字段。
    definition: PluginDefinition;
    // 这个插件已经注册到 ToolRegistry 的工具名列表。
    // 卸载插件时，需要根据这个列表逐个 unregister。
    tools: string[];
}

// 插件管理器类。外部通过这个类加载和卸载插件。
export class PluginManager {
    // 保存所有已经加载的插件。
    // key 是插件名，例如 "github"；value 是插件定义和它注册过的工具名。
    private plugins = new Map<string, LoadedPlugin>();

    // 工具注册中心。
    // 插件本身不会直接暴露给 agent，插件提供的 tools 会注册到这个 registry 里。
    private registry: ToolRegistry;

    // 创建 PluginManager 时必须传入 ToolRegistry。
    // 这样 PluginManager 才知道插件工具应该注册到哪里。
    constructor(registry: ToolRegistry) {
        this.registry = registry;
    }

    // 加载一个插件。
    //
    // definition: 插件定义对象，必须包含 name/version/description/activate。
    // config: 调用方传入的额外配置，可覆盖插件默认配置。
    //
    // 返回值：这个插件注册成功的工具名列表。
    async load(definition: PluginDefinition, config?: PluginConfig): Promise<string[]> {
        // 避免同一个插件被重复加载。
        // 注意这里按插件名判断，不是按对象引用判断。
        if (this.plugins.has(definition.name)) {
            throw new Error(`插件 "${definition.name}" 已加载`);
        }

        // 合并插件配置，并解析其中的环境变量占位符。
        //
        // definition.config 是插件默认配置。
        // config 是外部传进来的配置。
        // 后面的 ...config 会覆盖前面的 ...definition.config。
        //
        // 例子：
        // definition.config = { timeout: 1000, apiKey: "${OPENAI_API_KEY}" }
        // config            = { timeout: 3000 }
        // 合并后 timeout 会变成 3000。
        const resolvedConfig = this.resolveEnvVars({
            ...definition.config,
            ...config,
        });

        // 记录这个插件注册过的工具名。
        // 这里保存的是“加了插件名前缀之后”的工具名。
        // 后面 unload() 要靠这个数组把工具注销掉。
        const registeredTools: string[] = [];

        // 构造传给插件 activate() 的 API。
        //
        // 插件不能直接操作 PluginManager 的内部状态。
        // 它只能通过这个 api 注册工具、读取配置、打印日志。
        const api: PluginApi = {
            // 插件调用 api.registerTools([...]) 时，会执行这里。
            registerTools: (tools: ToolDefinition[]) => {
                // 遍历插件要注册的每一个工具。
                for (const tool of tools) {
                    // 给工具名加插件名前缀，避免不同插件的工具重名。
                    //
                    // 例如：
                    // 插件名是 "github"，工具名是 "search"，
                    // 最终注册到 ToolRegistry 的名字就是 "github__search"。
                    const prefixedName = `${definition.name}__${tool.name}`;

                    // 创建一个新的工具定义。
                    // 不直接修改原始 tool，避免影响插件自己持有的对象。
                    const prefixedTool: ToolDefinition = {
                        // 保留原工具的其他字段，比如 parameters、execute、isReadOnly 等。
                        ...tool,
                        // 替换成加了插件名前缀的新名字。
                        name: prefixedName,
                        // 在描述前加来源标识，方便调试时看出工具来自哪个插件。
                        description: `[Plugin:${definition.name}] ${tool.description}`,
                    };

                    // 把处理后的工具注册到全局 ToolRegistry。
                    // 注册后，系统后续才能发现并调用这个工具。
                    this.registry.register(prefixedTool);

                    // 记录工具名，方便卸载插件时 unregister。
                    registeredTools.push(prefixedName);
                }
            },

            // 插件调用 api.getConfig() 可以拿到最终配置。
            // 这个配置已经经过默认配置合并和环境变量解析。
            getConfig: () => resolvedConfig,

            // 插件调用 api.log("xxx") 时，会打印带插件名前缀的日志。
            log: (message: string) => {
                console.log(`  [plugin:${definition.name}] ${message}`);
            },
        };

        // 真正激活插件。
        //
        // 插件通常会在 activate(api) 里面：
        // 1. 读取 api.getConfig()
        // 2. 初始化自己的客户端或状态
        // 3. 调用 api.registerTools() 注册工具
        //
        // 这里用 await，因为 activate 可能是异步的。
        try {
            await definition.activate(api);
        } catch (err) {
            // 把未知错误统一转成可打印的字符串。
            const msg = err instanceof Error ? err.message : String(err);

            // 打印激活失败日志，带上插件名。
            console.error(`  [plugin:${definition.name}] 激活失败: ${msg}`);

            // 继续抛出原始错误，让调用方知道 load 失败了。
            //
            // 注意：当前代码没有自动回滚“activate 执行一半时已经注册的工具”。
            // 如果某个插件先注册工具后抛错，这些工具可能已经进入 registry。
            // 更严格的实现可以在这里遍历 registeredTools 做 unregister。
            throw err;
        }

        // 插件激活成功后，把它记录到已加载插件表里。
        this.plugins.set(definition.name, {
            // 保存插件定义，卸载时可能要调用 definition.destroy()。
            definition,
            // 保存这个插件注册过的工具。
            tools: registeredTools,
        });

        // 返回注册成功的工具名列表。
        return registeredTools;
    }

    // 卸载指定插件。
    //
    // 返回 true：确实找到了插件，并完成卸载流程。
    // 返回 false：这个插件本来就没加载。
    async unload(name: string): Promise<boolean> {
        // 从已加载插件表里按名字查找。
        const plugin = this.plugins.get(name);

        // 没找到就直接返回 false，不抛错。
        if (!plugin) return false;

        // 如果插件提供了 destroy()，先让插件自己清理资源。
        //
        // destroy() 常见用途：
        // - 关闭网络连接
        // - 停止后台任务
        // - 释放文件句柄
        // - 清理临时状态
        if (plugin.definition.destroy) {
            try {
                await plugin.definition.destroy();
            } catch (err) {
                // destroy 失败只记录日志，不中断后续卸载。
                //
                // 这样做是为了避免插件清理失败后，它的工具还继续留在 ToolRegistry 里。
                // 换句话说，这里的策略是“尽量把插件从系统里移除干净”。
                const msg = err instanceof Error ? err.message : String(err);
                console.error(`  [plugin:${name}] destroy 出错: ${msg}`);
            }
        }

        // 把这个插件注册过的所有工具从 ToolRegistry 注销。
        // 注销后，agent 就不能再调用这些工具了。
        for (const toolName of plugin.tools) {
            this.registry.unregister(toolName);
        }

        // 从插件管理器自己的已加载列表里删除插件记录。
        this.plugins.delete(name);

        // 表示卸载流程完成。
        return true;
    }

    // 卸载所有已加载插件。
    async unloadAll(): Promise<void> {
        // 先复制一份插件名列表。
        //
        // 因为 unload(name) 内部会修改 this.plugins，
        // 如果直接一边遍历 Map 一边删除，逻辑会更难判断。
        const names = Array.from(this.plugins.keys());

        // 按顺序逐个卸载。
        for (const name of names) {
            await this.unload(name);
        }
    }

    // 获取某个已加载插件的内部记录。
    //
    // 如果插件不存在，返回 undefined。
    get(name: string): LoadedPlugin | undefined {
        return this.plugins.get(name);
    }

    // 列出所有已加载插件的简要信息。
    //
    // 这个方法没有返回 activate/destroy 等函数，
    // 只返回适合展示或调试的信息。
    list(): Array<{ name: string; version: string; description: string; tools: string[] }> {
        // Map.values() 得到所有 LoadedPlugin。
        // Array.from(...) 把它转成数组。
        // map(...) 再转换成更简单的展示结构。
        return Array.from(this.plugins.values()).map(p => ({
            name: p.definition.name,
            version: p.definition.version,
            description: p.definition.description,
            tools: p.tools,
        }));
    }

    // 解析配置里的环境变量占位符。
    //
    // 只处理这种格式：
    //   "${ENV_NAME}"
    //
    // 不处理这种嵌在字符串中间的格式：
    //   "Bearer ${ENV_NAME}"
    //   "prefix-${ENV_NAME}"
    //
    // 因为下面的判断要求 value 同时 startsWith("${") 和 endsWith("}")。
    private resolveEnvVars(config: PluginConfig): PluginConfig {
        // 创建一个新对象，避免修改传进来的 config。
        const resolved: PluginConfig = {};

        // Object.entries(config) 会得到一组 [key, value]。
        // 例如 { apiKey: "abc", enabled: true }
        // 会变成 [["apiKey", "abc"], ["enabled", true]]。
        for (const [key, value] of Object.entries(config)) {
            // 如果 value 是完整的环境变量占位符，就读取 process.env。
            if (typeof value === 'string' && value.startsWith('${') && value.endsWith('}')) {
                // slice(2, -1) 会去掉前面的 "${" 和最后的 "}"。
                // 例如 "${OPENAI_API_KEY}" 会得到 "OPENAI_API_KEY"。
                const envKey = value.slice(2, -1);

                // 从 Node.js 的 process.env 中读取环境变量。
                // 如果没有这个环境变量，就使用空字符串。
                resolved[key] = process.env[envKey] || '';
            } else {
                // 不是环境变量占位符的值，直接原样保留。
                resolved[key] = value;
            }
        }

        // 返回解析完成的新配置对象。
        return resolved;
    }
}
