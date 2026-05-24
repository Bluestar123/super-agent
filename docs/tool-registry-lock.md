# ToolRegistry 锁逻辑说明

本文档解释 `src/tool-registry.ts` 里 `ToolRegistry` 的锁逻辑。

核心一句话：这里实现的是一个简化版“读写锁”。

- `isConcurrencySafe === true` 的工具走共享锁，可以多个一起跑。
- 其他工具走独占锁，必须等所有工具都跑完，自己单独跑。
- 这不是操作系统线程锁，而是基于 `Promise` 和 `await` 的 JavaScript 异步排队逻辑。

## 相关代码位置

锁相关代码主要在：

- `src/tool-registry.ts:18-21`：锁状态变量
- `src/tool-registry.ts:37-43`：获取共享锁
- `src/tool-registry.ts:45-48`：释放共享锁
- `src/tool-registry.ts:50-56`：获取独占锁
- `src/tool-registry.ts:58-61`：释放独占锁
- `src/tool-registry.ts:63-67`：唤醒等待队列
- `src/tool-registry.ts:75-101`：执行 tool 时使用锁

## 三个状态变量

```ts
private exclusiveLock = false;
```

表示当前有没有独占锁持有者。

如果是 `true`，说明某个非并发安全工具正在执行，其他工具都应该等待。

```ts
private concurrentCount = 0;
```

表示当前有多少个共享锁持有者。

例如同时跑了 3 个 `isConcurrencySafe=true` 的工具，这里就是 `3`。

```ts
private waitQueue: Array<() => void> = [];
```

等待队列。

里面放的是一组 `Promise` 的 `resolve` 函数。谁拿不到锁，就创建一个 `Promise`，把自己的 `resolve` 塞进去，然后通过 `await` 挂起。等锁释放时，代码会调用这些 `resolve`，让等待者醒来并重新检查能不能拿锁。

## 获取共享锁：`acquireConcurrent`

```ts
private async acquireConcurrent(): Promise<void> {
```

定义一个异步函数，用来获取共享锁。

```ts
while (this.exclusiveLock) {
```

只要现在有人持有独占锁，就不能进入。

注意：这里只检查 `exclusiveLock`，不检查有没有独占锁正在排队。

```ts
await new Promise<void>((r) => this.waitQueue.push(r));
```

如果被独占锁挡住，就创建一个 `Promise`，把它的 `resolve` 函数放进 `waitQueue`。

这行的效果是：当前工具暂停执行，直到未来有人调用这个 `resolve()`。

```ts
}
this.concurrentCount++;
```

走到这里说明没有独占锁，可以拿共享锁。

于是共享锁数量加一。

多个并发安全工具可以同时走到这里，所以 `concurrentCount` 可能是 `1`、`2`、`3` 等。

## 释放共享锁：`releaseConcurrent`

```ts
private releaseConcurrent(): void {
```

定义释放共享锁的方法。

```ts
this.concurrentCount--;
```

当前共享锁持有者执行完了，所以数量减一。

```ts
if (this.concurrentCount === 0) this.drainQueue();
```

如果共享锁数量变成 `0`，说明所有并发工具都结束了。

这时可能有独占工具正在等待，所以调用 `drainQueue()` 唤醒等待队列。

如果还有其他共享锁没释放，例如 `concurrentCount` 还是 `2`，就不能唤醒独占工具，因为独占工具必须等所有共享工具结束。

## 获取独占锁：`acquireExclusive`

```ts
private async acquireExclusive(): Promise<void> {
```

定义获取独占锁的方法。

```ts
while (this.exclusiveLock || this.concurrentCount > 0) {
```

只要满足任意一个条件，就不能拿独占锁：

- 已经有人持有独占锁：`this.exclusiveLock`
- 还有共享锁没释放：`this.concurrentCount > 0`

也就是说，独占锁要求当前没有任何工具正在执行。

```ts
await new Promise<void>((r) => this.waitQueue.push(r));
```

拿不到锁时，把自己的 `resolve` 放进等待队列，然后暂停。

```ts
}
this.exclusiveLock = true;
```

走到这里说明：

- 没有独占锁
- 没有共享锁

于是把 `exclusiveLock` 标记为 `true`，表示自己拿到了独占锁。

## 释放独占锁：`releaseExclusive`

```ts
private releaseExclusive(): void {
```

定义释放独占锁的方法。

```ts
this.exclusiveLock = false;
```

独占工具执行完了，释放独占标记。

```ts
this.drainQueue();
```

唤醒等待队列里的所有人，让它们重新竞争锁。

## 唤醒等待队列：`drainQueue`

```ts
private drainQueue(): void {
```

定义唤醒等待者的方法。

```ts
const waiting = this.waitQueue.splice(0);
```

把当前等待队列里的所有 `resolve` 取出来，并清空原队列。

`splice(0)` 会修改原数组，所以 `this.waitQueue` 会变成空数组。

```ts
for (const resolve of waiting) resolve();
```

逐个调用 `resolve()`。

注意：这不是直接让等待者拿到锁，只是让它们从 `await` 后面继续执行。继续执行后，它们还会回到 `while` 条件重新判断。

所以这个实现不是严格 FIFO 队列，而是“全部叫醒，谁条件满足谁继续”。

## 执行工具时怎么用锁

```ts
const isSafe = tool.isConcurrencySafe === true;
```

判断这个工具是不是声明为并发安全。

只有明确写了 `true` 才算并发安全。`false` 和 `undefined` 都按不安全处理。

```ts
const registry = this;
```

保存 `this`，方便后面的 `execute` 闭包里调用锁方法。

```ts
if (isSafe) {
  await registry.acquireConcurrent();
```

如果并发安全，就获取共享锁。

这类工具可以和其他并发安全工具一起执行。

```ts
} else {
  await registry.acquireExclusive();
```

如果不是并发安全，就获取独占锁。

这类工具执行时，必须等其他所有工具完成，而且执行期间也不允许其他工具进来。

```ts
try {
  const raw = await executeFn(input);
```

拿到锁之后，真正执行工具函数。

```ts
} finally {
```

`finally` 的意思是：无论工具成功、失败、抛异常，都一定执行这里。

这个很关键。否则工具报错后锁不释放，后续所有工具可能永久卡住。

```ts
if (isSafe) {
  registry.releaseConcurrent();
} else {
  registry.releaseExclusive();
}
```

根据之前拿的是共享锁还是独占锁，释放对应的锁。

## 执行时序例子

假设有 4 个工具：

- A：`isConcurrencySafe=true`
- B：`isConcurrencySafe=true`
- C：没有 `isConcurrencySafe`
- D：`isConcurrencySafe=true`

如果 A、B 先启动：

```txt
A 获取共享锁，concurrentCount = 1
B 获取共享锁，concurrentCount = 2
```

此时 C 想启动：

```txt
C 需要独占锁，但 concurrentCount > 0
C 进入 waitQueue 等待
```

A 结束：

```txt
concurrentCount = 1
还有 B 在跑，不唤醒队列
```

B 结束：

```txt
concurrentCount = 0
drainQueue() 唤醒 C
C 重新检查，没人持锁，于是 exclusiveLock = true
```

C 执行期间 D 想启动：

```txt
D 是共享锁，但 exclusiveLock = true
D 进入 waitQueue 等待
```

C 结束：

```txt
exclusiveLock = false
drainQueue() 唤醒 D
D 获取共享锁
```

## 一个重要细节

这个实现是可用的简化读写锁，但不是严格公平锁。

原因是 `acquireConcurrent()` 只检查当前有没有 `exclusiveLock`，不检查有没有独占任务已经在排队：

```ts
while (this.exclusiveLock)
```

所以理论上，如果不断有新的并发安全工具进来，等待独占锁的工具可能一直被延后。

换句话说，当前实现偏向让并发安全工具尽量多跑。

如果要避免独占工具长期等待，通常需要再加一个类似 `waitingWriters` 的计数。只要有独占工具在排队，新的共享锁也要进入等待队列。

