import fs from 'node:fs';
import path from 'node:path';
import type { MemoryEntry } from './store.js';

/**
 * 记忆条目验证器
 *
 * 负责对 MemoryEntry 进行健康检查，发现以下问题：
 * - stale_path：内容中引用的文件路径已不存在
 * - never_used：超过 TTL 未被读取，可能已过时
 * - duplicate_name：存在同名记忆条目，可能需要合并
 */

/** 单条验证问题的描述 */
export interface ValidationIssue {
    /** 问题类型：过期路径 | 长期未使用 | 重名 */
    kind: 'stale_path' | 'never_used' | 'duplicate_name';
    /** 人类可读的问题描述 */
    message: string;
}

/** 验证报告：将一个记忆条目与其发现的所有问题关联 */
export interface ValidationReport {
    entry: MemoryEntry;
    issues: ValidationIssue[];
}

/** 用于从文本中提取文件路径的正则（支持 ts/tsx/js/json/md 等常见扩展名） */
const PATH_RE = /(?<![\w/])([\w./-]+\.(?:ts|tsx|js|jsx|json|md|mdx|sql|yml|yaml|toml|env|sh|py))/g;

/**
 * 从文本内容中提取所有疑似文件路径
 * @param content - 记忆条目的文本内容
 * @returns 去重后的路径列表
 */
export function extractPaths(content: string): string[] {
    const paths = new Set<string>();
    for (const match of content.matchAll(PATH_RE)) {
        paths.add(match[1]);
    }
    return Array.from(paths);
}

/**
 * 不同类型记忆的 TTL（Time-To-Live），单位为天
 *
 * 记忆类型不同，其"保鲜期"也不同：
 * - user：用户偏好几乎不过期（365 天）
 * - feedback：纠正反馈保留 3 个月（90 天）
 * - project：项目决策变化较快（30 天）
 * - reference：外部资源引用需要频繁刷新（14 天）
 *
 * 默认 TTL 为 30 天（适用于未明确分类的记忆类型）
 */
const TTL_BY_TYPE: Record<string, number> = {
    user: 365,
    feedback: 90,
    project: 30,
    reference: 14,
};

/**
 * 验证单条记忆条目，检查其中的文件路径是否有效以及是否超过 TTL
 * @param entry - 待验证的记忆条目
 * @param baseDir - 用于解析相对路径的基准目录，默认为当前目录
 * @returns 发现的验证问题列表
 */
export function validateEntry(
    entry: MemoryEntry,
    baseDir = '.',
): ValidationIssue[] {
    const issues: ValidationIssue[] = [];

    // 1. 检查内容中引用的文件路径是否存在
    const paths = extractPaths(entry.content);
    for (const p of paths) {
        const abs = path.isAbsolute(p) ? p : path.join(baseDir, p);
        if (!fs.existsSync(abs)) {
            issues.push({
                kind: 'stale_path',
                message: `引用的路径不存在：${p}`,
            });
        }
    }

    // 2. 检查记忆是否超过 TTL 未被读取
    if (entry.lastReadAt) {
        // 根据记忆类型获取对应的 TTL，未知类型默认 30 天
        const staleDays = TTL_BY_TYPE[entry.type] ?? 30;
        const days = (Date.now() - entry.lastReadAt) / (1000 * 60 * 60 * 24);
        if (days > staleDays) {
            issues.push({
                kind: 'never_used',
                message: `已 ${Math.floor(days)} 天没被读过，超过 ${entry.type} 类型的 ${staleDays} 天保质期`,
            });
        }
    }

    return issues;
}

/**
 * 批量验证所有记忆条目，并额外检测重名问题
 * @param entries - 待验证的记忆条目列表
 * @param baseDir - 用于解析相对路径的基准目录
 * @returns 包含问题的验证报告列表（无问题的条目不会出现在结果中）
 */
export function lintAll(
    entries: MemoryEntry[],
    baseDir = '.',
): ValidationReport[] {
    const reports: ValidationReport[] = [];

    // 统计每个 name 出现的次数，用于检测重名
    const nameCount = new Map<string, number>();
    for (const e of entries) {
        nameCount.set(e.name, (nameCount.get(e.name) || 0) + 1);
    }

    // 逐条验证，并在发现重名时追加 duplicate_name 问题
    for (const entry of entries) {
        const issues = validateEntry(entry, baseDir);
        if ((nameCount.get(entry.name) || 0) > 1) {
            issues.push({
                kind: 'duplicate_name',
                message: `存在 ${nameCount.get(entry.name)} 条同名记忆，可能需要合并`,
            });
        }
        // 仅保留存在问题的条目
        if (issues.length > 0) reports.push({ entry, issues });
    }

    return reports;
}
